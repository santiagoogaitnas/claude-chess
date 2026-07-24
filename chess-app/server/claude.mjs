#!/usr/bin/env node
/**
 * CLI for Claude's side of the board. Talks to the local chess server.
 *
 *   node claude.mjs state          # print current position
 *   node claude.mjs wait [seconds] # block until your turn / a draw offer / game over (exit 2 = still waiting)
 *   node claude.mjs move Nf6       # play a move (SAN or UCI)
 *   node claude.mjs new [w|b]      # new game, optional Claude color
 *   node claude.mjs resign         # resign the game as Claude
 *   node claude.mjs draw offer     # offer a draw (also: draw accept | draw decline)
 *   node claude.mjs pgn            # print the game as PGN
 *   node claude.mjs games          # print the archive of past games (PGN)
 *   node claude.mjs shutdown       # stop the server
 */
const PORT = Number(process.env.CHESS_PORT || 3456);
// Dial 127.0.0.1, not localhost: the server binds IPv4 only, and on hosts that
// resolve localhost to ::1 first, Node 18's fetch never falls back to IPv4.
const BASE = `http://127.0.0.1:${PORT}`;

// Optional: render an ASCII board locally. Degrades to FEN-only output if
// chess.js isn't installed next to this file (server deps not yet installed).
let Chess = null;
try { ({ Chess } = await import('chess.js')); } catch { /* FEN-only output */ }

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, data: await res.json() };
}

function printState(s) {
  if (Chess && s.fen) {
    try { console.log(new Chess(s.fen).ascii()); } catch { /* bad FEN — skip board */ }
  }
  console.log(`FEN: ${s.fen}`);
  console.log(`Turn: ${s.turn === 'w' ? 'White' : 'Black'} | Claude is ${s.claudeColor === 'w' ? 'White' : 'Black'} | Status: ${s.status}`);
  if (s.history?.length) console.log(`Moves: ${s.history.join(' ')}`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'state') {
    const { data } = await api('GET', '/api/state');
    printState(data);
  } else if (cmd === 'wait') {
    // Long-poll /api/wait in <=25s slices until something needs Claude or the
    // budget runs out. Exit 0 = act on REASON; exit 2 = still nothing, wait again.
    const budget = Number(arg) > 0 ? Number(arg) : 100; // seconds — stays under a 120s exec timeout
    const deadline = Date.now() + budget * 1000;
    for (let left = budget * 1000; left > 0; left = deadline - Date.now()) {
      const { ok, data } = await api('GET', `/api/wait?timeout=${Math.max(1000, Math.min(25000, left))}`);
      // A reply without ok+reason is not a wait event — something other than
      // an up-to-date chess server answered (older build, foreign service).
      if (!ok || !data.reason) {
        console.error(`Unexpected response from ${BASE}/api/wait — is an up-to-date chess server running? (${JSON.stringify(data).slice(0, 200)})`);
        process.exit(1);
      }
      if (data.reason === 'timeout') continue;
      console.log(`EVENT: ${data.event ?? '(none)'}`);
      console.log(`REASON: ${data.reason}`);
      printState(data);
      process.exit(0);
    }
    console.log(`Still waiting after ${budget}s — nothing happened yet. Run wait again to keep listening.`);
    process.exit(2);
  } else if (cmd === 'move') {
    if (!arg) { console.error('usage: claude.mjs move <san-or-uci>'); process.exit(1); }
    const { ok, data } = await api('POST', '/api/claude/move', { move: arg });
    if (!ok) { console.error(`REJECTED: ${data.error}`); printState(data); process.exit(1); }
    console.log(`Played ${arg}.`);
    printState(data);
  } else if (cmd === 'new') {
    const { data } = await api('POST', '/api/new', { claudeColor: arg === 'w' ? 'w' : 'b' });
    console.log('New game started.');
    printState(data);
  } else if (cmd === 'resign') {
    const { ok, data } = await api('POST', '/api/resign', { by: 'claude' });
    if (!ok) { console.error(`REJECTED: ${data.error}`); printState(data); process.exit(1); }
    console.log('Resigned.');
    printState(data);
  } else if (cmd === 'draw') {
    const action = arg || 'offer';
    if (!['offer', 'accept', 'decline'].includes(action)) {
      console.error('usage: claude.mjs draw <offer|accept|decline>');
      process.exit(1);
    }
    const { ok, data } = await api('POST', '/api/draw', { by: 'claude', action });
    if (!ok) { console.error(`REJECTED: ${data.error}`); printState(data); process.exit(1); }
    const said = { offer: 'Draw offered — waiting for opponent.', accept: 'Draw accepted.', decline: 'Draw declined.' };
    console.log(said[action]);
    printState(data);
  } else if (cmd === 'pgn') {
    const res = await fetch(`${BASE}/api/pgn`);
    console.log(await res.text());
  } else if (cmd === 'games') {
    const res = await fetch(`${BASE}/api/games`);
    const text = await res.text();
    console.log(text.trim() ? text : '(no games archived yet)');
  } else if (cmd === 'shutdown') {
    await api('POST', '/api/shutdown');
    console.log('Server stopped.');
  } else {
    console.error('usage: claude.mjs <state|move|new|resign|draw|pgn|games|shutdown> [arg]');
    console.error('   or: claude.mjs wait [seconds]  # long-poll until your turn / a draw offer / game over');
    process.exit(1);
  }
} catch (e) {
  console.error(`Cannot reach chess server on ${BASE} — is it running? (${e.message})`);
  process.exit(1);
}
