#!/usr/bin/env node
/**
 * Chess bridge server — V1
 *
 * Human plays through the web UI; each human move is injected into a running
 * Claude session via `tmux send-keys`. Claude answers by calling the CLI
 * (`node server/claude.mjs move e7e5`) or POSTing to /api/claude/move.
 *
 * Endpoints:
 *   GET  /api/state           -> full game state (fen, turn, history, status)
 *   GET  /api/moves[?square=] -> legal moves (all, or from one square) for UI hints
 *   POST /api/move            -> {move} human move (SAN or UCI); injects prompt to Claude
 *   POST /api/claude/move     -> {move} Claude's reply move
 *   POST /api/undo            -> take back the last full move (human + Claude reply)
 *   POST /api/resign          -> {by?: 'human'|'claude'} resign the game (default human)
 *   POST /api/draw            -> {by?, action?: 'offer'|'accept'|'decline'} draw negotiation
 *   POST /api/nudge           -> re-inject the your-turn prompt (recover a lost injection)
 *   GET  /api/pgn             -> the game as annotated PGN text (for export/analysis)
 *   GET  /api/games           -> archive of past games on this port as concatenated PGN
 *   POST /api/new             -> {claudeColor?} start a new game (default claude=black)
 *   POST /api/shutdown        -> stop the server
 *   GET  /events              -> Server-Sent Events stream of state updates
 *   GET  /                    -> serves repo-root web/ static files (if present)
 *
 * Config (env):
 *   CHESS_PORT         port to listen on            (default 3456)
 *   CHESS_TMUX_TARGET  tmux pane running claude      (default: none -> injection disabled, manual mode)
 *   CHESS_RESUME       set to 0 for an ephemeral game (skip restoring/writing .run/game-<port>.json)
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { Chess } from 'chess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..', '..', 'web');
const RUN_DIR = join(__dirname, '..', '.run');
const PORT = Number(process.env.CHESS_PORT || 3456);
const GAME_FILE = join(RUN_DIR, `game-${PORT}.json`);
const ARCHIVE_FILE = join(RUN_DIR, `games-${PORT}.pgn`);
const TMUX_TARGET = process.env.CHESS_TMUX_TARGET || '';
const PERSIST = process.env.CHESS_RESUME !== '0'; // 0 = ephemeral: no restore, no snapshots

let game = new Chess();
let claudeColor = 'b'; // 'w' | 'b'
let awaitingClaude = false;
let resignedBy = null; // 'w' | 'b' | null
let drawOfferBy = null; // 'w' | 'b' | null — pending draw offer
let drawAgreed = false;
let archived = false; // current game already appended to the archive
let lastError = null;
const sseClients = new Set();

// ---------- game state ----------
function statusOf(g) {
  if (resignedBy) return 'resigned';
  if (drawAgreed) return 'draw';
  if (g.isCheckmate()) return 'checkmate';
  if (g.isStalemate()) return 'stalemate';
  if (g.isDraw()) return 'draw';
  if (g.isCheck()) return 'check';
  return 'playing';
}

/** Human-readable reason the game ended (null while in progress). */
function statusDetailOf(g) {
  if (resignedBy) return `${resignedBy === 'w' ? 'White' : 'Black'} resigned`;
  if (drawAgreed) return 'draw by agreement';
  if (g.isCheckmate()) return `checkmate — ${g.turn() === 'w' ? 'Black' : 'White'} wins`;
  if (g.isStalemate()) return 'stalemate';
  if (g.isThreefoldRepetition()) return 'draw by threefold repetition';
  if (g.isInsufficientMaterial()) return 'draw by insufficient material';
  if (g.isDrawByFiftyMoves()) return 'draw by fifty-move rule';
  return null;
}

function isOver() {
  return !!resignedBy || drawAgreed || game.isGameOver();
}

