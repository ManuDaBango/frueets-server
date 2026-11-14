/* ============================================================================
   engine.js  -  THE RULES OF GAME OF FRUEETS (no pictures, no sounds, no physics)
   ============================================================================
   WHY a separate file?
   ANALOGY: think of a board game. The BOARD and PIECES (pegs, ball, cups, colours, sounds) are one thing.
   The RULEBOOK (who pays what, who wins what, whose turn it is) is another. The rulebook is just words and
   numbers: it doesn't care whether the pieces are shown on a phone, a laptop or a server far away.

   Keeping the rulebook in its own file means:
     * the page (browser) uses it to run a game on one device, exactly as before, and
     * later the SERVER (Node) uses the very same file as the referee for friends playing from different countries.
       One rulebook, two places: they can never disagree.

   HOW IT WORKS
   Everything about "where the game is up to" lives in one object, S (short for "session"):
     S.state       "home" | "idle" | "playing" | "result" | "gameover" | "final"
     S.table       { players: [...], current: index of whoever's turn it is, started: bool, kitty: dollars in the pool }
     S.results     fruits the current game's balls landed in, e.g. ["Cherry", "Star"]
     S.ballsLeft   balls not yet played in the current game
     S.keepsTurn   true when the game just finished was a win, so the same player goes again
     S.lastOutcome { label, payout, net, capped, wanted } for the game that just finished
     S.outcomeKind "jackpot" | "big" | "small" | "none"  (which jingle to play)
     S.endInfo     { title, line2, note } used when a player is out
   Each function below takes S, changes it, and returns a small note about what happened.
   Nothing here touches the screen, so it is easy to test with thousands of fake games.
   ============================================================================ */
