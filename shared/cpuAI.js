/*
 * Hadouken Battle - CPU opponent AI
 * =================================
 * This module contains ONLY the CPU's action-selection logic. It is kept fully
 * separate from the game rules (shared/gameEngine.js), the UI (index.html) and
 * the battle-mode control flow. It never re-implements any rule: every legality
 * check, cost lookup and turn outcome is delegated to an injected engine that
 * exposes the same API as shared/gameEngine.js.
 *
 * Design goals (see the feature spec):
 *   1. Only legal actions are ever candidates       -> engine.validateAction
 *   2. Clearly-pointless actions are pruned (0%)     -> isMeaninglessAction
 *   3. Candidates are scored by expected value       -> scoreAction
 *   4. The player's recent action history is used     -> PlayerHistory + predict
 *   5. Predictions are re-filtered by current energy  -> predictPlayerActions
 *   6. Expected value is computed by SIMULATING each   -> engine.resolveTurn
 *      (cpuAction x predictedPlayerAction) combo with the real engine
 *   7. Selection is stochastic (softmax), never fully  -> softmaxPick(rng)
 *      deterministic, but illegal / pointless actions stay at 0%
 *   8. Character specials are evaluated like any other action
 *
 * Determinism / testability: all randomness flows through an injected `rng`
 * (a function returning a float in [0,1)). Tests pass a seeded/constant rng to
 * get deterministic behaviour.
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

  var DEFAULT_TEMPERATURE = 0.6; // softmax temperature (fixed; no difficulty knob)

  // -----------------------------------------------------------------------
  // Player history: records the opponent's chosen actions so the CPU can
  // predict their next move. Only a bounded recent window is used so the CPU
  // adapts to a shift in the player's behaviour.
  // -----------------------------------------------------------------------
  function createPlayerHistory(windowSize) {
    var size = windowSize || 8; // "recent 5-10 turns"
    var actions = [];
    return {
      record: function (action) {
        if (action == null) return;
        actions.push(action);
        if (actions.length > size) actions.shift();
      },
      recent: function () { return actions.slice(); },
      count: function () { return actions.length; },
      reset: function () { actions.length = 0; },
    };
  }

  // -----------------------------------------------------------------------
  // Prediction of the player's NEXT action.
  //
  // Combines:
  //   - Laplace-smoothed frequencies from the recent history, so an empty or
  //     tiny history does not over-react to a single observed action.
  //   - A hard filter to the actions the player can ACTUALLY afford right now
  //     (spec #5): even if they historically spam a special, if they can't pay
  //     for it this turn it is dropped from the prediction.
  //
  // Returns an array of { action, prob } that sums to 1 over the player's
  // currently-legal actions. If the player somehow has no legal action, an
  // empty array is returned and the caller treats it as "no attack incoming".
  // -----------------------------------------------------------------------
  function predictPlayerActions(engine, playerCharId, playerEnergy, history) {
    var allActions = engine.ACTIONS;

    // (5) Only actions the player can currently afford are viable.
    var legal = allActions.filter(function (a) {
      return engine.validateAction(playerCharId, a, playerEnergy).ok;
    });
    if (legal.length === 0) return [];

    var recent = history ? history.recent() : [];

    // Count occurrences of each *legal* action within the recent window.
    var counts = {};
    legal.forEach(function (a) { counts[a] = 0; });
    recent.forEach(function (a) {
      if (Object.prototype.hasOwnProperty.call(counts, a)) counts[a] += 1;
    });

    // (4) Laplace smoothing over the legal action set:
    //   P(a) = (count(a) + 1) / (total + numLegalActions)
    // With no history every legal action is equally likely; as history grows
    // the observed distribution dominates.
    var totalLegalObserved = 0;
    legal.forEach(function (a) { totalLegalObserved += counts[a]; });
    var denom = totalLegalObserved + legal.length;

    return legal.map(function (a) {
      return { action: a, prob: (counts[a] + 1) / denom };
    });
  }

  // -----------------------------------------------------------------------
  // Legal-move candidates for the CPU (spec #1). Delegates to the engine.
  // -----------------------------------------------------------------------
  function legalActions(engine, charId, energy) {
    return engine.ACTIONS.filter(function (a) {
      return engine.validateAction(charId, a, energy).ok;
    });
  }

  // -----------------------------------------------------------------------
  // "Clearly meaningless" pruning (spec #2).
  //
  // The one rule the spec calls out explicitly: a plain Guard whose ONLY effect
  // is to block a blast is pointless when the opponent cannot threaten a
  // blockable blast this turn. Concretely: guard is meaningless when the
  // opponent cannot afford ANY blast-type attack that a guard could block
  // (i.e. only a plain "blast" is blockable by guard). If the opponent has 0
  // energy they can't blast at all, so guard does nothing.
  //
  // We stay conservative: we only prune guard, and only when it is provably
  // useless given the current rules. Guard is NOT pruned if the character's
  // guard could ever matter (it never has a special side effect in the current
  // roster, but if a future character gave guard extra meaning this check would
  // need revisiting — hence it is centralised here, next to the rules access).
  //
  // Charge is never pruned (topping energy is legitimately useful), and no
  // attacking action is pruned by this rule.
  // -----------------------------------------------------------------------
  function isMeaninglessAction(engine, ctx, action) {
    if (action !== "guard") return false;

    // Only a plain "blast" is blockable by guard (megablast/giga/pierce are
    // unguardable). So guard has value only if the opponent could blast.
    var oppCanBlast = engine.validateAction(ctx.oppChar, "blast", ctx.oppEnergy).ok;
    if (oppCanBlast) return false; // guard could block an incoming blast -> meaningful

    // Opponent cannot blast this turn -> a plain guard blocks nothing -> pointless.
    return true;
  }

  function pruneMeaningless(engine, ctx, actions) {
    var kept = actions.filter(function (a) {
      return !isMeaninglessAction(engine, ctx, a);
    });
    // Never return an empty candidate set: if pruning removed everything, fall
    // back to the legal set (should not happen, but keeps the CPU safe).
    return kept.length ? kept : actions;
  }

  // -----------------------------------------------------------------------
  // Utility of a fully-resolved turn from the CPU's point of view.
  //
  // `cpuSlot` is 1 or 2 (which side the CPU plays). We read the engine's
  // resolveTurn outcome (before/after HP+energy, finished/winner) and turn it
  // into a scalar the CPU wants to maximise.
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
    var hpTaken = before.hp[cpuSlot] - after.hp[cpuSlot];   // damage to self (>=0 if hurt)
    var enGain = after.energy[cpuSlot] - before.energy[cpuSlot];
    var oppEnLoss = before.energy[oppSlot] - after.energy[oppSlot];

    // Weights: HP swings matter most, then denying opponent energy, then our
    // own energy economy. Dealing damage is good; taking damage is bad.
    var score = 0;
    score += hpDealt * 30;
    score -= hpTaken * 34;         // slightly value survival over aggression
    score += oppEnLoss * 6;        // draining/denying opponent resources
    score += enGain * 4;           // building our own resources (charge)

    // Small positional bonus: being ahead on HP after the turn is good; being
    // behind is bad. This nudges the CPU toward pressing an advantage and
    // playing safe when behind.
    score += (after.hp[cpuSlot] - after.hp[oppSlot]) * 3;

    return score;
  }

  // -----------------------------------------------------------------------
  // Expected-value score for a single CPU candidate action (spec #3, #6).
  //
  // Score(cpuAction) = Σ_playerAction P(playerAction) × Utility(resolveTurn(...))
  //
  // The turn outcome for each (cpuAction, playerAction) pair is produced by the
  // REAL engine so the CPU never reasons about rules itself. If the opponent
  // has no legal action at all, the CPU evaluates its action against a neutral
  // "charge" stand-in so it can still compare candidates.
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
      preds = [{ action: "charge", prob: 1 }]; // neutral fallback
    }

    var expected = 0;
    for (var i = 0; i < preds.length; i++) {
      var playerAction = preds[i].action;
      var p = preds[i].prob;

      var a1 = cpuSlot === 1 ? cpuAction : playerAction;
      var a2 = cpuSlot === 1 ? playerAction : cpuAction;

      var outcome = engine.resolveTurn(chars, a1, a2, hp, energy);
      // An invalid outcome should never occur (both actions are pre-validated),
      // but guard against it by treating it as strongly unfavourable.
      var util = outcome.valid ? utilityOfOutcome(outcome, cpuSlot) : LOSS_UTILITY;
      expected += p * util;
    }
    return expected;
  }

  // -----------------------------------------------------------------------
  // Softmax stochastic selection (spec #7). Higher score -> higher probability,
  // but low-scoring (yet still sensible) actions keep a small chance. Meaningless
  // and illegal actions are already excluded before this point, so they are 0%.
  // -----------------------------------------------------------------------
  function softmaxPick(scored, temperature, rng) {
    var temp = temperature > 0 ? temperature : DEFAULT_TEMPERATURE;

    // Numerical stability: subtract the max score before exponentiating.
    var maxScore = -Infinity;
    scored.forEach(function (s) { if (s.score > maxScore) maxScore = s.score; });

    var weights = scored.map(function (s) {
      return Math.exp((s.score - maxScore) / temp);
    });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);

    var r = rng() * total;
    var acc = 0;
    for (var i = 0; i < scored.length; i++) {
      acc += weights[i];
      if (r < acc) return scored[i].action;
    }
    return scored[scored.length - 1].action; // fallback (float rounding)
  }

  // -----------------------------------------------------------------------
  // Public factory. `engine` must expose: ACTIONS, validateAction, actionCost,
  // resolveTurn, CHARACTERS (same contract as shared/gameEngine.js).
  //
  // opts:
  //   temperature   softmax temperature (default 0.6)
  //   historyWindow how many recent player actions to remember (default 8)
  //   cpuSlot       which player the CPU plays (default 2)
  // -----------------------------------------------------------------------
  function createCpuAI(engine, opts) {
    opts = opts || {};
    var temperature = typeof opts.temperature === "number" ? opts.temperature : DEFAULT_TEMPERATURE;
    var cpuSlot = opts.cpuSlot || 2;
    var history = createPlayerHistory(opts.historyWindow);

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

    // Return the scored, pruned candidate list (mostly for tests / debugging).
    function evaluate(state) {
      var ctx = buildContext(state);

      var candidates = legalActions(engine, ctx.cpuChar, ctx.cpuEnergy); // (1)
      candidates = pruneMeaningless(engine, ctx, candidates);            // (2)

      var predictions = predictPlayerActions(                            // (4,5)
        engine, ctx.oppChar, ctx.oppEnergy, history
      );

      var scored = candidates.map(function (a) {                         // (3,6)
        return { action: a, score: scoreAction(engine, ctx, a, predictions) };
      });
      return { ctx: ctx, predictions: predictions, scored: scored };
    }

    // Choose the CPU's action for the current state. `rng` is injectable for
    // deterministic tests; defaults to Math.random.
    function chooseAction(state, rng) {
      var r = typeof rng === "function" ? rng : Math.random;
      var res = evaluate(state);
      if (res.scored.length === 0) {
        // No candidate at all (should be impossible: charge/guard are free).
        return "charge";
      }
      return softmaxPick(res.scored, temperature, r); // (7)
    }

    return {
      // Main entry point used by the battle-mode controller.
      chooseAction: chooseAction,
      // Record the human player's chosen action after each turn (spec #4).
      recordPlayerAction: function (action) { history.record(action); },
      // Introspection helpers (used by unit tests).
      evaluate: evaluate,
      predictPlayerActions: function (state) {
        var ctx = buildContext(state);
        return predictPlayerActions(engine, ctx.oppChar, ctx.oppEnergy, history);
      },
      legalActions: function (state) {
        var ctx = buildContext(state);
        return legalActions(engine, ctx.cpuChar, ctx.cpuEnergy);
      },
      candidateActions: function (state) {
        var ctx = buildContext(state);
        return pruneMeaningless(engine, ctx, legalActions(engine, ctx.cpuChar, ctx.cpuEnergy));
      },
      history: history,
      cpuSlot: cpuSlot,
    };
  }

  return {
    createCpuAI: createCpuAI,
    createPlayerHistory: createPlayerHistory,
    // Exposed for unit testing of the individual pieces.
    predictPlayerActions: predictPlayerActions,
    legalActions: legalActions,
    isMeaninglessAction: isMeaninglessAction,
    pruneMeaningless: pruneMeaningless,
    utilityOfOutcome: utilityOfOutcome,
    scoreAction: scoreAction,
    softmaxPick: softmaxPick,
    WIN_UTILITY: WIN_UTILITY,
    LOSS_UTILITY: LOSS_UTILITY,
    DRAW_UTILITY: DRAW_UTILITY,
  };
});