function state() {
  const last = game.history({ verbose: true }).at(-1);
  return {
    fen: game.fen(),
    lastMove: last ? { from: last.from, to: last.to, san: last.san } : null,
    pgn: game.pgn(),
    turn: game.turn(),
    claudeColor,
    awaitingClaude,
    status: statusOf(game),
    statusDetail: statusDetailOf(game),
    gameOver: isOver(),
    resignedBy,
    drawOfferBy,
    drawAgreed,
    history: game.history(),
    lastError,
    tmuxTarget: TMUX_TARGET || null,
  };
}

// ---------- persistence ----------
function persist() {
  if (!PERSIST) return;
  const snapshot = JSON.stringify({ pgn: game.pgn(), claudeColor, awaitingClaude, resignedBy, drawOfferBy, drawAgreed, archived });
  writeFile(GAME_FILE, snapshot).catch((e) => {
    lastError = `persist failed: ${e.message}`;
  });
}

function restore() {
  if (!PERSIST) return;
  try {
    const saved = JSON.parse(readFileSync(GAME_FILE, 'utf8'));
    const g = new Chess();
    g.loadPgn(saved.pgn || '');
    game = g;
    claudeColor = saved.claudeColor === 'w' ? 'w' : 'b';
    awaitingClaude = !!saved.awaitingClaude;
    resignedBy = saved.resignedBy === 'w' || saved.resignedBy === 'b' ? saved.resignedBy : null;
    drawOfferBy = saved.drawOfferBy === 'w' || saved.drawOfferBy === 'b' ? saved.drawOfferBy : null;
    drawAgreed = !!saved.drawAgreed;
    // Pre-archive snapshots lack the flag; assume a finished game was archived
    // when it ended so a restart doesn't append it a second time.
    archived = 'archived' in saved ? !!saved.archived : isOver();
    if (game.history().length || resignedBy) {
      console.log(`[chess] resumed saved game (${game.history().length} half-moves, status: ${statusOf(game)})`);
    }
  } catch {
    /* no saved game, or unreadable — start fresh */
  }
}

function broadcast() {
  if (isOver()) archiveGame();
  else archived = false; // a takeback revived an archived finish — the next finish is a new entry
  const payload = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of sseClients) res.write(payload);
  persist();
}

/**
 * Append the current game's PGN to the per-port archive (once per finish).
 * Called for finished games on every broadcast, and by /api/new when it
 * discards an unfinished game — those are archived with result '*'.
 */
function archiveGame() {
  if (!PERSIST || archived) return;
  if (game.history().length === 0 && !resignedBy) return; // nothing worth keeping
  archived = true;
  appendFile(ARCHIVE_FILE, `${exportPgn()}\n`).catch((e) => {
    lastError = `archive failed: ${e.message}`;
  });
}

/** Try a move given in SAN ("Nf3") or UCI ("g1f3"); returns move object or null. */
function tryMove(g, moveStr) {
  const s = String(moveStr || '').trim();
  if (!s) return null;
  try {
    return g.move(s); // SAN
  } catch {
    /* fall through to UCI */
  }
  const m = s.toLowerCase().match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (!m) return null;
  try {
    return g.move({ from: m[1], to: m[2], promotion: m[3] || 'q' });
  } catch {
    return null;
  }
}

/** PGN result token for the current game ('*' while in progress). */
function resultToken() {
  if (resignedBy) return resignedBy === 'w' ? '0-1' : '1-0';
  if (game.isCheckmate()) return game.turn() === 'w' ? '0-1' : '1-0';
  if (drawAgreed || game.isDraw() || game.isStalemate()) return '1/2-1/2';
  return '*';
}

/** Full PGN with headers, on a clone so the live game stays header-free. */
function exportPgn() {
  const g = new Chess();
  g.loadPgn(game.pgn());
  const result = resultToken();
  const headers = {
    Event: 'Claude Chess (local bridge)',
    Site: `localhost:${PORT}`,
    Date: new Date().toISOString().slice(0, 10).replaceAll('-', '.'),
    White: claudeColor === 'w' ? 'Claude' : 'Human',
    Black: claudeColor === 'b' ? 'Claude' : 'Human',
    Result: result,
  };
  for (const [k, v] of Object.entries(headers)) (g.setHeader ?? g.header).call(g, k, v);
  const body = g.pgn().trimEnd();
  return body.endsWith(result) ? `${body}\n` : `${body} ${result}\n`;
}

