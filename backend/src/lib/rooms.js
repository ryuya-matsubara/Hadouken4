"use strict";
/*
 * Room domain logic + DynamoDB access patterns.
 *
 * Data model (single-table-ish, two tables):
 *   Rooms table (PK: roomId)
 *     roomId       "1234"  (4-digit string code)
 *     status       "waiting" | "charselect" | "playing" | "finished"
 *     p1Conn       connectionId of player 1 (creator)
 *     p2Conn       connectionId of player 2 (joiner)
 *     p1Char       chosen character id | null
 *     p2Char       chosen character id | null
 *     hp           { "1": n, "2": n }
 *     energy       { "1": n, "2": n }
 *     turn         current turn number (>=1)
 *     actions      { "<turn>": { "1": action|undefined, "2": action|undefined } }
 *     version      monotonic integer for optimistic concurrency
 *     winner       0|1|2|null (set when finished)
 *     ttl          epoch seconds for auto-deletion
 *
 *   Connections table (PK: connectionId)
 *     connectionId
 *     roomId
 *     slot         1 | 2
 *     ttl
 *
 * Concurrency & idempotency:
 *   - Recording an action uses a conditional Update that only writes if that
 *     player has NOT already submitted for the current turn -> double-submit
 *     safe.
 *   - Turn resolution uses a conditional Update on `version` so exactly one
 *     invocation performs the resolve+broadcast.
 */
const {
  doc,
  ROOMS_TABLE,
  CONNECTIONS_TABLE,
  ROOM_TTL_SECONDS,
  FINISHED_TTL_SECONDS,
  nowEpoch,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("./ddb");
const engine = require("./gameEngine");

function roomTtl() {
  return nowEpoch() + ROOM_TTL_SECONDS;
}
function finishedTtl() {
  return nowEpoch() + FINISHED_TTL_SECONDS;
}

async function getRoom(roomId) {
  const res = await doc.send(
    new GetCommand({ TableName: ROOMS_TABLE, Key: { roomId } })
  );
  return res.Item || null;
}

// Create a room only if the code is free (conditional put).
async function createRoom(roomId, connectionId) {
  const stats = engine.initialStats();
  const item = {
    roomId,
    status: "waiting",
    p1Conn: connectionId,
    p2Conn: null,
    p1Char: null,
    p2Char: null,
    hp: stats.hp,
    energy: stats.energy,
    turn: 1,
    actions: {},
    version: 0,
    winner: null,
    ttl: roomTtl(),
  };
  await doc.send(
    new PutCommand({
      TableName: ROOMS_TABLE,
      Item: item,
      // A code is reusable when it is free OR the existing room is stale: its
      // TTL has already passed. DynamoDB's TTL sweeper is best-effort and can
      // lag for hours, and a $disconnect is not guaranteed to fire, so an
      // abandoned room could otherwise keep a code occupied. Allowing takeover
      // of an expired room lets players reuse codes immediately.
      ConditionExpression:
        "attribute_not_exists(roomId) OR #ttl < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":now": nowEpoch() },
    })
  );
  return item;
}

// Join as player 2. Conditional: room exists, is waiting, and has no P2 yet.
async function joinRoom(roomId, connectionId) {
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression:
        "SET p2Conn = :c, #s = :charselect, #ttl = :ttl ADD version :one",
      ConditionExpression:
        "attribute_exists(roomId) AND #s = :waiting AND (attribute_not_exists(p2Conn) OR p2Conn = :null)",
      ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":c": connectionId,
        ":charselect": "charselect",
        ":waiting": "waiting",
        ":null": null,
        ":one": 1,
        ":ttl": roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

async function putConnection(connectionId, roomId, slot) {
  await doc.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        roomId,
        slot,
        ttl: roomTtl(),
      },
    })
  );
}

