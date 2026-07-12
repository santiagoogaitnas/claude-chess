#!/usr/bin/env node
/**
 * Regression test for the chess bridge server. Spawns a real server on a
 * test port (manual mode, no tmux) and exercises the full API contract.
 *
 *   npm test        (or: node test.mjs)
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** OS-assigned free port, so concurrent test runs never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const PORT = Number(process.env.CHESS_TEST_PORT || await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: res.status, data: await res.json() };
}

const server = spawn('node', [join(__dirname, 'server.mjs')], {
  env: { ...process.env, CHESS_PORT: String(PORT), CHESS_TMUX_TARGET: '', CHESS_RESUME: '0' },
  stdio: 'ignore',
});

// wait for the server to accept connections
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try { await fetch(`${BASE}/api/state`); up = true; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}
if (!up) { console.error('server did not start'); server.kill(); process.exit(1); }

try {
  console.log('state & legal moves');
  let r = await api('GET', '/api/state');
  check('initial fen', r.data.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'));
  r = await api('GET', '/api/moves');
  check('20 legal opening moves', r.data.moves?.length === 20, r.data);
  r = await api('GET', '/api/moves?square=e2');
  check('2 moves from e2', r.data.moves?.length === 2, r.data);

  check('lastMove null before first move', r.data.moves && (await api('GET', '/api/state')).data.lastMove === null);
  r = await api('GET', '/api/state');
  check('statusDetail null while playing', r.data.statusDetail === null, r.data);
  r = await api('POST', '/api/nudge');
  check('nudge with no move owed rejected 409', r.code === 409, r.data);

  console.log('turn enforcement & validation');
  r = await api('POST', '/api/move', { move: 'e4' });
  check('human e4 accepted', r.code === 200 && r.data.awaitingClaude === true, r.data);
  r = await api('POST', '/api/nudge');
  check('nudge in manual mode (no tmux target) rejected 409', r.code === 409 && /tmux/.test(r.data.error || ''), r.data);
  r = await api('GET', '/api/state');
  check('lastMove reflects e4', r.data.lastMove?.san === 'e4' && r.data.lastMove.from === 'e2' && r.data.lastMove.to === 'e4', r.data.lastMove);
  r = await api('POST', '/api/move', { move: 'd4' });
  check('second human move rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/undo');
  check('undo while awaiting Claude rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/claude/move', { move: 'e7e5' });
  check('claude e7e5 (UCI) accepted', r.code === 200 && r.data.awaitingClaude === false, r.data);
  r = await api('POST', '/api/claude/move', { move: 'Nf6' });
  check('claude out of turn rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/move', { move: 'Ke5' });
  check('illegal move rejected 400', r.code === 400, r.data);

  console.log('undo');
  r = await api('POST', '/api/undo');
  check('undo removes full move pair', r.code === 200 && r.data.history.length === 0 && r.data.turn === 'w', r.data);
  r = await api('POST', '/api/undo');
  check('undo on empty history rejected 409', r.code === 409, r.data);

  console.log("game over (fool's mate)");
  await api('POST', '/api/move', { move: 'f3' });
  await api('POST', '/api/claude/move', { move: 'e5' });
  await api('POST', '/api/move', { move: 'g4' });
  r = await api('POST', '/api/claude/move', { move: 'Qh4' });
  check('checkmate detected', r.data.status === 'checkmate' && r.data.gameOver === true, r.data);
  check('statusDetail names the winner', r.data.statusDetail === 'checkmate — Black wins', r.data.statusDetail);
  r = await api('POST', '/api/nudge');
  check('nudge after game over rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/move', { move: 'a3' });
  check('move after game over rejected 409', r.code === 409, r.data);

  console.log('new game');
  r = await api('POST', '/api/new', { claudeColor: 'w' });
  check('new game, Claude=white awaits Claude', r.data.claudeColor === 'w' && r.data.awaitingClaude === true, r.data);
  r = await api('POST', '/api/claude/move', { move: 'd4' });
  check('claude opens d4', r.code === 200 && r.data.history.length === 1, r.data);
  r = await api('POST', '/api/undo');
  check('undo of Claude opening re-awaits Claude', r.code === 200 && r.data.history.length === 0 && r.data.awaitingClaude === true, r.data);

  console.log('draw offers');
  await api('POST', '/api/new', {}); // claude = black, human to move
  r = await api('POST', '/api/draw', { by: 'human' });
  check('human offers draw', r.code === 200 && r.data.drawOfferBy === 'w', r.data);
  r = await api('POST', '/api/draw', { by: 'human' });
  check('second offer while pending rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/draw', { by: 'human', action: 'accept' });
  check('answering own offer rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/draw', { by: 'claude', action: 'decline' });
  check('claude declines, offer cleared', r.code === 200 && r.data.drawOfferBy === null && !r.data.gameOver, r.data);
  await api('POST', '/api/move', { move: 'e4' });
  await api('POST', '/api/claude/move', { move: 'e5' });
  r = await api('POST', '/api/draw', { by: 'claude' });
  check('claude offers draw', r.code === 200 && r.data.drawOfferBy === 'b', r.data);
  r = await api('POST', '/api/move', { move: 'Nf3' });
  check('human move lets offer lapse', r.code === 200 && r.data.drawOfferBy === null, r.data);
  await api('POST', '/api/claude/move', { move: 'Nc6' });
  await api('POST', '/api/draw', { by: 'human' });
  r = await api('POST', '/api/draw', { by: 'claude', action: 'accept' });
  check('claude accepts: draw agreed + game over', r.code === 200 && r.data.drawAgreed === true && r.data.status === 'draw' && r.data.gameOver === true, r.data);
  check('statusDetail says draw by agreement', r.data.statusDetail === 'draw by agreement', r.data.statusDetail);
  r = await api('POST', '/api/move', { move: 'd4' });
  check('move after agreed draw rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/undo');
  check('undo after agreed draw rejected 409', r.code === 409, r.data);
  r = await api('POST', '/api/draw', { by: 'human' });
  check('offer after game over rejected 409', r.code === 409, r.data);

  console.log('pgn export');
  const pgnRes = await fetch(`${BASE}/api/pgn`);
  const pgnText = await pgnRes.text();
  check('pgn has headers', pgnRes.status === 200 && pgnText.includes('[White "Human"]') && pgnText.includes('[Black "Claude"]'), pgnText);
  check('pgn has moves + agreed-draw result', pgnText.includes('1. e4 e5') && pgnText.includes('[Result "1/2-1/2"]') && pgnText.trimEnd().endsWith('1/2-1/2'), pgnText);

  console.log('archive (ephemeral server)');
  const gamesRes = await fetch(`${BASE}/api/games`);
  check('games archive empty when ephemeral (CHESS_RESUME=0)', gamesRes.status === 200 && (await gamesRes.text()) === '');

  console.log('oversized body');
  let refused = false;
  try {
    const res = await fetch(`${BASE}/api/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"move":"${'x'.repeat(100 * 1024)}"}`,
    });
    refused = res.status >= 400; // parsed as {} at best — never a 200
  } catch { refused = true; } // connection dropped by the 64 KB cap
  check('>64KB body refused', refused);
  r = await api('GET', '/api/state');
  check('server healthy after oversized body', r.code === 200 && r.data.drawAgreed === true, r.data);

  console.log('shutdown');
  r = await api('POST', '/api/shutdown');
  check('shutdown ok', r.code === 200 && r.data.ok === true, r.data);
  await new Promise((r2) => setTimeout(r2, 300));
  let dead = false;
  try { await fetch(`${BASE}/api/state`); } catch { dead = true; }
  check('server stopped', dead);

  console.log('restart re-prompt (tmux)');
  let tmuxOk = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { tmuxOk = false; }
  if (!tmuxOk) {
    console.log('  skip — tmux not available');
  } else {
    // A snapshot where Claude owes a move; a restarting server must re-inject
    // the your-turn prompt (the pre-restart one died with the old process).
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const sess = `chess-test-${port2}`;
    const snapFile = join(__dirname, '..', '.run', `game-${port2}.json`);
    let server2;
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', sess, 'cat']);
      const pane = execFileSync('tmux', ['list-panes', '-t', sess, '-F', '#{pane_id}']).toString().trim();
      mkdirSync(join(__dirname, '..', '.run'), { recursive: true });
      writeFileSync(snapFile, JSON.stringify({
        pgn: '1. e4', claudeColor: 'b', awaitingClaude: true,
        resignedBy: null, drawOfferBy: null, drawAgreed: false,
      }));
      server2 = spawn('node', [join(__dirname, 'server.mjs')], {
        env: { ...process.env, CHESS_PORT: String(port2), CHESS_TMUX_TARGET: pane, CHESS_RESUME: '1' },
        stdio: 'ignore',
      });
      let up2 = false;
      for (let i = 0; i < 50 && !up2; i++) {
        try { await fetch(`${base2}/api/state`); up2 = true; }
        catch { await new Promise((r2) => setTimeout(r2, 100)); }
      }
      check('restarted server up with snapshot', up2);
      const st = up2 ? (await (await fetch(`${base2}/api/state`)).json()) : {};
      check('resumed state still awaits Claude', st.awaitingClaude === true && st.history?.[0] === 'e4', st);
      await new Promise((r2) => setTimeout(r2, 800)); // injection sends text, then Enter after 150ms
      const paneText = execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', pane]).toString();
      check('re-prompt injected after restart', paneText.includes('resumed after a server restart'), paneText.trim().slice(0, 200));
      check('re-prompt carries movetext + FEN', paneText.includes('Moves so far: 1. e4') && paneText.includes('Position (FEN):'), paneText.trim().slice(0, 200));
      const nudgeRes = await fetch(`${base2}/api/nudge`, { method: 'POST' });
      check('nudge accepted while Claude owes a move', nudgeRes.status === 200, await nudgeRes.text());
      await new Promise((r2) => setTimeout(r2, 500)); // text, then Enter after 150ms
      const paneText2 = execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', pane]).toString();
      check('nudge re-injects your-turn reminder', paneText2.includes('Reminder — it is still your turn'), paneText2.trim().slice(-200));
    } finally {
      server2?.kill();
      try { execFileSync('tmux', ['kill-session', '-t', sess], { stdio: 'ignore' }); } catch { /* already gone */ }
      try { rmSync(snapFile); } catch { /* never written */ }
    }
  }

  console.log('game archive (persistent server)');
  {
    const port3 = await freePort();
    const base3 = `http://127.0.0.1:${port3}`;
    const snap3 = join(__dirname, '..', '.run', `game-${port3}.json`);
    const arch3 = join(__dirname, '..', '.run', `games-${port3}.pgn`);
    const env3 = { ...process.env, CHESS_PORT: String(port3), CHESS_TMUX_TARGET: '', CHESS_RESUME: '1' };
    const api3 = async (method, path, body) => {
      const res = await fetch(base3 + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { code: res.status, data: await res.json() };
    };
    const waitUp = async () => {
      for (let i = 0; i < 50; i++) {
        try { await fetch(`${base3}/api/state`); return true; }
        catch { await new Promise((r3) => setTimeout(r3, 100)); }
      }
      return false;
    };
    const archiveText = async () => {
      await new Promise((r3) => setTimeout(r3, 300)); // appendFile is async
      return (await fetch(`${base3}/api/games`)).text();
    };
    const events = (txt) => (txt.match(/\[Event /g) || []).length;
    let server3 = spawn('node', [join(__dirname, 'server.mjs')], { env: env3, stdio: 'ignore' });
    try {
      check('archive server up', await waitUp());
      check('archive empty before any game ends', (await archiveText()) === '');
      // fool's mate — Claude (black) delivers it
      await api3('POST', '/api/move', { move: 'f3' });
      await api3('POST', '/api/claude/move', { move: 'e5' });
      await api3('POST', '/api/move', { move: 'g4' });
      const mate = await api3('POST', '/api/claude/move', { move: 'Qh4#' });
      check('fools mate ends game', mate.data.status === 'checkmate', mate.data);
      let txt = await archiveText();
      check('finished game archived with mate result', events(txt) === 1 && txt.includes('Qh4#') && txt.includes('[Result "0-1"]'), txt);
      await api3('POST', '/api/new', {});
      txt = await archiveText();
      check('new after finished game does not re-archive it', events(txt) === 1, txt);
      // discard an unfinished game
      await api3('POST', '/api/move', { move: 'e4' });
      await api3('POST', '/api/new', {});
      txt = await archiveText();
      check('discarded unfinished game archived with result *', events(txt) === 2 && txt.includes('[Result "*"]'), txt);
      // resigned game
      await api3('POST', '/api/move', { move: 'd4' });
      await api3('POST', '/api/resign', {});
      txt = await archiveText();
      check('resigned game archived', events(txt) === 3 && (txt.match(/\[Result "0-1"\]/g) || []).length === 2, txt);
      // restart on the finished game must not append a duplicate
      server3.kill();
      await new Promise((r3) => setTimeout(r3, 300));
      server3 = spawn('node', [join(__dirname, 'server.mjs')], { env: env3, stdio: 'ignore' });
      check('archive server restarted', await waitUp());
      txt = await archiveText();
      check('restart does not re-archive finished game', events(txt) === 3, txt);
    } finally {
      server3?.kill();
      try { rmSync(snap3); } catch { /* never written */ }
      try { rmSync(arch3); } catch { /* never written */ }
    }
  }
} finally {
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
