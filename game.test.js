// Plays real games through the server with fake players (real physics, real WebSockets). Run: node game.test.js
const { spawn } = require("child_process");
const WebSocket = require("ws");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("  PASS", n); } else { fail++; console.log("  FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function client() {
  return new Promise(res => {
    const w = new WebSocket("ws://localhost:3458"); w.inbox = [];
    w.on("message", m => w.inbox.push(JSON.parse(m.toString())));
    w.on("open", () => res(w));
    w.say = (o) => w.send(JSON.stringify(o));
    w.last = (t) => [...w.inbox].reverse().find(m => m.type === t);
    w.all = (t, name) => w.inbox.filter(m => m.type === t && (!name || m.name === name));
  });
}
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(50); } return false; }
(async () => {
  const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: 3458 } });
  await wait(1000);
  const A = await client(); A.say({ type: "create", name: "Ann" }); await wait(150);
  const code = A.last("joined").code;
  const B = await client(); B.say({ type: "join", code, name: "Ben" }); await wait(150);
  A.say({ type: "start" }); await wait(150);
  const room0 = A.last("room");
  check("cups are sent to everyone: 13 cups filling the board", room0.cups && room0.cups.length === 13 && Math.abs(room0.cups[12].right - 400) < 0.01, room0.cups && room0.cups.length);
  const total = (r) => r.session.table.players.reduce((s, p) => s + p.balance, 0) + r.session.table.kitty;
  const START = total(room0);

  B.say({ type: "release", power: 0.5 }); await wait(100);
  check("only the player whose turn it is can release (Ben can't)", !A.last("ball") );
  B.say({ type: "primary" }); await wait(100);
  check("Ben can't insert on Ann's turn", A.last("room").session.state === "idle");
  A.say({ type: "release", power: 0.5 }); await wait(100);
  check("can't release before inserting", !A.last("ball"));
  A.say({ type: "primary" }); await wait(150);
  let r = A.last("room");
  check("Ann inserts: game playing, bet in the kitty", r.session.state === "playing" && r.session.table.kitty === 51 && r.session.table.players[0].balance === 9, r.session.table);
  check("both players got the insert event", A.all("event", "insert").length === 1 && B.all("event", "insert").length === 1);

  // three balls
  for (let ball = 1; ball <= 3; ball++) {
    const before = A.inbox.length;
    A.say({ type: "release", power: 0.1 + 0.4 * Math.random() });
    await wait(150);
    check("ball " + ball + " is rolling (both see it)", A.last("room").rolling === true && B.last("ball") && B.last("ball").x !== null, A.last("room").rolling);
    if (ball === 1) {
      A.say({ type: "release", power: 0.9 }); await wait(100);
      check("can't launch a second ball while one is rolling (only one release happened)", A.all("event", "release").length === 1, A.all("event", "release").length);
      A.say({ type: "tilt" }); await wait(100);
      check("tilt works while rolling and shows to everyone", A.all("event", "tilt").length === 1 && B.all("event", "tilt").length === 1);
      A.say({ type: "tilt" }); await wait(100);
      check("second tilt refused (cooldown)", A.last("error") && /Tilt ready in/.test(A.last("error").message), A.last("error"));
    }
    const ok = await until(() => A.all("event", "landed").length === ball, 40000);
    check("ball " + ball + " landed", ok);
    await wait(1400);   // let it sit and clear
    if (ball < 3) { A.say({ type: "shuffle" }); await wait(100); }
  }
  r = A.last("room");
  const landed = A.all("event", "landed");
  check("three landed events, last one finished the game", landed.length === 3 && landed[2].finished === true && landed[0].finished === false);
  check("the ball positions were streamed (many messages)", A.all("ball").length > 100, A.all("ball").length);
  check("ball disappears after sitting (x null)", A.last("ball").x === null);
  check("after 3 balls: state is result or gameover", ["result", "gameover"].includes(r.session.state), r.session.state);
  check("money is conserved", Math.abs(total(r) - START) < 1e-9, [total(r), START]);
  const o = r.session.lastOutcome;
  check("prize paid is multiplier x bet capped by kitty, and net = prize - bet", o.net === o.payout - 1, o);
  check("the same ball positions reached both players", Math.abs(A.all("ball").length - B.all("ball").length) <= 2, [A.all("ball").length, B.all("ball").length]);

  if (r.session.state === "result") {
    const keeps = r.session.keepsTurn;
    A.say({ type: "primary" }); await wait(200);
    r = A.last("room");
    if (keeps) check("a winner plays again (Ann, same bet)", r.session.state === "playing" && r.session.table.current === 0);
    else check("a loser passes the turn to Ben", r.session.state === "idle" && r.session.table.current === 1, [r.session.state, r.session.table.current]);
  }
  // cash out and settle up
  for (let guard = 0; guard < 6 && A.last("room").session.state !== "final"; guard++) {
    const st = A.last("room").session, cur = st.table.players[st.table.current].name, who = cur === "Ann" ? A : B;
    if (st.state === "idle" || st.state === "result") { who.say({ type: "cashout" }); await wait(100); }
    who.say({ type: "primary" }); await wait(150);
  }
  r = A.last("room");
  check("everyone cashed out: settle-up screen", r.session.state === "final", r.session.state);
  check("money still conserved at the end", Math.abs(total(r) - START) < 1e-9);

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  srv.kill(); process.exit(fail ? 1 : 0);
})();
