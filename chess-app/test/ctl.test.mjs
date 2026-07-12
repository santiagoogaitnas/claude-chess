/**
 * End-to-end lifecycle tests for chess-app/bin/chess-ctl.
 *
 * Runs against an ISOLATED copy of the app in a temp dir: chess-ctl keeps
 * singleton state in chess-app/.run (pid/port/pane) and `start --port N`
 * deliberately reaps a live previous instance, so exercising it in-repo
 * would kill any real game in progress. The copy mirrors the real layout
 * (<root>/web, <root>/chess-app/{bin,server}) because server.mjs resolves
 * both relative to itself; node_modules is symlinked from the repo.
 *
 * Run: node --test chess-app/test/ctl.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  cpSync,
  symlinkSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// OS-assigned free ports so concurrent runs of this suite (e.g. two agents
// testing at once) never collide on ports or chess-server-<port> sessions.
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
async function distinctPorts(n) {
  const ports = new Set();
  while (ports.size < n) ports.add(await freePort());
  return [...ports];
}
const [PORT_A, PORT_B, PORT_FOREIGN, PORT_INJECT] = await distinctPorts(4);

let root; // temp copy of the repo layout
let ctl;
let runDir;
let foreignProc = null;
let injectProc = null;
const INJECT_SESSION = `chess-inject-test-${PORT_INJECT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCtl(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Force manual mode: a real $TMUX_PANE would make the server inject move
  // prompts into whatever pane is running this test suite.
  delete env.TMUX_PANE;
  delete env.CHESS_PORT;
  const res = spawnSync('bash', [ctl, ...args], { env, encoding: 'utf8', timeout: 30000 });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '' };
}

async function apiUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(150);
  }
  return fn();
}

function tmuxSessionExists(name) {
  return spawnSync('tmux', ['has-session', '-t', name]).status === 0;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'chess-ctl-test-'));
  cpSync(join(REPO_ROOT, 'web'), join(root, 'web'), { recursive: true });
  cpSync(join(REPO_ROOT, 'chess-app', 'bin'), join(root, 'chess-app', 'bin'), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, 'chess-app', 'server'), join(root, 'chess-app', 'server'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  symlinkSync(
    join(REPO_ROOT, 'chess-app', 'server', 'node_modules'),
    join(root, 'chess-app', 'server', 'node_modules')
  );
  ctl = join(root, 'chess-app', 'bin', 'chess-ctl');
  runDir = join(root, 'chess-app', '.run');
});

after(async () => {
  if (foreignProc && foreignProc.exitCode === null) foreignProc.kill('SIGKILL');
  if (injectProc && injectProc.exitCode === null) injectProc.kill('SIGKILL');
  spawnSync('tmux', ['kill-session', '-t', INJECT_SESSION]);
  runCtl(['stop']);
  for (const p of [PORT_A, PORT_B, PORT_FOREIGN]) {
    spawnSync('tmux', ['kill-session', '-t', `chess-server-${p}`]);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test('start --port boots the server, persists state files, serves the API', async () => {
  const { code, out, err } = runCtl(['start', '--port', String(PORT_A), '--no-open']);
  assert.equal(code, 0, `stderr: ${err}`);
  assert.match(out, new RegExp(`chess server up: http://127\\.0\\.0\\.1:${PORT_A}`));
  assert.match(out, /manual mode/); // no pane given
  assert.equal(readFileSync(join(runDir, 'port'), 'utf8'), String(PORT_A));
  const pid = Number(readFileSync(join(runDir, 'server.pid'), 'utf8'));
  assert.ok(pid > 0);
  process.kill(pid, 0); // throws if not alive
  const state = await (await fetch(`http://127.0.0.1:${PORT_A}/api/state`)).json();
  assert.match(state.fen, /^rnbqkbnr/);
});

test('start is idempotent while the server is up', () => {
  // No CHESS_PORT / --port: must resolve the running port from .run/port.
  const { code, out } = runCtl(['start', '--no-open']);
  assert.equal(code, 0);
  assert.match(out, new RegExp(`already running .*${PORT_A}`));
});

test('status reports the running game', () => {
  const { code, out } = runCtl(['status']);
  assert.equal(code, 0);
  assert.match(out, /running \(pid \d+\)/);
  assert.match(out, /turn: White/);
  assert.match(out, /fen: rnbqkbnr/);
});

test('start rejects a non-numeric --port with exit 2', () => {
  const { code, err } = runCtl(['start', '--port', 'abc', '--no-open']);
  assert.equal(code, 2);
  assert.match(err, /--port expects a number/);
});

test('start --port <other> reaps the previous instance instead of orphaning it', async () => {
  const { code, err } = runCtl(['start', '--port', String(PORT_B), '--no-open']);
  assert.equal(code, 0);
  assert.match(err, new RegExp(`stopping previous instance on port ${PORT_A}`));
  assert.equal(readFileSync(join(runDir, 'port'), 'utf8'), String(PORT_B));
  assert.ok(await apiUp(PORT_B), 'new port should answer');
  assert.ok(await waitFor(async () => !(await apiUp(PORT_A))), 'old port should be down');
  assert.ok(!tmuxSessionExists(`chess-server-${PORT_A}`), 'old tmux session should be gone');
});

test('restart preserves the port and comes back up', async () => {
  const oldPid = Number(readFileSync(join(runDir, 'server.pid'), 'utf8'));
  const { code, out } = runCtl(['restart', '--no-open']);
  assert.equal(code, 0, out);
  assert.match(out, /chess server stopped/);
  assert.match(out, new RegExp(`chess server up: http://127\\.0\\.0\\.1:${PORT_B}`));
  const newPid = Number(readFileSync(join(runDir, 'server.pid'), 'utf8'));
  assert.notEqual(newPid, oldPid);
  assert.ok(await waitFor(() => apiUp(PORT_B)), 'restarted server should answer');
});

test('stop shuts down the server and cleans all state files', async () => {
  const { code, out } = runCtl(['stop']);
  assert.equal(code, 0);
  assert.match(out, /chess server stopped/);
  assert.ok(await waitFor(async () => !(await apiUp(PORT_B))), 'API should stop answering');
  for (const f of ['server.pid', 'port', 'pane']) {
    assert.ok(!existsSync(join(runDir, f)), `${f} should be removed`);
  }
  assert.ok(!tmuxSessionExists(`chess-server-${PORT_B}`));
  const status = runCtl(['status']);
  assert.notEqual(status.code, 0);
  assert.match(status.out, /not running/);
});

test('start refuses a port already held by a server it did not launch', async () => {
  foreignProc = spawn('node', [join(root, 'chess-app', 'server', 'server.mjs')], {
    env: { ...process.env, CHESS_PORT: String(PORT_FOREIGN), CHESS_RESUME: '0' },
    stdio: 'ignore',
  });
  assert.ok(await waitFor(() => apiUp(PORT_FOREIGN)), 'foreign server should boot');
  const { code, err } = runCtl(['start', '--port', String(PORT_FOREIGN), '--no-open']);
  assert.equal(code, 1);
  assert.match(err, /wasn't started by chess-ctl/);
  assert.ok(!existsSync(join(runDir, 'server.pid')), 'must not adopt the foreign server');
  foreignProc.kill('SIGKILL');
});

// Regression: on a non-default port the tmux-injected reply command MUST carry
// CHESS_PORT=<port>, or Claude's `claude.mjs move` defaults to 3456 and silently
// misses this game (server.mjs claudeCli(), see the port-prefix logic).
test('injected move prompt carries CHESS_PORT on a non-default port', async () => {
  if (spawnSync('tmux', ['-V']).status !== 0) {
    console.log('tmux unavailable — skipping injection test');
    return;
  }
  // A harmless tty sink Claude's pane stands in for; terminal echo makes the
  // injected keystrokes visible to capture-pane.
  // Wide window so the injected command isn't wrapped mid-token on screen.
  assert.equal(
    spawnSync('tmux', ['new-session', '-d', '-x', '300', '-y', '50', '-s', INJECT_SESSION, 'cat'])
      .status,
    0,
    'should create the sink tmux session'
  );

  injectProc = spawn('node', [join(root, 'chess-app', 'server', 'server.mjs')], {
    env: {
      ...process.env,
      CHESS_PORT: String(PORT_INJECT),
      CHESS_TMUX_TARGET: INJECT_SESSION,
      CHESS_RESUME: '0',
    },
    stdio: 'ignore',
  });
  assert.ok(await waitFor(() => apiUp(PORT_INJECT)), 'injection server should boot');

  // Human (White) plays; it becomes Claude's (Black) turn -> server injects.
  const res = await fetch(`http://127.0.0.1:${PORT_INJECT}/api/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ move: 'e4' }),
  });
  assert.ok(res.ok, `move should be accepted (status ${res.status})`);

  // -J joins wrapped lines so tokens split across the pane boundary rejoin.
  const capture = () =>
    spawnSync('tmux', ['capture-pane', '-p', '-J', '-t', INJECT_SESSION], { encoding: 'utf8' })
      .stdout;
  const injected = await waitFor(() => capture().includes(`CHESS_PORT=${PORT_INJECT}`));
  const pane = capture();
  assert.ok(
    injected,
    `injected prompt must prefix the reply command with CHESS_PORT=${PORT_INJECT}; pane was: ${pane}`
  );
  assert.match(pane, /claude\.mjs" move/, 'injected prompt must tell Claude to run claude.mjs move');

  injectProc.kill('SIGKILL');
  spawnSync('tmux', ['kill-session', '-t', INJECT_SESSION]);
});

test('unknown subcommand prints usage and exits 2', () => {
  const { code, out } = runCtl(['bogus']);
  assert.equal(code, 2);
  assert.match(out, /chess-ctl start/);
});
