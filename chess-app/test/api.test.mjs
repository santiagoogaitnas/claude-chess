// API contract tests for chess-app/server (see server/API.md).
// Run: node --test chess-app/test/api.test.mjs
// Spawns a real server on CHESS_PORT (no tmux target -> manual mode) and
// exercises every endpoint, turn enforcement, game-over, undo, resign,
// persistence across restarts, and SSE.
// The server persists to chess-app/.run/game-<port>.json; the suite stashes
// any saved game for its port up front and restores it afterwards so a test
// run never clobbers a game in progress.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
// Default to an OS-assigned free port so concurrent runs of this suite
// (e.g. two agents testing at once) never collide; env still pins it.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}
const PORT = Number(process.env.CHESS_TEST_PORT || (await freePort()));
// Snapshots are per-port (game-<port>.json), so a test run can never touch a
// game being played on another port; we still stash/restore this port's file.
const GAME_FILE = join(__dirname, '..', '.run', `game-${PORT}.json`);
const BASE = `http://127.0.0.1:${PORT}`;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let proc;
let savedGame = null; // the user's real game.json, restored in after()

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});

async function startServer(extraEnv = {}) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CHESS_PORT: String(PORT), CHESS_TMUX_TARGET: '', ...extraEnv },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/state');
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  p.kill('SIGKILL');
  throw new Error(`server did not start on :${PORT}`);
}

function waitExit(p, ms = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

// Persistence is fire-and-forget; wait until the snapshot contains `needle`.
// Generous ceiling: under a full parallel `npm test` (three suites + their
// spawned servers) the write can land well past 2s; polling means a passing
// run never waits longer than it has to.
async function waitPersisted(needle, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(GAME_FILE, 'utf8')).includes(needle)) return true;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

before(async () => {
  savedGame = await readFile(GAME_FILE, 'utf8').catch(() => null);
  await rm(GAME_FILE, { force: true }); // start from a clean slate
  proc = await startServer();
});

after(async () => {
  proc?.kill('SIGKILL');
  // Put the user's saved game back exactly as we found it.
  if (savedGame !== null) {
    await mkdir(dirname(GAME_FILE), { recursive: true });
    await writeFile(GAME_FILE, savedGame);
  } else {
    await rm(GAME_FILE, { force: true });
  }
});

test('fresh state has the documented shape and defaults', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  assert.equal(body.fen, START_FEN);
  assert.equal(body.turn, 'w');
  assert.equal(body.claudeColor, 'b');
  assert.equal(body.awaitingClaude, false);
  assert.equal(body.status, 'playing');
  assert.equal(body.statusDetail, null);
  assert.equal(body.gameOver, false);
  assert.equal(body.resignedBy, null);
  assert.equal(body.lastMove, null);
  assert.equal(body.drawOfferBy, null);
  assert.equal(body.drawAgreed, false);
  assert.deepEqual(body.history, []);
  assert.equal(body.lastError, null);
  assert.equal(body.tmuxTarget, null);
  assert.equal(typeof body.pgn, 'string');
});

test('/api/moves returns all legal moves and per-square moves', async () => {
  const all = await get('/api/moves');
  assert.equal(all.status, 200);
  assert.equal(all.body.moves.length, 20);
  const e2 = await get('/api/moves?square=e2');
  assert.equal(e2.status, 200);
  assert.deepEqual(e2.body.moves.map((m) => m.to).sort(), ['e3', 'e4']);
});

test('human SAN move is accepted and hands the turn to Claude', async () => {
  const { status, body } = await post('/api/move', { move: 'e4' });
  assert.equal(status, 200);
  assert.equal(body.awaitingClaude, true);
  assert.equal(body.turn, 'b');
  assert.deepEqual(body.history, ['e4']);
});

test('human cannot move while awaiting Claude (409)', async () => {
  const { status, body } = await post('/api/move', { move: 'd4' });
  assert.equal(status, 409);
  assert.match(body.error, /not your turn/);
  assert.deepEqual(body.history, ['e4']); // state unchanged
});

test('illegal Claude move is rejected with 400 and does not change state', async () => {
  const { status, body } = await post('/api/claude/move', { move: 'Ke2' });
  assert.equal(status, 400);
  assert.match(body.error, /illegal move/);
  assert.equal(body.awaitingClaude, true);
});

