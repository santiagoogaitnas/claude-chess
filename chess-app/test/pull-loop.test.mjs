// End-to-end pull loop for the no-tmux ("manual mode") transport: a fake agent
// plays a full game by driving the real claude.mjs CLI as child processes, the
// way a terminal agent does when tmux isn't available to push the human's moves.
// Run: node --test chess-app/test/pull-loop.test.mjs
//
// The human side scripts its moves over HTTP (POST /api/move, /api/draw); the
// agent side only ever runs `claude.mjs wait|move|draw` and reacts to the
// REASON:/EVENT: lines and exit codes it prints — wait exits 0 on an event
// (reason your-turn | draw-offer | game-over), 2 when its budget lapses with
// nothing owed, and 1 when the server is unreachable. The server runs with no
// tmux target and CHESS_RESUME=0 (ephemeral: no snapshot file, no archive) on an
// OS-assigned free port so overlapping runs never collide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');
const CLI = join(__dirname, '..', 'server', 'claude.mjs');

// OS-assigned free port by default so concurrent runs never collide; env pins it.
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
const PORT = Number(process.env.CHESS_PULL_TEST_PORT || (await freePort()));
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
const children = new Set(); // live claude.mjs subprocesses, killed in after() even on failure

// Run claude.mjs as a child; resolves { code, stdout, stderr } and never rejects
// on non-zero exit (exit codes are the contract under test). The generous
// execFile timeout only bounds a hang — a resolving `wait` is passed a smaller
// budget in args so the CLI's own exit 2 fires first with a clear message.
function cli(args, { port = PORT, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, CHESS_PORT: String(port) }, timeout },
      (err, stdout, stderr) => {
        children.delete(child);
        resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
      }
    );
    children.add(child);
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
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});

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

// Model the agent sitting in a blocking wait: start `claude.mjs wait`, then run
// `trigger` (the human's HTTP action) that satisfies it, and hand back the wait
// result. Resolution is guaranteed once trigger lands and needs no sleep to
// order the two — the server answers a waiter registered before the change via
// broadcast(), or one whose request arrives after it immediately at request
// time — so whichever of the subprocess and the POST wins the race, wait ends.
async function waitThrough(trigger) {
  const waiting = cli(['wait', '20']);
  await trigger();
  return waiting;
}

before(async () => {
  proc = await startServer();
});

after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already exited */ } }
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
});

test('wait against an unreachable server exits 1', async () => {
  const { code, stderr } = await cli(['wait'], { port: 3 }); // nothing listens on :3
  assert.equal(code, 1);
  assert.match(stderr, /Cannot reach chess server on http:\/\/127\.0\.0\.1:3/);
});

test('wait exits 2 when the budget lapses with nothing owed', async () => {
  await post('/api/new', { claudeColor: 'b' }); // human to move — nothing owed to the agent
  const { code, stdout } = await cli(['wait', '1']); // 1s budget, one ~1s poll slice
  assert.equal(code, 2);
  assert.match(stdout, /Still waiting after 1s/);
});

test('pull loop: a fake agent plays a full game over wait/move/draw subprocesses', async () => {
  // Fresh game, the agent is Black; the human (HTTP) opens.
  const fresh = await post('/api/new', { claudeColor: 'b' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.awaitingClaude, false);

  // --- draw offer / decline exchange -------------------------------------
  // The agent is waiting; the human offers a draw -> wait surfaces draw-offer.
  const drawWait = await waitThrough(async () => {
    const offer = await post('/api/draw'); // defaults: by human, action offer
    assert.equal(offer.status, 200);
    assert.equal(offer.body.drawOfferBy, 'w');
  });
  assert.equal(drawWait.code, 0);
  assert.ok(drawWait.stdout.includes('REASON: draw-offer'), drawWait.stdout);
  assert.ok(drawWait.stdout.includes('EVENT: Opponent offers a draw'), drawWait.stdout);
  // The agent declines on the merits via the CLI; the game continues.
  const decline = await cli(['draw', 'decline']);
  assert.equal(decline.code, 0);
  assert.match(decline.stdout, /Draw declined\./);
  assert.equal((await get('/api/state')).body.drawOfferBy, null);

  // --- your-turn #1: human moves, the agent replies ----------------------
  const turn1 = await waitThrough(async () => {
    const m = await post('/api/move', { move: 'f3' });
    assert.equal(m.status, 200);
    assert.equal(m.body.awaitingClaude, true);
  });
  assert.equal(turn1.code, 0);
  assert.ok(turn1.stdout.includes('REASON: your-turn'), turn1.stdout);
  assert.ok(turn1.stdout.includes('EVENT: Human played f3'), turn1.stdout);
  const reply1 = await cli(['move', 'e5']);
  assert.equal(reply1.code, 0);
  assert.match(reply1.stdout, /Played e5\./);
  assert.match(reply1.stdout, /Moves: f3 e5/);

  // --- your-turn #2: the human walks into fool's mate --------------------
  const turn2 = await waitThrough(async () => {
    const m = await post('/api/move', { move: 'g4' });
    assert.equal(m.status, 200);
  });
  assert.equal(turn2.code, 0);
  assert.ok(turn2.stdout.includes('REASON: your-turn'), turn2.stdout);
  assert.ok(turn2.stdout.includes('EVENT: Human played g4'), turn2.stdout);
  // The agent delivers checkmate; its move response already reports the finish.
  const mate = await cli(['move', 'Qh4#']);
  assert.equal(mate.code, 0);
  assert.match(mate.stdout, /Played Qh4#\./);
  assert.match(mate.stdout, /Status: checkmate/);

  // --- game-over surfaced on the next wait -------------------------------
  // The loop polls once more, learns the game has ended, and stops.
  const over = await cli(['wait', '20']);
  assert.equal(over.code, 0);
  assert.ok(over.stdout.includes('REASON: game-over'), over.stdout);
  assert.ok(over.stdout.includes('EVENT: Game over: checkmate — Black wins'), over.stdout);

  const final = await get('/api/state');
  assert.equal(final.body.gameOver, true);
  assert.equal(final.body.status, 'checkmate');
  assert.deepEqual(final.body.history, ['f3', 'e5', 'g4', 'Qh4#']);
});
