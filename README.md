# Chess with Claude

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen?logo=node.js&logoColor=white" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencies-1%20(chess.js)-blue" alt="One dependency: chess.js">
  <img src="https://img.shields.io/badge/runs-100%25%20local-informational" alt="Runs 100% local">
  <img src="https://img.shields.io/badge/opponent-Claude%20Code-d97757" alt="Opponent: Claude Code">
</p>

Play chess in your browser against a live Claude Code session. Your moves are
relayed to Claude by injecting a prompt into its terminal via tmux; Claude
replies through a small CLI that posts its move back to the server. A local
Node server is the referee — every move is validated with chess.js.

<p align="center">
  <img src="docs/screenshot.png" alt="A real screenshot of the browser board mid-game (Italian Game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6) with the live move list and controls beside it; the status bar reads 'Your move'." width="820">
</p>
<p align="center"><em>An actual game in progress — the real browser UI, not a mockup. You play in the browser; Claude answers from its terminal.</em></p>

## What makes it different

You're not playing a chess engine — you're playing a live Claude Code session.
After each move Claude tells you, in the chat, what it played and why; it offers
and accepts draws on the merits, grants takebacks graciously, and talks through
the game like an opponent sitting across the table:

> **You play** `Bc4` (the Italian Game).
> **Claude answers** `…Nf6` — *"Developing with tempo and keeping an eye on your
> e4 pawn. I'll castle next and stay flexible in the center. Your move."*

The server stays a strict referee — every move is checked with chess.js and the
UI is never trusted — but the opponent is Claude: it reasons about the position,
comments on the game, and adapts to how you play.

## Contents

