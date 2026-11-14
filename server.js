/* ============================================================================
   server.js  -  STEP 13b: THE BALL (physics on the server)
   ============================================================================
   NEW IN THIS STEP (on top of the tiny server of Step 12):
     * ROOMS. A room is one table of friends. It has a 4-letter code (like KQWM). ANALOGY: a hotel with many
       meeting rooms. The code is the room number. People in room KQWM never see people in room ABCD.
     * Create / join / rejoin. A "token" is a secret ticket the server gives you when you join. Your browser keeps it,
       so if your phone drops the line you can come back as YOURSELF, not as a stranger. (The ticket is what makes
       "same code and same name" safe: someone else typing your name does not have your ticket.)
     * The HOST is whoever created the room. Only the host can press Start.
     * When the host starts, the server creates the game with engine.js (the rulebook) and sends everyone the state.
   NEW IN 13b: THE BALL. Each room owns a "board" (board.js: pegs, cups, Matter.js physics). When the player whose turn it is
   lets go of the spring, they send ONE number, the power. The SERVER drops the ball and runs the physics 60 times a second,
   sending everyone the ball's position as it falls: { type: "ball", x, y }. When it lands, the server tells the rulebook
   (engine.js), which pays the prize. ANALOGY: one referee rolls the dice in the middle of the table; everyone watches the same roll.
   Because the server decides everything, nobody can cheat by changing their own copy of the game.

   MESSAGES THE CLIENT CAN SEND (all JSON, always with a "type"):
     { type: "create", name }                     open a new room, you are the host
     { type: "join", code, name, token? }         join (or rejoin, if you pass your old token)
     { type: "start" }                            host only: begin the game
     { type: "bet", step: +1 or -1 }              change your bet (only on your turn, before inserting)
     { type: "primary" }                          the big overlay button: Insert / Play again / Pass / Settle up (your turn)
     { type: "release", power: 0..1 }             let go of the spring: drops the ball (your turn, game in progress)
     { type: "tilt" }                             nudge the rolling ball (your turn; rules decide if it is allowed)
     { type: "shuffle" }                          rearrange the cups between balls (once per ball)
     { type: "cashout" }                          leave the game and keep your money; mid-game the bet is forfeited (your turn, ball not rolling)
     { type: "leave" }                            leave the room
   MESSAGES THE SERVER SENDS BACK:
     { type: "joined", code, token, name, host }  once, just for you: keep the token!
     { type: "room", code, started, members, session, cups, rolling }   to everyone, whenever anything changes
     { type: "ball", x, y }                       60 times a second while a ball is moving (x is null when it disappears)
     { type: "event", name, ... }                 things to play a sound for: insert, release, landed, tilt, shuffle, pass, final
     { type: "error", message }
   ============================================================================ */

const http = require("http");               // built into Node: makes a web server
const crypto = require("crypto");           // built into Node: makes hard-to-guess random tokens
const { WebSocketServer } = require("ws");  // the package we installed with npm: the open phone line
const Rules = require("./engine.js");       // OUR rulebook: money and turns (a file next to this one)
const Board = require("./board.js");        // OUR table: pegs, cups and the ball (needs the matter-js package)

// The door to knock on. On Render, process.env.PORT is set for us. On your own computer there is none, so we use 3000.
const PORT = process.env.PORT || 3000;

// ---------- 1. HTTP: the front page and the health check ----------
const TEST_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Frueets server</title>
<body style="font-family:system-ui;max-width:560px;margin:24px auto;padding:0 16px">
<h2>Frueets server test: rooms</h2>
<p>Open this page in two tabs. In tab 1: type a name and press <b>Create room</b>. In tab 2: type another name and the code, press <b>Join</b>. Then the host presses <b>Start</b>.</p>
<input id="name" value="Manu" size="9" style="font-size:18px;padding:6px">
<button id="create" style="font-size:18px">Create room</button>
<input id="code" placeholder="CODE" size="5" maxlength="4" style="font-size:18px;padding:6px;text-transform:uppercase">
<button id="join" style="font-size:18px">Join</button>
<button id="start" style="font-size:18px">Start</button>
<pre id="log" style="background:#f3efff;padding:10px;border-radius:8px;white-space:pre-wrap;font-size:13px"></pre>
<script>
  const log = (t) => { document.getElementById("log").textContent = t + "\\n" + document.getElementById("log").textContent; };
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  let socket = null;
  function connect(then) {
    socket = new WebSocket(scheme + location.host);
    socket.onopen = then;
    socket.onmessage = (e) => {
      const m = JSON.parse(e.data);
      // Keep our secret ticket in the browser so we can rejoin later.
      if (m.type === "joined") { localStorage.setItem("frueets-token-" + m.code, m.token); document.getElementById("code").value = m.code; }
      log(e.data);
    };
    socket.onclose = () => log("(disconnected)");
  }
  const name = () => document.getElementById("name").value;
  const code = () => document.getElementById("code").value.toUpperCase();
  document.getElementById("create").onclick = () => connect(() => socket.send(JSON.stringify({ type: "create", name: name() })));
  document.getElementById("join").onclick = () => connect(() => socket.send(JSON.stringify({ type: "join", code: code(), name: name(), token: localStorage.getItem("frueets-token-" + code()) || undefined })));
  document.getElementById("start").onclick = () => socket.send(JSON.stringify({ type: "start" }));
