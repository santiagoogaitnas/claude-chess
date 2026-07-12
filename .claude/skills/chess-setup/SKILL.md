---
name: chess-setup
description: One-command setup and health check for the Claude chess app. Verifies prerequisites (node, tmux, a browser opener), installs the server dependency, optionally installs /chess globally, runs a smoke test, and tells the user exactly how to start playing. Trigger on "/chess-setup", "set up chess", "check chess setup", "get chess ready", "why won't chess start", "install chess".
---

# /chess-setup — get the chess app ready to play

The user wants you to make sure everything needed to play chess against Claude
is in place — and fix or explain anything that isn't. They may not know what to
check or which command to run; that is your job. Work through the steps below in
order, run the checks yourself, and report a short, plain-English summary at the
end (a checklist of ✅ / ⚠️ / ❌ with the one action needed for each ⚠️/❌).

All commands are relative to the repo root. If this skill was installed
globally, the installer baked the repo's absolute path into a preamble above —
`cd` there first (quote it; the path may contain spaces).

Do not ask the user questions you can answer by running a command. Only ask when
a decision is genuinely theirs (e.g. "install /chess globally?").

## 1. Preflight — check the prerequisites

Run these checks and note the result of each. Don't stop at the first failure;
gather them all so you can give the user one complete report.

```bash
node --version      # need v18+ (built-in test runner + fetch used by tests)
npm --version       # ships with node
tmux -V             # optional but strongly recommended (enables auto move prompts)
git --version       # only needed if they haven't cloned yet
[ -n "$TMUX" ] && echo "in tmux: yes" || echo "in tmux: no"  # inside a tmux session?
```

Interpret the results:

- **node missing or < v18** → this is a hard blocker. Tell them to install
  Node 18+ and give the platform-appropriate hint:
  - macOS: `brew install node` (or download from <https://nodejs.org>)
  - Debian/Ubuntu: `sudo apt install nodejs npm` (or use nvm / nodesource for a
    current version if the distro's is old)
  - Windows: install from <https://nodejs.org> or `winget install OpenJS.NodeJS`
- **tmux missing** → not a blocker, but without it the server can't auto-inject
  the user's moves into your session, so `/chess` runs in **manual polling
  mode** (you poll `/api/state`; slightly slower turns). Offer the install hint
  (`brew install tmux` / `sudo apt install tmux`) and let them decide.
- **Not inside tmux** (`TMUX` unset) but tmux *is* installed → for the best
  experience they should start Claude inside tmux:
  ```bash
  tmux new -s chess
  claude
  ```
  Explain this is optional; without it, manual mode still works.
- **A browser opener** — `chess-ctl` opens the board automatically, but only
  via `open` (macOS) or `xdg-open` (Linux) — those are the only two it calls.
  Confirm one exists for their platform; if not, the board still starts, they'll
  just open the URL by hand. (On WSL, `open`/`xdg-open` are usually absent, so
  expect the manual-open path.)
  ```bash
  command -v open xdg-open 2>/dev/null || echo "no auto-opener — open http://localhost:3456 by hand"
  ```

## 2. Install the server dependency

The server needs one package (chess.js). `chess-ctl start` installs it
automatically on first run, but pre-warming it here makes the first game
instant and surfaces any npm problems now instead of mid-launch:

```bash
npm --prefix chess-app/server install
```

If this fails (offline, proxy, permissions), report the exact npm error and the
likely cause — don't bury it.

## 3. Smoke test — prove it actually works

Run the test suites. They use an ephemeral, non-persisted server on a throwaway
port, so they're safe to run anytime and don't disturb a game in progress:

```bash
npm test
```

- All green → the app is verified working end to end (server, CLI, lifecycle,
  and browser board). Say so plainly.
- Failures → capture the failing test name and output, then diagnose. A common
  cause is a stale server on the default port; `chess-app/bin/chess-ctl status`
  shows what's running. Report what you find rather than hand-waving.

If `npm test` is too slow or the user only wants a quick check, a lighter proof
is to start and immediately stop the server:

```bash
chess-app/bin/chess-ctl start --no-open && chess-app/bin/chess-ctl status && chess-app/bin/chess-ctl stop
```

## 4. Offer to install /chess globally

`/chess` works out of the box when Claude Code is launched **inside this repo**.
If the user wants to start a game from any directory / any session, offer to
install the skill user-level (this is a real change to their `~/.claude`, so
ask before doing it):

```bash
chess-app/bin/install-skill              # installs to ~/.claude/skills/chess
chess-app/bin/install-skill --uninstall  # reverses it
```

If you install it, remind them to restart any already-open Claude sessions to
pick it up, and that re-running the installer is needed if they move the repo.

## 5. Report and hand off

Give the user a compact status report, then tell them exactly how to play:

> Everything's ready. Start a game any time by saying **`/chess`** (or "let's
> play chess"). I'll launch the board at <http://localhost:3456>, you play
> White, and I'll reply to your moves.

If anything is still ⚠️/❌, lead with the single most important next action
(e.g. "Install Node 18+ first — everything else is ready"). Keep it short and
friendly; the goal is that a person who didn't know what to check now knows
exactly where they stand and what, if anything, to do next.
