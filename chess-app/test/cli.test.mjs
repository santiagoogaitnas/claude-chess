// CLI tests for chess-app/server/claude.mjs (Claude's side of the board).
// Run: node --test chess-app/test/cli.test.mjs
// Spawns a real server on its own port with CHESS_RESUME=0 (ephemeral, no
// snapshot file, no tmux target) and drives every claude.mjs subcommand as a
// child process, asserting stdout/stderr text and exit codes — the actual
// interface Claude sees when playing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const CLI = join(__dirname, '..', 'server', 'claude.mjs');
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
const PORT = Number(process.env.CHESS_CLI_TEST_PORT || (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

// Run claude.mjs with args; resolves { code, stdout, stderr } (never rejects
// on non-zero exit — exit codes are part of the contract under test).
function cli(args, port = PORT) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, CHESS_PORT: String(port) }, timeout: 10_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })
    );
  });
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function startServer() {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CHESS_PORT: String(PORT), CHESS_TMUX_TARGET: '', CHESS_RESUME: '0' },
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

before(async () => {
  proc = await startServer();
});

after(() => {
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
});

test('state prints FEN, turn, colors and status', async () => {
  const { code, stdout } = await cli(['state']);
  assert.equal(code, 0);
  assert.match(stdout, /^FEN: rnbqkbnr\/pppppppp/m);
  assert.match(stdout, /Turn: White \| Claude is Black \| Status: playing/);
  assert.doesNotMatch(stdout, /Moves:/); // no history yet
});

test('move out of turn is REJECTED with exit 1 and state echo', async () => {
  const { code, stdout, stderr } = await cli(['move', 'e5']);
  assert.equal(code, 1);
  assert.match(stderr, /REJECTED: /i);
  assert.match(stdout, /FEN: /); // printState still runs so Claude can recover
});

test('move plays a legal SAN reply and prints the new position', async () => {
  await api('POST', '/api/move', { move: 'e4' }); // human opens
  const { code, stdout } = await cli(['move', 'e5']);
  assert.equal(code, 0);
  assert.match(stdout, /Played e5\./);
  assert.match(stdout, /Moves: e4 e5/);
  assert.match(stdout, /Turn: White/);
});

test('illegal move is REJECTED with exit 1 and leaves position unchanged', async () => {
  await api('POST', '/api/move', { move: 'Nf3' });
  const { code, stderr } = await cli(['move', 'Ke4']); // king can't teleport
  assert.equal(code, 1);
  assert.match(stderr, /REJECTED: /);
  const { body } = await api('GET', '/api/state');
  assert.deepEqual(body.history, ['e4', 'e5', 'Nf3']);
});

test('move accepts UCI coordinates too', async () => {
  const { code, stdout } = await cli(['move', 'b8c6']); // Nc6 as UCI
  assert.equal(code, 0);
  assert.match(stdout, /Moves: e4 e5 Nf3 Nc6/);
});

test('resign as Claude ends the game', async () => {
  const { code, stdout } = await cli(['resign']);
  assert.equal(code, 0);
  assert.match(stdout, /Resigned\./);
  assert.match(stdout, /Status: resigned/);
  const { body } = await api('GET', '/api/state');
  assert.equal(body.resignedBy, body.claudeColor); // resignedBy is a color ('w'|'b')
});

test('resign twice is REJECTED with exit 1', async () => {
  const { code, stderr } = await cli(['resign']);
  assert.equal(code, 1);
  assert.match(stderr, /REJECTED: /);
});

test('new w starts a fresh game with Claude as White', async () => {
  const { code, stdout } = await cli(['new', 'w']);
  assert.equal(code, 0);
  assert.match(stdout, /New game started\./);
  assert.match(stdout, /Claude is White \| Status: playing/);
  const { body } = await api('GET', '/api/state');
  assert.equal(body.claudeColor, 'w');
  assert.deepEqual(body.history, []);
});

test('new without arg defaults Claude to Black', async () => {
  const { code, stdout } = await cli(['new']);
  assert.equal(code, 0);
  assert.match(stdout, /Claude is Black/);
});

test('draw offer/decline/accept round-trips via /api/draw', async () => {
  const offer = await cli(['draw', 'offer']);
  assert.equal(offer.code, 0);
  assert.match(offer.stdout, /Draw offered — waiting for opponent\./);
  // Human declines over HTTP; game continues.
  await api('POST', '/api/draw', { by: 'human', action: 'decline' });
  let { body } = await api('GET', '/api/state');
  assert.equal(body.status, 'playing');
  // Human offers, Claude accepts via CLI -> draw.
  await api('POST', '/api/draw', { by: 'human', action: 'offer' });
  const accept = await cli(['draw', 'accept']);
  assert.equal(accept.code, 0);
  assert.match(accept.stdout, /Draw accepted\./);
  ({ body } = await api('GET', '/api/state'));
  assert.notEqual(body.status, 'playing');
});

test('draw with a bad action prints usage and exits 1', async () => {
  const { code, stderr } = await cli(['draw', 'maybe']);
  assert.equal(code, 1);
  assert.match(stderr, /usage: claude\.mjs draw <offer\|accept\|decline>/);
});

test('accepting a draw nobody offered is REJECTED', async () => {
  await cli(['new']); // fresh game, no pending offer
  const { code, stderr } = await cli(['draw', 'accept']);
  assert.equal(code, 1);
  assert.match(stderr, /REJECTED: /);
});

test('pgn prints the game moves as PGN', async () => {
  await cli(['new']);
  await api('POST', '/api/move', { move: 'd4' });
  await cli(['move', 'd5']);
  const { code, stdout } = await cli(['pgn']);
  assert.equal(code, 0);
  assert.match(stdout, /1\. d4 d5/);
});

test('move without an argument prints usage and exits 1', async () => {
  const { code, stderr } = await cli(['move']);
  assert.equal(code, 1);
  assert.match(stderr, /usage: claude\.mjs move <san-or-uci>/);
});

test('unknown subcommand prints usage and exits 1', async () => {
  const { code, stderr } = await cli(['bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /usage: claude\.mjs <state\|move\|new\|resign\|draw\|pgn\|games\|shutdown>/);
});

test('unreachable server yields a clear error and exit 1', async () => {
  const { code, stderr } = await cli(['state'], 3); // nothing listens on :3
  assert.equal(code, 1);
  assert.match(stderr, /Cannot reach chess server on http:\/\/localhost:3/);
});

test('shutdown stops the server', async () => {
  const { code, stdout } = await cli(['shutdown']);
  assert.equal(code, 0);
  assert.match(stdout, /Server stopped\./);
  assert.ok(await waitExit(proc), 'server process should exit after shutdown');
  proc = null;
});
