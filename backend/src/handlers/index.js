"use strict";
/*
 * Single Lambda entry point for the Hadouken WebSocket API.
 *
 * API Gateway routes ($connect, $disconnect, $default and the custom action
 * routes) all target this function. We dispatch on the action name found in the
 * message body (routeSelectionExpression = $request.body.action).
 *
 * Design principles enforced here:
 *   - The SERVER is authoritative. Client-sent HP/energy are ignored; state is
 *     recomputed by the shared rule engine from the actions only.
 *   - All input is validated (room id format, character id, action name).
 *   - A player can only affect their OWN room/slot (looked up from the
 *     connection record), never another room.
 *   - Opponent actions are never revealed until both are in.
 *   - Idempotent: duplicate action submissions for the same turn are ignored.
 *   - Logging is intentionally sparse (errors + a couple of milestones) to keep
 *     CloudWatch costs low.
 */
const rooms = require("../lib/rooms");
const engine = require("../lib/gameEngine");
const { endpointFromEvent, send } = require("../lib/ws");

const ROOM_CODE_RE = /^[0-9]{4}$/;

// ---- small logging helper (stderr for errors only) ----
function logError(context, err) {
  // Single concise line; no payload dumps.
  console.error(context, err && err.name ? err.name : String(err));
}

function ok() {
  return { statusCode: 200, body: "" };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (e) {
    return {};
  }
}

// ---- Broadcast helpers -----------------------------------------------------

// Public room view for a given viewer slot. Never leaks the opponent's pending
// action for the current turn.
function roomView(room, viewerSlot) {
  const turnKey = String(room.turn);
  const turnActions = (room.actions && room.actions[turnKey]) || {};
  const mine = turnActions[String(viewerSlot)] || null;
  const oppSlot = viewerSlot === 1 ? 2 : 1;
  const oppHasActed = Boolean(turnActions[String(oppSlot)]);
  return {
    roomId: room.roomId,
    status: room.status,
    slot: viewerSlot,
    turn: room.turn,
    hp: room.hp,
    energy: room.energy,
    chars: { 1: room.p1Char || null, 2: room.p2Char || null },
    players: { 1: Boolean(room.p1Conn), 2: Boolean(room.p2Conn) },
    winner: typeof room.winner === "number" ? room.winner : null,
    // Only the viewer's own submitted action + whether the opponent has acted.
    myAction: mine,
    opponentReady: oppHasActed,
  };
}

async function sendToSlot(endpoint, room, slot, type, extra) {
  const conn = slot === 1 ? room.p1Conn : room.p2Conn;
  if (!conn) return true;
  const payload = Object.assign({ type }, extra || {});
  const alive = await send(endpoint, conn, payload);
  return alive;
}

// Send each player their own personalised room state.
async function broadcastState(endpoint, room, type) {
  const t = type || "state";
  await Promise.all([
    sendToSlot(endpoint, room, 1, t, { room: roomView(room, 1) }),
    sendToSlot(endpoint, room, 2, t, { room: roomView(room, 2) }),
  ]);
}

async function sendError(endpoint, connectionId, code, message) {
  await send(endpoint, connectionId, { type: "error", code, message });
}

// ---- Route handlers --------------------------------------------------------

async function handleConnect() {
  // Nothing to persist yet; the connection is associated with a room when it
  // creates/joins one.
  return ok();
}

async function handleDisconnect(event) {
  const connectionId = event.requestContext.connectionId;
  const endpoint = endpointFromEvent(event);
  try {
    const conn = await rooms.getConnection(connectionId);
    if (!conn) return ok();
    await rooms.deleteConnection(connectionId);
    const room = await rooms.getRoom(conn.roomId);
    if (!room) return ok();
    // A disconnect (including one caused by a network/comms error) frees the
    // room so its 4-digit code can be reused immediately. Notify the opponent
    // that the other player left, then delete the room.
    const oppSlot = conn.slot === 1 ? 2 : 1;
    await sendToSlot(endpoint, room, oppSlot, "opponentLeft", {
      slot: conn.slot,
    });
    await rooms.deleteRoom(conn.roomId);
    // Also drop the opponent's connection record so it isn't left dangling.
    const oppConn = oppSlot === 1 ? room.p1Conn : room.p2Conn;
    if (oppConn) {
      try { await rooms.deleteConnection(oppConn); } catch (e) {}
    }
  } catch (err) {
    logError("disconnect", err);
  }
  return ok();
}

