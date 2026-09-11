"use strict";
/*
 * Unit tests for the CPU opponent AI (shared/cpuAI.js).
 *
 * The AI is deliberately decoupled from the rules: it takes an injected engine
 * (here the real shared/gameEngine.js) and an injected rng. That lets these
 * tests be fully deterministic — every "random" pick is controlled by a fake
 * rng we pass in, and distribution tests sample many rng values.
 *
 * Run with the Node.js built-in test runner:  node --test
 *
 * Covers:
 *   - Only affordable/legal actions are candidates (energy filter)
 *   - Meaningless Guard (opponent can't blast) is pruned
 *   - The player's actions are predicted UNIFORMLY (no history used)
 *   - Player actions the player cannot currently afford are excluded
 *   - A lethal (winning) attack dominates and is chosen ~100%
 *   - An immediate-loss action is scored very low / not chosen
 *   - Specials are considered and selectable for every character
 *   - Selection is STOCHASTIC: reasonable options share probability
 *     (blast not ~100% when energy is available; guard not ~100% at 0 energy),
 *     while a lone clear optimum is chosen 100% (both energy = 0 -> charge)
 *   - Determinism via injected rng
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// The AI uses the SAME authoritative engine as the game — no rule duplication.
const engine = require("../src/lib/gameEngine");
const cpuAI = require("../../shared/cpuAI");

// ---- helpers --------------------------------------------------------------
function makeState(c1, c2, hp1, hp2, en1, en2) {
  return {
    char: { 1: c1, 2: c2 },
    hp: { 1: hp1, 2: hp2 },
    energy: { 1: en1, 2: en2 },
  };
}
// A constant rng (always returns v) makes a single draw deterministic.
const constRng = (v) => () => v;

// Sample chooseAction N times and return { action: fraction } (0..1).
function sampleDistribution(ai, state, n) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const a = ai.chooseAction(state, Math.random);
    counts[a] = (counts[a] || 0) + 1;
  }
  const frac = {};
  for (const k of Object.keys(counts)) frac[k] = counts[k] / n;
  return frac;
}

// ---------------------------------------------------------------------------
// Legal-move filtering.
// ---------------------------------------------------------------------------
test("CPU only considers affordable actions (no energy -> no blast/mega/special)", () => {
  // CPU (P2) is Hadou with 0 energy: it can only charge or guard.
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 1, 0);
  const legal = ai.legalActions(state);
  assert.deepEqual(legal.sort(), ["charge", "guard"]);

  // Over many rng values the chosen action is always affordable.
  for (let i = 0; i < 20; i++) {
    const a = ai.chooseAction(state, constRng(i / 20));
    assert.ok(engine.validateAction("hadou", a, 0).ok, `chose unaffordable ${a}`);
  }
});

test("chooseAction always returns a legal action across the rng range", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("blaze", "blaze", 3, 3, 3, 2);
  for (let i = 0; i <= 20; i++) {
    const a = ai.chooseAction(state, constRng(i / 21));
    assert.ok(engine.validateAction("blaze", a, 2).ok, `illegal action returned: ${a}`);
  }
});

// ---------------------------------------------------------------------------
// Meaningless-move pruning.
// ---------------------------------------------------------------------------
test("Guard is pruned when opponent cannot blast (opponent energy = 0)", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 0, 1); // opponent (P1) has 0 energy
  const candidates = ai.candidateActions(state);
  assert.ok(!candidates.includes("guard"), "guard must be pruned as meaningless");

  const ctx = {
    cpuSlot: 2, cpuChar: "hadou", oppChar: "hadou",
    cpuHp: 3, oppHp: 3, cpuEnergy: 1, oppEnergy: 0,
  };
  assert.equal(cpuAI.isMeaninglessAction(engine, ctx, "guard"), true);
});

test("Guard is NOT pruned when opponent can blast", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 1, 1); // opponent has 1 energy
  const candidates = ai.candidateActions(state);
  assert.ok(candidates.includes("guard"), "guard should remain when opponent can blast");
});

// ---------------------------------------------------------------------------
// Player prediction: UNIFORM over the player's currently-legal actions, and it
// does NOT depend on any history (recordPlayerAction is a no-op).
// ---------------------------------------------------------------------------
test("Player prediction is uniform over the player's legal actions", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 3, 3); // player full energy
  const preds = ai.predictPlayerActions(state);
  const probs = preds.map((x) => x.prob);
  probs.forEach((p) => assert.ok(Math.abs(p - probs[0]) < 1e-9, "prediction must be uniform"));
  const total = probs.reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "prediction probs must sum to 1");
});

test("recordPlayerAction has no effect on decisions (history is not used)", () => {
  const state = makeState("hadou", "hadou", 3, 3, 3, 3);
  const before = cpuAI.createCpuAI(engine, { cpuSlot: 2 }).actionDistribution(state);

  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  for (let i = 0; i < 20; i++) ai.recordPlayerAction("blast"); // should be ignored
  const after = ai.actionDistribution(state);

  const key = (d) => d.map((x) => x.action + ":" + x.prob.toFixed(6)).join(",");
  assert.equal(key(after), key(before), "history must not change the distribution");
});

test("Unaffordable player actions are excluded from the (uniform) prediction", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  // Player (P1) has only 1 energy: megablast (2) and special (3) are excluded.
  const state = makeState("hadou", "hadou", 3, 3, 1, 3);
  const actions = ai.predictPlayerActions(state).map((x) => x.action);
  assert.ok(!actions.includes("megablast"));
  assert.ok(!actions.includes("special"));
  assert.ok(actions.includes("blast"));
});

// ---------------------------------------------------------------------------
// Utility: lethal attacks dominate; immediate-loss actions are avoided.
// ---------------------------------------------------------------------------
test("A lethal attack dominates and is chosen ~100%", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  // Opponent (P1) at 1 HP with 0 energy. CPU (P2) Hadou has 2 energy: megablast
  // (unguardable, 1 dmg) is lethal.
  const state = makeState("hadou", "hadou", 1, 3, 0, 2);
  const { scored, distribution } = ai.evaluate(state);
  const megaScore = scored.find((s) => s.action === "megablast").score;
  const chargeScore = scored.find((s) => s.action === "charge").score;
  assert.ok(megaScore > chargeScore, "lethal megablast should outscore charge");
  assert.ok(megaScore >= cpuAI.WIN_UTILITY * 0.5, "lethal move carries a large win utility");

  // The lethal move should be the (near-)only action in the distribution.
  const mega = distribution.find((d) => d.action === "megablast");
  assert.ok(mega && mega.prob > 0.99, "lethal move should be chosen ~100%");
  assert.equal(ai.chooseAction(state, constRng(0.5)), "megablast");
});

test("Guard beats charging into a lethal blast (defence valued when it saves the game)", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  // CPU (P2) at 1 HP, 1 energy. Opponent (P1) at 3 HP with only 1 energy, so the
  // player's only attack is a (blockable) blast. Guarding avoids a possible KO.
  const state = makeState("hadou", "hadou", 3, 1, 1, 1);
  const { scored } = ai.evaluate(state);
  const guard = scored.find((s) => s.action === "guard");
  const charge = scored.find((s) => s.action === "charge");
  assert.ok(guard, "guard should be a candidate (opponent can blast)");
  assert.ok(guard.score > charge.score, "guarding beats charging when a blast could be lethal");
});

// ---------------------------------------------------------------------------
// Specials are considered and selectable for every character.
// ---------------------------------------------------------------------------
test("Specials are evaluated as normal candidates (all characters)", () => {
  for (const cid of engine.CHAR_ORDER) {
    const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
    const cost = engine.actionCost(cid, "special");
    const state = makeState("hadou", cid, 3, 3, 1, Math.max(cost, 0));
    const legal = ai.legalActions(state);
    assert.ok(legal.includes("special"), `${cid}: special should be affordable/legal`);
    const { scored } = ai.evaluate(state);
    assert.ok(scored.some((s) => s.action === "special"), `${cid}: special should be scored`);
  }
});

test("Angel heal special is valued when the CPU is hurt", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  // CPU is Angel at 1 HP with 2 energy (heal costs 2). Opponent can't attack.
  const state = makeState("hadou", "angel", 3, 1, 0, 2);
  const { scored } = ai.evaluate(state);
  const heal = scored.find((s) => s.action === "special");
  const charge = scored.find((s) => s.action === "charge");
  assert.ok(heal, "heal special should be a candidate");
  assert.ok(heal.score > charge.score, "healing should beat charging when hurt & safe");
});

// ---------------------------------------------------------------------------
// The distribution() building block matches the intended shape.
// ---------------------------------------------------------------------------
test("distribution: close scores share probability; a large gap prunes the loser", () => {
  // Close cluster (22 / 19 / 17) -> a real spread, best NOT ~100%.
  const spread = cpuAI.distribution([
    { action: "blast", score: 22 },
    { action: "guard", score: 19 },
    { action: "charge", score: 17 },
  ]);
  const byAction = Object.fromEntries(spread.map((d) => [d.action, d.prob]));
  assert.ok(byAction.blast < 0.7, "top action must not dominate a close cluster");
  assert.ok(byAction.guard > 0.15 && byAction.charge > 0.12, "others keep a real share");
  assert.ok(byAction.blast > byAction.guard && byAction.guard > byAction.charge,
    "probability still ranks with score");

  // Large gap (20 vs -50) -> the loser is pruned, winner 100%.
  const dom = cpuAI.distribution([
    { action: "charge", score: 20 },
    { action: "guard", score: -50 },
  ]);
  assert.equal(dom.length, 1);
  assert.equal(dom[0].action, "charge");
  assert.ok(Math.abs(dom[0].prob - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// End-to-end distribution over 1000 samples for the three required scenarios.
// ---------------------------------------------------------------------------
test("both energy>0: Blast is NOT chosen ~100% (probability is spread)", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 2, 2); // both have energy
  const frac = sampleDistribution(ai, state, 1000);
  assert.ok((frac.blast || 0) < 0.7, `blast share too high: ${(frac.blast || 0)}`);
  // At least three distinct reasonable actions actually get chosen.
  const chosen = Object.keys(frac).filter((a) => frac[a] > 0.02);
  assert.ok(chosen.length >= 3, `expected a spread, got: ${JSON.stringify(frac)}`);
});

test("CPU energy=0 / player energy>0: Guard is NOT chosen ~100% (splits with Charge)", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 2, 0); // player en2, cpu en0
  const frac = sampleDistribution(ai, state, 1000);
  assert.ok((frac.guard || 0) < 0.9, `guard share too high: ${(frac.guard || 0)}`);
  assert.ok((frac.charge || 0) > 0.1, `charge should get a real share: ${(frac.charge || 0)}`);
});

test("both energy=0: Charge is the only sensible action -> chosen 100%", () => {
  const ai = cpuAI.createCpuAI(engine, { cpuSlot: 2 });
  const state = makeState("hadou", "hadou", 3, 3, 0, 0);
  const frac = sampleDistribution(ai, state, 1000);
  assert.equal(frac.charge, 1, `expected charge 100%, got: ${JSON.stringify(frac)}`);
});

// ---------------------------------------------------------------------------
// Determinism: same state + same rng -> same choice.
// ---------------------------------------------------------------------------
test("chooseAction is deterministic given a fixed rng", () => {
  const state = makeState("blaze", "hadou", 2, 3, 2, 2);
  const a1 = cpuAI.createCpuAI(engine, { cpuSlot: 2 }).chooseAction(state, constRng(0.37));
  const a2 = cpuAI.createCpuAI(engine, { cpuSlot: 2 }).chooseAction(state, constRng(0.37));
  assert.equal(a1, a2);
});
