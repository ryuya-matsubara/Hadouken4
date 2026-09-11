"use strict";
/*
 * Unit tests for the authoritative rule engine (shared/gameEngine.js, copied to
 * backend/src/lib/gameEngine.js). Uses the Node.js built-in test runner so no
 * external dependency is required:  node --test
 *
 * Covers the required cases:
 *   - normal attack (blast)         - HP update
 *   - guard                         - simultaneous actions
 *   - special moves                 - invalid action
 *   - energy consumption            - double submission (idempotency contract)
 *   - game end
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/lib/gameEngine");

// Helper: build a stats object.
function stats(hp1, hp2, en1, en2) {
  return { hp: { 1: hp1, 2: hp2 }, energy: { 1: en1, 2: en2 } };
}
// Helper: resolve a turn and return the outcome.
function resolve(c1, c2, a1, a2, s) {
  return engine.resolveTurn({ 1: c1, 2: c2 }, a1, a2, s.hp, s.energy);
}

// ---------------------------------------------------------------------------
// Normal attack (blast)
// ---------------------------------------------------------------------------
test("blast vs charge: attacker deals 1 damage and spends 1 energy", () => {
  const s = stats(3, 3, 1, 0);
  const o = resolve("hadou", "hadou", "blast", "charge", s);
  assert.equal(o.valid, true);
  assert.equal(o.after.hp[2], 2, "P2 loses 1 HP");
  assert.equal(o.after.hp[1], 3, "P1 unchanged");
  assert.equal(o.after.energy[1], 0, "P1 spends 1 energy on blast");
  assert.equal(o.after.energy[2], 1, "P2 charges +1 energy");
  const dmg = o.events.find((e) => e.type === "dmg");
  assert.ok(dmg && dmg.target === 2 && dmg.amount === 1);
});

test("blast vs blast: both are blast-type -> clash, no damage", () => {
  const s = stats(3, 3, 1, 1);
  const o = resolve("hadou", "hadou", "blast", "blast", s);
  assert.equal(o.clash, true);
  assert.equal(o.after.hp[1], 3);
  assert.equal(o.after.hp[2], 3);
  assert.ok(o.logs.includes("相殺！"));
  // Both still pay the blast cost.
  assert.equal(o.after.energy[1], 0);
  assert.equal(o.after.energy[2], 0);
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
test("blast vs guard: guard blocks the blast, no damage", () => {
  const s = stats(3, 3, 1, 0);
  const o = resolve("hadou", "hadou", "blast", "guard", s);
  assert.equal(o.after.hp[2], 3, "guard prevents damage");
  assert.ok(o.logs.some((l) => l.includes("ガード成功")));
  assert.equal(o.after.energy[1], 0, "blast still consumes energy even if blocked");
});

// ---------------------------------------------------------------------------
// Special moves
// ---------------------------------------------------------------------------
test("special 波動拳 (Hadou): unguardable, 1 dmg, costs 3 energy", () => {
  const s = stats(3, 3, 3, 0);
  const o = resolve("hadou", "hadou", "special", "guard", s);
  assert.equal(o.after.hp[2], 2, "波動拳 pierces guard");
  assert.equal(o.after.energy[1], 0, "costs 3 energy");
});

test("special ギガブラスト (Blaze): 2 dmg, unguardable, costs 3", () => {
  // ギガブラスト is unguardable: guarding does NOT block it.
  const guarded = resolve("blaze", "angel", "special", "guard", stats(3, 3, 3, 0));
  assert.equal(guarded.after.hp[2], 1, "guard does not block ギガブラスト (2 dmg)");

  const hit = resolve("blaze", "hadou", "special", "charge", stats(3, 3, 3, 0));
  assert.equal(hit.after.hp[2], 1, "ギガブラスト deals 2 damage");
  assert.equal(hit.after.energy[1], 0, "costs 3 energy");
});

// ---------------------------------------------------------------------------
// New common action: メガブラスト
// ---------------------------------------------------------------------------
test("megablast: 1 dmg, unguardable, costs 2 energy", () => {
  const guarded = resolve("hadou", "hadou", "megablast", "guard", stats(3, 3, 2, 0));
  assert.equal(guarded.after.hp[2], 2, "guard does NOT block megablast (1 dmg)");
  assert.equal(guarded.after.energy[1], 0, "megablast costs 2 energy");

  const bad = resolve("hadou", "hadou", "megablast", "charge", stats(3, 3, 1, 0));
  assert.equal(bad.valid, false, "megablast needs 2 energy");
  assert.equal(bad.invalid[1], "not_enough_energy");
});

test("clash tiers: blast vs megablast, megablast vs megablast, giga vs mega all clash", () => {
  const bm = resolve("hadou", "hadou", "blast", "megablast", stats(3, 3, 1, 2));
  assert.equal(bm.clash, true, "blast vs megablast clash");
  assert.equal(bm.after.hp[1], 3);
  assert.equal(bm.after.hp[2], 3);

  const mm = resolve("hadou", "hadou", "megablast", "megablast", stats(3, 3, 2, 2));
  assert.equal(mm.clash, true, "megablast vs megablast clash");

  const gm = resolve("blaze", "hadou", "special", "megablast", stats(3, 3, 3, 2));
  assert.equal(gm.clash, true, "gigablast vs megablast clash");
  assert.equal(gm.after.hp[1], 3);
  assert.equal(gm.after.hp[2], 3);
});

test("special ヒール (Angel): heals 1 HP, capped at MAX_HP, costs 2", () => {
  const o = resolve("angel", "hadou", "special", "charge", stats(1, 3, 2, 0));
  assert.equal(o.after.hp[1], 2, "heals +1");
  assert.equal(o.after.energy[1], 0, "costs 2 energy");

  const capped = resolve("angel", "hadou", "special", "charge", stats(3, 3, 2, 0));
  assert.equal(capped.after.hp[1], 3, "cannot exceed MAX_HP");
});

test("special VOID (Phantom): drains opponent energy by 1, costs 0", () => {
  const o = resolve("phantom", "hadou", "special", "charge", stats(3, 3, 0, 2));
  // opponent charged +1 (2->3) then drained -1 => 2
  assert.equal(o.after.energy[2], 2, "opponent net energy after charge then drain");
  assert.equal(o.after.energy[1], 0, "VOID costs no energy");
});

test("VOID user still takes damage if opponent attacked", () => {
  // Phantom uses VOID, opponent blasts. VOID user should lose HP.
  const o = resolve("phantom", "hadou", "special", "blast", stats(3, 3, 0, 1));
  assert.equal(o.after.hp[1], 2, "VOID does not defend against a blast");
});

test("波動拳 nullifies opponent blast-type (opponent attack fails)", () => {
  const o = resolve("hadou", "hadou", "special", "blast", stats(3, 3, 3, 1));
  assert.equal(o.after.hp[2], 2, "波動拳 lands");
  assert.equal(o.after.hp[1], 3, "opponent blast is nullified, no damage to P1");
  assert.ok(o.logs.some((l) => l.includes("無効化")));
});

test("波動拳 nullifies megablast and gigablast too", () => {
  // vs megablast
  const vm = resolve("hadou", "hadou", "special", "megablast", stats(3, 3, 3, 2));
  assert.equal(vm.after.hp[2], 2, "波動拳 lands 1");
  assert.equal(vm.after.hp[1], 3, "megablast nullified");
  // vs gigablast (Blaze special)
  const vg = resolve("hadou", "blaze", "special", "special", stats(3, 3, 3, 3));
  assert.equal(vg.after.hp[2], 2, "波動拳 lands 1 on Blaze");
  assert.equal(vg.after.hp[1], 3, "gigablast nullified");
});

// ---------------------------------------------------------------------------
// Energy consumption / charge
// ---------------------------------------------------------------------------
test("charge increases energy by 1, capped at MAX_ENERGY", () => {
  const o = resolve("hadou", "hadou", "charge", "charge", stats(3, 3, 0, 3));
  assert.equal(o.after.energy[1], 1);
  assert.equal(o.after.energy[2], 3, "capped at MAX_ENERGY");
});

// ---------------------------------------------------------------------------
// Simultaneous actions (both attack, trade damage)
// ---------------------------------------------------------------------------
test("simultaneous: 波動拳 (pierce) vs ギガブラスト -> blast-type nullified, pierce lands", () => {
  // Both attack. Hadou's 波動拳 pierces; Blaze's ギガブラスト is blast-type
  // and therefore is nullified by the pierce.
  const o = resolve("hadou", "blaze", "special", "special", stats(3, 3, 3, 3));
  assert.equal(o.after.hp[2], 2, "波動拳 lands on P2");
  assert.equal(o.after.hp[1], 3, "ギガブラスト nullified by 波動拳");
});

test("simultaneous: piercing 波動拳 vs blast -> only piercing lands", () => {
  const o = resolve("hadou", "hadou", "special", "blast", stats(3, 3, 3, 1));
  assert.equal(o.after.hp[1], 3);
  assert.equal(o.after.hp[2], 2);
});

// ---------------------------------------------------------------------------
// Invalid action
// ---------------------------------------------------------------------------
test("invalid action name is rejected, state unchanged", () => {
  const o = resolve("hadou", "hadou", "teleport", "charge", stats(3, 3, 3, 0));
  assert.equal(o.valid, false);
  assert.equal(o.invalid[1], "invalid_action");
  assert.deepEqual(o.after.hp, { 1: 3, 2: 3 }, "no state change on invalid input");
});

test("blast without energy is rejected", () => {
  const o = resolve("hadou", "hadou", "blast", "charge", stats(3, 3, 0, 0));
  assert.equal(o.valid, false);
  assert.equal(o.invalid[1], "not_enough_energy");
});

test("special without enough energy is rejected", () => {
  const o = resolve("hadou", "hadou", "special", "charge", stats(3, 3, 2, 0));
  assert.equal(o.valid, false);
  assert.equal(o.invalid[1], "not_enough_energy");
});

test("invalid character id is rejected", () => {
  const o = engine.resolveTurn({ 1: "ninja", 2: "hadou" }, "charge", "charge", { 1: 3, 2: 3 }, { 1: 0, 2: 0 });
  assert.equal(o.valid, false);
  assert.equal(o.invalid[1], "invalid_character");
});

// validateAction (used server-side before recording) matches resolve rejection.
test("validateAction guards energy and names", () => {
  assert.equal(engine.validateAction("hadou", "blast", 0).ok, false);
  assert.equal(engine.validateAction("hadou", "blast", 1).ok, true);
  assert.equal(engine.validateAction("hadou", "nope", 3).ok, false);
  // Blaze's ギガブラスト now costs 3.
  assert.equal(engine.validateAction("blaze", "special", 3).ok, true);
  assert.equal(engine.validateAction("blaze", "special", 2).ok, false);
  // megablast is a valid common action costing 2.
  assert.equal(engine.validateAction("hadou", "megablast", 2).ok, true);
  assert.equal(engine.validateAction("hadou", "megablast", 1).ok, false);
});

// ---------------------------------------------------------------------------
// Double submission (idempotency): resolving with the same inputs is
// deterministic. (The DynamoDB-level dedupe is covered by rooms.js; here we
// assert the engine itself is a pure function of its inputs.)
// ---------------------------------------------------------------------------
test("engine is deterministic: same inputs -> identical outcome", () => {
  const args = ["hadou", "blaze", "blast", "guard", stats(3, 3, 2, 0)];
  const a = resolve(...args);
  const b = resolve("hadou", "blaze", "blast", "guard", stats(3, 3, 2, 0));
  assert.deepEqual(a.after, b.after);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.logs, b.logs);
});

// ---------------------------------------------------------------------------
// Game end
// ---------------------------------------------------------------------------
test("game ends when a player's HP reaches 0; winner set", () => {
  // P1=Blaze uses ギガブラスト (2 dmg) on P2 at 2HP -> 0.
  const o = resolve("blaze", "hadou", "special", "charge", stats(3, 2, 3, 0));
  assert.equal(o.after.hp[2], 0);
  assert.equal(o.finished, true);
  assert.equal(o.winner, 1);
});

test("double KO is a draw (winner 0)", () => {
  // Both at 1 HP, both land a hit that isn't a clash: use 波動拳 both sides.
  const o = resolve("hadou", "hadou", "special", "special", stats(1, 1, 3, 3));
  assert.equal(o.after.hp[1], 0);
  assert.equal(o.after.hp[2], 0);
  assert.equal(o.finished, true);
  assert.equal(o.winner, 0);
});

test("no KO: match continues, winner null", () => {
  const o = resolve("hadou", "hadou", "charge", "charge", stats(3, 3, 0, 0));
  assert.equal(o.finished, false);
  assert.equal(o.winner, null);
});

test("HP never goes below 0", () => {
  // P2 has only 1 HP and takes megablast (2 dmg) -> clamped to 0, not -1.
  const o = resolve("hadou", "hadou", "megablast", "charge", stats(3, 1, 2, 0));
  assert.equal(o.after.hp[2], 0, "clamped at 0, not negative");
});