async function handleCreateRoom(event, body) {
  const connectionId = event.requestContext.connectionId;
  const endpoint = endpointFromEvent(event);
  const roomId = String(body.roomId || "");
  if (!ROOM_CODE_RE.test(roomId)) {
    await sendError(endpoint, connectionId, "bad_room_code", "ルームコードは4桁の数字です");
    return ok();
  }
  try {
    const room = await rooms.createRoom(roomId, connectionId);
    await rooms.putConnection(connectionId, roomId, 1);
    await send(endpoint, connectionId, {
      type: "roomCreated",
      room: roomView(room, 1),
    });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      await sendError(endpoint, connectionId, "room_exists", "そのルームコードは使用中です");
    } else {
      logError("createRoom", err);
      await sendError(endpoint, connectionId, "server_error", "ルーム作成に失敗しました");
    }
  }
  return ok();
}

async function handleJoinRoom(event, body) {
  const connectionId = event.requestContext.connectionId;
  const endpoint = endpointFromEvent(event);
  const roomId = String(body.roomId || "");
  if (!ROOM_CODE_RE.test(roomId)) {
    await sendError(endpoint, connectionId, "bad_room_code", "ルームコードは4桁の数字です");
    return ok();
  }
  try {
    const room = await rooms.joinRoom(roomId, connectionId);
    await rooms.putConnection(connectionId, roomId, 2);
    // Both players are now present -> tell both we've entered char select.
    await broadcastState(endpoint, room, "roomJoined");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      const existing = await rooms.getRoom(roomId);
      if (!existing) {
        await sendError(endpoint, connectionId, "room_not_found", "ルームが見つかりません");
      } else {
        await sendError(endpoint, connectionId, "room_full", "このルームは満員です");
      }
    } else {
      logError("joinRoom", err);
      await sendError(endpoint, connectionId, "server_error", "参加に失敗しました");
    }
  }
  return ok();
}

// Resolve the caller's room + slot from the connection record. Ensures a
// connection can only act on its own room -> prevents cross-room tampering.
async function resolveCaller(event) {
  const connectionId = event.requestContext.connectionId;
  const conn = await rooms.getConnection(connectionId);
  if (!conn) return null;
  return { connectionId, roomId: conn.roomId, slot: conn.slot };
}

async function handleSelectCharacter(event, body) {
  const endpoint = endpointFromEvent(event);
  const caller = await resolveCaller(event);
  if (!caller) {
    await sendError(endpoint, event.requestContext.connectionId, "no_room", "ルームに参加していません");
    return ok();
  }
  const charId = String(body.charId || "");
  if (!engine.isValidCharId(charId)) {
    await sendError(endpoint, caller.connectionId, "bad_character", "不正なキャラクターです");
    return ok();
  }
  try {
    let room = await rooms.setCharacter(caller.roomId, caller.slot, charId);
    // If both characters are now chosen, flip to playing.
    if (room.p1Char && room.p2Char && room.status === "charselect") {
      try {
        room = await rooms.startPlaying(caller.roomId);
        await broadcastState(endpoint, room, "battleStart");
        return ok();
      } catch (e) {
        if (e.name !== "ConditionalCheckFailedException") throw e;
        room = await rooms.getRoom(caller.roomId);
      }
    }
    await broadcastState(endpoint, room, "charUpdate");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Already chosen / wrong phase -> just re-send current state.
      const room = await rooms.getRoom(caller.roomId);
      if (room) await broadcastState(endpoint, room, "charUpdate");
    } else {
      logError("selectCharacter", err);
      await sendError(endpoint, caller.connectionId, "server_error", "キャラクター選択に失敗しました");
    }
  }
  return ok();
}

