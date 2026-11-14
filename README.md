# Game of Frueets: the server (Step 13b: the ball on the server)

This is a small Node server. It now has **rooms**: a host opens a room, gets a 4-letter code, friends join with the code, and the host starts the game (the server then creates it with `engine.js`, the rulebook). Anyone whose connection drops can come back to the same seat using the secret ticket (token) their browser kept.

**New in 13b:** the server now runs the ball physics (`board.js`, using Matter.js). The player whose turn it is sends one number (how far they pulled the spring) and the server drops the ball, streams its position to everyone 60 times a second, and tells the rulebook where it landed. One referee, everyone watches the same ball.

The server is tested but still has no pretty screen: that is Step 14, when the game page connects to it.

## The files, and how to read them (in this order)

| File | What it is | Analogy |
|---|---|---|
| `engine.js` | The rules: bets, kitty, prizes, turns, tilt, settle-up. No screen, no sound. | The rulebook in the box |
| `board.js` | The table: pegs, walls, cups, the ball, Matter.js physics. No pictures. | The table itself |
| `server.js` | Opens the doors, listens, answers. Uses `engine.js`. | The kitchen |
| `package.json` | The shopping list (`ws`) and the command to start (`npm start`). | The recipe card header |
| `package-lock.json` | The exact versions bought, so every computer gets the same. | The receipt |
| `game.test.js` | Plays a full game through the server with fake players. | A dress rehearsal |
| `rooms.test.js` | Starts the server and tests rooms with fake players. | A rehearsal before opening night |
| `.gitignore` | Tells Git not to upload `node_modules`. | "Don't pack the groceries" |

Read `server.js` top to bottom. Every part is commented. The four ideas in it:
- **`require(...)`** pulls in another file or package (`http` and `ws` for the doors, `engine.js` for the rules).
- **`httpServer`** answers "letters": the test page at `/` and a `/health` check.
- **`wss.on("connection", ...)`** runs once for each person who connects. `socket` is the phone line to that one person.
- **`socket.on("message", ...)`** runs each time that person speaks. We read the JSON, look at `type`, and reply.

## Try the rooms
Open the server's address (your Render address, or http://localhost:3000) in **two browser tabs**. Tab 1: type a name, press **Create room**. Tab 2: type another name, press **Join** (the code is already filled in, because both tabs share the same browser). Then press **Start** in tab 1. The log shows exactly what the server sends everyone.

To run the automatic tests: `node rooms.test.js` (17 checks) and `node game.test.js` (25 checks: a whole game with fake players and real physics, takes about 30 seconds).

## Try it on your own computer first

1. Install Node: https://nodejs.org (choose the LTS button). Restart your terminal afterwards.
2. Open a terminal in this folder (in File Explorer, click the address bar, type `powershell`, press Enter).
3. Run: `npm install` (downloads `ws` into a `node_modules` folder, one time).
4. Run: `npm start`. You should see `Frueets server listening on port 3000`.
5. Open http://localhost:3000 in your browser, press **Connect**, then **Play a demo game**.
6. Stop the server with Ctrl+C.

## Put it on Render

Render runs your server on a computer in a data centre and gives it a web address. It watches your GitHub repo and redeploys every time you push.

1. **Make a new GitHub repo** for this folder (a separate one from `alt108-site`, because this is a program, not a website). Suggested name: `frueets-server`. Push these files to it (not `node_modules`: `.gitignore` handles that).
2. In Render click **New +** then **Web Service**, and connect that repo.
3. Fill in:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install` (Render runs this once per deploy, like step 3 above)
   - **Start Command:** `npm start` (same as step 4 above)
   - **Instance type:** your paid plan (a paid instance doesn't fall asleep, which matters for a game)
   - **Health Check Path** (under Advanced): `/health`
4. Press **Create Web Service**. Watch the log: it ends with `Frueets server listening on port ...`. (The exact button names in Render may differ a little. The ideas are the same.)
5. Render shows the address, something like `https://frueets-server.onrender.com`. Open it, press Connect and Play a demo game. Same page, now on the internet.

Why `process.env.PORT`? Render decides which door your server must use and tells it through that setting. `server.js` reads it and falls back to 3000 on your own computer.

## What comes next
- **Step 13c:** turn timers and skipping (45 seconds idle, 20 seconds disconnected, host can skip), chat and emoji reactions.
- **Step 14:** the game page connects to this server, and the join links `www.alt108.com/frueets/?room=KQWM` start working.