- [What makes it different](#what-makes-it-different) — you're playing Claude, not an engine
- [What you need](#what-you-need) — prerequisites
- [Try it](#try-it) — the fastest path to a game
- [Let Claude set it up](#not-sure-you-have-everything-let-claude-set-it-up) — one command checks and installs everything
- [Quick start (manual)](#quick-start-manual) — run the server yourself
- [How a move flows](#how-a-move-flows) — the round-trip, end to end
- [Configuration](#configuration-environment-variables) · [HTTP API](#http-api) · [Persistence](#persistence) — reference
- [Project layout](#project-layout) — where everything lives
- [Troubleshooting](#troubleshooting) — symptom → fix
- [Stopping a game](#stopping-a-game) · [License](#license)

## What you need

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Anthropic's terminal agent; it plays as your opponent.
- **Node.js 18+** — runs the referee server (built-in test runner + `fetch`). No other install; the server's one dependency (chess.js) auto-installs on first launch.
- **tmux** *(recommended)* — lets the server push your moves straight into Claude's session. Without it, `/chess` falls back to a slightly slower polling mode.

Not sure what you have? [Let Claude check for you](#not-sure-you-have-everything-let-claude-set-it-up) — no manual auditing required.

## Try it

Clone the repo, then run Claude Code inside tmux from its directory and say
`/chess`:

```bash
git clone https://github.com/santiagoogaitnas/claude-chess.git
cd claude-chess
tmux new -s chess
claude
# then: /chess
```

Claude starts the server, opens the board at <http://localhost:3456>, and
plays you. Say "stop the game" when you're done.

`/chess` works out of the box only when Claude Code is launched inside this
repo (the skill lives at `.claude/skills/chess/`). To use it from **any**
session, install it user-level once:

```bash
chess-app/bin/install-skill              # copies the skill to ~/.claude/skills/chess
chess-app/bin/install-skill --uninstall  # removes it
```

The installed copy bakes in this repo's absolute path, so Claude knows where
the app lives no matter where the conversation started. Re-run the installer
if you move the repo; restart open Claude sessions to pick it up.

## Not sure you have everything? Let Claude set it up

If you don't know what to install or which command to run, don't guess — ask
Claude to check for you. Inside a Claude Code session, just say it in plain
English — no command to memorize:

> **"set up chess"** · **"check chess setup"** · **"get chess ready"** ·
> **"install chess"** · **"why won't chess start?"**

Any of these (or the explicit `/chess-setup`) puts Claude to work:

Claude runs through the prerequisites (Node 18+, tmux, a browser opener),
installs the server's dependency, offers to install `/chess` globally, runs a
smoke test, and hands you back a plain-English ✅/⚠️/❌ checklist with the one
fix needed for anything that isn't ready — then tells you exactly how to start
a game. The same request works after something breaks, too — it diagnoses a
stuck or silent game, not just a fresh install.

Prefer a plain script (no Claude session needed)? `chess-doctor` does the same
checks from your shell:

```bash
chess-app/bin/chess-doctor          # check only: what's ready, what's missing
chess-app/bin/chess-doctor --fix    # also install server deps + the /chess skill
```

It changes nothing unless you pass `--fix`, and on success prints the exact
command to start playing. The root `package.json` wraps both as npm scripts, so
from a fresh clone you can just run:

```bash
npm run doctor   # check only (same as chess-doctor)
npm run setup    # check + install anything missing (same as chess-doctor --fix)
```

## Quick start (manual)

```bash
# inside the tmux pane where Claude Code is running:
chess-app/bin/chess-ctl start        # captures $TMUX_PANE, opens the browser
chess-app/bin/chess-ctl status       # pid, URL, current position
chess-app/bin/chess-ctl restart      # bounce the server; the game resumes from disk
chess-app/bin/chess-ctl stop
```

The root `package.json` wraps the same lifecycle (`npm start`, `npm stop`,
`npm run restart`, `npm run status`) and runs every test suite with one
command: `npm test` (server regression checks + the api/cli/ctl/tmux/web e2e suites).

On a fresh clone, `chess-ctl start` installs the server's only dependency
(chess.js) automatically — no manual `npm install` needed.

`chess-ctl` hosts the server in a detached tmux session
(`chess-server-<port>`) so it survives the shell that launched it, and keeps
pid/log files under `chess-app/.run/`. Use `chess-ctl log [n]` to tail the
server log or `chess-ctl log -f` to follow it live (the log is rotated to
`server.log.1` once it passes 512 KB).

You can also run the server directly in a terminal you keep open:

```bash
CHESS_TMUX_TARGET=$TMUX_PANE node chess-app/server/server.mjs
# then open http://localhost:3456
```

You play White by default; make a move on the board and Claude gets prompted
in its terminal to reply.

## How a move flows

<p align="center">
  <img src="docs/gameplay.gif" alt="Animated board playing out a full Scholar's Mate (1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7#) beside a live move list, ending in checkmate, then looping." width="470">
</p>

1. You move a piece in the browser → `POST /api/move`.
2. The server validates it with chess.js and pushes the new position to the
   board over Server-Sent Events.
3. The server injects a one-line prompt into Claude's tmux pane
   (`tmux send-keys`), containing your move, the SAN movetext so far, the FEN,
   and the exact reply command.
4. Claude thinks, then runs `node chess-app/server/claude.mjs move Nf6`. The
   server validates and broadcasts, and your board updates.

<p align="center">
  <img src="docs/flow.svg" alt="Data-flow diagram: your move POSTs from the browser board to the Node server (the referee, validating with chess.js), which relays it to Claude Code in a tmux pane via 'tmux send-keys'; Claude replies with 'claude.mjs move', and the server pushes the new position back to the browser over SSE." width="820">
</p>
<p align="center"><em>Gold is your move heading out; blue is Claude's reply coming back. The server referees both directions.</em></p>

### No tmux? Manual mode

If `CHESS_TMUX_TARGET` is unset, injection is disabled. Claude (or you, in a
second terminal) can still drive its side directly:

```bash
cd chess-app/server
node claude.mjs state       # print ASCII board, FEN, turn, history, status
node claude.mjs move e7e5   # play a move (SAN or UCI)
node claude.mjs new w       # new game, Claude plays White
node claude.mjs resign      # resign as Claude
node claude.mjs draw offer  # offer a draw (also: draw accept | draw decline)
node claude.mjs pgn         # print the game as PGN
node claude.mjs games       # print the archive of finished games (PGN)
node claude.mjs shutdown    # stop the server
```

## Configuration (environment variables)

| Variable            | Default | Meaning |
|---------------------|---------|---------|
| `CHESS_PORT`        | `3456`  | HTTP port for API + web UI |
| `CHESS_TMUX_TARGET` | unset   | tmux pane running Claude (e.g. `$TMUX_PANE`); unset = manual mode |
| `CHESS_RESUME`      | `1`     | `0` = ephemeral game: skip restoring/writing the `.run/game-<port>.json` snapshot |

## HTTP API

| Endpoint           | Method | Body / behavior |
|--------------------|--------|-----------------|
| `/api/state`       | GET    | Full game state: `fen`, `pgn`, `turn`, `claudeColor`, `awaitingClaude`, `status`, `statusDetail` (human-readable end reason, `null` in progress), `gameOver`, `resignedBy`, `drawOfferBy`, `drawAgreed`, `history`, `lastMove`, `lastError`, `tmuxTarget` |
| `/api/moves`       | GET    | Legal moves, verbose (`?square=e2` limits to one square) — used for UI hints. |
| `/api/move`        | POST   | `{move}` — human move, SAN or UCI. 400 if illegal, 409 if not your turn or game over. Triggers tmux injection. |
| `/api/claude/move` | POST   | `{move}` — Claude's reply. Same validation, only on Claude's turn. |
| `/api/undo`        | POST   | Take back the last full move (Claude's reply + your move). 409 while waiting for Claude, with empty history, or after a resignation or agreed draw. Undoing also lets a pending draw offer lapse. |
| `/api/resign`      | POST   | `{by?: "human"\|"claude"}` (default `human`) — resign the game. Sets `status:"resigned"` and `gameOver:true`; a human resignation injects a you-win notice to Claude. |
| `/api/draw`        | POST   | `{by?: "human"\|"claude", action?: "offer"\|"accept"\|"decline"}` (defaults `human`/`offer`). Offer sets `drawOfferBy` (a human offer is injected to Claude); accept by the other side agrees the draw (`status:"draw"`, `drawAgreed:true`); decline clears it. Playing a move lets a pending offer lapse. 409: double offer, answering your own offer, no offer pending, game over. |
| `/api/pgn`         | GET    | The game as PGN text (headers + result token) — export for analysis. |
| `/api/games`       | GET    | Archive of finished games on this port as concatenated PGN (empty `200` when none). Each finished game is appended once; `/api/new` over an unfinished game archives it with result `*`. Skipped under `CHESS_RESUME=0`. |
| `/api/nudge`       | POST   | Re-inject the your-turn prompt into Claude's pane — recovery when an injection was lost. 409 unless it is Claude's turn in a live game with a tmux target; 502 if the injection fails. |
| `/api/new`         | POST   | `{claudeColor?: "w"\|"b"}` — reset the game (default: Claude is Black). If Claude is White, it is prompted to open. |
| `/api/shutdown`    | POST   | Graceful server exit. |
| `/events`          | GET    | SSE stream of state snapshots (the UI's live feed). |
| `/`                | GET    | Serves the web UI from the repo-root `web/` directory. |

All move legality and turn order are enforced server-side; the UI is never
trusted. Request bodies over 64 KB are refused. The full endpoint contract
lives in
[`chess-app/server/API.md`](chess-app/server/API.md).

## Persistence

Every state change is snapshotted to `chess-app/.run/game-<port>.json` (PGN,
colors, flags). On startup the server restores its port's snapshot, so a crash
or `chess-ctl restart` resumes the game in progress. If it was Claude's turn
when the server died, the restarted server re-injects the your-turn prompt into
Claude's tmux pane so the game doesn't stall. `POST /api/new` overwrites
the snapshot; set `CHESS_RESUME=0` for a fully ephemeral game (the test suites
use this).

## Project layout

```
├── ARCHITECTURE.md              design, API contract, V2 roadmap
├── LICENSE                      MIT
├── docs/                        README media (screenshot.png, gameplay.gif, flow.svg)
├── package.json                 root scripts: npm start / stop / restart / status / test
├── .claude/skills/
│   ├── chess/                   the /chess skill Claude follows to play
│   └── chess-setup/             the /chess-setup skill (checks + readies your machine)
├── web/                         browser board (vanilla JS, no build step, served by the server)
│   └── vendor/chess.js          local engine for move hints (server stays authoritative)
└── chess-app/
    ├── bin/
    │   ├── chess-ctl            lifecycle bridge: start / stop / restart / status / log
    │   ├── chess-doctor         one-command setup check + optional --fix (no Claude needed)
    │   └── install-skill        publish /chess to ~/.claude/skills for use from any session
    ├── server/
    │   ├── server.mjs           HTTP server: API, SSE, static UI, tmux injection, persistence
    │   ├── claude.mjs           CLI for Claude's side (state / move / new / resign / draw / pgn / games / shutdown)
    │   ├── test.mjs             server regression suite (`npm test` from server/)
    │   └── API.md               full endpoint contract
    ├── test/                    e2e suites (`node --test chess-app/test/*.test.mjs`)
    │   ├── api.test.mjs         HTTP API suite
    │   ├── cli.test.mjs         claude.mjs CLI suite
    │   ├── ctl.test.mjs         chess-ctl lifecycle suite
    │   ├── tmux.test.mjs        tmux port-injection guard (fake-tmux stub, no real tmux)
    │   └── web.test.mjs         browser-board DOM-shim suite (runs serverless)
    └── .run/                    runtime files (pid, log, pane, port, game-<port>.json)
```

## Troubleshooting

Start with the automated check — it names the one thing that's wrong and how to
fix it: `chess-app/bin/chess-doctor` (or `/chess-setup` inside Claude). The
common cases:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/chess` does nothing / "skill not found" | The skill only auto-loads inside this repo | `chess-app/bin/install-skill`, then restart the Claude session |
| Claude never replies to your move | Server was started with no tmux pane (`CHESS_TMUX_TARGET` unset → manual mode) | Launch Claude inside `tmux` and start via `chess-ctl start` (it captures the pane), or drive Claude's side by hand with `node chess-app/server/claude.mjs move …` |
| Move played, but Claude's answer never arrives | A `tmux send-keys` injection was lost | `curl -X POST localhost:3456/api/nudge` re-sends the your-turn prompt |
| `a server is already responding … but it wasn't started by chess-ctl` | Another process holds the port | Stop it, or pick another: `chess-ctl start --port 3457` |
| Board never loads / can't reach the page | Server binds `127.0.0.1` only | Open it on the same machine at <http://localhost:3456> — it is not exposed to the network by design |
| Server won't start on a fresh clone | Node too old or missing | Needs **Node 18+**; `chess-ctl` auto-installs the one dependency (chess.js) on first start |
| Not sure what died | — | `chess-app/bin/chess-ctl log 50` prints the last 50 server-log lines (`log -f` follows live) |

## Stopping a game

Run `chess-app/bin/chess-ctl stop`, ask Claude to stop (it runs
`claude.mjs shutdown`), or `curl -X POST localhost:3456/api/shutdown`.
`chess-ctl stop`/`restart` only act on a server they launched — if something
else is answering on the port they exit with an error instead of killing it.

Status: V1 — single game, localhost only; the game auto-saves and resumes
across server restarts.

## License

Released under the [MIT License](LICENSE).
