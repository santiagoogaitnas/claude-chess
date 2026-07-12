# Chess server — API contract (V1)

Run: `node server/server.mjs` (env: `CHESS_PORT` default 3456, `CHESS_TMUX_TARGET` = tmux pane running claude, e.g. `mysession:0.0`; unset = manual mode, no injection).

Serves static files from the repo-root `web/` directory at `/` (UI lives there: `index.html`, `board.js`, `style.css`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/state` | — | Current state (below) |
| GET | `/api/moves` | — | `{"moves":[...]}` all legal moves (verbose chess.js objects); `?square=e2` filters to one square — for UI move hints |
| GET | `/events` | — | SSE stream; emits full state JSON on every change |
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
  "lastError": null, "tmuxTarget": "sess:0.0"
}
```

Errors: `400` illegal move, `409` wrong turn / game over — body always includes `error` + full state. Request bodies over 64 KB are dropped (connection destroyed).

Claude-side CLI: `node server/claude.mjs <state|move|new|resign|draw|pgn|games|shutdown> [arg]` (respects `CHESS_PORT`; `draw` takes `offer|accept|decline`). State output includes an ASCII board when chess.js is installed next to the CLI (falls back to FEN-only otherwise).

Persistence: every state change is snapshotted to `chess-app/.run/game-<port>.json` (PGN + colors + flags); on startup the server restores its port's snapshot, so a restart resumes the game in progress. If the restored game was awaiting Claude's move (and a tmux target is configured), the server re-injects the your-turn prompt on startup so the game doesn't stall. `CHESS_RESUME=0` runs ephemeral (no restore, no snapshots, no archive — the test suite uses this); `POST /api/new` overwrites the snapshot. Completed games additionally accumulate in `chess-app/.run/games-<port>.pgn` (served by `GET /api/games`); the snapshot's `archived` flag keeps a restart from appending a finished game twice, and a takeback that revives a finished game re-arms archiving so the eventual new finish is recorded as its own entry.

The server binds to `127.0.0.1` only. Regression tests: `npm test` (spawns a real server on an OS-assigned free port — `CHESS_TEST_PORT` pins one — and exercises the full contract, including the restart re-prompt via a scratch tmux session).
