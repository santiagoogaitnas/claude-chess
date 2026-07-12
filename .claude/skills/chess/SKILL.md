---
name: chess
description: Play chess against the user in a browser UI. Launches the local chess server, receives the user's moves (via tmux injection or polling), replies with your own moves, and shuts everything down on request. Trigger on "/chess", "let's play chess", "chess game", "stop the chess game".
---

# /chess — play chess with the user

You are the opponent. The user plays on a browser board; the server in
`chess-app/server/` validates every move with chess.js and relays the user's
moves to you. Lifecycle is managed by `chess-app/bin/chess-ctl`; you play
through the CLI `chess-app/server/claude.mjs`. Design overview:
`ARCHITECTURE.md` at the repo root.

This is usually an *interlude*, not a dedicated session: the user is mid-task,
gets the itch to play a few moves, and starts a game right where they are.
Treat it that way — keep it light, don't derail whatever you were doing, and
when the game ends (§6) pick the earlier work back up where you left off
without needing to be reminded. It's a small, fun break inside a normal Claude
session, not a chess site.

Default port is **3456** (`CHESS_PORT` overrides — export it so `chess-ctl`
and `claude.mjs` agree). All paths are relative to the repo root.

## 1. Start (when the user asks to play)

1. **Start the server** (it auto-installs server deps on first run):

   ```bash
   chess-app/bin/chess-ctl start
   ```

   It captures `$TMUX_PANE` automatically (so run it in the foreground, not
   via run_in_background), reuses an already-running server, waits for
   health, opens the browser, and prints the tmux target. If it prints
   "manual mode", you are not in tmux — remember to use the §2 polling
   fallback. On failure it prints the server log; report that to the user.
2. **Start a game**: ask which color the user wants if they haven't said;
   default them to white (you black):

   ```bash
   node chess-app/server/claude.mjs new b   # b|w = YOUR color, not the user's
   ```
3. Tell the user the board is up at http://localhost:3456 and to move there.
   If you are white, make your first move now (§3).

## 2. Receiving the user's moves

- **tmux (preferred)** — after each user move the server injects a one-line
  prompt into this session stating the move, the FEN, and the SAN movetext so
  far. Respond to each
  injected prompt as it arrives; between moves, end your turn normally and
  wait. Do not busy-poll. If the user's move ends the game, the injected line
  is a game-over notice instead of a move prompt — handle it per §6, don't
  try to move. A draw-offer notice may also arrive instead of a move prompt —
  handle it per §5.
- **Takebacks** — after an undo (§4) you may be re-prompted for a position
  you thought you already answered; that's normal. Re-run `claude.mjs state`
  and play from the position it shows, not from memory.
- **Fallback (manual mode)** — the server sets `awaitingClaude: true` when
  it's your move. Poll for it with a bounded loop, then play:

  ```bash
  for i in $(seq 1 60); do
    curl -s localhost:3456/api/state | grep -q '"awaitingClaude":true' && break
    sleep 2
  done
  ```

  Loop: poll → think → move → poll, until the game ends or the user stops
  you. If the poll times out (~2 min), tell the user you're still waiting on
  their move and ask them to ping you after playing.

## 3. Making your move

1. Get the position: `node chess-app/server/claude.mjs state`
   (prints an ASCII board plus FEN, whose turn, status, and move history;
   `move` echoes the same board after your move).
2. Read the board and history, think about the position properly, and pick a
   strong legal move. Play real chess — no throwing the game, but be a good
   sport in commentary.
3. Post it (SAN like `Nf6` or UCI like `e7e5` both work):

   ```bash
   node chess-app/server/claude.mjs move Nf6
   ```

   `REJECTED` means illegal or out-of-turn: re-run `state`, list the actual
   legal moves with `curl -s localhost:3456/api/moves` (add `?square=e2` to
   filter to one piece), pick from that list, and post a corrected move.
   Never pass a turn.
4. Briefly tell the user what you played and why (one or two sentences).

Only move on your turn — the server rejects out-of-turn moves. The server is
the referee; never edit game state by hand.

## 4. Takebacks

If the user asks to take back a move (they can also click Undo in the UI):

```bash
curl -s -X POST localhost:3456/api/undo
```