async function handleSubmitAction(event, body) {
  const endpoint = endpointFromEvent(event);
  const caller = await resolveCaller(event);
  if (!caller) {
    await sendError(endpoint, event.requestContext.connectionId, "no_room", "ルームに参加していません");
    return ok();
  }
  // The move is sent under "move" so it does not collide with the "action"
  // route-selection field (which is always "submitAction" here).
  const action = String(body.move || "");
  const clientTurn = Number(body.turn);

  const room = await rooms.getRoom(caller.roomId);
  if (!room || room.status !== "playing") {
    await sendError(endpoint, caller.connectionId, "not_playing", "対戦中ではありません");
    return ok();
  }
  // Turn guard: ignore stale submissions from a previous turn.
  if (Number.isFinite(clientTurn) && clientTurn !== room.turn) {
    // Re-sync the client to the current state rather than error noisily.
    await sendToSlot(endpoint, room, caller.slot, "state", { room: roomView(room, caller.slot) });
    return ok();
  }
  // Validate the action against the AUTHORITATIVE energy for this slot.
  const chars = { 1: room.p1Char, 2: room.p2Char };
  const v = engine.validateAction(chars[caller.slot], action, room.energy[String(caller.slot)]);
  if (!v.ok) {
    await sendError(endpoint, caller.connectionId, v.reason, "そのアクションは選べません");
    return ok();
  }

  let updated;
  try {
    updated = await rooms.recordAction(caller.roomId, room.turn, caller.slot, action);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Double submit for this turn -> ignore, just confirm current state.
      const cur = await rooms.getRoom(caller.roomId);
      if (cur) await sendToSlot(endpoint, cur, caller.slot, "state", { room: roomView(cur, caller.slot) });
      return ok();
    }
    logError("recordAction", err);
    await sendError(endpoint, caller.connectionId, "server_error", "送信に失敗しました");
    return ok();
  }

  const turnKey = String(updated.turn);
  const turnActions = (updated.actions && updated.actions[turnKey]) || {};
  const a1 = turnActions["1"];
  const a2 = turnActions["2"];

  if (!a1 || !a2) {
    // Only one player has acted. Tell the acting player we're waiting, and tell
    // the opponent that this player is now ready (without revealing the move).
    await sendToSlot(endpoint, updated, caller.slot, "waitingForOpponent", {
      room: roomView(updated, caller.slot),
    });
    const oppSlot = caller.slot === 1 ? 2 : 1;
    await sendToSlot(endpoint, updated, oppSlot, "opponentReady", {
      room: roomView(updated, oppSlot),
    });
    return ok();
  }

  // Both actions present -> resolve authoritatively. Use the version we just
  // read so exactly one invocation commits + broadcasts the result.
  const outcome = engine.resolveTurn(chars, a1, a2, updated.hp, updated.energy);
  if (!outcome.valid) {
    // Should not happen (both were validated), but guard anyway.
    logError("resolve_invalid", new Error(JSON.stringify(outcome.invalid)));
    await broadcastState(endpoint, updated, "state");
    return ok();
  }

  const next = {
    hp: outcome.after.hp,
    energy: outcome.after.energy,
    turn: outcome.finished ? updated.turn : updated.turn + 1,
    finished: outcome.finished,
    winner: outcome.winner,
  };

  let committed;
  try {
    committed = await rooms.commitResolvedTurn(caller.roomId, updated.version, next);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Another invocation already resolved this turn. Nothing to do.
      return ok();
    }
    logError("commitTurn", err);
    return ok();
  }

  // Broadcast the SAME resolved result to both clients so their battle scenes
  // are identical. We include the actions (now safe to reveal) and the full
  // outcome for the choreography, plus the authoritative post-turn state.
  const result = {
    turn: updated.turn,
    actions: { 1: a1, 2: a2 },
    chars: chars,
    events: outcome.events,
    logs: outcome.logs,
    clash: outcome.clash,
    fails: outcome.fails,
    isAttack: outcome.isAttack,
    before: outcome.before,
    after: outcome.after,
    finished: outcome.finished,
    winner: outcome.winner,
    nextTurn: committed.turn,
  };
  await Promise.all([
    sendToSlot(endpoint, committed, 1, "turnResult", { result, room: roomView(committed, 1) }),
    sendToSlot(endpoint, committed, 2, "turnResult", { result, room: roomView(committed, 2) }),
  ]);
  return ok();
}

