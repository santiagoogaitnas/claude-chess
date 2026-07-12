<!--
Thanks for contributing! Keep PRs small and focused — see CONTRIBUTING.md.
Fill in the sections below and check off the list before requesting review.
-->

## What & why

<!-- What does this change do, and why? Link any related issue with "Closes #123". -->

## How I tested it

<!-- e.g. `npm test` (isolated) is green; drove a live game via /chess or the HTTP API. -->

## Checklist

- [ ] Branched off `main`.
- [ ] Added or updated tests to cover the change (move handling → `chess-app/server/test.mjs`).
- [ ] Ran `npm test` **in isolation** and it's green (server + `api`/`cli`/`ctl`/`tmux`/`web` e2e).
- [ ] Kept the docs honest — if an endpoint changed, updated [`chess-app/server/API.md`](../chess-app/server/API.md), the README HTTP API table, and [`ARCHITECTURE.md`](../ARCHITECTURE.md).
- [ ] No new runtime dependencies (chess.js is deliberately the only one), or explained why one is needed.
- [ ] The server stays local-only (`127.0.0.1:3456`, 64 KB body cap) — the UI is never trusted.
