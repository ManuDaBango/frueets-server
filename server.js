/* ============================================================================
   server.js  -  STEP 12: THE TINY SERVER
   ============================================================================
   WHAT IS A SERVER? ANALOGY: a restaurant kitchen.
     * Your phone/laptop (the "client") is the diner. It sends an order and waits.
     * The server is the kitchen. It is a program that stays running, listens for orders, and sends back food.
     * An "address" (like https://frueets.onrender.com) is the restaurant's street address.
     * A "port" is which door of the building to knock on. (Render picks the door for us: process.env.PORT.)

   TWO KINDS OF CONVERSATION
     * HTTP is like posting a letter: you send a request, you get ONE reply, the conversation is over.
       A web page loading is HTTP. We use it for the front page and a "health check".
     * WebSocket is like a phone call that stays open: either side can speak at any moment.
       A multiplayer game needs this, because the server must be able to tell you "Ben's ball just landed"
       without you asking. We use the "ws" package for it.

   WHAT THIS STEP DOES (and nothing more, on purpose):
     1. Serves a small test page at "/" so you can check the server is alive from any browser.
     2. Accepts WebSocket connections and understands two messages:
          { type: "hello", name: "Manu" }   -> replies "welcome" and says how many people are connected
          { type: "demo" }                  -> plays one whole game using engine.js, the SAME rulebook the page uses,
                                               with random fruit, and sends back what happened.
     The demo proves the point of Step 11: the rulebook runs here, on the server, untouched.
   Steps 13 and 14 add rooms, turns and the shared ball. Run it on your own computer with:  node server.js
   ============================================================================ */

const http = require("http");               // built into Node: makes a web server
const { WebSocketServer } = require("ws");  // the package we installed with npm: the open phone line
const Rules = require("./engine.js");       // OUR rulebook (a file next to this one)

// The door to knock on. On Render, process.env.PORT is set for us. On your own computer there is none, so we use 3000.
const PORT = process.env.PORT || 3000;

// ---------- 1. HTTP: the front page and the health check ----------
const TEST_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Frueets server</title>
<body style="font-family:system-ui;max-width:520px;margin:24px auto;padding:0 16px">
<h2>Frueets server test</h2>
<p>If you can press the buttons below and see replies, the server and the phone line (WebSocket) both work.</p>
<input id="name" value="Manu" style="font-size:18px;padding:6px"> <button id="go" style="font-size:18px">Connect</button>
<button id="demo" style="font-size:18px" disabled>Play a demo game</button>
<pre id="log" style="background:#f3efff;padding:10px;border-radius:8px;white-space:pre-wrap"></pre>
<script>
  const log = (t) => { document.getElementById("log").textContent += t + "\\n"; };
  let socket = null;
  document.getElementById("go").onclick = () => {
    // "wss://" is the secure phone line (used when the page itself is https). "ws://" is the plain one (your own computer).
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(scheme + location.host);
    socket.onopen    = () => { log("connected"); socket.send(JSON.stringify({ type: "hello", name: document.getElementById("name").value })); document.getElementById("demo").disabled = false; };
    socket.onmessage = (e) => log("server says: " + e.data);
    socket.onclose   = () => log("disconnected");
  };
  document.getElementById("demo").onclick = () => socket.send(JSON.stringify({ type: "demo" }));
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

// ---------- 2. WebSocket: the open phone line ----------
// We attach the WebSocket server to the same HTTP server, so both share one door (one port).
const wss = new WebSocketServer({ server: httpServer });

const FRUIT_BAG = ["Cherry", "Cherry", "Cherry", "Peach", "Peach", "Pineapple", "Pineapple", "Lemon", "Star"];

// This function runs once for EVERY new person who connects. "socket" is the phone line to that one person.
wss.on("connection", function (socket) {
  socket.playerName = "Anonymous";
  console.log("someone connected. Now connected: " + wss.clients.size);

  // This runs every time THIS person sends us a message.
  socket.on("message", function (raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());       // messages are JSON text, e.g. {"type":"hello"}
    } catch (error) {
      return;                                     // not valid JSON: ignore it (never trust what arrives)
    }

    if (message.type === "hello") {
      // Keep the name short and plain: a stranger could send anything.
      socket.playerName = String(message.name || "Anonymous").slice(0, 12);
      send(socket, { type: "welcome", name: socket.playerName, connected: wss.clients.size });
    }

    if (message.type === "demo") {
      // Use the rulebook exactly as the page does: seat a player, bet, play 3 balls, see the result.
      const S = Rules.newSession([socket.playerName]);
      Rules.startGame(S);
      const dropped = [];
      for (let i = 0; i < Rules.BALLS_PER_GAME; i++) {
        const fruit = FRUIT_BAG[Math.floor(Math.random() * FRUIT_BAG.length)];
        dropped.push(fruit);
        Rules.ballLanded(S, fruit);
      }
      send(socket, {
        type: "demoResult",
        balls: dropped,
        label: S.lastOutcome.label,
        prize: S.lastOutcome.payout,
        youNowHave: Rules.me(S).balance,
        kittyNow: S.table.kitty
      });
    }
  });

  socket.on("close", function () {
    console.log("someone left. Now connected: " + wss.clients.size);
  });
});

// A helper so we don't repeat ourselves: turn an object into JSON text and send it down one phone line.
function send(socket, object) {
  if (socket.readyState === 1) {                  // 1 means "the line is open"
    socket.send(JSON.stringify(object));
  }
}

// Start listening: "open the restaurant doors".
httpServer.listen(PORT, function () {
  console.log("Frueets server listening on port " + PORT);
});