async function handleRematch(event) {
  const endpoint = endpointFromEvent(event);
  const caller = await resolveCaller(event);
  if (!caller) {
    await sendError(endpoint, event.requestContext.connectionId, "no_room", "ルームに参加していません");
    return ok();
  }
  try {
    const room = await rooms.resetForRematch(caller.roomId);
    await broadcastState(endpoint, room, "rematchStart");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Already reset by the other player; just push current state.
      const room = await rooms.getRoom(caller.roomId);
      if (room) await broadcastState(endpoint, room, "state");
    } else {
      logError("rematch", err);
      await sendError(endpoint, caller.connectionId, "server_error", "再戦に失敗しました");
    }
  }
  return ok();
}

// Reset a finished room back to character select so both players can pick a
// new character before the next match.
async function handleChangeCharacters(event) {
  const endpoint = endpointFromEvent(event);
  const caller = await resolveCaller(event);
  if (!caller) {
    await sendError(endpoint, event.requestContext.connectionId, "no_room", "ルームに参加していません");
    return ok();
  }
  try {
    const room = await rooms.resetForCharSelect(caller.roomId);
    await broadcastState(endpoint, room, "charSelectReset");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Already reset by the other player; just push current state.
      const room = await rooms.getRoom(caller.roomId);
      if (room) await broadcastState(endpoint, room, "charSelectReset");
    } else {
      logError("changeCharacters", err);
      await sendError(endpoint, caller.connectionId, "server_error", "キャラ選び直しに失敗しました");
    }
  }
  return ok();
}

async function handleLeave(event) {
  const endpoint = endpointFromEvent(event);
  const caller = await resolveCaller(event);
  if (!caller) return ok();
  try {
    await rooms.deleteConnection(caller.connectionId);
    const room = await rooms.getRoom(caller.roomId);
    if (room) {
      const oppSlot = caller.slot === 1 ? 2 : 1;
      await sendToSlot(endpoint, room, oppSlot, "opponentLeft", { slot: caller.slot });
      // Best effort cleanup: delete the room so the code frees up.
      await rooms.deleteRoom(caller.roomId);
    }
  } catch (err) {
    logError("leave", err);
  }
  return ok();
}

// ---- Dispatcher ------------------------------------------------------------
exports.handler = async (event) => {
  const routeKey = event.requestContext && event.requestContext.routeKey;
  if (routeKey === "$connect") return handleConnect(event);
  if (routeKey === "$disconnect") return handleDisconnect(event);

  const body = parseBody(event);
  const action = body.action || routeKey;

  try {
    switch (action) {
      case "createRoom":
        return await handleCreateRoom(event, body);
      case "joinRoom":
        return await handleJoinRoom(event, body);
      case "selectCharacter":
        return await handleSelectCharacter(event, body);
      case "submitAction":
        return await handleSubmitAction(event, body);
      case "rematch":
        return await handleRematch(event);
      case "changeCharacters":
        return await handleChangeCharacters(event);
      case "leave":
        return await handleLeave(event);
      default: {
        const endpoint = endpointFromEvent(event);
        await sendError(endpoint, event.requestContext.connectionId, "unknown_action", "不明なアクションです");
        return ok();
      }
    }
  } catch (err) {
    logError("dispatch", err);
    return ok(); // Never surface a 5xx to API Gateway for a socket frame.
  }
};
