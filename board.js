/* ============================================================================
   board.js  -  THE BOARD AND THE BALL (physics, no pictures, no sound)
   ============================================================================
   engine.js is the RULEBOOK (money and turns). board.js is the TABLE ITSELF: the pegs, the walls, the cups and the
   ball bouncing down. It uses Matter.js, the same physics library as the game page, with the same numbers, so the
   ball behaves the same way.

   WHY on the server? If every phone ran its own physics, each would drop a slightly different ball, and friends would
   disagree about where it landed. So ONE computer (the server) runs the physics, and everybody else just WATCHES
   the ball's position arrive 60 times a second. ANALOGY: one referee rolls the real dice; everyone else looks.

   HOW TO USE (the server does this):
       const board = Board.createBoard();     // builds the world
       board.setCups(board.newLayout());      // choose where the cups go
       board.launch(0.5);                     // let the ball go from 50% along the top
       board.step();                          // move the world forward 1/60 of a second (call 60 times a second)
                                              // returns a list of things that happened: [{ type: "landed", fruit, cup }]
   ============================================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(require("matter-js")); }
  else { root.Board = factory(root.Matter); }
}(typeof self !== "undefined" ? self : this, function (Matter) {

  // ------ SETTINGS (the same numbers as the game page) ------
  const BOARD_WIDTH = 450, BOARD_HEIGHT = 640;   // CHANGED IN 15: 400 -> 450. Must match the page.
  const PEG_RADIUS = 6, PEG_ROWS = 4, PEG_SPACING = 50, FIRST_PEG_ROW_Y = 120, PEG_ROW_GAP = 45, PEG_BOUNCE = 0.2;
  const BALL_RADIUS = 9, BALL_BOUNCE = 0.5, GRAVITY = 1, BALL_AIR_RESISTANCE = 0.06;
  const BALL_CLEAR_FRAMES = 60;     // how long a landed ball sits in its cup (60 steps = 1 second)
  const ENTRY_MARGIN = 12;          // the ball enters this far from each side at most
  const LAUNCH_WOBBLE = 6;          // random sideways wobble at launch, in pixels
  const CUP_HEIGHT = 80, DIVIDER_WIDTH = 4;
  const WALL_PEGS_REMOVED_AT_BOTTOM = 0;
  const STEP_MS = 1000 / 60;        // how much game time one physics step covers
  // GAME SPEED: how many times faster than a 60-steps-a-second clock the game runs. The game page runs at this speed too (see GAME_SPEED
  // in the page), so a ball falls at the same pace online and offline. 2.4 is what a 144 Hz laptop screen gave the first versions.
  const GAME_SPEED = 2.0;
  // Fourteen cups (CHANGED IN 15: a second Star was added). The width follows the prize a little: the Bell and the Star are narrower.
  // Only the proportions matter (the cups are stretched to fill the board).
  const CUP_RECIPE = [
    { fruit: "Cherry",    count: 3, width: 34 },
    { fruit: "Peach",     count: 3, width: 34 },
    { fruit: "Pineapple", count: 2, width: 34 },
    { fruit: "Lemon",     count: 2, width: 34 },
    { fruit: "Star",      count: 2, width: 30 },
    { fruit: "Bell",      count: 2, width: 28 }
  ];

  // Where the pegs are. (The page and the server both need this: the server for physics, the page to draw them.)
  function pegPositions() {
    const list = [], wallYs = [];
    for (let row = 0; row < PEG_ROWS; row++) {
      const shift = (row % 2 === 0) ? 0 : PEG_SPACING / 2;
      const y = FIRST_PEG_ROW_Y + row * PEG_ROW_GAP;
      for (let x = shift + PEG_SPACING / 2; x < BOARD_WIDTH; x += PEG_SPACING) { list.push({ x: x, y: y }); }
      if (shift !== 0) { wallYs.push(y); }
    }
    const keep = Math.max(0, wallYs.length - WALL_PEGS_REMOVED_AT_BOTTOM);
    for (let i = 0; i < keep; i++) { list.push({ x: 0, y: wallYs[i] }, { x: BOARD_WIDTH, y: wallYs[i] }); }   // half pegs on the walls
    return list;
  }

  function powerToX(p) { return ENTRY_MARGIN + p * (BOARD_WIDTH - 2 * ENTRY_MARGIN); }

  // A new random cup layout: [{ fruit, left, right }, ...] left to right, no two neighbours the same, filling the board.
  function newLayout(rng) {
    rng = rng || Math.random;
    const slots = [];
    for (const item of CUP_RECIPE) { for (let n = 0; n < item.count; n++) { slots.push({ fruit: item.fruit, width: item.width }); } }
    function shuffle(list) { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = list[i]; list[i] = list[j]; list[j] = t; } }
    function sameNeighbours(list) { for (let i = 1; i < list.length; i++) { if (list[i].fruit === list[i - 1].fruit) return true; } return false; }
    do { shuffle(slots); } while (sameNeighbours(slots));
    let total = 0; for (const s of slots) { total += s.width; }
    const scale = BOARD_WIDTH / total;
    const cups = []; let x = 0;
    for (const s of slots) { const w = s.width * scale; cups.push({ fruit: s.fruit, left: x, right: x + w }); x += w; }
    return cups;
  }

  // ------ THE LIVE WORLD (needs Matter) ------
  function createBoard(rng) {
    rng = rng || Math.random;
    const Engine = Matter.Engine, Bodies = Matter.Bodies, Composite = Matter.Composite, Body = Matter.Body;
    const engine = Engine.create();
    engine.gravity.y = GRAVITY;
    Composite.add(engine.world, [
      Bodies.rectangle(-10, BOARD_HEIGHT / 2, 20, BOARD_HEIGHT * 2, { isStatic: true }),
      Bodies.rectangle(BOARD_WIDTH + 10, BOARD_HEIGHT / 2, 20, BOARD_HEIGHT * 2, { isStatic: true }),
      Bodies.rectangle(BOARD_WIDTH / 2, BOARD_HEIGHT + 10, BOARD_WIDTH, 20, { isStatic: true })
    ]);
    Composite.add(engine.world, pegPositions().map(function (p) {
      return Bodies.circle(p.x, p.y, PEG_RADIUS, { isStatic: true, restitution: PEG_BOUNCE });
    }));

    let cups = [], dividers = [];
    let ball = null, landed = false, landedSteps = 0, stuckSteps = 0;

    function setCups(layout) {
      for (const d of dividers) { Composite.remove(engine.world, d); }
      dividers = [];
      cups = layout;
      for (let i = 1; i < cups.length; i++) {
        const x = cups[i].left;
        dividers.push(Bodies.rectangle(x, BOARD_HEIGHT - CUP_HEIGHT / 2, DIVIDER_WIDTH, CUP_HEIGHT, { isStatic: true, restitution: 0.3 }));
        // The rounded top is half the divider's width. Any bigger and the narrow Star cup is too tight for the ball.
        dividers.push(Bodies.circle(x, BOARD_HEIGHT - CUP_HEIGHT, DIVIDER_WIDTH / 2, { isStatic: true, restitution: PEG_BOUNCE }));
      }
      Composite.add(engine.world, dividers);
    }

    function cupIndexAt(x) {
      for (let i = 0; i < cups.length; i++) { if (x >= cups[i].left && x < cups[i].right) return i; }
      return (x < 0) ? 0 : cups.length - 1;
    }

    function clear() {
      if (ball) { Composite.remove(engine.world, ball); }
      ball = null; landed = false; landedSteps = 0; stuckSteps = 0;
    }

    // Let a ball go. 'power' is 0 to 1 = how far along the top it starts. Does nothing if a ball is already in play.
    function launch(power) {
      if (ball) return false;
      const wobble = (rng() - 0.5) * 2 * LAUNCH_WOBBLE;
      ball = Bodies.circle(powerToX(power) + wobble, 40, BALL_RADIUS, {
        restitution: BALL_BOUNCE, friction: 0.001, frictionAir: BALL_AIR_RESISTANCE, density: 0.004
      });
      Composite.add(engine.world, ball);
      Body.setVelocity(ball, { x: (rng() - 0.5) * 1, y: 2 });
      landed = false; landedSteps = 0; stuckSteps = 0;
      return true;
    }

    // Shove the rolling ball sideways (the Tilt).
    function nudge(dx) {
      if (ball && !landed) { Body.setVelocity(ball, { x: ball.velocity.x + dx, y: ball.velocity.y }); }
    }

    // Move the world forward one step (1/60 second). Returns what happened: [] or [{ type: "landed", ... }] or [{ type: "cleared" }].
    function step() {
      const events = [];
      if (!ball) return events;
      Engine.update(engine, STEP_MS);
      if (!landed) {
        if (ball.position.y > BOARD_HEIGHT - BALL_RADIUS - 6 && ball.speed < 0.5) {
          landed = true;
          const index = cupIndexAt(ball.position.x);
          events.push({ type: "landed", cup: index, fruit: cups[index].fruit });
        } else {
          // Rescue a ball that is balanced on a peg and not moving.
          stuckSteps = (ball.speed < 0.1) ? stuckSteps + 1 : 0;
          if (stuckSteps > 90) { Body.setVelocity(ball, { x: (rng() - 0.5) * 3, y: -1 }); stuckSteps = 0; }
        }
      } else {
        landedSteps++;
        if (landedSteps > BALL_CLEAR_FRAMES) { clear(); events.push({ type: "cleared" }); }
      }
      return events;
    }

    return {
      setCups: setCups, newLayout: function () { return newLayout(rng); }, launch: launch, nudge: nudge, step: step, clear: clear,
      getCups: function () { return cups; },
      hasBall: function () { return ball !== null; },                          // a ball is on the board (rolling or sitting in a cup)
      isRolling: function () { return ball !== null && !landed; },
      position: function () { return ball ? { x: ball.position.x, y: ball.position.y } : null; }
    };
  }

  return {
    BOARD_WIDTH: BOARD_WIDTH, BOARD_HEIGHT: BOARD_HEIGHT, PEG_RADIUS: PEG_RADIUS, BALL_RADIUS: BALL_RADIUS,
    CUP_HEIGHT: CUP_HEIGHT, DIVIDER_WIDTH: DIVIDER_WIDTH, STEP_MS: STEP_MS, GAME_SPEED: GAME_SPEED, CUP_RECIPE: CUP_RECIPE,
    pegPositions: pegPositions, powerToX: powerToX, newLayout: newLayout, createBoard: createBoard
  };
}));
