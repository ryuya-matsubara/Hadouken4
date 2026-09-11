"use strict";
/*
 * Room-level concurrency & idempotency tests. These exercise rooms.js against
 * an in-memory DynamoDB mock (test/mockDdb.js) so we can verify the system-level
 * contracts without AWS:
 *   - a room code cannot be created twice
 *   - joining a full room fails
 *   - character selection is idempotent per slot
 *   - a player's action for a turn can only be recorded ONCE (double-submit)
 *   - only ONE resolve commit succeeds when both invocations race (version CAS)
 *   - rematch resets state exactly once
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const mock = require("./mockDdb");

// ---- Inject the mock DocumentClient in place of the real ./ddb module -----
const mockDoc = mock.createMockDoc();
const ddbPath = require.resolve("../src/lib/ddb");
const fakeDdb = {
  doc: mockDoc,
  ROOMS_TABLE: "hadouken-online-Rooms",
  CONNECTIONS_TABLE: "hadouken-online-Connections",
  ROOM_TTL_SECONDS: 3600,
  FINISHED_TTL_SECONDS: 600,
  nowEpoch: () => 1000,
  GetCommand: mock.GetCommand,
  PutCommand: mock.PutCommand,
  UpdateCommand: mock.UpdateCommand,
  DeleteCommand: mock.DeleteCommand,
};
require.cache[ddbPath] = new Module(ddbPath, module);
require.cache[ddbPath].exports = fakeDdb;
require.cache[ddbPath].loaded = true;

// Now require rooms.js -> it will pick up the fake ddb from the cache.
const rooms = require("../src/lib/rooms");
const engine = require("../src/lib/gameEngine");

function reset() {
  for (const k of Object.keys(mockDoc._tables)) delete mockDoc._tables[k];
}

test("createRoom: same code cannot be created twice", async () => {
  reset();
  await rooms.createRoom("1234", "connA");
  await assert.rejects(
    () => rooms.createRoom("1234", "connB"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});

test("createRoom: a stale (expired-TTL) room can be reclaimed with the same code", async () => {
  reset();
  await rooms.createRoom("1234", "connA");
  // Simulate an abandoned room whose $disconnect never fired: force its TTL
  // into the past. (nowEpoch() is fixed at 1000 in this test harness.)
  const store = mockDoc._tables["hadouken-online-Rooms"];
  const key = Object.keys(store)[0];
  store[key].ttl = 1; // in the past relative to nowEpoch()=1000
  // A new player can now take over the same code.
  const reclaimed = await rooms.createRoom("1234", "connB");
  assert.equal(reclaimed.status, "waiting");
  assert.equal(reclaimed.p1Conn, "connB");
});

test("joinRoom: succeeds once, then a third player is rejected", async () => {
  reset();
  await rooms.createRoom("2222", "connA");
  const joined = await rooms.joinRoom("2222", "connB");
  assert.equal(joined.status, "charselect");
  assert.equal(joined.p2Conn, "connB");
  await assert.rejects(
    () => rooms.joinRoom("2222", "connC"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});

test("joinRoom: non-existent room is rejected", async () => {
  reset();
  await assert.rejects(
    () => rooms.joinRoom("9999", "connX"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});

test("setCharacter: idempotent per slot (second lock rejected), both -> startPlaying", async () => {
  reset();
  await rooms.createRoom("3333", "connA");
  await rooms.joinRoom("3333", "connB");
  await rooms.setCharacter("3333", 1, "hadou");
  // Re-locking slot 1 must fail (its char is already set).
  await assert.rejects(
    () => rooms.setCharacter("3333", 1, "blaze"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
  const afterP2 = await rooms.setCharacter("3333", 2, "angel");
  assert.equal(afterP2.p1Char, "hadou");
  assert.equal(afterP2.p2Char, "angel");
  const playing = await rooms.startPlaying("3333");
  assert.equal(playing.status, "playing");
});

async function beginMatch(code, c1, c2) {
  await rooms.createRoom(code, "connA");
  await rooms.joinRoom(code, "connB");
  await rooms.setCharacter(code, 1, c1);
  await rooms.setCharacter(code, 2, c2);
  return rooms.startPlaying(code);
}

test("recordAction: double submission for same turn/slot is rejected", async () => {
  reset();
  await beginMatch("4444", "hadou", "hadou");
  await rooms.recordAction("4444", 1, 1, "charge");
  // Same player, same turn, submits again -> must be rejected.
  await assert.rejects(
    () => rooms.recordAction("4444", 1, 1, "blast"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});

test("recordAction: opponent action hidden until both submitted", async () => {
  reset();
  await beginMatch("4445", "hadou", "hadou");
  const afterP1 = await rooms.recordAction("4445", 1, 1, "charge");
  // Only slot 1 recorded so far.
  assert.equal(afterP1.actions["1"]["1"], "charge");
  assert.equal(afterP1.actions["1"]["2"], undefined, "opponent action not present yet");
  const afterP2 = await rooms.recordAction("4445", 1, 2, "guard");
  assert.equal(afterP2.actions["1"]["1"], "charge");
  assert.equal(afterP2.actions["1"]["2"], "guard");
});

test("commitResolvedTurn: only one of two racing commits succeeds (version CAS)", async () => {
  reset();
  const room = await beginMatch("5555", "hadou", "hadou");
  await rooms.recordAction("5555", 1, 1, "charge");
  const both = await rooms.recordAction("5555", 1, 2, "charge");
  const version = both.version;
  const outcome = engine.resolveTurn(
    { 1: "hadou", 2: "hadou" },
    "charge",
    "charge",
    both.hp,
    both.energy
  );
  const next = {
    hp: outcome.after.hp,
    energy: outcome.after.energy,
    turn: outcome.finished ? both.turn : both.turn + 1,
    finished: outcome.finished,
    winner: outcome.winner,
  };
  // First commit at `version` succeeds.
  const committed = await rooms.commitResolvedTurn("5555", version, next);
  assert.equal(committed.turn, 2);
  assert.equal(committed.energy["1"], 1);
  // Second commit with the SAME stale version must fail (already advanced).
  await assert.rejects(
    () => rooms.commitResolvedTurn("5555", version, next),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});

test("full turn to KO then rematch resets state once", async () => {
  reset();
  await beginMatch("6666", "blaze", "hadou");
  // ギガブラスト now deals 2 dmg (costs 3 energy). Hadou starts at 3 HP, so it
  // takes TWO ギガブラスト to KO. Helper to play one turn and commit.
  let r, turn = 1;
  const playTurn = async (a1, a2) => {
    await rooms.recordAction("6666", turn, 1, a1);
    r = await rooms.recordAction("6666", turn, 2, a2);
    const out = engine.resolveTurn({ 1: "blaze", 2: "hadou" }, a1, a2, r.hp, r.energy);
    r = await rooms.commitResolvedTurn("6666", r.version, {
      hp: out.after.hp, energy: out.after.energy,
      turn: out.finished ? turn : turn + 1, finished: out.finished, winner: out.winner,
    });
    if (!out.finished) turn += 1;
    return out;
  };
  // Charge to 3 energy, fire ギガブラスト (Hadou 3 -> 1).
  await playTurn("charge", "charge");
  await playTurn("charge", "charge");
  await playTurn("charge", "charge");
  assert.equal(r.energy["1"], 3, "Blaze charged to 3 energy");
  await playTurn("special", "charge");
  assert.equal(r.hp["2"], 1, "Hadou down to 1 after first ギガブラスト");
  // Charge again and fire the finishing ギガブラスト (1 -> 0 KO).
  await playTurn("charge", "charge");
  await playTurn("charge", "charge");
  await playTurn("charge", "charge");
  const out = await playTurn("special", "charge");
  assert.equal(out.finished, true);
  assert.equal(out.winner, 1);
  assert.equal(r.status, "finished");
  assert.equal(r.winner, 1);

  // Rematch resets state; a second rematch (already reset) must fail.
  const reset1 = await rooms.resetForRematch("6666");
  assert.equal(reset1.status, "playing");
  assert.equal(reset1.hp["1"], engine.MAX_HP);
  assert.equal(reset1.hp["2"], engine.MAX_HP);
  assert.equal(reset1.turn, 1);
  await assert.rejects(
    () => rooms.resetForRematch("6666"),
    (e) => e.name === "ConditionalCheckFailedException"
  );
});
