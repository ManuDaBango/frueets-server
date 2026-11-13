/* ============================================================================
   server.js  -  STEP 13a: ROOMS AND THE LOBBY
   ============================================================================
   NEW IN THIS STEP (on top of the tiny server of Step 12):
     * ROOMS. A room is one table of friends. It has a 4-letter code (like KQWM). ANALOGY: a hotel with many
       meeting rooms. The code is the room number. People in room KQWM never see people in room ABCD.
     * Create / join / rejoin. A "token" is a secret ticket the server gives you when you join. Your browser keeps it,
       so if your phone drops the line you can come back as YOURSELF, not as a stranger. (The ticket is what makes
       "same code and same name" safe: someone else typing your name does not have your ticket.)
     * The HOST is whoever created the room. Only the host can press Start.
     * When the host starts, the server creates the game with engine.js (the rulebook) and sends everyone the state.
   NOT YET: the ball. Step 13b adds the physics so the server drops the ball and everyone watches the same one.

   MESSAGES THE CLIENT CAN SEND (all JSON, always with a "type"):
     { type: "create", name }                     open a new room, you are the host
     { type: "join", code, name, token? }         join (or rejoin, if you pass your old token)
     { type: "start" }                            host only: begin the game
     { type: "bet", step: +1 or -1 }              change your bet (only on your turn, before inserting)
     { type: "leave" }                            leave the room
   MESSAGES THE SERVER SENDS BACK:
     { type: "joined", code, token, name, host }  once, just for you: keep the token!
     { type: "room", code, started, members: [{ name, connected, host }], session }   to everyone, whenever anything changes
     { type: "error", message }
   ============================================================================ */

const http = require("http");               // built into Node: makes a web server
const crypto = require("crypto");           // built into Node: makes hard-to-guess random tokens
const { WebSocketServer } = require("ws");  // the package we installed with npm: the open phone line
const Rules = require("./engine.js");       // OUR rulebook (a file next to this one)

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
//   room = { code, members: [ { token, name, socket, connected, host } ], S: the game (or null until Start), lastActive }
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
    session: room.S
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

// ---------- 3. WEBSOCKET: the open phone line ----------
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
      const room = { code: makeRoomCode(), members: [], S: null, lastActive: Date.now() };
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
