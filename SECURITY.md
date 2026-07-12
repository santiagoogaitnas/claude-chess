# Security Policy

Chess with Claude runs entirely on your own machine. It ships no accounts, no
network exposure, and one dependency. This document explains the security model
so you can reason about what the app can and cannot do, and how to report a
problem responsibly.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Instead, use
GitHub's **[Report a vulnerability](../../security/advisories/new)** flow
(Security → Advisories → Report a vulnerability) to disclose it privately. If
that is unavailable, open a minimal issue titled "security contact request"
without details and a maintainer will arrange a private channel.

Please include: what you observed, the steps to reproduce, and the impact you
think it has. We aim to acknowledge reports within a few days.

## Security model

The design goal is that running the app is no more dangerous than running any
local dev server. The relevant guarantees are enforced **server-side** in
`chess-app/server/server.mjs` — the browser UI is never trusted.

- **Local-only by default.** The server binds `127.0.0.1` explicitly
  (`server.listen(PORT, '127.0.0.1', …)`), so it is reachable only from your own
  machine and is never exposed to your network or the internet.
- **No shell interpolation.** Moves are relayed into Claude's terminal with
  `execFile('tmux', ['send-keys', …])` — an argument vector, not a shell string
  — and the move text is sent with tmux's `-l` (literal) flag, so a crafted move
  cannot inject key sequences or shell commands.
- **The server is the referee.** Every move is validated with chess.js on the
  server. Move legality and turn order are enforced there; the UI cannot make an
  illegal move happen, no matter what it sends.
- **Bounded input.** Request bodies larger than 64 KB are refused
  (`MAX_BODY = 64 * 1024`); the API only ever accepts tiny move/flag JSON.
- **No secrets, no accounts.** There is no authentication, no cookies, and no
  credentials stored or transmitted. Game state lives in a local PGN file under
  `chess-app/.run/` (git-ignored). There is nothing to leak.
- **One dependency.** The server's only runtime dependency is chess.js, pinned
  via `chess-app/server/package-lock.json` and installed with `npm ci` in CI.

## What is intentionally out of scope

- **There is no authentication.** Because the server binds `127.0.0.1` and is
  meant for a single local player, any process on your machine can talk to it
  while a game is running. Do **not** put this behind a reverse proxy, forward
  its port, or bind it to a public interface. It is not hardened for a hostile
  network and is not meant to be.
- **tmux move injection is a convenience, not a sandbox.** When
  `CHESS_TMUX_TARGET` is set, the server types into that pane. Point it only at
  a pane you own that is running your Claude session.
- **Claude Code itself** is governed by its own permissions and is out of scope
  for this repo.

## Supported versions

This is a small single-branch project; only the latest `main` is supported.
Please reproduce any report against the current `main` before filing.