test('legal Claude move (UCI) is accepted and clears awaitingClaude', async () => {
  const { status, body } = await post('/api/claude/move', { move: 'e7e5' });
  assert.equal(status, 200);
  assert.equal(body.awaitingClaude, false);
  assert.equal(body.turn, 'w');
  assert.deepEqual(body.history, ['e4', 'e5']);
});

test('Claude cannot move on the human turn (409)', async () => {
  const { status, body } = await post('/api/claude/move', { move: 'Nc6' });
  assert.equal(status, 409);
  assert.match(body.error, /not claude turn/);
});

test('undo takes back the last full move pair', async () => {
  const { status, body } = await post('/api/undo');
  assert.equal(status, 200);
  assert.deepEqual(body.history, []);
  assert.equal(body.fen, START_FEN);
});

test('undo with no moves played returns 409', async () => {
  const { status, body } = await post('/api/undo');
  assert.equal(status, 409);
  assert.match(body.error, /nothing to undo/);
});

test('undo while awaiting Claude returns 409', async () => {
  await post('/api/move', { move: 'e4' });
  const { status, body } = await post('/api/undo');
  assert.equal(status, 409);
  assert.match(body.error, /cannot undo while waiting/);
  await post('/api/claude/move', { move: 'e5' }); // restore a clean turn
});

test('new game with claudeColor w puts Claude to move first', async () => {
  const { status, body } = await post('/api/new', { claudeColor: 'w' });
  assert.equal(status, 200);
  assert.equal(body.claudeColor, 'w');
  assert.equal(body.awaitingClaude, true);
  assert.deepEqual(body.history, []);
  // Human cannot move: it is Claude's turn.
  const rejected = await post('/api/move', { move: 'e4' });
  assert.equal(rejected.status, 409);
  const claude = await post('/api/claude/move', { move: 'e4' });
  assert.equal(claude.status, 200);
  assert.equal(claude.body.awaitingClaude, false);
});

test("fool's mate reaches checkmate and locks the game", async () => {
  await post('/api/new', { claudeColor: 'b' });
  await post('/api/move', { move: 'f3' });
  await post('/api/claude/move', { move: 'e5' });
  await post('/api/move', { move: 'g4' });
  const mate = await post('/api/claude/move', { move: 'Qh4#' });
  assert.equal(mate.status, 200);
  assert.equal(mate.body.status, 'checkmate');
  assert.equal(mate.body.statusDetail, 'checkmate — Black wins');
  assert.equal(mate.body.gameOver, true);
  // No side may move after game over.
  const human = await post('/api/move', { move: 'a3' });
  assert.equal(human.status, 409);
  assert.match(human.body.error, /game over/);
  const claude = await post('/api/claude/move', { move: 'a6' });
  assert.equal(claude.status, 409);
  assert.match(claude.body.error, /game over/);
  await post('/api/new', { claudeColor: 'b' });
});

test('human resignation ends the game and blocks all further play', async () => {
  await post('/api/move', { move: 'e4' });
  await post('/api/claude/move', { move: 'e5' });
  const { status, body } = await post('/api/resign'); // default by: human
  assert.equal(status, 200);
  assert.equal(body.status, 'resigned');
  assert.equal(body.statusDetail, 'White resigned');
  assert.equal(body.gameOver, true);
  assert.equal(body.resignedBy, 'w'); // human plays white when Claude is black
  assert.equal(body.awaitingClaude, false);
  const human = await post('/api/move', { move: 'd4' });
  assert.equal(human.status, 409);
  const claude = await post('/api/claude/move', { move: 'Nc6' });
  assert.equal(claude.status, 409);
  const undo = await post('/api/undo');
  assert.equal(undo.status, 409);
  assert.match(undo.body.error, /resigned/);
  const again = await post('/api/resign');
  assert.equal(again.status, 409);
  assert.match(again.body.error, /game over/);
});

test('new game clears a resignation; Claude can resign too', async () => {
  const fresh = await post('/api/new', { claudeColor: 'b' });
  assert.equal(fresh.body.resignedBy, null);
  assert.equal(fresh.body.gameOver, false);
  const { status, body } = await post('/api/resign', { by: 'claude' });
  assert.equal(status, 200);
  assert.equal(body.resignedBy, 'b'); // Claude's color
  assert.equal(body.status, 'resigned');
  await post('/api/new', { claudeColor: 'b' });
});

