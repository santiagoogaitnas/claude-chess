# Chess-with-Claude — Architecture (V1)

Play chess in a browser UI against Claude, where Claude is a live Claude Code
session. The human's move reaches Claude over one of two interchangeable
transports: with tmux the server injects it into Claude's terminal; without
tmux Claude pulls it by long-polling `GET /api/wait`. Either way Claude replies
by running a small CLI that posts its move back to the server. tmux is optional
— preferred when available, because the chat stays free between moves.

## Flow

```
 You (browser UI)                 chess server (Node)              Claude session
 ───────────────                  ───────────────────              ──────────────
 click move  ──POST /api/move──▶  validate (chess.js)
                                  update state, broadcast SSE
                                  tmux send-keys ────────────────▶ "[chess] Opponent played e4.
                                                                    FEN … Reply by running:
                                                                    node server/claude.mjs move <m>"
                                                                   Claude thinks, runs CLI
 board updates ◀──SSE──────────  validate ◀─POST /api/claude/move─ claude.mjs move e7e5
```

When Claude is not inside tmux (`CHESS_TMUX_TARGET` unset), injection is a no-op
("manual mode") and Claude drives its side by pulling: `claude.mjs wait`
long-polls `GET /api/wait` until a move is owed (or a draw offer / game-over
lands), then Claude replies with `claude.mjs move`. Same game loop, no tmux.

## Components & file layout

```
.
├── ARCHITECTURE.md              this file
├── README.md                    user-facing setup/usage (the only README)
├── LICENSE                      MIT
├── package.json                 root scripts: npm start / stop / restart / status / test
├── .gitignore                   excludes node_modules/, chess-app/.run/, OS junk
├── docs/                        README media (screenshot.png, gameplay.gif, flow.svg)
├── web/                         board UI (vanilla JS, no build step) served at /
│   ├── index.html
│   ├── board.js
│   ├── style.css
│   └── vendor/chess.js          vendored chess.js ESM — client-side legal-move hints
│                                (server stays authoritative; UI degrades gracefully
│                                if the import fails)
├── chess-app/
│   ├── bin/
│   │   ├── cli.mjs              npx entry point (`npx claude-chess`): start / stop / status / doctor
│   │   ├── chess-ctl            lifecycle script: start / stop / restart / status / log
│   │   ├── chess-doctor         setup check + optional --fix (no Claude session needed)
│   │   └── install-skill        publish the /chess skill to ~/.claude/skills
│   ├── .run/                    runtime files (server.pid, server.log, pane, port,
│   │                            game-<port>.json snapshots) — gitignore
│   ├── test/                    e2e suites (node --test): api.test.mjs,
│   │                            cli.test.mjs, ctl.test.mjs, pull-loop.test.mjs,
│   │                            tmux.test.mjs, web.test.mjs
│   └── server/
│       ├── package.json         deps: chess.js only
│       ├── API.md               wire-level API contract
│       ├── server.mjs           HTTP server: JSON API, SSE, static UI, tmux injection, /api/wait long poll
│       ├── prompts.mjs          agent-facing prompt/notice text (imported by server.mjs)
│       ├── claude.mjs           CLI for Claude: state / wait / move / new / resign / draw / pgn / games / shutdown
│       │                        (state & move print an ASCII board; FEN-only degrade)
│       └── test.mjs             regression suite (`npm test` — spawns a real server)
└── .claude/skills/
    ├── chess/SKILL.md           /chess skill: launch server, play loop, shutdown
    └── chess-setup/SKILL.md     /chess-setup skill: check prerequisites + ready the machine
```

## Server API (default port 3456, override with CHESS_PORT)

The server binds to `127.0.0.1` only — local play, nothing exposed on the LAN.