// ---------- tmux bridge ----------
function injectToClaude(text) {
  if (!TMUX_TARGET) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Send the prompt text, then Enter as a separate key event so the
    // client treats it as message submission rather than literal text.
    execFile('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', text], (err) => {
      if (err) {
        lastError = `tmux inject failed: ${err.message}`;
        return resolve(false);
      }
      setTimeout(() => {
        execFile('tmux', ['send-keys', '-t', TMUX_TARGET, 'Enter'], (err2) => {
          if (err2) lastError = `tmux Enter failed: ${err2.message}`;
          resolve(!err2);
        });
      }, 150);
    });
  });
}

/**
 * SAN movetext so far ("1. e4 e5 2. Nf3"), or '' before the first move.
 * game.pgn() may include header lines and a result token, and its newlines
 * would prematurely submit the injected tmux prompt — keep movetext only.
 */
function movesSoFar() {
  const movetext = game.pgn()
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('['))
    .join(' ')
    .replace(/\s*\*\s*$/, '')
    .trim();
  return movetext ? `Moves so far: ${movetext}. ` : '';
}

// Build the claude.mjs command Claude is told to run. When the server is on a
// non-default port (e.g. after `chess-ctl start --port N`), prefix CHESS_PORT
// so the reply hits THIS server — without it, claude.mjs defaults to 3456 and
// Claude's move would silently miss this game.
const CLAUDE_CLI = join(__dirname, 'claude.mjs');
function claudeCli(args) {
  const prefix = PORT === 3456 ? '' : `CHESS_PORT=${PORT} `;
  return `${prefix}node "${CLAUDE_CLI}" ${args}`;
}

function claudePrompt(humanMove) {
  const replyCmd = claudeCli('move <your-move>');
  return (
    `[chess] Opponent played ${humanMove}. ${movesSoFar()}Position (FEN): ${game.fen()}. ` +
    `You are ${claudeColor === 'w' ? 'White' : 'Black'} and it is your turn. ` +
    `Reply with exactly one legal move by running: ${replyCmd} ` +
    `(SAN like Nf6 or UCI like g8f6). Game status: ${statusOf(game)}.`
  );
}

/** Your-turn reminder with no new opponent move — used for restart resume and /api/nudge. */
function turnReminderPrompt(lead) {
  return (
    `[chess] ${lead} ${movesSoFar()}Position (FEN): ${game.fen()}. ` +
    `You are ${claudeColor === 'w' ? 'White' : 'Black'}. Reply with exactly one legal move by running: ` +
    `${claudeCli('move <your-move>')} (SAN like Nf6 or UCI like g8f6).`
  );
}

