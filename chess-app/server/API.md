# Chess server — API contract (V1)

Run: `node server/server.mjs` (env: `CHESS_PORT` default 3456, `CHESS_TMUX_TARGET` = tmux pane running claude, e.g. `mysession:0.0`; unset = manual mode, no injection).

Serves static files from the repo-root `web/` directory at `/` (UI lives there: `index.html`, `board.js`, `style.css`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/state` | — | Current state (below) |
| GET | `/api/moves` | — | `{"moves":[...]}` all legal moves (verbose chess.js objects); `?square=e2` filters to one square — for UI move hints |
| GET | `/events` | — | SSE stream; emits full state JSON on every change |
| GET | `/api/wait` | — | Long poll for the agent side: the response is held until the game needs the agent, then carries `{"reason", "event", ...state}`. `reason` is `game-over` (game ended), `draw-offer` (a human offer is pending), or `your-turn` (a move is owed) — checked in that priority order at request time and on every state change — else `timeout` once `?timeout=` ms elapse (default 25000, clamped to 1000–120000). `event` is a one-line description of the last thing that happened ("Human played Bc4", "Opponent offers a draw", "Game over: checkmate — White wins", …); `null` on `timeout` or when nothing has happened yet. Any number of concurrent waiters all resolve; a waiter whose connection closes is discarded |
| POST | `/api/move` | `{"move":"e4"}` | Human move (SAN or UCI). Triggers tmux injection of a prompt (includes SAN movetext so far + FEN) telling Claude to reply via `claude.mjs move <mv>`; if the move ends the game, a game-over notice is injected instead |
| POST | `/api/claude/move` | `{"move":"e5"}` | Claude's move (usually via `node server/claude.mjs move e5`) |
| POST | `/api/undo` | — | Take back the last full move pair (Claude's reply + the human move). `409` while awaiting Claude, with empty history, or after a resignation. Undoing Claude's opening move re-sets `awaitingClaude` and re-prompts Claude |
| POST | `/api/resign` | `{"by":"human"\|"claude"}` | Resign the game (default `human`). Sets `status:"resigned"` + `gameOver:true`; a human resignation injects a you-win notice to Claude |
| POST | `/api/draw` | `{"by":"human"\|"claude", "action":"offer"\|"accept"\|"decline"}` | Draw negotiation (defaults: `by:human`, `action:offer`). Offer sets `drawOfferBy` and (human offers only) injects an accept/decline prompt to Claude; accept by the *other* side sets `drawAgreed:true` + `status:"draw"` + `gameOver:true`; decline clears the offer. Playing any move lets a pending offer lapse. `409`: offer while one pending, answering your own offer, no offer pending, game over |
| POST | `/api/nudge` | — | Re-inject the your-turn prompt to Claude — recovery when an injection was lost (pane busy/cleared). `409` unless `awaitingClaude` and the game is live and a tmux target is configured; `502` if the tmux injection itself fails |
| GET | `/api/pgn` | — | The game as PGN text (Event/Site/Date/White/Black/Result headers, result token appended) — for export/analysis. Also via `claude.mjs pgn` |
| GET | `/api/games` | — | Archive of past games on this port as concatenated PGN (empty `200` when none). Every finished game (mate, auto-draw, resignation, agreed draw) is appended once; `/api/new` over an unfinished game archives it with result `*`. Skipped when `CHESS_RESUME=0`. Also via `claude.mjs games` |
| POST | `/api/new` | `{"claudeColor":"w"\|"b"}` | New game (default Claude = black; if white, prompt injected immediately). Archives the outgoing game first if it had moves (see `/api/games`) |
| POST | `/api/shutdown` | — | Stop server |

State shape:

```json
{
  "fen": "...", "pgn": "...", "turn": "w",
  "lastMove": {"from": "e2", "to": "e4", "san": "e4"},
  "_lastMove_note": "null before the first move",
  "claudeColor": "b", "awaitingClaude": true,
  "status": "playing|check|checkmate|stalemate|draw|resigned",
  "_note": "status 'draw' covers both auto-draws (stalemate/50-move/repetition/material) and agreed draws — drawAgreed distinguishes them",
  "statusDetail": "checkmate — Black wins",
  "_statusDetail_note": "human-readable end reason (winner, 'draw by threefold repetition' / 'fifty-move rule' / 'insufficient material' / 'agreement', 'White resigned', ...); null while the game is in progress",
  "gameOver": false, "resignedBy": null,
  "drawOfferBy": null, "drawAgreed": false,
  "history": ["e4","e5"],
  "lastError": null,
  "lastEvent": "Human played e4",
  "_lastEvent_note": "agent-facing description of the most recent state change (what /api/wait returns as event); null until something happens — not persisted across restarts",
  "tmuxTarget": "sess:0.0"
}
```

Errors: `400` illegal move, `409` wrong turn / game over — body always includes `error` + full state. Request bodies over 64 KB are dropped (connection destroyed).

Claude-side CLI: `node server/claude.mjs <state|wait|move|new|resign|draw|pgn|games|shutdown> [arg]` (respects `CHESS_PORT`; `draw` takes `offer|accept|decline`). `wait [seconds]` long-polls `/api/wait` until something needs the agent, then prints `EVENT:` and `REASON:` lines plus the usual state printout — exit 0; exit 2 when the budget (default ~100 s, kept under a 120 s exec timeout) runs out with nothing to report; exit 1 when the server is unreachable. State output includes an ASCII board when chess.js is installed next to the CLI (falls back to FEN-only otherwise).

## Being the opponent

The contract any terminal agent follows to play the human — works with zero tmux:

1. Check the board with `node server/claude.mjs state`; start a game with `new [w|b]` when asked to (as White, play the first move right away).
2. Run `node server/claude.mjs wait`. Exit 0 means act on the `REASON:` line; exit 2 means nothing happened within the budget — run `wait` again; exit 1 means the server is unreachable.
3. Act on the reason, then go back to step 2:

| Reason | Meaning | Response |
|---|---|---|
| `your-turn` | A move is owed: the human moved, took back your opening move, or you are White in a fresh game | Pick a move, then `claude.mjs move <san-or-uci>` |
| `draw-offer` | The human's draw offer is pending | `claude.mjs draw accept` or `claude.mjs draw decline` (playing a move also declines) |
| `game-over` | Checkmate, stalemate, auto-draw, resignation, or agreed draw | Stop looping; `state`/`pgn` for the result |
| `timeout` | Nothing happened in one poll window (raw `/api/wait` callers only) | Poll again |

`claude.mjs wait` absorbs `timeout` itself by re-polling until its budget, so its callers only ever see the first three reasons or exit 2. `resign` and `draw offer` are valid whenever the game is live. With a tmux target configured the server also pushes these prompts into the agent's pane as they happen; `/api/wait` behaves the same either way.

Persistence: every state change is snapshotted to `chess-app/.run/game-<port>.json` (PGN + colors + flags); on startup the server restores its port's snapshot, so a restart resumes the game in progress. If the restored game was awaiting Claude's move (and a tmux target is configured), the server re-injects the your-turn prompt on startup so the game doesn't stall. `CHESS_RESUME=0` runs ephemeral (no restore, no snapshots, no archive — the test suite uses this); `POST /api/new` overwrites the snapshot. Completed games additionally accumulate in `chess-app/.run/games-<port>.pgn` (served by `GET /api/games`); the snapshot's `archived` flag keeps a restart from appending a finished game twice, and a takeback that revives a finished game re-arms archiving so the eventual new finish is recorded as its own entry.

The server binds to `127.0.0.1` only. Regression tests: `npm test` (spawns a real server on an OS-assigned free port — `CHESS_TEST_PORT` pins one — and exercises the full contract, including the restart re-prompt via a scratch tmux session).