| Endpoint             | Method | Body / notes |
|----------------------|--------|--------------|
| `/api/state`         | GET    | `{fen, pgn, turn, claudeColor, awaitingClaude, status, statusDetail, gameOver, resignedBy, drawOfferBy, drawAgreed, history, lastMove, lastError, lastEvent, tmuxTarget}` — `statusDetail` is the human-readable end reason (winner at mate, `"draw by threefold repetition"` / fifty-move / insufficient material / agreement, who resigned); `null` while the game is in progress. `lastEvent` is the agent-facing description of the most recent change (what `/api/wait` returns as `event`); `null` until something happens, not persisted |
| `/api/moves`         | GET    | `{moves: [...]}` legal moves (verbose chess.js objects); `?square=e2` filters — UI move hints |
| `/api/wait`          | GET    | long poll for the agent side — holds the response until the game needs Claude (`reason` `game-over` / `draw-offer` / `your-turn`, checked in that priority order at request time and on every state change) or `?timeout=` ms elapse (`timeout`; default 25000, clamped 1000–120000); returns `{reason, event, ...state}` where `event` is a one-line description of the last change (`null` on timeout / before anything happens). Concurrent waiters all resolve; a closed connection drops its waiter |
| `/api/new`           | POST   | `{claudeColor?: "w"\|"b"}` — resets game (default Claude=Black); prompts Claude to open if White |
| `/api/move`          | POST   | `{move: "<san or uci>"}` — human move; 400 illegal, 409 wrong turn/game over; triggers injection |
| `/api/claude/move`   | POST   | `{move}` — Claude's reply; same validation, only on Claude's turn |
| `/api/undo`          | POST   | takes back the last full move pair; 409 while awaiting Claude, after a resignation or agreed draw, or with empty history; clears any pending draw offer; re-prompts Claude if his opening move was undone |
| `/api/resign`        | POST   | `{by?: "human"\|"claude"}` (default human) — ends the game (`status: "resigned"`); a human resignation injects a you-win notice to Claude; 409 if already over |
| `/api/draw`          | POST   | `{by?: "human"\|"claude", action?: "offer"\|"accept"\|"decline"}` (defaults human/offer) — offer sets `drawOfferBy` (human offers are injected to Claude); accept by the other side sets `drawAgreed` + `status: "draw"`; decline clears it; any move lets a pending offer lapse; 409 on double-offer, answering your own offer, no offer pending, or game over |
| `/api/pgn`           | GET    | game as PGN text (Event/Site/Date/White/Black/Result headers + result token) — export/analysis |
| `/api/games`         | GET    | archive of past games on this port as concatenated PGN (empty `200` when none); each finished game is appended once, `/api/new` over an unfinished game archives it with result `*`; skipped when `CHESS_RESUME=0` |
| `/api/nudge`         | POST   | re-inject the your-turn prompt (recover a lost injection — pane busy/cleared); 409 unless `awaitingClaude` in a live game with a tmux target, 502 if the injection fails |
| `/api/shutdown`      | POST   | graceful exit |
| `/events`            | GET    | SSE stream of state snapshots |
| `/`                  | GET    | static UI from repo-root `web/` |

Turn enforcement and move legality are validated server-side with chess.js;
the UI is never trusted. Human moves are rejected on Claude's turn and vice
versa. Error bodies always include `error` plus the full state. Request bodies
over 64 KB are refused (connection destroyed). The wire-level
source of truth is `chess-app/server/API.md`; regression coverage lives in
`chess-app/server/test.mjs` (`npm test`).

## Persistence

After every state change the server snapshots the game (PGN, `claudeColor`,
`awaitingClaude`, `resignedBy`, `drawOfferBy`, `drawAgreed`) to
`chess-app/.run/game-<port>.json` and
restores it on startup, so a crash or restart mid-game resumes the same
position. If the restored game was awaiting Claude's move and a tmux target is
configured, startup re-injects the your-turn prompt (the original injection
died with the old process) so the game doesn't stall. Set `CHESS_RESUME=0` for
an ephemeral game (no restore, no snapshots). `POST /api/new` overwrites the
snapshot with the fresh game.