It rewinds the last full move pair — your reply plus their move — so it's
their turn again with the same color. A `409` means it's currently your move
(tell them to wait for your reply, then undo), there's nothing to undo, or
the game already ended by resignation or agreed draw. Special case: if the
undo rewinds your
*opening* move as white, the server re-prompts you — just play your first
move again (a different one, if that's why they asked). Grant takebacks
graciously; it's a friendly game.

## 5. Draw offers

- **The user offers a draw** (via the UI's Offer-draw button, in chat, or via
  `curl -s -X POST localhost:3456/api/draw` — either way the server injects
  an offer notice into your session). Decide on the merits: accept if the
  position is genuinely drawish or you're worse, decline politely otherwise.

  ```bash
  node chess-app/server/claude.mjs draw accept    # or: draw decline
  ```

  Simply playing your move also declines — a pending offer lapses when
  either side moves.
- **You offer a draw** with `node chess-app/server/claude.mjs draw offer`
  (only when the position warrants it — dead-drawn endgame, forced
  repetition). The UI shows the user an accept/decline banner, and the server
  injects a notice when they answer. If they answer *in chat* instead, relay
  it for them:
  `curl -s -X POST localhost:3456/api/draw -H 'content-type: application/json' -d '{"action":"accept"}'`
  (`by` defaults to human; use `"decline"` accordingly).
- A `409` means an offer is already pending, there's no offer to answer, or
  you tried to answer your own offer.
- An accepted draw ends the game: status `draw`, and moves/undo return `409`
  until `/api/new` (§6).

## 6. Game end and shutdown

- On checkmate/stalemate/draw (by rule or by agreement, §5) — whether you
  see it in `claude.mjs state`, your own move output, or an injected
  game-over notice — announce the result and offer a rematch
  (`claude.mjs new b` or `new w`). If the user wants the game record for
  analysis, `node chess-app/server/claude.mjs pgn` prints it as PGN (the UI
  also has a Download-PGN link they can use directly).
- **Resignations** — the user can resign via the UI's Resign button (or
  `curl -s -X POST localhost:3456/api/resign`); the server injects a you-win
  notice into your session. Acknowledge the win graciously and offer a
  rematch — don't try to move. If the user asks *you* to concede (or your
  position is utterly hopeless and they'd clearly prefer to wrap up), resign
  with `node chess-app/server/claude.mjs resign`; otherwise play on — no
  premature resignations. After any resignation the game is locked
  (moves/undo return `409`) until `/api/new`.
- When the user says stop/quit/close (or declines a rematch):

  ```bash
  chess-app/bin/chess-ctl stop
  ```

  It shuts the server down and cleans up the PID/pane files. Tell the user
  the game is closed, then — if you were in the middle of something before the
  game — smoothly return to it, so the chess break feels like a quick detour
  rather than a hard context switch.

## Troubleshooting

- **`chess-ctl status`** shows whether the server is up, the tmux target
  (with a DEAD warning if the pane is gone), whether it's waiting on your
  move, any pending draw offer, the last injection error, and the current
  position; **`chess-ctl log`** tails the server log.
- **Port busy** → restart on another port and use it everywhere:
  `export CHESS_PORT=3457; chess-app/bin/chess-ctl start` — then give the
  user the new address (claude.mjs reads `CHESS_PORT` too, and adjust the
  port in any `curl localhost:3456/...` commands from this file).
- **No injected prompts arriving despite tmux** → `chess-ctl status` shows
  the pane (and flags it DEAD if gone); if it's wrong or empty, `chess-ctl
  stop` then `chess-ctl start --pane "$TMUX_PANE"`, or fall back to the §2
  polling loop. If a single prompt was lost but the pane is fine,
  `curl -s -X POST localhost:3456/api/nudge` re-injects the your-turn
  reminder (409 if it isn't actually your turn, or in manual mode).
- **Server died mid-game** → `chess-ctl log` for the cause, then
  `chess-ctl restart`. The game survives: every state change is snapshotted
  to `chess-app/.run/game-<port>.json` and restored on startup, so the
  position, colors, and whose turn it is come back as they were. If it was
  your move when it died, the restarted server re-injects the your-turn
  prompt (tmux mode) — just answer it; otherwise run `claude.mjs state` to
  re-sync and continue. (Set `CHESS_RESUME=0` only if
  you deliberately want an ephemeral, non-persisted server.)