async function getConnection(connectionId) {
  const res = await doc.send(
    new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
  return res.Item || null;
}

async function deleteConnection(connectionId) {
  await doc.send(
    new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
}

// Set a player's chosen character. Conditional on being in charselect and the
// slot not already having locked a character (idempotent per slot).
async function setCharacter(roomId, slot, charId) {
  const attr = slot === 1 ? "p1Char" : "p2Char";
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET #c = :char, #ttl = :ttl ADD version :one",
      ConditionExpression:
        "attribute_exists(roomId) AND #s = :charselect AND (attribute_not_exists(#c) OR #c = :null)",
      ExpressionAttributeNames: { "#c": attr, "#s": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":char": charId,
        ":charselect": "charselect",
        ":null": null,
        ":one": 1,
        ":ttl": roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

// Move a fully-chosen room into the playing state (conditional so only one
// invocation flips it).
async function startPlaying(roomId) {
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET #s = :playing, #ttl = :ttl ADD version :one",
      ConditionExpression:
        "#s = :charselect AND attribute_exists(p1Char) AND attribute_exists(p2Char) AND p1Char <> :null AND p2Char <> :null",
      ExpressionAttributeNames: { "#s": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":playing": "playing",
        ":charselect": "charselect",
        ":null": null,
        ":one": 1,
        ":ttl": roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

// Record a player's action for the current turn. Idempotent + double-submit
// safe: the conditional only allows a write when that slot has no action for
// this turn yet. Throws ConditionalCheckFailedException on a duplicate.
async function recordAction(roomId, turn, slot, action) {
  const turnKey = String(turn);
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      // actions.<turn>.<slot> = action
      UpdateExpression:
        "SET actions.#t = if_not_exists(actions.#t, :empty), #ttl = :ttl",
      ConditionExpression:
        "#s = :playing AND #cturn = :turn",
      ExpressionAttributeNames: {
        "#t": turnKey,
        "#s": "status",
        "#cturn": "turn",
        "#ttl": "ttl",
      },
      ExpressionAttributeValues: {
        ":empty": {},
        ":playing": "playing",
        ":turn": turn,
        ":ttl": roomTtl(),
      },
      ReturnValues: "NONE",
    })
  );
  // Now set the slot's action only if not already present.
  const slotKey = String(slot);
  const res2 = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression: "SET actions.#t.#p = :a ADD version :one",
      ConditionExpression:
        "#s = :playing AND #cturn = :turn AND attribute_not_exists(actions.#t.#p)",
      ExpressionAttributeNames: {
        "#t": turnKey,
        "#p": slotKey,
        "#s": "status",
        "#cturn": "turn",
      },
      ExpressionAttributeValues: {
        ":a": action,
        ":playing": "playing",
        ":turn": turn,
        ":one": 1,
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res2.Attributes;
}

// Commit a resolved turn's authoritative result. Conditional on the version we
// read, so exactly one invocation applies+broadcasts the result.
async function commitResolvedTurn(roomId, expectedVersion, next) {
  const finished = next.finished;
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression:
        "SET hp = :hp, energy = :en, #turn = :nextturn, #s = :status, winner = :winner, #ttl = :ttl ADD version :one",
      ConditionExpression: "version = :expected",
      ExpressionAttributeNames: { "#turn": "turn", "#s": "status", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":hp": next.hp,
        ":en": next.energy,
        ":nextturn": next.turn,
        ":status": finished ? "finished" : "playing",
        ":winner": finished ? next.winner : null,
        ":expected": expectedVersion,
        ":one": 1,
        ":ttl": finished ? finishedTtl() : roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

// Reset a finished room for a rematch, keeping characters. Conditional on
// being finished so a rematch only triggers once.
async function resetForRematch(roomId) {
  const stats = engine.initialStats();
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression:
        "SET #s = :playing, hp = :hp, energy = :en, #turn = :one, actions = :empty, winner = :null, #ttl = :ttl ADD version :incr",
      ConditionExpression: "#s = :finished",
      ExpressionAttributeNames: { "#s": "status", "#turn": "turn", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":playing": "playing",
        ":finished": "finished",
        ":hp": stats.hp,
        ":en": stats.energy,
        ":one": 1,
        ":empty": {},
        ":null": null,
        ":incr": 1,
        ":ttl": roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

// Reset a finished room back to CHARACTER SELECT, clearing both players'
// chosen characters and stats. Lets both players pick a new character for the
// next match. Conditional on being finished so it only triggers once.
async function resetForCharSelect(roomId) {
  const stats = engine.initialStats();
  const res = await doc.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { roomId },
      UpdateExpression:
        "SET #s = :charselect, p1Char = :null, p2Char = :null, hp = :hp, energy = :en, #turn = :one, actions = :empty, winner = :null, #ttl = :ttl ADD version :incr",
      ConditionExpression: "#s = :finished",
      ExpressionAttributeNames: { "#s": "status", "#turn": "turn", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":charselect": "charselect",
        ":finished": "finished",
        ":null": null,
        ":hp": stats.hp,
        ":en": stats.energy,
        ":one": 1,
        ":empty": {},
        ":incr": 1,
        ":ttl": roomTtl(),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return res.Attributes;
}

async function deleteRoom(roomId) {
  await doc.send(
    new DeleteCommand({ TableName: ROOMS_TABLE, Key: { roomId } })
  );
}

module.exports = {
  getRoom,
  createRoom,
  joinRoom,
  putConnection,
  getConnection,
  deleteConnection,
  setCharacter,
  startPlaying,
  recordAction,
  commitResolvedTurn,
  resetForRematch,
  resetForCharSelect,
  deleteRoom,
};