test('draw offer: double-offer 409, own-answer 409, decline clears it', async () => {
  const offer = await post('/api/draw'); // defaults: by human, action offer
  assert.equal(offer.status, 200);
  assert.equal(offer.body.drawOfferBy, 'w'); // human is white when Claude is black
  assert.equal(offer.body.drawAgreed, false);
  const again = await post('/api/draw', { by: 'claude' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already pending/);
  const own = await post('/api/draw', { action: 'accept' });
  assert.equal(own.status, 409);
  assert.match(own.body.error, /own draw offer/);
  const decline = await post('/api/draw', { by: 'claude', action: 'decline' });
  assert.equal(decline.status, 200);
  assert.equal(decline.body.drawOfferBy, null);
  assert.equal(decline.body.gameOver, false);
});

test('draw answer with no offer pending is 409; unknown action is 400', async () => {
  const none = await post('/api/draw', { action: 'accept' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /no draw offer pending/);
  const bad = await post('/api/draw', { action: 'flip' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /unknown draw action/);
});

test('a pending draw offer lapses when a move is played', async () => {
  const offer = await post('/api/draw', { by: 'claude' });
  assert.equal(offer.status, 200);
  assert.equal(offer.body.drawOfferBy, 'b');
  const move = await post('/api/move', { move: 'e4' });
  assert.equal(move.status, 200);
  assert.equal(move.body.drawOfferBy, null);
  await post('/api/claude/move', { move: 'e5' });
});

test('accepted draw ends the game and locks it until /api/new', async () => {
  await post('/api/draw', { by: 'claude' });
  const accept = await post('/api/draw', { action: 'accept' }); // human accepts
  assert.equal(accept.status, 200);
  assert.equal(accept.body.drawAgreed, true);
  assert.equal(accept.body.drawOfferBy, null);
  assert.equal(accept.body.status, 'draw');
  assert.equal(accept.body.statusDetail, 'draw by agreement');
  assert.equal(accept.body.gameOver, true);
  assert.equal((await post('/api/move', { move: 'd4' })).status, 409);
  assert.equal((await post('/api/claude/move', { move: 'Nc6' })).status, 409);
  assert.equal((await post('/api/undo')).status, 409);
  assert.equal((await post('/api/resign')).status, 409);
  assert.equal((await post('/api/draw')).status, 409);
  // PGN records the agreed result.
  const pgn = await (await fetch(BASE + '/api/pgn')).text();
  assert.match(pgn, /\[Result "1\/2-1\/2"\]/);
  assert.match(pgn, /1\/2-1\/2\s*$/);
  const fresh = await post('/api/new', { claudeColor: 'b' });
  assert.equal(fresh.body.drawAgreed, false);
  assert.equal(fresh.body.drawOfferBy, null);
  assert.equal(fresh.body.gameOver, false);
});

test('GET /api/pgn exports headers, movetext and in-progress result', async () => {
  await post('/api/move', { move: 'e4' });
  await post('/api/claude/move', { move: 'e5' });
  const res = await fetch(BASE + '/api/pgn');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /x-chess-pgn/);
  const pgn = await res.text();
  for (const h of ['Event', 'Site', 'Date', 'White', 'Black', 'Result']) {
    assert.match(pgn, new RegExp(`\\[${h} "`), `missing [${h} ...] header`);
  }
  assert.match(pgn, /\[White "Human"\]/);
  assert.match(pgn, /\[Black "Claude"\]/);
  assert.match(pgn, /1\. e4 e5/);
  assert.match(pgn, /\*\s*$/); // game still in progress
  await post('/api/new', { claudeColor: 'b' }); // clean board for the tests below
});

test('/api/nudge: 409 when no move is owed, in manual mode, and after game over', async () => {
  // Fresh board, human to move — nothing is owed to Claude.
  const idle = await post('/api/nudge');
  assert.equal(idle.status, 409);
  assert.match(idle.body.error, /nothing to nudge/);
  // Hand the turn to Claude; this suite runs the server with no tmux target,
  // so even a legitimately owed nudge is rejected as manual mode.
  await post('/api/move', { move: 'e4' });
  const manual = await post('/api/nudge');
  assert.equal(manual.status, 409);
  assert.match(manual.body.error, /tmux/);
  await post('/api/claude/move', { move: 'e5' });
  // Game over wins over everything else.
  await post('/api/resign');
  const over = await post('/api/nudge');
  assert.equal(over.status, 409);
  assert.match(over.body.error, /game over/);
  await post('/api/new', { claudeColor: 'b' });
});

test('stalemate ends the game with statusDetail and locks both sides', async () => {
  // Sam Loyd's 10-move stalemate; human plays White, Claude Black.
  const white = ['e3', 'Qh5', 'Qxa5', 'Qxc7', 'h4', 'Qxd7+', 'Qxb7', 'Qxb8', 'Qxc8', 'Qe6'];
  const black = ['a5', 'Ra6', 'h5', 'Rah6', 'f6', 'Kf7', 'Qd3', 'Qh7', 'Kg6'];
  for (let i = 0; i < white.length; i++) {
    const w = await post('/api/move', { move: white[i] });
    assert.equal(w.status, 200, `white ${white[i]}: ${w.body.error}`);
    if (i < black.length) {
      const b = await post('/api/claude/move', { move: black[i] });
      assert.equal(b.status, 200, `black ${black[i]}: ${b.body.error}`);
    }
  }
  const { body } = await get('/api/state');
  assert.equal(body.status, 'stalemate');
  assert.equal(body.statusDetail, 'stalemate');
  assert.equal(body.gameOver, true);
  assert.equal((await post('/api/claude/move', { move: 'Kg7' })).status, 409);
  assert.equal((await post('/api/move', { move: 'Kg2' })).status, 409);
  await post('/api/new', { claudeColor: 'b' });
});

test('threefold repetition ends the game with statusDetail', async () => {
  for (let i = 0; i < 2; i++) {
    await post('/api/move', { move: 'Nf3' });
    await post('/api/claude/move', { move: 'Nc6' });
    await post('/api/move', { move: 'Ng1' });
    await post('/api/claude/move', { move: 'Nb8' });
  }
  // Start position has now occurred three times.
  const { body } = await get('/api/state');
  assert.equal(body.statusDetail, 'draw by threefold repetition');
  assert.equal(body.status, 'draw');
  assert.equal(body.gameOver, true);
  assert.equal((await post('/api/move', { move: 'e4' })).status, 409);
  await post('/api/new', { claudeColor: 'b' }); // clean board for the tests below
});

test('SSE /events sends the current state immediately', async () => {
  const controller = new AbortController();
  const res = await fetch(BASE + '/events', { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /^data: /);
  const state = JSON.parse(text.slice(6).trim());
  assert.equal(state.fen, START_FEN);
  controller.abort();
});

test('GET / serves the web UI', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<html/i);
});

test('static handler blocks path traversal out of web/', async () => {
  const res = await fetch(BASE + '/%2e%2e/chess-app/server/server.mjs');
  assert.notEqual(res.status, 200);
});

test('game state survives a server restart via .run/game.json', async () => {
  await post('/api/new', { claudeColor: 'b' });
  await post('/api/move', { move: 'e4' });
  await post('/api/claude/move', { move: 'e5' });
  assert.equal(await waitPersisted('e5'), true, 'snapshot never reached game.json');
  proc.kill('SIGKILL');
  await waitExit(proc);
  proc = await startServer();
  const { body } = await get('/api/state');
  assert.deepEqual(body.history, ['e4', 'e5']);
  assert.equal(body.turn, 'w');
  assert.equal(body.awaitingClaude, false);
  assert.deepEqual(body.lastMove, { from: 'e7', to: 'e5', san: 'e5' });
});

test('CHESS_RESUME=0 ignores the saved game and starts fresh', async () => {
  proc.kill('SIGKILL');
  await waitExit(proc);
  proc = await startServer({ CHESS_RESUME: '0' });
  const { body } = await get('/api/state');
  assert.deepEqual(body.history, []);
  assert.equal(body.fen, START_FEN);
});

test('/api/shutdown stops the server', async () => {
  const { status, body } = await post('/api/shutdown');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // The process should exit on its own shortly after.
  assert.equal(await waitExit(proc), true);
});