Completed games also accumulate in `chess-app/.run/games-<port>.pgn` (served by
`GET /api/games`). Each finish is appended once — a snapshot `archived` flag
stops a restart from re-recording the same game, and a takeback that revives a
finished game re-arms archiving so the eventual new finish is logged as its own
entry. Archiving is skipped entirely under `CHESS_RESUME=0`.

## Transports (how a human move reaches Claude)

The game logic is transport-agnostic; only delivery of the human's move differs.
tmux push is preferred when available; agent pull works everywhere.

**tmux push** (optional, preferred — the chat stays free between moves):

- The skill launches the server with `CHESS_TMUX_TARGET=$TMUX_PANE` (Claude's
  own pane) when running inside tmux.
- On each human move the server runs `tmux send-keys -t "$CHESS_TMUX_TARGET"
  -l '<one-line prompt>'` followed by `Enter` (after a short delay, so the
  Claude Code composer registers the text before submit).
- The injected prompt is self-contained: it states the move, the SAN movetext
  so far, the FEN, whose turn it is, and the exact reply command, so Claude
  needs no other context. The movetext is stripped to a single line (PGN
  headers/newlines would submit the prompt mid-injection).
- When the human's move ends the game, a game-over notice (including the
  `statusDetail` end reason) is injected instead of a move request; a human
  resignation injects a you-win notice; a human draw offer injects an
  accept/decline prompt (`claude.mjs draw accept|decline`), and human
  accept/decline of Claude's offer is announced too; undoing Claude's opening
  move re-injects the open prompt.
- Injection failures are surfaced in state as `lastError` rather than lost.

**Agent pull** (no tmux): the agent long-polls `GET /api/wait`, which holds the
response until a move is owed, a draw offer is pending, or the game ends, then
returns the reason plus full state. `claude.mjs wait` wraps this in a bounded
loop — act on the reason, then wait again — and the skill's manual-mode path
uses it. No repeated short-interval polling.

Every prompt and notice string lives in `chess-app/server/prompts.mjs`, imported
by `server.mjs`, so how the app talks to an agent is defined in one place.

## Lifecycle (the /chess skill)

1. `chess-app/bin/chess-ctl start` — installs server deps if missing (npm),
   captures `$TMUX_PANE` (or `--pane <target>`; neither → manual mode), reaps
   any live previous instance on a different port, hosts the server in a
   detached tmux session `chess-server-<port>` so it outlives the shell that
   launched it (no tmux → a detached node process tracked by the pidfile, as
   `bin/cli.mjs` does), writes pid/log/pane/port under `chess-app/.run/`,
   waits for `/api/state`, and opens `http://localhost:<port>`. Later
   `stop`/`status`/`log`/`restart` resolve the port from `.run/port` (a
   `CHESS_PORT` env override still wins); `restart` also preserves the
   persisted pane target. Ownership is enforced both ways: `start` refuses a
   port a foreign server answers on, and `stop`/`restart` refuse to shut down
   a server chess-ctl didn't launch (pid is verified to be our `server.mjs`,
   so a stale/recycled pid file can't kill an innocent process). `start`
   rotates `server.log` to `server.log.1` once it exceeds 512 KB;
   `log -f` follows the log live.
2. Claude tells the user the board is up; each human move arrives as an
   injected `[chess]` prompt (tmux), or Claude pulls it with `claude.mjs wait`
   in manual mode.
3. On "let's stop" / checkmate: `chess-ctl stop` (graceful `/api/shutdown`,
   then kill + tmux session cleanup).

`npx claude-chess` (`chess-app/bin/cli.mjs`) is a packaged front end to the same
lifecycle (`start` default / `stop` / `status` / `doctor`, `--no-open` to skip
the browser): it starts `server.mjs` using the same `.run/` pid/log/port files,
and inside tmux hands off to `chess-ctl` for the full push experience.

## Future (not V1)

- Multiple concurrent games / game IDs
- Move clocks, PGN import
- Engine hints, analysis panel
- Deploy mode (remote server + auth) — keep game state isolated in the server
  to make this easy.
