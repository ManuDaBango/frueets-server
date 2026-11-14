// Tests turn timers, skipping, chat and reactions. Uses short timers so it runs fast. Run: node social.test.js
const { spawn } = require("child_process");
const WebSocket = require("ws");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("  PASS", n); } else { fail++; console.log("  FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function client() {
  return new Promise(res => {
    const w = new WebSocket("ws://localhost:3459"); w.inbox = [];
    w.on("message", m => w.inbox.push(JSON.parse(m.toString())));
    w.on("open", () => res(w));
    w.say = (o) => w.send(JSON.stringify(o));
    w.last = (t) => [...w.inbox].reverse().find(m => m.type === t);
    w.all = (t, name) => w.inbox.filter(m => m.type === t && (!name || m.name === name));
  });
}
const cur = (w) => { const s = w.last("room").session; return s.table.players[s.table.current].name; };
(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: 3459, IDLE_MS: 700, GONE_MS: 350 } });
  await wait(1000);
  const A = await client(); A.say({ type: "create", name: "Ann" }); await wait(150);
  const code = A.last("joined").code;
  const B = await client(); B.say({ type: "join", code, name: "Ben" }); await wait(100);
  const C = await client(); C.say({ type: "join", code, name: "Cy" }); await wait(100);
  A.say({ type: "start" }); await wait(100);

  console.log("A. turn timer");
  check("timer is running and shown to clients", A.last("room").turnMsLeft > 0 && A.last("room").turnMsLeft <= 700, A.last("room").turnMsLeft);
  check("Ann starts", cur(A) === "Ann");
  await wait(1000);
  check("Ann idles: skipped to Ben", cur(A) === "Ben");
  check("everyone told 'skipped'", A.all("event", "skipped").length >= 1 && B.all("event", "skipped")[0].player === "Ann" && B.all("event", "skipped")[0].why === "timer");
  check("a skipped player stays in the rotation", A.last("room").session.table.players.every(p => p.active));
  await wait(2400);
  check("skipping keeps going round (everyone idle)", A.all("event", "skipped").length >= 3, A.all("event", "skipped").length);

  console.log("B. acting resets the clock");
  const now = cur(A), who = { Ann: A, Ben: B, Cy: C }[now];
  await wait(400);
  who.say({ type: "bet", step: 1 }); await wait(100);
  check("a bet change restarts the 700 ms timer", A.last("room").turnMsLeft > 550, A.last("room").turnMsLeft);

  console.log("C. host skip");
  const before = cur(A);
  B.say({ type: "skip" }); await wait(100);   // Ben is not host (unless host moved), Ann created the room
  check("non-host skip ignored", cur(A) === before || A.all("event", "skipped").filter(e => e.why === "host").length === 0);
  A.say({ type: "skip" }); await wait(100);
  check("host skip passes the turn", cur(A) !== before && A.all("event", "skipped").some(e => e.why === "host"), [before, cur(A)]);

  console.log("D. skipping mid-game forfeits the bet");
  // find whose turn, insert, then host skips
  const mover = { Ann: A, Ben: B, Cy: C }[cur(A)];
  mover.say({ type: "primary" }); await wait(100);
  const st = A.last("room").session;
  const total = (s) => s.table.players.reduce((x, p) => x + p.balance, 0) + s.table.kitty;
  check("game in progress", st.state === "playing");
  A.say({ type: "skip" }); await wait(100);
  const st2 = A.last("room").session;
  check("host skipped a player mid-game: next player idle, bet stays in the kitty", st2.state === "idle" && st2.table.kitty === st.table.kitty, [st2.state, st2.table.kitty, st.table.kitty]);
  check("money conserved after the forfeit", total(st2) === 10 * 3 + 50, total(st2));

  console.log("E. disconnected players get skipped faster");
  // Let it settle to a known player, then disconnect Cy and wait for the turn to reach Cy.
  C.close(); await wait(100);
  check("Cy shown as disconnected", A.last("room").members.find(m => m.name === "Cy").connected === false);
  let waited = 0; while (cur(A) !== "Cy" && waited < 4000) { A.say({ type: "skip" }); await wait(80); waited += 80; }
  const t0 = Date.now(); const n0 = A.all("event", "skipped").length;
  await until(() => A.all("event", "skipped").length > n0 && A.all("event", "skipped").slice(-1)[0].player === "Cy", 1500);
  const took = Date.now() - t0;
  check("Cy (offline) was skipped in about GONE_MS (350 ms), not IDLE_MS (700 ms)", took < 650, took);
  check("Cy still has a seat (can rejoin)", A.last("room").session.table.players.some(p => p.name === "Cy" && p.active));

  console.log("F. chat");
  A.say({ type: "chat", text: "  hello <b>all</b>  " }); await wait(100);
  check("chat reaches everyone, trimmed, with < and > removed", B.last("chat") && B.last("chat").text === "hello ball/b" && !/[<>]/.test(B.last("chat").text), B.last("chat"));
  check("chat carries the sender's name", B.last("chat").name === "Ann");
  await wait(800);
  A.say({ type: "chat", text: "x".repeat(500) }); await wait(100);
  check("long chat cut to 140 characters", A.last("chat").text.length === 140, A.last("chat").text.length);
  await wait(800);
  const nBefore = B.all("chat").length;
  for (let i = 0; i < 12; i++) A.say({ type: "chat", text: "spam " + i });
  await wait(300);
  check("chat flood is limited (12 sent very fast, at most 1 arrives)", B.all("chat").length - nBefore <= 1, B.all("chat").length - nBefore);
  await wait(800);
  const nEmpty = B.all("chat").length;
  A.say({ type: "chat", text: "   " }); await wait(100);
  check("empty chat ignored", B.all("chat").length === nEmpty);
  const D = await client(); D.say({ type: "join", code, name: "Dee" }); await wait(150);
  check("a stranger can't join a game that has started", D.last("error") && /already started/.test(D.last("error").message), D.last("error"));
  const tokB = B.last("joined").token; B.close(); await wait(100);
  const B2 = await client(); B2.say({ type: "join", code, name: "x", token: tokB }); await wait(200);
  check("rejoin sends recent chat", B2.last("chatHistory") && B2.last("chatHistory").messages.length >= 2, B2.last("chatHistory"));

  console.log("G. reactions");
  A.say({ type: "react", emoji: "\u{1F525}" }); await wait(100);
  check("allowed reaction reaches everyone", B2.last("react") && B2.last("react").emoji === "\u{1F525}" && B2.last("react").name === "Ann");
  const nr = B2.all("react").length;
  await wait(400); A.say({ type: "react", emoji: "<script>" }); A.say({ type: "react", emoji: "\u{1F4A9}" }); await wait(100);
  check("anything not on the allowed list is ignored", B2.all("react").length === nr);

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  srv.kill(); process.exit(fail ? 1 : 0);
  async function until(f, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await wait(20); } return false; }
})();
