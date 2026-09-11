/*
 * Hadouken Battle - CPU opponent AI
 * =================================
 * This module contains ONLY the CPU's action-selection logic. It is kept fully
 * separate from the game rules (shared/gameEngine.js), the UI (index.html) and
 * the battle-mode control flow. It never re-implements any rule: every legality
 * check, cost lookup and turn outcome is delegated to an injected engine that
 * exposes the same API as shared/gameEngine.js.
 *
 * Decision pipeline (per turn):
 *   1. List the CPU's currently LEGAL actions            -> engine.validateAction
 *   2. Drop clearly-meaningless actions                  -> isMeaninglessAction
 *   3. List the PLAYER's currently legal actions and treat them as EQUALLY
 *      likely (uniform). The CPU does NOT use the player's past history — it
 *      reasons only from the current HP / energy / characters / rules.
 *   4. For each CPU candidate, SIMULATE every (cpuAction x playerAction) pair
 *      with the real engine and compute the CPU's utility of the outcome  (#6)
 *   5. ExpectedUtility(cpuAction) = Σ P(playerAction) × Utility(...)        (#7)
 *   6. Prune candidates that are clearly dominated (their expected utility is
 *      far below the best) so an obviously-bad move gets 0% and a lone optimum
 *      gets ~100%.
 *   7. NORMALISE the surviving expected utilities to ~0..1 and apply a softmax
 *      over the NORMALISED values (weighted draw). Because normalisation is
 *      scale-invariant, the spread of the resulting distribution depends on the
 *      *relative ranking* of the actions, NOT on the raw utility magnitudes.
 *      This is the key fix: several reasonable actions share probability
 *      instead of the top-scoring action winning ~100% of the time.
 *
 * Rationale for the normalisation step:
 *   Utilities here have large magnitudes (a point of HP is worth ~30). Feeding
 *   raw scores straight into softmax with a small temperature made the best
 *   action win ~99.98% of the time — effectively an argmax. Min-max
 *   normalising the candidates to [0,1] first means a "best vs 2nd vs 3rd"
 *   spread of e.g. 22 / 19 / 17 maps to 1.0 / 0.4 / 0.0, which softmax turns
 *   into a sensible spread (~45% / 32% / 23%) rather than 100% / 0% / 0%.
 *
 * Determinism / testability: all randomness flows through an injected `rng`
 * (a function returning a float in [0,1)). Tests pass a constant/seeded rng for
 * deterministic behaviour, or sample many rng values to check the distribution.
 *
 * UMD-ish export: CommonJS (Node/tests) and browser global (window.HadoukenCpuAI).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api; // Node / tests
  } else {
    root.HadoukenCpuAI = api; // browser
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Utility scoring constants. WIN / LOSS dominate every other term so the CPU
  // always prefers a lethal finish and always avoids a self-inflicted loss.
  var WIN_UTILITY = 1000;
  var LOSS_UTILITY = -1000;
  var DRAW_UTILITY = -50; // a draw (double KO) is bad, but far better than a loss

  // Softmax temperature applied to the NORMALISED (0..1) expected utilities.
  // With normalised inputs in [0,1], this value controls how sharply the CPU
  // favours higher-ranked actions:
  //   - larger  -> flatter distribution (more random among reasonable options)
  //   - smaller -> sharper distribution (closer to argmax)
  // With normalised inputs, 1.5 gives a "best a bit favoured, but a real spread
  // among close options" feel. E.g. expected utilities 22/19/17 normalise to
  // 1.0/0.4/0.0, which softmax at this temperature turns into ~46%/31%/23% —
  // matching the intended behaviour instead of a near-100% argmax.
  var DEFAULT_TEMPERATURE = 1.5;

  // A candidate is pruned (0% chance) when its expected utility is more than
  // this many points BELOW the best candidate's expected utility. This keeps
  // "clearly bad" moves out of the weighted draw while letting merely "weaker"
  // moves keep a share. Tuned against the utility weights below: one point of
  // HP is worth ~30, so a full-HP swing (~64) is always "clearly" dominant, but
  // small economy differences (a few points) never prune a reasonable option.
  var DOMINANCE_GAP = 45;

  // ---- Utility weights (per turn outcome) ---------------------------------
  var W_HP_DEALT = 30;   // damage dealt to the opponent
  var W_HP_TAKEN = 34;   // damage taken by the CPU (slightly > dealt: value survival)
  var W_OPP_EN_LOSS = 6; // energy drained/denied from the opponent
  var W_EN_GAIN = 4;     // energy the CPU gains (charge)
  var W_HP_LEAD = 3;     // post-turn HP lead (press advantage / play safe)

  // -----------------------------------------------------------------------
  // Legal actions for a given player (delegates to the engine — no rules here).
  // -----------------------------------------------------------------------
  function legalActions(engine, charId, energy) {
    return engine.ACTIONS.filter(function (a) {
      return engine.validateAction(charId, a, energy).ok;
    });
  }

  // -----------------------------------------------------------------------
  // Uniform prediction of the player's next action.
  //
  // The CPU treats every action the player can currently AFFORD as equally
  // likely (no history, no bias). Actions the player cannot pay for this turn
  // are excluded. Returns [{ action, prob }] summing to 1, or [] if the player
  // has no legal action at all.
  // -----------------------------------------------------------------------
  function predictPlayerActions(engine, playerCharId, playerEnergy) {
    var legal = legalActions(engine, playerCharId, playerEnergy);
    if (legal.length === 0) return [];
    var p = 1 / legal.length;
    return legal.map(function (a) { return { action: a, prob: p }; });
  }

  // -----------------------------------------------------------------------
  // "Clearly meaningless" pruning.
  //
  // A plain Guard whose ONLY effect is to block a blast is pointless when the
  // opponent cannot threaten a blockable blast this turn. Only a plain "blast"
  // is blockable by guard (megablast/giga/pierce are unguardable), so guard has
  // value only if the opponent can afford a blast. If the opponent has 0 energy
  // they cannot blast, so guard does nothing -> excluded.
  //
  // Charge is never pruned (topping energy is legitimately useful), and no
  // attacking action is pruned by this rule.
  // -----------------------------------------------------------------------
  function isMeaninglessAction(engine, ctx, action) {
    if (action !== "guard") return false;
    var oppCanBlast = engine.validateAction(ctx.oppChar, "blast", ctx.oppEnergy).ok;
    return !oppCanBlast; // meaningful only if the opponent could blast
  }

  function pruneMeaningless(engine, ctx, actions) {
    var kept = actions.filter(function (a) {
      return !isMeaninglessAction(engine, ctx, a);
    });
    // Never return an empty candidate set.
    return kept.length ? kept : actions;
  }

  // -----------------------------------------------------------------------
  // Utility of a fully-resolved turn from the CPU's point of view.
  // Reflects: damage dealt, damage taken, energy gain, opponent energy loss,
  // win, loss, and (via the engine's resolveTurn) every character special.
  // -----------------------------------------------------------------------
  function utilityOfOutcome(outcome, cpuSlot) {
    var oppSlot = cpuSlot === 1 ? 2 : 1;

    if (outcome.finished) {
      if (outcome.winner === cpuSlot) return WIN_UTILITY;
      if (outcome.winner === oppSlot) return LOSS_UTILITY;
      return DRAW_UTILITY; // draw (0) = double KO
    }

    var before = outcome.before, after = outcome.after;

    var hpDealt = before.hp[oppSlot] - after.hp[oppSlot];   // damage to opponent
    var hpTaken = before.hp[cpuSlot] - after.hp[cpuSlot];   // damage to self
    var enGain = after.energy[cpuSlot] - before.energy[cpuSlot];
    var oppEnLoss = before.energy[oppSlot] - after.energy[oppSlot];

    var score = 0;
    score += hpDealt * W_HP_DEALT;
    score -= hpTaken * W_HP_TAKEN;
    score += oppEnLoss * W_OPP_EN_LOSS;
    score += enGain * W_EN_GAIN;
    score += (after.hp[cpuSlot] - after.hp[oppSlot]) * W_HP_LEAD;

    return score;
  }

  // -----------------------------------------------------------------------
  // Expected utility of one CPU candidate action against the (uniform) player
  // prediction. Each (cpuAction, playerAction) outcome is produced by the REAL
  // engine so the CPU never reasons about rules itself.
  // -----------------------------------------------------------------------
  function scoreAction(engine, ctx, cpuAction, predictions) {
    var cpuSlot = ctx.cpuSlot;
    var oppSlot = cpuSlot === 1 ? 2 : 1;

    var chars = {};
    chars[cpuSlot] = ctx.cpuChar;
    chars[oppSlot] = ctx.oppChar;

    var hp = {}; hp[cpuSlot] = ctx.cpuHp; hp[oppSlot] = ctx.oppHp;
    var energy = {}; energy[cpuSlot] = ctx.cpuEnergy; energy[oppSlot] = ctx.oppEnergy;

    var preds = predictions;
    if (!preds || preds.length === 0) {
      preds = [{ action: "charge", prob: 1 }]; // neutral fallback (opponent stuck)
    }

    var expected = 0;
    for (var i = 0; i < preds.length; i++) {
      var playerAction = preds[i].action;
      var p = preds[i].prob;

      var a1 = cpuSlot === 1 ? cpuAction : playerAction;
      var a2 = cpuSlot === 1 ? playerAction : cpuAction;

      var outcome = engine.resolveTurn(chars, a1, a2, hp, energy);
      var util = outcome.valid ? utilityOfOutcome(outcome, cpuSlot) : LOSS_UTILITY;
      expected += p * util;
    }
    return expected;
  }

  // -----------------------------------------------------------------------
  // From scored candidates -> a probability distribution.
  //
  // Steps:
  //   1. Prune candidates whose expected utility is more than DOMINANCE_GAP
  //      below the best (clearly-bad moves -> 0%). A single surviving candidate
  //      therefore gets probability 1 (a lone clear optimum -> 100%).
  //   2. Min-max normalise the survivors' expected utilities to [0,1].
  //   3. Softmax over the normalised values with DEFAULT_TEMPERATURE.
  //
  // Returns [{ action, prob }] over the surviving candidates (prob sums to 1).
  // -----------------------------------------------------------------------
  function distribution(scored, temperature) {
    var temp = temperature > 0 ? temperature : DEFAULT_TEMPERATURE;

    var maxScore = -Infinity;
    scored.forEach(function (s) { if (s.score > maxScore) maxScore = s.score; });

    // (1) Prune clearly-dominated candidates.
    var kept = scored.filter(function (s) {
      return maxScore - s.score <= DOMINANCE_GAP;
    });
    if (kept.length === 0) kept = scored.slice(); // safety
    if (kept.length === 1) {
      return [{ action: kept[0].action, prob: 1 }];
    }

    // (2) Min-max normalise the survivors to [0,1].
    var lo = Infinity, hi = -Infinity;
    kept.forEach(function (s) {
      if (s.score < lo) lo = s.score;
      if (s.score > hi) hi = s.score;
    });
    var range = hi - lo;
    var norm = kept.map(function (s) {
      return { action: s.action, n: range > 0 ? (s.score - lo) / range : 0 };
    });

    // (3) Softmax over the normalised values.
    var weights = norm.map(function (s) { return Math.exp(s.n / temp); });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);

    return norm.map(function (s, i) {
      return { action: s.action, prob: weights[i] / total };
    });
  }

  // Draw an action from a [{action, prob}] distribution using the injected rng.
  function drawFromDistribution(dist, rng) {
    var r = rng();
    var acc = 0;
    for (var i = 0; i < dist.length; i++) {
      acc += dist[i].prob;
      if (r < acc) return dist[i].action;
    }
    return dist[dist.length - 1].action; // fallback (float rounding)
  }

  // -----------------------------------------------------------------------
  // Public factory. `engine` must expose: ACTIONS, validateAction, actionCost,
  // resolveTurn, CHARACTERS (same contract as shared/gameEngine.js).
  //
  // opts:
  //   temperature  softmax temperature over normalised utilities (default 0.35)
  //   cpuSlot      which player the CPU plays (default 2)
  // -----------------------------------------------------------------------
  function createCpuAI(engine, opts) {
    opts = opts || {};
    var temperature = typeof opts.temperature === "number" ? opts.temperature : DEFAULT_TEMPERATURE;
    var cpuSlot = opts.cpuSlot || 2;

    // Build the per-decision context from a { char, hp, energy } view.
    // `state` shape: { char:{1,2}, hp:{1,2}, energy:{1,2} } (matches index.html).
    function buildContext(state) {
      var oppSlot = cpuSlot === 1 ? 2 : 1;
      return {
        cpuSlot: cpuSlot,
        cpuChar: state.char[cpuSlot],
        oppChar: state.char[oppSlot],
        cpuHp: state.hp[cpuSlot],
        oppHp: state.hp[oppSlot],
        cpuEnergy: state.energy[cpuSlot],
        oppEnergy: state.energy[oppSlot],
      };
    }

    // Full evaluation for a state: pruned candidates, their expected-utility
    // scores, and the resulting probability distribution. Used by chooseAction
    // and exposed for tests / debugging.
    function evaluate(state) {
      var ctx = buildContext(state);

      var candidates = pruneMeaningless(
        engine, ctx, legalActions(engine, ctx.cpuChar, ctx.cpuEnergy)
      );

      var predictions = predictPlayerActions(engine, ctx.oppChar, ctx.oppEnergy);

      var scored = candidates.map(function (a) {
        return { action: a, score: scoreAction(engine, ctx, a, predictions) };
      });

      var dist = distribution(scored, temperature);
      return { ctx: ctx, predictions: predictions, scored: scored, distribution: dist };
    }

    // Choose the CPU's action for the current state. `rng` is injectable for
    // deterministic tests; defaults to Math.random.
    function chooseAction(state, rng) {
      var r = typeof rng === "function" ? rng : Math.random;
      var res = evaluate(state);
      if (res.distribution.length === 0) return "charge"; // safety
      return drawFromDistribution(res.distribution, r);
    }

    return {
      // Main entry point used by the battle-mode controller.
      chooseAction: chooseAction,
      // Kept for API compatibility with index.html. The CPU intentionally does
      // NOT use the player's history to decide, so this is a no-op.
      recordPlayerAction: function () { /* no-op: history is not used */ },
      // Introspection helpers (used by unit tests / debugging).
      evaluate: evaluate,
      actionDistribution: function (state) { return evaluate(state).distribution; },
      predictPlayerActions: function (state) {
        var ctx = buildContext(state);
        return predictPlayerActions(engine, ctx.oppChar, ctx.oppEnergy);
      },
      legalActions: function (state) {
        var ctx = buildContext(state);
        return legalActions(engine, ctx.cpuChar, ctx.cpuEnergy);
      },
      candidateActions: function (state) {
        var ctx = buildContext(state);
        return pruneMeaningless(engine, ctx, legalActions(engine, ctx.cpuChar, ctx.cpuEnergy));
      },
      cpuSlot: cpuSlot,
    };
  }

  return {
    createCpuAI: createCpuAI,
    // Exposed for unit testing of the individual pieces.
    predictPlayerActions: predictPlayerActions,
    legalActions: legalActions,
    isMeaninglessAction: isMeaninglessAction,
    pruneMeaningless: pruneMeaningless,
    utilityOfOutcome: utilityOfOutcome,
    scoreAction: scoreAction,
    distribution: distribution,
    drawFromDistribution: drawFromDistribution,
    WIN_UTILITY: WIN_UTILITY,
    LOSS_UTILITY: LOSS_UTILITY,
    DRAW_UTILITY: DRAW_UTILITY,
    DOMINANCE_GAP: DOMINANCE_GAP,
    DEFAULT_TEMPERATURE: DEFAULT_TEMPERATURE,
  };
});