(function (root, factory) {
  // "UMD wrapper": lets this one file work both as a browser <script> (it makes a global called Rules)
  // and as a Node module (require("./engine.js")). You can ignore this little shell.
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Rules = factory(); }
}(typeof self !== "undefined" ? self : this, function () {

  // ------------------------------------------------------------------------
  // SETTINGS (money and rules). These are the numbers you can change to experiment.
  // ------------------------------------------------------------------------
  const STARTING_BALANCE   = 10;   // dollars each new player starts with (their "stack")
  // CHANGED IN 14b: the kitty is now $20 for EVERY player (it used to be one $50 kitty shared out). So everyone buys in for
  // STARTING_BALANCE + KITTY_PER_PLAYER = $30: $10 to play with and $20 into the shared kitty. A table of 2 opens with a $40 kitty, 5 with $100.
  const KITTY_PER_PLAYER   = 20;
  const KITTY_START        = KITTY_PER_PLAYER;   // one player's share; the page shows this on the home screen (the old name is kept)
  const SETTLE_ROUND_CENTS = 10;   // settle-up payments are rounded to this many cents (the odd cents go to the biggest winner)
  const BET_MIN            = 1;    // smallest bet for one game
  const BET_MAX            = 5;    // biggest bet for one game
  const JACKPOT_MULTIPLIER = 50;   // three Stars pays this many times your bet, never more than the kitty holds
  const TILT_EVERY_GAMES   = 3;    // a player may use Tilt once in this many of their own games
  // CHANGED IN 14a: the tilt is about 3 times stronger (it was 1.6 and 3.6, which hardly moved the ball). Measured with the real physics:
  // pressed after the last pegs a small tilt moves the landing spot about 2 cups sideways, a large one about 3 to 4 cups. Pressed early,
  // among the pegs, the pegs scramble the ball again, so the result is unpredictable. (Speed added to the ball, in pixels per step.)
  const TILT_SMALL         = 4.5;  // sideways nudge for a small tilt
  const TILT_LARGE         = 9;    // sideways nudge for a large tilt
  const BALLS_PER_GAME     = 3;    // balls in one game
  const MAX_PLAYERS        = 5;    // most players at one table
  const SOUND_BIG_WIN_AT   = 12;   // a prize of this many dollars or more counts as "big" (picks the jingle)
  const KEEP_TURN_MIN_PAYOUT = 1;  // a game paying at least this many dollars keeps the turn. 9999 switches the rule off.

  // Prizes for a $1 bet. The real prize is the number x your bet (a $3 bet pays 3x).
  // CHANGED IN 14a: the Bell is back (it is the best fruit), and the prizes for combinations that use the wild Star are about
  // half of what they were. WHY: with 13 cups, a player who aims at the Star hits it about 1 ball in 6, and the old wild prizes returned
  // them $1.70 for every $1 bet, so the kitty would empty in no time. Now a player aiming at the Star gets back about $1.20 per $1
  // (skill pays, a little), and one who pulls at random about $0.62. (The old numbers are in the comments in case you want them back.)
  const PAYOUT_THREE     = { Cherry: 4, Peach: 6, Pineapple: 12, Lemon: 24, Bell: 36 };    // three of a kind
  const PAYOUT_WITH_STAR = { Cherry: 2, Peach: 3, Pineapple: 5,  Lemon: 10, Bell: 15 };    // two of a kind + one Star   (was 3, 5, 9, 18)
  const PAYOUT_TWO_STARS = { Cherry: 1, Peach: 2, Pineapple: 3,  Lemon: 6,  Bell: 9  };    // two Stars + one fruit     (was 2, 3, 6, 12)
  // Three Stars is the JACKPOT: JACKPOT_MULTIPLIER x your bet, capped at what the kitty holds.

  // ------------------------------------------------------------------------
  // STARTING A SESSION
  // ------------------------------------------------------------------------
  // The state of the machine before anyone has sat down (the home screen).
  function emptySession() {
    return {
      state: "home",
      table: { players: [], current: 0, started: false, kitty: 0 },
      results: [], ballsLeft: 0, keepsTurn: false,
      lastOutcome: { label: "", payout: 0, net: 0, capped: false, wanted: 0 },
      outcomeKind: "none",
      endInfo: { title: "", line2: "", note: "" }
    };
  }

  // Sit people down. "typed" is the list of names as typed (some may be empty).
  // Empty names become "Player" / "Player 2". Two people with the same name would share one scoreboard line,
  // so a repeated name gets a number ("Sam", "Sam 2").
  function newSession(typed) {
    const S = emptySession();
    const taken = {};
    for (let i = 0; i < typed.length; i++) {
      let name = String(typed[i]).trim();
      if (name === "") {
        name = (typed.length === 1) ? "Player" : "Player " + (i + 1);
      }
      let finalName = name;
      let n = 2;
      while (taken[finalName.toLowerCase()]) {
        finalName = name + " " + n;
        n = n + 1;
      }
      taken[finalName.toLowerCase()] = true;
      S.table.players.push({
        name: finalName,
        key: finalName.toLowerCase(),
        balance: STARTING_BALANCE,   // the player's stack
        bet: BET_MIN,                // remembered between games
        lastBet: BET_MIN,            // what the game in progress (or just finished) was played at
        tiltWait: 0,                 // games to wait before Tilt is ready again (0 = ready)
        biggestWin: 0,
        active: true,                // false once the player is out of the rotation (out of money, or cashed out)
        putIn: STARTING_BALANCE + KITTY_PER_PLAYER,   // everything this player has paid in: grows by STARTING_BALANCE with each top-up
        topUps: 0,                   // how many times the host has added a stack for this player
        wantsTopUp: false,           // true while the player is asking the host for more money
        cashedOut: false,            // true once the player has taken their money and left the pool
        takeHome: 0                  // what they took when they cashed out (only meaningful if cashedOut)
      });
    }
    S.table.kitty = KITTY_PER_PLAYER * S.table.players.length;     // $20 for each player who sits down
    S.state = "idle";
    return S;
  }

  // ------------------------------------------------------------------------
  // LOOKING AT THE TABLE
  // ------------------------------------------------------------------------
  function me(S) { return S.table.players[S.table.current]; }          // whose turn it is
  function activePlayers(S) { return S.table.players.filter(function (p) { return p.active; }); }

  // Index of the next active player after the current one, going round the table. -1 if nobody is left.
  function nextActiveIndex(S) {
    const count = S.table.players.length;
    for (let step = 1; step <= count; step++) {
      const index = (S.table.current + step) % count;
      if (S.table.players[index].active) { return index; }
    }
    return -1;
  }

  // ------------------------------------------------------------------------
  // BETS
  // ------------------------------------------------------------------------
  // A bet can never be more than the player holds, or outside BET_MIN..BET_MAX.
  function clampBet(player) {
    const most = Math.min(BET_MAX, Math.floor(player.balance));
    player.bet = Math.max(BET_MIN, Math.min(player.bet, most));
  }

  // Raise or lower the current player's bet by 'step' dollars. Returns true if it actually changed.
  function changeBet(S, step) {
    const who = me(S);
    const before = who.bet;
    who.bet = who.bet + step;
    clampBet(who);
    return who.bet !== before;
  }

  // ------------------------------------------------------------------------
  // PLAYING A GAME
  // ------------------------------------------------------------------------
  // The bet moves from the player's stack into the kitty and the game begins.
  // Returns { ok: false } if the player can't afford it, otherwise { ok: true, firstGame: bool }.
  function startGame(S) {
    const who = me(S);
    clampBet(who);
    if (who.balance < who.bet) { return { ok: false }; }

    const firstGame = !S.table.started;
    who.balance = who.balance - who.bet;               // the bet moves from the stack...
    S.table.kitty = S.table.kitty + who.bet;           // ...into the kitty
    S.table.started = true;
    who.lastBet = who.bet;

    S.ballsLeft = BALLS_PER_GAME;
    S.results = [];
    S.keepsTurn = false;
    S.state = "playing";
    return { ok: true, firstGame: firstGame };
  }

  function plural(fruitName) {
    if (fruitName === "Cherry") return "Cherries";
    if (fruitName === "Peach")  return "Peaches";
    return fruitName + "s";
  }

  // What do these fruits win? Returns the prize as a MULTIPLIER of the bet, or { jackpot: true }.
  function evaluateGame(fruits) {
    const stars  = fruits.filter(function (f) { return f === "Star"; }).length;
    const others = fruits.filter(function (f) { return f !== "Star"; });

    if (stars === 3) {
      return { jackpot: true, label: "THREE STARS!" };
    }
    if (stars === 2) {
      return { mult: PAYOUT_TWO_STARS[others[0]], label: "Two Stars + " + others[0] };
    }
    const first = others[0];
    const allSame = others.every(function (f) { return f === first; });
    if (allSame) {
      if (stars === 0) {
        return { mult: PAYOUT_THREE[first], label: "Three " + plural(first) + "!" };
      }
      return { mult: PAYOUT_WITH_STAR[first], label: "Wild Star + " + first };
    }
    return { mult: 0, label: "No match" };
  }

  // A ball has landed in a cup of this fruit. Returns { finished: bool }.
  function ballLanded(S, fruitName) {
    S.results.push(fruitName);
    S.ballsLeft = S.ballsLeft - 1;
    if (S.results.length >= BALLS_PER_GAME) {
      finishGame(S);
      return { finished: true };
    }
    return { finished: false };
  }

  // All the balls are in: work out the prize and pay it out of the kitty.
  function finishGame(S) {
    const who = me(S);
    const multi = S.table.players.length > 1;          // wording: "You are out" for one player, "Priya is out" for several
    const outcome = evaluateGame(S.results);
    const bet = who.lastBet;

    // THE POOL RULE: the prize is paid out of the kitty, so it can never be more than the kitty holds.
    const wanted = outcome.jackpot ? JACKPOT_MULTIPLIER * bet : outcome.mult * bet;
    const payout = Math.min(wanted, S.table.kitty);
    S.table.kitty = S.table.kitty - payout;
    who.balance = who.balance + payout;
    who.biggestWin = Math.max(who.biggestWin, payout);

    S.lastOutcome = { label: outcome.label, payout: payout, net: payout - bet, capped: payout < wanted, wanted: wanted };
    S.keepsTurn = (payout >= KEEP_TURN_MIN_PAYOUT);    // a real win means you play again (a jackpot too)
    if (who.tiltWait > 0) { who.tiltWait = who.tiltWait - 1; }

    if (outcome.jackpot)                    { S.outcomeKind = "jackpot"; }
    else if (payout >= SOUND_BIG_WIN_AT)    { S.outcomeKind = "big"; }
    else if (payout > 0)                    { S.outcomeKind = "small"; }
    else                                    { S.outcomeKind = "none"; }

    if (who.balance < BET_MIN) {
      // Out of money: out of the rotation (for now).
      S.endInfo = {
        title: "Out of money!",
        line2: (multi ? who.name + " is out" : "You are out") + " with " + moneyText(who.balance),
        note: ""
      };
      who.active = false;
      S.keepsTurn = false;
      S.state = "gameover";
    } else {
      S.state = "result";
    }
  }

  // Hand the turn to the next player who is still in. Returns false if nobody is left.
  function advanceTurn(S) {
    const next = nextActiveIndex(S);
    if (next === -1) { return false; }
    S.table.current = next;
    clampBet(me(S));                                   // their remembered bet, but never more than they hold
    S.results = [];
    S.keepsTurn = false;
    S.ballsLeft = 0;
    S.state = "idle";
    return true;
  }

  // Everyone is finished: show the settle-up.
  function showFinal(S) {
    S.state = "final";
  }

  // CASHING OUT (CHANGED IN 14b). A player may cash out at any time, on anyone's turn. They take their stack PLUS an equal share of
  // the kitty as it is right now (like cashing in chips at a poker table), and leave the pool. Their result is locked in.
  // The kitty shrinks by the share they took, so the players who stay keep their own shares.
  // If it was this player's turn the game ends for them ("gameover" screen, then the turn moves on). A game in progress is forfeited:
  // its bet is already in the kitty and stays there.
  function poolPlayers(S) { return S.table.players.filter(function (p) { return !p.cashedOut; }); }

  function cashOut(S, index) {
    const who = S.table.players[index];
    if (!who || who.cashedOut || S.state === "home" || S.state === "final") { return { ok: false }; }
    const multi = S.table.players.length > 1;
    const wasCurrent = (index === S.table.current);
    const forfeited = wasCurrent && (S.state === "playing");
    const share = S.table.kitty / poolPlayers(S).length;     // equal share among everyone still in the pool (this player included)
    S.table.kitty = S.table.kitty - share;
    who.takeHome = who.balance + share;
    who.balance = 0;                                         // the money has left the table
    who.cashedOut = true;
    who.active = false;
    who.wantsTopUp = false;
    const net = who.takeHome - who.putIn;
    if (wasCurrent) {
      S.endInfo = {
        title: multi ? "Cashed out" : "Game ended",
        line2: (multi ? who.name + " cashes out" : "You cash out") + " with " + moneyText(who.takeHome),
        note: forfeited ? "(The game in progress was forfeited)" : ""
      };
      S.keepsTurn = false;
      S.state = "gameover";
    }
    return { ok: true, wasCurrent: wasCurrent, forfeited: forfeited, takeHome: who.takeHome, net: net };
  }

  // The current player leaves the rotation ("End game" / "Cash out"), used by the one-player game.
  // Returns { action: "none" }   nothing to do (already finished),
  //         { action: "home" }   nobody has put a coin in yet, so just go back to the home screen,
  //         { action: "left", forfeited: bool, net: dollars to put on the scoreboard (0 if nothing was forfeited) }.
  function leaveTable(S) {
    if (S.state === "home" || S.state === "gameover" || S.state === "final") { return { action: "none" }; }
    if (S.state === "idle" && !S.table.started) { return { action: "home" }; }
    const lastBet = me(S).lastBet;
    const r = cashOut(S, S.table.current);
    if (!r.ok) { return { action: "none" }; }
    return { action: "left", forfeited: r.forfeited, net: r.forfeited ? -lastBet : 0 };
  }

  // TOP-UP: the host adds one more starting stack to a player (for example after a big bet lost them everything).
  // It is new money from that player's pocket, so it is added to what they have paid in; the settle-up counts it.
  function requestTopUp(S, index) {
    const p = S.table.players[index];
    if (!p || p.cashedOut || S.state === "final" || S.state === "home") { return { ok: false }; }
    if (p.balance >= BET_MIN) { return { ok: false }; }          // only for someone who cannot afford a bet
    p.wantsTopUp = true;
    return { ok: true };
  }
  function topUp(S, index) {
    const p = S.table.players[index];
    if (!p || p.cashedOut || S.state === "final" || S.state === "home") { return { ok: false }; }
    p.balance = p.balance + STARTING_BALANCE;
    p.putIn = p.putIn + STARTING_BALANCE;
    p.topUps = p.topUps + 1;
    p.wantsTopUp = false;
    p.active = true;                                             // back in the rotation
    clampBet(p);
    return { ok: true };
  }

  // SKIPPING a player who is away or too slow. Unlike leaving, a skipped player STAYS in the rotation (their seat and money
  // are kept) and gets their turn again when it comes round. If they were in the middle of a game, that game is forfeited:
  // the bet is already in the kitty, so it stays there. Returns { ok: false } if there is nobody to hand the turn to.
  function skipTurn(S) {
    if (S.state === "home" || S.state === "gameover" || S.state === "final") { return { ok: false }; }
    if (activePlayers(S).length <= 1) { return { ok: false }; }
    const who = me(S);
    const forfeited = (S.state === "playing");
    advanceTurn(S);
    return { ok: true, name: who.name, forfeited: forfeited };
  }

  // ------------------------------------------------------------------------
  // TILT (once every TILT_EVERY_GAMES of a player's own games)
  // ------------------------------------------------------------------------
  // 'ballRolling' is something only the physics knows, so the caller tells us.
  function canTilt(S, ballRolling) {
    return S.state === "playing" && ballRolling && me(S).tiltWait === 0;
  }
  // Uses up the player's tilt and says what shove to give the ball: { ok: true, direction: -1 or 1, strength }.
  // 'rng' is a function giving random numbers between 0 and 1 (Math.random by default; tests can pass their own).
  function useTilt(S, ballRolling, rng) {
    rng = rng || Math.random;
    if (S.state !== "playing") { return { ok: false, reason: "" }; }
    if (!ballRolling) { return { ok: false, reason: "Tilt works while the ball is rolling" }; }
    const who = me(S);
    if (who.tiltWait > 0) {
      return { ok: false, reason: "Tilt ready in " + who.tiltWait + (who.tiltWait === 1 ? " game" : " games") };
    }
    who.tiltWait = TILT_EVERY_GAMES;
    return { ok: true, direction: (rng() < 0.5) ? -1 : 1, strength: (rng() < 0.5) ? TILT_SMALL : TILT_LARGE };
  }

  // ------------------------------------------------------------------------
  // THE SETTLE-UP (CHANGED IN 14b)
  // ------------------------------------------------------------------------
  // Everyone paid in "putIn" ($10 stack + $20 for the kitty, plus any top-ups). A player who cashed out already took their
  // money; everyone still in the pool takes their stack plus an equal share of what is left in the kitty.
  // Each player's NET is what they take home minus what they paid in. The nets add up to zero, so the settle-up is just
  // "who pays whom": the biggest loser pays the biggest winner, and so on, until everyone is square.
  function settle(S) {
    const pool = poolPlayers(S);
    const share = pool.length > 0 ? S.table.kitty / pool.length : 0;
    const rows = S.table.players.map(function (p) {
      const takeHome = p.cashedOut ? p.takeHome : p.balance + share;
      return { name: p.name, stack: p.cashedOut ? null : p.balance, cashedOut: p.cashedOut, topUps: p.topUps, putIn: p.putIn,
               takeHome: takeHome, net: takeHome - p.putIn };
    });
    // work in whole cents, rounded to SETTLE_ROUND_CENTS; any leftover cents go to the biggest winner so the nets still add to zero
    const cents = rows.map(function (r) { return Math.round(r.net * 100 / SETTLE_ROUND_CENTS) * SETTLE_ROUND_CENTS; });
    let leftover = cents.reduce(function (t, c) { return t + c; }, 0);
    if (leftover !== 0) {
      let best = 0;
      for (let i = 1; i < cents.length; i++) { if (cents[i] > cents[best]) { best = i; } }
      cents[best] = cents[best] - leftover;
    }
    rows.forEach(function (r, i) { r.netRounded = cents[i] / 100; });
    // who pays whom (greedy: biggest debtor pays biggest creditor)
    const owe = cents.map(function (c, i) { return { i: i, c: c }; });
    const payments = [];
    for (let guard = 0; guard < 50; guard++) {
      owe.sort(function (a, b) { return a.c - b.c; });
      const debtor = owe[0], creditor = owe[owe.length - 1];
      if (debtor.c >= 0 || creditor.c <= 0) { break; }
      const amount = Math.min(-debtor.c, creditor.c);
      payments.push({ from: rows[debtor.i].name, to: rows[creditor.i].name, amount: amount / 100 });
      debtor.c += amount; creditor.c -= amount;
    }
    rows.sort(function (a, b) { return b.net - a.net; });
    return { share: share, kitty: S.table.kitty, poolCount: pool.length, rows: rows, payments: payments };
  }

  // Dollars as text for the engine's own messages ("$8" or "$8.33"). The page has its own copy for the screen.
  function moneyText(amount) {
    const v = Math.round(amount * 100) / 100;
    return "$" + (Number.isInteger(v) ? v : v.toFixed(2));
  }

  return {
    STARTING_BALANCE: STARTING_BALANCE, KITTY_START: KITTY_START, KITTY_PER_PLAYER: KITTY_PER_PLAYER, BET_MIN: BET_MIN, BET_MAX: BET_MAX,
    JACKPOT_MULTIPLIER: JACKPOT_MULTIPLIER, TILT_EVERY_GAMES: TILT_EVERY_GAMES, TILT_SMALL: TILT_SMALL,
    TILT_LARGE: TILT_LARGE, BALLS_PER_GAME: BALLS_PER_GAME, MAX_PLAYERS: MAX_PLAYERS,
    SOUND_BIG_WIN_AT: SOUND_BIG_WIN_AT, KEEP_TURN_MIN_PAYOUT: KEEP_TURN_MIN_PAYOUT,
    PAYOUT_THREE: PAYOUT_THREE, PAYOUT_WITH_STAR: PAYOUT_WITH_STAR, PAYOUT_TWO_STARS: PAYOUT_TWO_STARS,
    emptySession: emptySession, newSession: newSession, me: me, activePlayers: activePlayers,
    nextActiveIndex: nextActiveIndex, clampBet: clampBet, changeBet: changeBet, startGame: startGame,
    evaluateGame: evaluateGame, ballLanded: ballLanded, advanceTurn: advanceTurn, showFinal: showFinal,
    leaveTable: leaveTable, cashOut: cashOut, poolPlayers: poolPlayers, topUp: topUp, requestTopUp: requestTopUp, skipTurn: skipTurn, canTilt: canTilt, useTilt: useTilt, settle: settle, plural: plural
  };
}));