/** One-line game-over description, e.g. "draw (draw by threefold repetition)". */
function gameOverText() {
  const detail = statusDetailOf(game);
  return `${statusOf(game)}${detail ? ` (${detail})` : ''}`;
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let path = new URL(req.url, 'http://x').pathname;
  if (path === '/') path = '/index.html';
  const file = normalize(join(UI_DIR, path));
  if (!file.startsWith(UI_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    await stat(file);
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found (UI not built yet? hit /api/state)' });
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 64 * 1024; // request bodies are tiny move/flag JSON; refuse anything bigger

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && path === '/api/state') return send(res, 200, state());

  if (req.method === 'GET' && path === '/api/moves') {
    const square = new URL(req.url, 'http://x').searchParams.get('square');
    try {
      const moves = game.moves(square ? { square, verbose: true } : { verbose: true });
      return send(res, 200, { moves });
    } catch {
      return send(res, 400, { error: `invalid square: ${square}` });
    }
  }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify(state())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/api/new') {
    const body = await readBody(req);
    archiveGame(); // keep a record of an unfinished game being discarded (result '*')
    game = new Chess();
    claudeColor = body.claudeColor === 'w' ? 'w' : 'b';
    awaitingClaude = claudeColor === 'w';
    resignedBy = null;
    drawOfferBy = null;
    drawAgreed = false;
    archived = false;
    lastError = null;
    if (awaitingClaude) {
      await injectToClaude(
        `[chess] New game started. You are White. Position (FEN): ${game.fen()}. ` +
        `Make the first move by running: ${claudeCli('move <your-move>')}`
      );
    }
    broadcast();
    return send(res, 200, state());
  }

  if (req.method === 'POST' && path === '/api/move') {
    const body = await readBody(req);
    if (isOver()) return send(res, 409, { error: 'game over', ...state() });
    if (game.turn() === claudeColor) return send(res, 409, { error: "not your turn — waiting for Claude", ...state() });
    const mv = tryMove(game, body.move);
    if (!mv) return send(res, 400, { error: `illegal move: ${body.move}`, ...state() });
    lastError = null;
    drawOfferBy = null; // playing a move lets any pending offer lapse
    awaitingClaude = !game.isGameOver();
    broadcast();
    if (awaitingClaude) {
      injectToClaude(claudePrompt(mv.san)).then(broadcast);
    } else {
      injectToClaude(
        `[chess] Opponent played ${mv.san} — game over: ${gameOverText()}. ` +
        `Final position (FEN): ${game.fen()}. No move needed; the game has ended.`
      ).then(broadcast);
    }
    return send(res, 200, state());
  }

  if (req.method === 'POST' && path === '/api/resign') {
    const body = await readBody(req);
    if (isOver()) return send(res, 409, { error: 'game over', ...state() });
    const by = body.by === 'claude' ? claudeColor : claudeColor === 'w' ? 'b' : 'w';
    resignedBy = by;
    awaitingClaude = false;
    drawOfferBy = null;
    lastError = null;
    broadcast();
    if (by !== claudeColor) {
      injectToClaude(
        `[chess] Opponent resigned — you win! Final position (FEN): ${game.fen()}. ` +
        `The game has ended; no move needed.`
      ).then(broadcast);
    }
    return send(res, 200, state());
  }

  if (req.method === 'GET' && path === '/api/games') {
    let text = '';
    try { text = await readFile(ARCHIVE_FILE, 'utf8'); } catch { /* no games archived yet */ }
    res.writeHead(200, {
      'Content-Type': 'application/x-chess-pgn; charset=utf-8',
      'Content-Disposition': 'inline; filename="games.pgn"',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(text);
  }

  if (req.method === 'GET' && path === '/api/pgn') {
    res.writeHead(200, {
      'Content-Type': 'application/x-chess-pgn; charset=utf-8',
      'Content-Disposition': 'inline; filename="game.pgn"',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(exportPgn());
  }

  if (req.method === 'POST' && path === '/api/draw') {
    const body = await readBody(req);
    const actor = body.by === 'claude' ? claudeColor : claudeColor === 'w' ? 'b' : 'w';
    const action = body.action || 'offer';
    if (isOver()) return send(res, 409, { error: 'game over', ...state() });

    if (action === 'offer') {
      if (drawOfferBy) return send(res, 409, { error: 'a draw offer is already pending', ...state() });
      drawOfferBy = actor;
      broadcast();
      if (actor !== claudeColor) {
        injectToClaude(
          `[chess] Opponent offers a draw. Position (FEN): ${game.fen()}. ` +
          `Accept with: ${claudeCli('draw accept')} — or decline with: ` +
          `${claudeCli('draw decline')} (or simply play your move${game.turn() === claudeColor ? '' : ' when it is your turn'}, which declines).`
        ).then(broadcast);
      }
      return send(res, 200, state());
    }

    if (action === 'accept' || action === 'decline') {
      if (!drawOfferBy) return send(res, 409, { error: 'no draw offer pending', ...state() });
      if (drawOfferBy === actor) return send(res, 409, { error: 'cannot answer your own draw offer', ...state() });
      if (action === 'accept') {
        drawAgreed = true;
        drawOfferBy = null;
        awaitingClaude = false;
        lastError = null;
        broadcast();
        if (actor !== claudeColor) {
          injectToClaude(
            `[chess] Opponent accepted your draw offer — the game is drawn by agreement. ` +
            `Final position (FEN): ${game.fen()}. No move needed.`
          ).then(broadcast);
        }
      } else {
        drawOfferBy = null;
        broadcast();
        if (actor !== claudeColor) {
          injectToClaude(
            `[chess] Opponent declined your draw offer — play continues. Position (FEN): ${game.fen()}.` +
            (game.turn() === claudeColor ? ' It is your turn.' : ' Wait for their move.')
          ).then(broadcast);
        }
      }
      return send(res, 200, state());
    }

    return send(res, 400, { error: `unknown draw action: ${action}`, ...state() });
  }

  if (req.method === 'POST' && path === '/api/undo') {
    if (game.history().length === 0) return send(res, 409, { error: 'nothing to undo', ...state() });
    if (resignedBy) return send(res, 409, { error: 'game over (resigned)', ...state() });
    if (drawAgreed) return send(res, 409, { error: 'game over (draw agreed)', ...state() });
    if (awaitingClaude) return send(res, 409, { error: 'cannot undo while waiting for Claude', ...state() });
    // Take back Claude's reply (if any) plus the human move that preceded it,
    // so it is the human's turn again with their last move removed.
    game.undo();
    if (game.history().length > 0 && game.turn() === claudeColor) game.undo();
    lastError = null;
    drawOfferBy = null;
    if (game.turn() === claudeColor) {
      // Only Claude's opening move existed; it's Claude's turn again.
      awaitingClaude = true;
      broadcast();
      injectToClaude(
        `[chess] Opponent took back your opening move. Position (FEN): ${game.fen()}. ` +
        `You are ${claudeColor === 'w' ? 'White' : 'Black'}; play your move again via: ` +
        `${claudeCli('move <your-move>')}`
      ).then(broadcast);
    } else {
      broadcast();
      injectToClaude(
        `[chess] Opponent took back the last move pair. Position (FEN): ${game.fen()}. ` +
        `It is their turn; wait for their next move.`
      ).then(broadcast);
    }
    return send(res, 200, state());
  }

  if (req.method === 'POST' && path === '/api/nudge') {
    if (isOver()) return send(res, 409, { error: 'game over', ...state() });
    if (!awaitingClaude) return send(res, 409, { error: 'not waiting for Claude — nothing to nudge', ...state() });
    if (!TMUX_TARGET) return send(res, 409, { error: 'no tmux target configured (manual mode)', ...state() });
    const ok = await injectToClaude(
      turnReminderPrompt('Reminder — it is still your turn (the previous prompt may have been lost).')
    );
    broadcast();
    if (!ok) return send(res, 502, { error: lastError || 'tmux inject failed', ...state() });
    lastError = null;
    return send(res, 200, state());
  }

  if (req.method === 'POST' && path === '/api/claude/move') {
    const body = await readBody(req);
    if (isOver()) return send(res, 409, { error: 'game over', ...state() });
    if (game.turn() !== claudeColor) return send(res, 409, { error: 'not claude turn', ...state() });
    const mv = tryMove(game, body.move);
    if (!mv) return send(res, 400, { error: `illegal move: ${body.move}`, ...state() });
    awaitingClaude = false;
    drawOfferBy = null; // playing a move lets any pending offer lapse
    lastError = null;
    broadcast();
    return send(res, 200, state());
  }

  if (req.method === 'POST' && path === '/api/shutdown') {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 404, { error: 'not found' });
});

mkdirSync(RUN_DIR, { recursive: true });
restore();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[chess] server on http://localhost:${PORT}`);
  console.log(`[chess] tmux target: ${TMUX_TARGET || '(none — manual mode, Claude replies via claude.mjs)'}`);
  // If we resumed a game where Claude owed a move, the pre-restart prompt is
  // gone with the old process — re-inject it so the game doesn't stall.
  if (awaitingClaude && !isOver() && TMUX_TARGET) {
    injectToClaude(
      turnReminderPrompt('Game resumed after a server restart — it is still your turn.')
    ).then(broadcast);
  }
});