</script>`;

// This function runs once for EVERY request that arrives (every "letter").
const httpServer = http.createServer(function (request, response) {
  if (request.url === "/health") {
    // Render pings this address now and then to check we are alive.
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(TEST_PAGE);
  }
});

// ---------- 2. ROOMS ----------
// "rooms" is the hotel's register: room code -> room.
//   room = { code, members: [ { token, name, socket, connected, host } ], S: the game rules state (or null until Start),
//            board: the physics table, reshuffleUsed, bank + lastTick (the physics clock), lastActive }
const rooms = new Map();

// Letters that can't be mistaken for each other when read out loud or typed on a phone (no I, no O).
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function makeRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) { code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]; }
  } while (rooms.has(code));                      // keep trying until we find a code nobody is using
  return code;
}

function cleanName(raw) {
  return String(raw || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 12);   // letters, numbers, a few symbols, 12 long at most
}

// What everyone is told about a room. (We never send tokens: those are secret.)
function roomView(room) {
  return {
    type: "room",
    code: room.code,
    started: room.S !== null,
    members: room.members.map(function (m) { return { name: m.name, connected: m.connected, host: m.host }; }),
    session: room.S,
    cups: room.board ? room.board.getCups() : null,           // where each fruit's cup is (left and right edge, in board pixels)
    rolling: room.board ? room.board.isRolling() : false
  };
}

// Tell everyone in the room the latest state.
function broadcast(room) {
  const view = roomView(room);
  for (const m of room.members) {
    if (m.connected) { send(m.socket, view); }
  }
  room.lastActive = Date.now();
}

// If the host has gone, the next person still connected becomes host.
function fixHost(room) {
  if (room.members.some(function (m) { return m.host && m.connected; })) return;
  for (const m of room.members) { m.host = false; }
  const next = room.members.find(function (m) { return m.connected; });
  if (next) { next.host = true; }
}

// Send one message to everyone in the room.
function tellAll(room, object) {
  for (const m of room.members) { if (m.connected) { send(m.socket, object); } }
}

// Is it this person's turn in a running game?
function isTheirTurn(room, member) {
  return room.S !== null && Rules.me(room.S).name === member.name;
}

// ---------- THE PHYSICS CLOCK ----------
// Every 10 ms we look at each room. If a ball is in play we work out how much real time has passed and advance the
// physics by that much, in equal 1/60-second steps (the same idea as the "fixed timestep" in the game page).
// Then we send everyone the ball's new position.
const TICK_MS = 10;
setInterval(function () {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.board || !room.board.hasBall()) { room.bank = 0; room.lastTick = now; continue; }
    room.bank += Math.min(now - room.lastTick, 100);          // never catch up more than 0.1 s in one go
    room.lastTick = now;
    let steps = 0;
    while (room.bank >= Board.STEP_MS && steps < 5 && room.board.hasBall()) {
      const events = room.board.step();
      room.bank -= Board.STEP_MS;
      steps++;
      for (const e of events) { onBoardEvent(room, e); }
    }
    const p = room.board.position();
    tellAll(room, p ? { type: "ball", x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 } : { type: "ball", x: null });
  }
}, TICK_MS);

// Something happened on the board (a ball landed in a cup, or its sitting time is over).
function onBoardEvent(room, e) {
  if (e.type === "landed") {
    const result = Rules.ballLanded(room.S, e.fruit);         // the rulebook counts the ball and, on the last one, pays the prize
    tellAll(room, { type: "event", name: "landed", fruit: e.fruit, cup: e.cup, finished: result.finished });
    broadcast(room);
  }
  // "cleared" needs no action: the next tick sends { type: "ball", x: null } and everyone's ball disappears.
}

// ---------- 4. WEBSOCKET: the open phone line ----------
// We attach the WebSocket server to the same HTTP server, so both share one door (one port).
const wss = new WebSocketServer({ server: httpServer });

// This function runs once for EVERY new person who connects. "socket" is the phone line to that one person.
wss.on("connection", function (socket) {
  socket.room = null;       // which room this line belongs to (once they join one)
  socket.member = null;     // which seat in that room

  socket.on("message", function (raw) {
    if (raw.length > 2000) return;                // nobody needs to send us a novel
    let message;
    try {
      message = JSON.parse(raw.toString());       // messages are JSON text, e.g. {"type":"join"}
    } catch (error) {
      return;                                     // not valid JSON: ignore it (never trust what arrives)
    }

    // ----- create a room -----
    if (message.type === "create") {
      if (socket.room) return fail(socket, "You are already in a room");
      const name = cleanName(message.name) || "Player 1";
      const room = { code: makeRoomCode(), members: [], S: null, board: null, reshuffleUsed: false, bank: 0, lastTick: Date.now(), lastActive: Date.now() };
      rooms.set(room.code, room);
      seat(socket, room, name, true);
      return;
    }

    // ----- join (or rejoin) a room -----
    if (message.type === "join") {
      if (socket.room) return fail(socket, "You are already in a room");
      const room = rooms.get(String(message.code || "").toUpperCase());
      if (!room) return fail(socket, "No room with that code");

      // REJOIN: the right token means "this is the same person as before", so give them their old seat back.
      const old = room.members.find(function (m) { return message.token && m.token === message.token; });
      if (old) {
        if (old.connected && old.socket !== socket) { old.socket.room = null; old.socket.member = null; old.socket.close(); }   // same person on a new phone: the old line is dropped
        old.socket = socket; old.connected = true;
        socket.room = room; socket.member = old;
        fixHost(room);
        send(socket, { type: "joined", code: room.code, token: old.token, name: old.name, host: old.host });
        broadcast(room);
        return;
      }

      if (room.S !== null) return fail(socket, "That game has already started. (To come back, use the same phone or browser you joined with.)");
      if (room.members.length >= Rules.MAX_PLAYERS) return fail(socket, "That room is full");
      let name = cleanName(message.name) || "Player " + (room.members.length + 1);
      let unique = name, n = 2;
      while (room.members.some(function (m) { return m.name.toLowerCase() === unique.toLowerCase(); })) { unique = name + " " + n; n++; }
      seat(socket, room, unique, false);
      return;
    }

    // Everything below needs you to be in a room.
    const room = socket.room;
    if (!room) return;

    // ----- the host starts the game -----
    if (message.type === "start") {
      if (!socket.member.host) return fail(socket, "Only the host can start");
      if (room.S !== null) return;
      const names = room.members.map(function (m) { return m.name; });
      room.S = Rules.newSession(names);           // the rulebook seats everyone, in joining order
      room.board = Board.createBoard();           // and the table is built
      room.board.setCups(room.board.newLayout());
      broadcast(room);
      return;
    }

    // ----- change your bet (only on your own turn) -----
    if (message.type === "bet") {
      const S = room.S;
      if (!S || (S.state !== "idle" && S.state !== "result")) return;
      if (Rules.me(S).name !== socket.member.name) return;       // not your turn
      const step = message.step > 0 ? 1 : -1;
      if (Rules.changeBet(S, step)) { broadcast(room); }
      return;
    }

    // ----- everything from here on is in-game and only for the player whose turn it is -----
    const S = room.S;
    const mine = S !== null && isTheirTurn(room, socket.member);

    // ----- the big overlay button (same logic as the game page's primaryAction) -----
    if (message.type === "primary") {
      if (!S || room.board.hasBall() && room.board.isRolling()) return;
      if (!mine && !socket.member.host) return;                  // the host may also press it, so a stuck game can always move on
      if (S.state === "idle" || S.state === "result" && (S.keepsTurn || Rules.activePlayers(S).length <= 1)) {
        if (!mine) return;
        if (!Rules.startGame(S).ok) return;
        room.board.clear();
        room.board.setCups(room.board.newLayout());             // fresh cups every game
        room.reshuffleUsed = false;
        tellAll(room, { type: "event", name: "insert" });
      } else if (S.state === "result") {
        if (!Rules.advanceTurn(S)) return;
        tellAll(room, { type: "event", name: "pass" });
      } else if (S.state === "gameover") {
        if (Rules.activePlayers(S).length > 0) { Rules.advanceTurn(S); tellAll(room, { type: "event", name: "pass" }); }
        else { Rules.showFinal(S); tellAll(room, { type: "event", name: "final" }); }
      } else { return; }
      broadcast(room);
      return;
    }

    // ----- let go of the spring: the only thing the client sends is how far along the top the ball starts -----
    if (message.type === "release") {
      if (!mine || S.state !== "playing" || S.ballsLeft <= 0 || room.board.hasBall()) return;
      const power = Math.min(1, Math.max(0, Number(message.power) || 0));    // never trust the number: force it into 0..1
      room.board.launch(power);
      room.reshuffleUsed = false;
      room.lastTick = Date.now(); room.bank = 0;
      tellAll(room, { type: "event", name: "release", power: power });
      broadcast(room);
      return;
    }

    if (message.type === "tilt") {
      if (!mine) return;
      const t = Rules.useTilt(S, room.board.isRolling());       // the rulebook checks the rules and picks the direction and strength
      if (!t.ok) { if (t.reason) fail(socket, t.reason); return; }
      room.board.nudge(t.direction * t.strength);
      tellAll(room, { type: "event", name: "tilt" });
      broadcast(room);
      return;
    }

    if (message.type === "shuffle") {
      if (!mine || S.state !== "playing" || room.board.isRolling() || room.reshuffleUsed) return;
      room.board.setCups(room.board.newLayout());
      room.reshuffleUsed = true;
      tellAll(room, { type: "event", name: "shuffle" });
      broadcast(room);
      return;
    }

    if (message.type === "cashout") {
      // Allowed before inserting, after a game, or even mid-game between balls (the bet is already in the kitty, so it is forfeited).
      if (!mine || (S.state !== "idle" && S.state !== "result" && S.state !== "playing")) return;
      if (room.board.isRolling()) return;                      // wait for the ball to land
      room.board.clear();
      if (Rules.leaveTable(S).action === "left") { broadcast(room); }
      return;
    }

    if (message.type === "leave") { dropMember(socket, true); return; }
  });

  socket.on("close", function () { dropMember(socket, false); });
});

// Give a person a seat in a room and tell them (and everyone) about it.
function seat(socket, room, name, isHost) {
  const member = { token: crypto.randomBytes(12).toString("hex"), name: name, socket: socket, connected: true, host: isHost };
  room.members.push(member);
  socket.room = room;
  socket.member = member;
  send(socket, { type: "joined", code: room.code, token: member.token, name: name, host: isHost });   // only they get the token
  broadcast(room);
  console.log("room " + room.code + ": " + name + " joined (" + room.members.length + " in room, " + rooms.size + " rooms open)");
}

// Someone's line closed (or they chose to leave).
function dropMember(socket, onPurpose) {
  const room = socket.room, member = socket.member;
  if (!room || !member || member.socket !== socket) return;
  socket.room = null; socket.member = null;
  member.connected = false;
  // Before the game starts, leaving takes you off the list. Once it has started, your seat is kept so you can rejoin.
  if (room.S === null) { room.members.splice(room.members.indexOf(member), 1); }
  fixHost(room);
  broadcast(room);
  console.log("room " + room.code + ": " + member.name + " left");
}

// A helper so we don't repeat ourselves: turn an object into JSON text and send it down one phone line.
function send(socket, object) {
  if (socket.readyState === 1) {                  // 1 means "the line is open"
    socket.send(JSON.stringify(object));
  }
}
function fail(socket, message) { send(socket, { type: "error", message: message }); }

// Tidy up: every 10 minutes, close rooms where nobody is connected and nothing has happened for an hour.
setInterval(function () {
  for (const [code, room] of rooms) {
    const anyone = room.members.some(function (m) { return m.connected; });
    if (!anyone && Date.now() - room.lastActive > 60 * 60 * 1000) { rooms.delete(code); console.log("room " + code + " closed (empty)"); }
  }
}, 10 * 60 * 1000);

// Start listening: "open the restaurant doors".
httpServer.listen(PORT, function () {
  console.log("Frueets server listening on port " + PORT);
});
