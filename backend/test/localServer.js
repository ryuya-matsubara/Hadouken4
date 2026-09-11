"use strict";
/*
 * LOCAL, DEPENDENCY-FREE WebSocket test server for END-TO-END testing WITHOUT
 * AWS. It reuses the REAL rule engine (gameEngine.js) and REAL room logic
 * (rooms.js) driven by the in-memory DynamoDB mock (mockDdb.js), and speaks the
 * same message protocol as the Lambda handler (handlers/index.js), so two real
 * browsers can play a full online match locally.
 *
 * This is a TEST HARNESS ONLY. Production uses API Gateway + Lambda. It is not
 * deployed and not referenced by the frontend in production.
 *
 * Implements just enough of RFC 6455 (text frames, unmasking, close) to serve
 * browser WebSocket clients.
 *
 * Usage:  node backend/test/localServer.js [port]
 */
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

// ---- Wire the real rooms.js to the in-memory mock DDB -------------------
const mock = require("./mockDdb");
const mockDoc = mock.createMockDoc();
const ddbPath = require.resolve("../src/lib/ddb");
require.cache[ddbPath] = new Module(ddbPath, module);
require.cache[ddbPath].exports = {
  doc: mockDoc,
  ROOMS_TABLE: "Rooms",
  CONNECTIONS_TABLE: "Connections",
  ROOM_TTL_SECONDS: 3600,
  FINISHED_TTL_SECONDS: 600,
  nowEpoch: () => Math.floor(Date.now() / 1000),
  GetCommand: mock.GetCommand,
  PutCommand: mock.PutCommand,
  UpdateCommand: mock.UpdateCommand,
  DeleteCommand: mock.DeleteCommand,
};
require.cache[ddbPath].loaded = true;

const rooms = require("../src/lib/rooms");
const engine = require("../src/lib/gameEngine");

// ---- Connection registry (connectionId -> socket) -----------------------
const sockets = new Map();
let connSeq = 0;

// A stand-in for the API Gateway Management API "send". Mirrors ws.js contract.
async function sendTo(connectionId, payload) {
  const sock = sockets.get(connectionId);
  if (!sock || sock.destroyed) return false;
  wsSend(sock, JSON.stringify(payload));
  return true;
}

// ---- Re-implement the handler's message routing using rooms.js ----------
// We import the handler's PURE helpers by re-creating the minimal broadcast
// logic here against sendTo(). To avoid duplicating rules, we call rooms.js and
// engine.js exactly like handlers/index.js does.
const ROOM_CODE_RE = /^[0-9]{4}$/;

function roomView(room, viewerSlot) {
  const turnKey = String(room.turn);
  const turnActions = (room.actions && room.actions[turnKey]) || {};
  const oppSlot = viewerSlot === 1 ? 2 : 1;
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
    myAction: turnActions[String(viewerSlot)] || null,
    opponentReady: Boolean(turnActions[String(oppSlot)]),
  };
}
async function sendSlot(room, slot, type, extra) {
  const conn = slot === 1 ? room.p1Conn : room.p2Conn;
  if (!conn) return;
  await sendTo(conn, Object.assign({ type }, extra || {}));
}
async function broadcast(room, type) {
  await Promise.all([
    sendSlot(room, 1, type, { room: roomView(room, 1) }),
    sendSlot(room, 2, type, { room: roomView(room, 2) }),
  ]);
}
async function sendErr(conn, code, message) {
  await sendTo(conn, { type: "error", code, message });
}

