# CLAUDE.md

Guidance for Claude Code when working in this repo. If a user opens this repo
and asks you to "set up chess", "get this working", "check I have everything",
or "let's play" — this file tells you exactly what to do without guessing.

## What this project is

A browser chess app where the human plays a live Claude Code session. A local
Node server (`chess-app/server/server.mjs`) is the referee — it validates every
move with chess.js, serves the board UI from `web/`, and gets the human's move
to Claude one of two ways: pushing it into Claude's terminal via `tmux
send-keys`, or letting Claude pull it by long-polling `GET /api/wait` (no tmux
needed). Claude replies by running a small CLI (`chess-app/server/claude.mjs`)
that posts its move back. See `README.md` for the player-facing guide and
`ARCHITECTURE.md` for the design.

## Requirements

- **Node.js 18+** (built-in test runner + `fetch`). The server's only
  dependency, chess.js, auto-installs on first launch — no manual `npm install`.
- **tmux** *(optional)* — lets the server push the human's moves straight into
  Claude's pane so the chat stays free between moves. Without it, Claude pulls
  each move by long-polling `GET /api/wait` (`claude.mjs wait`); everything else
  works the same.
- **Claude Code** — the opponent.

## If the user asks you to set things up or check their machine

Run the setup checker, which reports a plain-English pass/warn/fail list and,
with `--fix`, installs what's missing:

```bash
chess-app/bin/chess-doctor          # check only — what's ready, what's missing
chess-app/bin/chess-doctor --fix    # also install server deps + the /chess skill
```

There is also a `/chess-setup` skill that does the same from inside a session.
Prefer `chess-doctor` when you just need to verify the environment quickly.

## If the user wants to play

- The `/chess` skill drives a full game (start the server, open the board,
  trade moves, shut down). Trigger it for "let's play chess", "/chess", etc.
- To make `/chess` work from any repo (not just this one), install it
  user-level once: `chess-app/bin/install-skill` (undo with `--uninstall`).

## Running the server directly

```bash
chess-app/bin/chess-ctl start        # start in a detached tmux session, open the browser
chess-app/bin/chess-ctl status       # pid, URL, current position
chess-app/bin/chess-ctl restart      # bounce the server; the game resumes from disk
chess-app/bin/chess-ctl stop
chess-app/bin/chess-ctl log [n]      # tail the server log (-f follows)
```

Outside a clone, `npx claude-chess` (`start` / `stop` / `status` / `doctor`,
`--no-open` to skip the browser) runs the same lifecycle and shares the same
`.run/` files.

The server binds `127.0.0.1:3456` only (not exposed to the network). The
Claude-side CLI is `node chess-app/server/claude.mjs <state|wait|move|new|resign|draw|pgn|games|shutdown>`.

## Before committing changes

Run the full suite and keep it green:

```bash
npm test        # server regression suite + api/cli/ctl/pull-loop/tmux/web e2e suites
```

Run it in isolation — starting several servers or overlapping test runs at once
can cause port/timing flakiness that is not a real failure. All move legality
and turn order are enforced server-side; never trust the UI. Request bodies over
64 KB are refused. The full endpoint contract lives in `chess-app/server/API.md`.
