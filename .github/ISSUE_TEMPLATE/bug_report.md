---
name: Bug report
about: Something isn't working — a move rejected wrongly, Claude not replying, the server not starting
title: "[bug] "
labels: bug
---

## What happened

<!-- A clear description of the bug and what you expected instead. -->

## Steps to reproduce

1.
2.
3.

## Diagnostics

Please run the setup checker and paste its output — it catches most environment issues:

```
chess-app/bin/chess-doctor
```

If the server is running, the tail of its log is often the smoking gun:

```
chess-app/bin/chess-ctl log 50
```

## Environment

- OS:
- Node version (`node -v`):
- tmux installed? (`tmux -V`, or "no"):
- Playing via `/chess` (tmux injection) or manual/polling mode?
