// Starts the server and tests rooms with real WebSocket clients. Run: node rooms.test.js
const { spawn } = require("child_process");
const WebSocket = require("ws");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("  PASS", n); } else { fail++; console.log("  FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function client() {
  return new Promise(res => {
    const w = new WebSocket("ws://localhost:3457"); w.inbox = [];
    w.on("message", m => w.inbox.push(JSON.parse(m.toString())));
    w.on("open", () => res(w));
    w.say = (o) => w.send(JSON.stringify(o));
    w.last = (t) => [...w.inbox].reverse().find(m => m.type === t);
  });
}
(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: 3457 } });
  await wait(1000);
  const A = await client(); A.say({ type: "create", name: "Ann" }); await wait(150);
  const ja = A.last("joined");
  check("create gives a 4-letter code", /^[A-HJ-NP-Z]{4}$/.test(ja.code), ja);
  check("creator is host with a token", ja.host === true && ja.token.length === 24);
  const B = await client(); B.say({ type: "join", code: ja.code.toLowerCase(), name: "Ben" }); await wait(150);
  check("join works (code is case-insensitive)", B.last("joined") && B.last("joined").host === false);
  const C = await client(); C.say({ type: "join", code: ja.code, name: "Ben" }); await wait(150);
  check("duplicate name becomes 'Ben 2'", C.last("joined").name === "Ben 2");
  const D = await client(); D.say({ type: "join", code: "ZZZZ", name: "X" }); await wait(100);
  check("unknown code is refused", D.last("error"));
  check("everyone sees 3 members", A.last("room").members.length === 3, A.last("room").members.length);
  check("tokens are never broadcast", !JSON.stringify(A.last("room")).includes(ja.token));
  B.say({ type: "start" }); await wait(100);
  check("non-host can't start", B.last("error") && !A.last("room").started);
  A.say({ type: "start" }); await wait(150);
  const room = A.last("room");
  check("host starts: session created with 3 players", room.started && room.session.table.players.length === 3 && room.session.state === "idle");
  check("players are Ann, Ben, Ben 2", room.session.table.players.map(p => p.name).join() === "Ann,Ben,Ben 2");
  B.say({ type: "bet", step: 1 }); await wait(100);
  check("bet change ignored when it isn't your turn", A.last("room").session.table.players[1].bet === 1);
  A.say({ type: "bet", step: 1 }); await wait(100);
  check("host bet change on own turn works", A.last("room").session.table.players[0].bet === 2);
  const E = await client(); E.say({ type: "join", code: ja.code, name: "Late" }); await wait(100);
  check("can't join after start without a token", E.last("error"));
  // rejoin: Ben's line drops, then he returns with his token
  const benToken = B.last("joined").token; B.close(); await wait(200);
  check("others see Ben disconnected", A.last("room").members.find(m => m.name === "Ben").connected === false);
  const B2 = await client(); B2.say({ type: "join", code: ja.code, name: "whoever", token: benToken }); await wait(150);
  check("rejoin with token gets the same seat back", B2.last("joined").name === "Ben" && A.last("room").members.find(m => m.name === "Ben").connected);
  const F = await client(); F.say({ type: "join", code: ja.code, name: "Ben" }); await wait(100);
  check("same name without the token can't steal the seat", F.last("error"));
  // host leaves: host passes on
  A.close(); await wait(200);
  check("host passes to someone still connected", B2.last("room").members.some(m => m.host && m.connected), B2.last("room").members);
  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  srv.kill(); process.exit(fail ? 1 : 0);
})();
