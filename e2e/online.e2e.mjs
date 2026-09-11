// End-to-end test for the Hadouken Battle ONLINE backend.
//
// Drives two real WebSocket clients against the deployed API Gateway WebSocket
// endpoint and verifies the full server-authoritative flow:
//   createRoom -> joinRoom -> selectCharacter x2 -> submitAction loop -> winner
//
// The server is authoritative: clients never compute HP/energy. We assert that
// both clients receive identical resolved turn results and that a KO ends the
// game with a winner.
//
// Usage:
//   WS_URL=wss://xxxx.execute-api.ap-northeast-1.amazonaws.com/prod \
//     node online.e2e.mjs
import WebSocket from 'ws';
import assert from 'node:assert';

const WS_URL = process.env.WS_URL
  || 'wss://ylb3wopy88.execute-api.ap-northeast-1.amazonaws.com/prod';

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small WS client wrapper that records received messages and lets us wait
// for a message of a given `type`.
class Client {
  constructor(label) {
    this.label = label;
    this.ws = new WebSocket(WS_URL);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      // Try to satisfy a pending waiter first.
      const idx = this.waiters.findIndex((w) => w.match(msg));
      if (idx !== -1) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }
  open() {
    // The socket starts connecting in the constructor, so it may already be
    // OPEN by the time this is awaited. Resolve immediately in that case to
    // avoid missing the 'open' event.
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${this.label}: open timeout`)), 12000);
      this.ws.once('open', () => { clearTimeout(to); resolve(); });
      this.ws.once('error', (e) => { clearTimeout(to); reject(e); });
    });
  }
  send(action, extra) {
    this.ws.send(JSON.stringify(Object.assign({ action }, extra || {})));
  }
  // Wait for a message matching predicate (or type string), with timeout.
  waitFor(matcher, timeoutMs = 12000) {
    const match = typeof matcher === 'string'
      ? (m) => m.type === matcher
      : matcher;
    const queued = this.queue.findIndex(match);
    if (queued !== -1) {
      const [m] = this.queue.splice(queued, 1);
      return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error(`${this.label}: timeout waiting for ${matcher}`));
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => { clearTimeout(t); resolve(m); },
      });
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const roomCode = String(Math.floor(1000 + Math.random() * 9000));
console.log(`Using WS_URL=${WS_URL}`);
console.log(`Room code: ${roomCode}`);

const a = new Client('P1');
const b = new Client('P2');

try {
  await a.open();
  check('client 1 WebSocket connects', a.ws.readyState === WebSocket.OPEN);
  await b.open();
  check('client 2 WebSocket connects', b.ws.readyState === WebSocket.OPEN);

  // --- Create room (P1) ---
  a.send('createRoom', { roomId: roomCode });
  const created = await a.waitFor('roomCreated');
  check('P1 receives roomCreated with slot 1', created.room && created.room.slot === 1);
  check('room starts in waiting status', created.room.status === 'waiting');

  // --- Join room (P2) ---
  b.send('joinRoom', { roomId: roomCode });
  const joinedB = await b.waitFor('roomJoined');
  const joinedA = await a.waitFor('roomJoined');
  check('P2 receives roomJoined with slot 2', joinedB.room && joinedB.room.slot === 2);
  check('both players see charselect after join',
    joinedA.room.status === 'charselect' && joinedB.room.status === 'charselect');
  check('both players present in room view',
    joinedA.room.players['1'] === true && joinedA.room.players['2'] === true);

  // --- Select characters ---
  // Both pick "hadou" (波動拳: cost 3, 1 dmg, unguardable/piercing).
  a.send('selectCharacter', { charId: 'hadou' });
  b.send('selectCharacter', { charId: 'hadou' });
  const startA = await a.waitFor('battleStart');
  const startB = await b.waitFor('battleStart');
  check('battleStart broadcast to both after both pick a character',
    startA.type === 'battleStart' && startB.type === 'battleStart');
  check('server sets status=playing on battleStart',
    startA.room.status === 'playing' && startB.room.status === 'playing');
  check('both characters recorded as hadou',
    startA.room.chars['1'] === 'hadou' && startA.room.chars['2'] === 'hadou');
  check('initial HP is 3/3 (server authoritative)',
    startA.room.hp['1'] === 3 && startA.room.hp['2'] === 3);

  // --- Play the game to a winner ---
  // Strategy: both charge until energy is full enough for 波動拳 (cost 3),
  // then P1 keeps using 波動拳 (1 dmg, piercing) while P2 charges. Server
  // resolves each turn; we assert both clients get identical turnResults.
  let currentTurn = startA.room.turn; // typically 1
  let finished = false;
  let winner = null;
  let sawDamage = false;
  let identicalResults = true;
  let lastRoomA = null;
  let lastRoomB = null;
  const MAX_TURNS = 40;

  for (let i = 0; i < MAX_TURNS && !finished; i++) {
    // Decide P1's move from its authoritative energy (read from latest state).
    const p1E = lastRoomA ? lastRoomA.energy['1'] : startA.room.energy['1'];
    const p2E = lastRoomB ? lastRoomB.energy['2'] : startB.room.energy['2'];

    const p1Move = p1E >= 3 ? 'special' : 'charge';
    const p2Move = 'charge';

    a.send('submitAction', { move: p1Move, turn: currentTurn });
    b.send('submitAction', { move: p2Move, turn: currentTurn });

    const resA = await a.waitFor('turnResult');
    const resB = await b.waitFor('turnResult');

    // The revealed actions & resolved after-state must match on both clients.
    if (JSON.stringify(resA.result.after) !== JSON.stringify(resB.result.after)
        || JSON.stringify(resA.result.actions) !== JSON.stringify(resB.result.actions)) {
      identicalResults = false;
    }

    const before2 = resA.result.before.hp['2'];
    const after2 = resA.result.after.hp['2'];
    if (after2 < before2) sawDamage = true;

    lastRoomA = resA.room;
    lastRoomB = resB.room;
    finished = resA.result.finished;
    winner = resA.result.winner;
    currentTurn = resA.result.nextTurn;
  }

  check('both clients received identical resolved turn results', identicalResults);
  check('波動拳 dealt damage to the opponent (server-resolved)', sawDamage);
  check('game finished with a winner within turn budget', finished === true);
  check('winner is player 1 (P2 HP reached 0)', winner === 1);
  check('final authoritative HP for loser (P2) is 0',
    lastRoomA && lastRoomA.hp['2'] === 0);

  // --- Rematch resets state ---
  a.send('rematch');
  const rematchA = await a.waitFor('rematchStart');
  const rematchB = await b.waitFor('rematchStart');
  check('rematch resets HP to 3/3 for both',
    rematchA.room.hp['1'] === 3 && rematchA.room.hp['2'] === 3
    && rematchB.room.hp['1'] === 3 && rematchB.room.hp['2'] === 3);

  // --- Play to a finish again so we can test "change characters" ---
  {
    let fin = false, lrA = rematchA.room, lrB = rematchB.room, turn = rematchA.room.turn;
    for (let i = 0; i < 40 && !fin; i++) {
      const p1Move = lrA.energy['1'] >= 3 ? 'special' : 'charge';
      a.send('submitAction', { move: p1Move, turn });
      b.send('submitAction', { move: 'charge', turn });
      const rA = await a.waitFor('turnResult');
      await b.waitFor('turnResult');
      lrA = rA.room; fin = rA.result.finished; turn = rA.result.nextTurn;
    }
    check('second game also finishes (pre-condition for change chars)', fin === true);
  }

  // --- Change characters: room resets to charselect, characters cleared ---
  a.send('changeCharacters');
  const csA = await a.waitFor('charSelectReset');
  const csB = await b.waitFor('charSelectReset');
  check('changeCharacters resets both clients to charselect',
    csA.room.status === 'charselect' && csB.room.status === 'charselect');
  check('changeCharacters clears both chosen characters',
    csA.room.chars['1'] === null && csA.room.chars['2'] === null);
  check('changeCharacters resets HP to 3/3',
    csA.room.hp['1'] === 3 && csA.room.hp['2'] === 3);
  // Re-pick and confirm the game can start again.
  a.send('selectCharacter', { charId: 'blaze' });
  b.send('selectCharacter', { charId: 'angel' });
  const restart = await a.waitFor('battleStart');
  check('can start a new match with new characters after change',
    restart.room.status === 'playing' && restart.room.chars['1'] === 'blaze');

  // --- New rules: メガブラスト (unguardable, 2 dmg) ---
  {
    const r = String(Math.floor(1000 + Math.random() * 9000));
    const x = new Client('R1'); await x.open();
    const y = new Client('R2'); await y.open();
    x.send('createRoom', { roomId: r }); await x.waitFor('roomCreated');
    y.send('joinRoom', { roomId: r }); await y.waitFor('roomJoined'); await x.waitFor('roomJoined');
    x.send('selectCharacter', { charId: 'hadou' });
    y.send('selectCharacter', { charId: 'hadou' });
    const sx = await x.waitFor('battleStart'); await y.waitFor('battleStart');
    let turn = sx.room.turn;
    // Charge twice -> 2 energy each.
    for (let i = 0; i < 2; i++) {
      x.send('submitAction', { move: 'charge', turn });
      y.send('submitAction', { move: 'charge', turn });
      const rr = await x.waitFor('turnResult'); await y.waitFor('turnResult');
      turn = rr.result.nextTurn;
    }
    // P1 megablast vs P2 guard -> unguardable, P2 takes 2 dmg.
    x.send('submitAction', { move: 'megablast', turn });
    y.send('submitAction', { move: 'guard', turn });
    const rx = await x.waitFor('turnResult'); await y.waitFor('turnResult');
    check('megablast is unguardable and deals 1 damage',
      rx.result.after.hp['2'] === rx.result.before.hp['2'] - 1);
    x.close(); y.close();
  }

  // --- New rules: blast vs megablast clash (both survive) ---
  {
    const r = String(Math.floor(1000 + Math.random() * 9000));
    const x = new Client('C1'); await x.open();
    const y = new Client('C2'); await y.open();
    x.send('createRoom', { roomId: r }); await x.waitFor('roomCreated');
    y.send('joinRoom', { roomId: r }); await y.waitFor('roomJoined'); await x.waitFor('roomJoined');
    x.send('selectCharacter', { charId: 'hadou' });
    y.send('selectCharacter', { charId: 'hadou' });
    const sx = await x.waitFor('battleStart'); await y.waitFor('battleStart');
    let turn = sx.room.turn;
    for (let i = 0; i < 2; i++) {
      x.send('submitAction', { move: 'charge', turn });
      y.send('submitAction', { move: 'charge', turn });
      const rr = await x.waitFor('turnResult'); await y.waitFor('turnResult');
      turn = rr.result.nextTurn;
    }
    x.send('submitAction', { move: 'blast', turn });
    y.send('submitAction', { move: 'megablast', turn });
    const rx = await x.waitFor('turnResult'); await y.waitFor('turnResult');
    check('blast vs megablast clash (no damage to either)',
      rx.result.clash === true &&
      rx.result.after.hp['1'] === rx.result.before.hp['1'] &&
      rx.result.after.hp['2'] === rx.result.before.hp['2']);
    x.close(); y.close();
  }

  // --- Error handling: invalid room code is rejected ---
  const c = new Client('P3');
  await c.open();
  c.send('joinRoom', { roomId: 'abcd' });
  const err = await c.waitFor('error');
  check('invalid room code returns an error', err.type === 'error' && err.code === 'bad_room_code');
  c.close();

  // --- Disconnect frees the room code (comms-error scenario) ---
  // Create a room, then abruptly drop the socket (simulating a network error).
  // The server should tear the room down so the same code is reusable.
  const freeCode = String(Math.floor(1000 + Math.random() * 9000));
  const d1 = new Client('D1');
  await d1.open();
  d1.send('createRoom', { roomId: freeCode });
  await d1.waitFor('roomCreated');
  d1.ws.terminate ? d1.ws.terminate() : d1.close(); // hard drop = comms error
  await sleep(3000); // allow $disconnect to process + room deletion
  const d2 = new Client('D2');
  await d2.open();
  d2.send('createRoom', { roomId: freeCode });
  // If the room was freed, we get roomCreated (not a room_exists error).
  const reuse = await d2.waitFor((m) => m.type === 'roomCreated' || m.type === 'error');
  check('room code is reusable after a disconnect (room freed server-side)',
    reuse.type === 'roomCreated');
  d2.close();
} catch (e) {
  console.error('E2E error:', e && e.stack ? e.stack : e);
  check(`no unexpected exception (${e && e.message})`, false);
} finally {
  a.close();
  b.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ONLINE E2E summary: ${passed}/${results.length} checks passed ====`);
// Give sockets a moment to close.
await sleep(300);
if (passed !== results.length) process.exitCode = 1;
process.exit(process.exitCode || 0);