async function onMessage(connectionId, body) {
  const action = body.action;
  try {
    if (action === "createRoom") {
      const roomId = String(body.roomId || "");
      if (!ROOM_CODE_RE.test(roomId)) return sendErr(connectionId, "bad_room_code", "4桁");
      try {
        const room = await rooms.createRoom(roomId, connectionId);
        await rooms.putConnection(connectionId, roomId, 1);
        await sendTo(connectionId, { type: "roomCreated", room: roomView(room, 1) });
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return sendErr(connectionId, "room_exists", "使用中");
        throw e;
      }
    } else if (action === "joinRoom") {
      const roomId = String(body.roomId || "");
      if (!ROOM_CODE_RE.test(roomId)) return sendErr(connectionId, "bad_room_code", "4桁");
      try {
        const room = await rooms.joinRoom(roomId, connectionId);
        await rooms.putConnection(connectionId, roomId, 2);
        await broadcast(room, "roomJoined");
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const ex = await rooms.getRoom(roomId);
          return sendErr(connectionId, ex ? "room_full" : "room_not_found", "");
        }
        throw e;
      }
    } else if (action === "selectCharacter") {
      const conn = await rooms.getConnection(connectionId);
      if (!conn) return sendErr(connectionId, "no_room", "");
      const charId = String(body.charId || "");
      if (!engine.isValidCharId(charId)) return sendErr(connectionId, "bad_character", "");
      try {
        let room = await rooms.setCharacter(conn.roomId, conn.slot, charId);
        if (room.p1Char && room.p2Char && room.status === "charselect") {
          try {
            room = await rooms.startPlaying(conn.roomId);
            return broadcast(room, "battleStart");
          } catch (e) {
            if (e.name !== "ConditionalCheckFailedException") throw e;
            room = await rooms.getRoom(conn.roomId);
          }
        }
        await broadcast(room, "charUpdate");
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const room = await rooms.getRoom(conn.roomId);
          if (room) await broadcast(room, "charUpdate");
        } else throw e;
      }
    } else if (action === "submitAction") {
      const conn = await rooms.getConnection(connectionId);
      if (!conn) return sendErr(connectionId, "no_room", "");
      const room = await rooms.getRoom(conn.roomId);
      if (!room || room.status !== "playing") return sendErr(connectionId, "not_playing", "");
      // The move is carried in body.move (body.action is the route key).
      const chosen = String(body.move);
      const clientTurn = Number(body.turn);
      if (Number.isFinite(clientTurn) && clientTurn !== room.turn) {
        return sendSlot(room, conn.slot, "state", { room: roomView(room, conn.slot) });
      }
      const chars = { 1: room.p1Char, 2: room.p2Char };
      const v = engine.validateAction(chars[conn.slot], chosen, room.energy[String(conn.slot)]);
      if (!v.ok) return sendErr(connectionId, v.reason, "");
      let updated;
      try {
        updated = await rooms.recordAction(conn.roomId, room.turn, conn.slot, chosen);
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const cur = await rooms.getRoom(conn.roomId);
          if (cur) await sendSlot(cur, conn.slot, "state", { room: roomView(cur, conn.slot) });
          return;
        }
        throw e;
      }
      const tk = String(updated.turn);
      const ta = (updated.actions && updated.actions[tk]) || {};
      const a1 = ta["1"], a2 = ta["2"];
      if (!a1 || !a2) {
        await sendSlot(updated, conn.slot, "waitingForOpponent", { room: roomView(updated, conn.slot) });
        const opp = conn.slot === 1 ? 2 : 1;
        await sendSlot(updated, opp, "opponentReady", { room: roomView(updated, opp) });
        return;
      }
      const outcome = engine.resolveTurn(chars, a1, a2, updated.hp, updated.energy);
      const next = {
        hp: outcome.after.hp, energy: outcome.after.energy,
        turn: outcome.finished ? updated.turn : updated.turn + 1,
        finished: outcome.finished, winner: outcome.winner,
      };
      let committed;
      try {
        committed = await rooms.commitResolvedTurn(conn.roomId, updated.version, next);
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return;
        throw e;
      }
      const result = {
        turn: updated.turn, actions: { 1: a1, 2: a2 }, chars,
        events: outcome.events, logs: outcome.logs, clash: outcome.clash,
        fails: outcome.fails, isAttack: outcome.isAttack,
        before: outcome.before, after: outcome.after,
        finished: outcome.finished, winner: outcome.winner, nextTurn: committed.turn,
      };
      await Promise.all([
        sendSlot(committed, 1, "turnResult", { result, room: roomView(committed, 1) }),
        sendSlot(committed, 2, "turnResult", { result, room: roomView(committed, 2) }),
      ]);
    } else if (action === "rematch") {
      const conn = await rooms.getConnection(connectionId);
      if (!conn) return sendErr(connectionId, "no_room", "");
      try {
        const room = await rooms.resetForRematch(conn.roomId);
        await broadcast(room, "rematchStart");
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") {
          const room = await rooms.getRoom(conn.roomId);
          if (room) await broadcast(room, "state");
        } else throw e;
      }
    } else if (action === "leave") {
      const conn = await rooms.getConnection(connectionId);
      if (!conn) return;
      await rooms.deleteConnection(connectionId);
      const room = await rooms.getRoom(conn.roomId);
      if (room) {
        const opp = conn.slot === 1 ? 2 : 1;
        await sendSlot(room, opp, "opponentLeft", { slot: conn.slot });
        await rooms.deleteRoom(conn.roomId);
      }
    }
  } catch (err) {
    console.error("handler error:", err && err.name, err && err.message);
  }
}

async function onDisconnect(connectionId) {
  try {
    const conn = await rooms.getConnection(connectionId);
    if (!conn) return;
    await rooms.deleteConnection(connectionId);
    const room = await rooms.getRoom(conn.roomId);
    if (room) {
      const opp = conn.slot === 1 ? 2 : 1;
      await sendSlot(room, opp, "opponentDisconnected", { slot: conn.slot });
    }
  } catch (e) { /* ignore */ }
}

// ===== Minimal RFC6455 WebSocket implementation =====
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsSend(socket, str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function parseFrames(buffer, onText, onClose) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { if (p + 2 > buffer.length) break; len = buffer.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(p)); p += 8; }
    let mask;
    if (masked) { if (p + 4 > buffer.length) break; mask = buffer.slice(p, p + 4); p += 4; }
    if (p + len > buffer.length) break;
    const data = buffer.slice(p, p + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    p += len;
    offset = p;
    if (opcode === 0x8) { onClose(); return offset; }
    if (opcode === 0x1) onText(data.toString("utf8"));
  }
  return offset;
}

const server = http.createServer((req, res) => {
  res.writeHead(426); res.end("Upgrade Required");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  const connectionId = "conn-" + (++connSeq);
  sockets.set(connectionId, socket);

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const consumed = parseFrames(
      buf,
      (text) => {
        let msg; try { msg = JSON.parse(text); } catch (e) { return; }
        onMessage(connectionId, msg);
      },
      () => { socket.end(); }
    );
    buf = buf.slice(consumed);
  });
  const cleanup = () => { sockets.delete(connectionId); onDisconnect(connectionId); };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

const port = Number(process.argv[2] || 8090);
server.listen(port, () => {
  console.log("Hadouken local WS test server on ws://127.0.0.1:" + port);
});
