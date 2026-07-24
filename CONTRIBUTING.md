# Contributing

Thanks for taking an interest! This is a small, self-contained project — a
browser chess board where the human plays a live Claude Code session, refereed
by a local Node server. You can be productive after reading two files:
[`ARCHITECTURE.md`](ARCHITECTURE.md) (how the pieces fit together) and
[`chess-app/server/API.md`](chess-app/server/API.md) (the exact HTTP contract).

## Getting set up

```bash
git clone https://github.com/santiagoogaitnas/claude-chess.git
cd claude-chess
npm run doctor        # check node 18+, tmux, browser opener, port, deps
npm run setup         # same check, but installs anything missing
```

`npm run doctor` / `npm run setup` are thin wrappers around
`chess-app/bin/chess-doctor`. The server's one dependency (chess.js) also
auto-installs the first time the server launches, so there is no manual
`npm install` step.

## Running the tests

Keep the whole suite green before opening a PR:

```bash
npm test
```

That runs two things:

- **`npm run test:server`** — the server regression suite
  (`chess-app/server/test.mjs`): move legality, turn order, persistence,
  archiving, the 64 KB body cap.
- **`npm run test:e2e`** — the end-to-end suites in `chess-app/test/`
  (`api`, `cli`, `ctl`, `pull-loop`, `tmux`, `web`), which drive the real HTTP
  API, the `claude.mjs` CLI, the `chess-ctl` lifecycle, the no-tmux pull loop,
  tmux move-injection, and the browser board module.

Run the suite **in isolation** — starting several servers or overlapping test
runs at once can cause port/timing flakiness that is not a real failure. CI
(`.github/workflows/ci.yml`) runs the same `npm test` on Node 18, 20, and 22.

## Ground rules for changes

- **The server is the referee.** All move legality and turn order are enforced
  server-side with chess.js — never trust the UI. If you touch move handling,
  add or update a test in `chess-app/server/test.mjs`.
- **Keep the API contract honest.** If you add, remove, or change an endpoint,
  update [`chess-app/server/API.md`](chess-app/server/API.md) and
  `ARCHITECTURE.md` so the docs don't drift (the README defers to `API.md` for
  the full contract).
- **The server stays local-only.** It binds `127.0.0.1:3456` and refuses
  request bodies over 64 KB. Don't expose it to the network.
- **No new runtime dependencies** without a good reason — chess.js is
  deliberately the only one.

## Opening a pull request

1. Branch off `main`.
2. Make your change; add or update tests to cover it.
3. Run `npm test` (isolated) and confirm it's green.
4. Update the relevant docs (README / `API.md` / `ARCHITECTURE.md`).
5. Open the PR with a short description of what changed and why.

Small, focused PRs are easiest to review. Thanks for contributing!
