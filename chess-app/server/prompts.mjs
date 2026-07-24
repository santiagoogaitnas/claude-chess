/**
 * Agent-facing prompt and notice text — everything the server says to the
 * agent playing the other side of the board lives in this one file.
 *
 * server.mjs passes a context snapshot: { fen, claudeColor, movetext, status,
 * yourTurn, cli }. `movetext` is the "Moves so far: …. " fragment ('' before
 * the first move), `yourTurn` is whether the side to move is the agent, and
 * `cli(args)` renders the claude.mjs command line for the agent to run
 * (CHESS_PORT prefix included on non-default ports). Builders take that
 * context plus per-event extras and return single-line prompts safe for tmux
 * injection (a newline would submit the prompt early).
 */

const colorName = (c) => (c === 'w' ? 'White' : 'Black');

/** Your-turn prompt after a human move that keeps the game going. */
export function yourTurnPrompt({ humanMove, movetext, fen, claudeColor, status, cli }) {
  return (
    `[chess] Opponent played ${humanMove}. ${movetext}Position (FEN): ${fen}. ` +
    `You are ${colorName(claudeColor)} and it is your turn. ` +
    `Reply with exactly one legal move by running: ${cli('move <your-move>')} ` +
    `(SAN like Nf6 or UCI like g8f6). Game status: ${status}.`
  );
}

/** Your-turn reminder with no new opponent move — restart resume and nudge. */
export function turnReminderPrompt({ lead, movetext, fen, claudeColor, cli }) {
  return (
    `[chess] ${lead} ${movetext}Position (FEN): ${fen}. ` +
    `You are ${colorName(claudeColor)}. Reply with exactly one legal move by running: ` +
    `${cli('move <your-move>')} (SAN like Nf6 or UCI like g8f6).`
  );
}

/** Re-prompt after a restart restored a game where the agent owes a move. */
export function resumeReminderPrompt(ctx) {
  return turnReminderPrompt({ ...ctx, lead: 'Game resumed after a server restart — it is still your turn.' });
}

/** /api/nudge — recover a your-turn prompt that got lost. */
export function nudgeReminderPrompt(ctx) {
  return turnReminderPrompt({ ...ctx, lead: 'Reminder — it is still your turn (the previous prompt may have been lost).' });
}

/** New game where the agent is White and must open. */
export function newGamePrompt({ fen, cli }) {
  return (
    `[chess] New game started. You are White. Position (FEN): ${fen}. ` +
    `Make the first move by running: ${cli('move <your-move>')}`
  );
}

/** The human's move just ended the game (mate/stalemate/auto-draw). */
export function gameOverNotice({ humanMove, over, fen }) {
  return (
    `[chess] Opponent played ${humanMove} — game over: ${over}. ` +
    `Final position (FEN): ${fen}. No move needed; the game has ended.`
  );
}

/** The human resigned. */
export function resignedNotice({ fen }) {
  return (
    `[chess] Opponent resigned — you win! Final position (FEN): ${fen}. ` +
    `The game has ended; no move needed.`
  );
}

/** The human offers a draw. */
export function drawOfferPrompt({ fen, yourTurn, cli }) {
  return (
    `[chess] Opponent offers a draw. Position (FEN): ${fen}. ` +
    `Accept with: ${cli('draw accept')} — or decline with: ` +
    `${cli('draw decline')} (or simply play your move${yourTurn ? '' : ' when it is your turn'}, which declines).`
  );
}

/** The human accepted the agent's draw offer. */
export function drawAcceptedNotice({ fen }) {
  return (
    `[chess] Opponent accepted your draw offer — the game is drawn by agreement. ` +
    `Final position (FEN): ${fen}. No move needed.`
  );
}

/** The human declined the agent's draw offer. */
export function drawDeclinedNotice({ fen, yourTurn }) {
  return (
    `[chess] Opponent declined your draw offer — play continues. Position (FEN): ${fen}.` +
    (yourTurn ? ' It is your turn.' : ' Wait for their move.')
  );
}

/** Takeback of the agent's opening move — the agent must move again. */
export function undoOpeningPrompt({ fen, claudeColor, cli }) {
  return (
    `[chess] Opponent took back your opening move. Position (FEN): ${fen}. ` +
    `You are ${colorName(claudeColor)}; play your move again via: ` +
    `${cli('move <your-move>')}`
  );
}

/** Takeback of the last human+agent move pair — back to the human's turn. */
export function undoPairNotice({ fen }) {
  return (
    `[chess] Opponent took back the last move pair. Position (FEN): ${fen}. ` +
    `It is their turn; wait for their next move.`
  );
}
