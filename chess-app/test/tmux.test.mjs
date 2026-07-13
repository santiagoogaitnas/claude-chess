// Deterministic tmux port-injection tests for chess-app/server.
// Run: node --test chess-app/test/tmux.test.mjs
//
// The server pushes the human's move into Claude's pane via `tmux send-keys`,
// and the injected prompt tells Claude which `node claude.mjs move …` command
// to run to reply. When the server runs on a NON-default port (e.g. after
// `chess-ctl start --port N`), that command MUST carry `CHESS_PORT=<port>` —
// otherwise claude.mjs defaults to 3456 and Claude's reply silently misses
// this game (server.mjs claudeCli()).
//
// ctl.test.mjs already exercises this end-to-end, but it SKIPS entirely when
// tmux is not installed and depends on terminal-echo/capture-pane timing. This
// suite stubs `tmux` on PATH with a script that records every send-keys payload
// synchronously, so the regression is guarded even in a tmux-less CI and covers
// BOTH the prefixed (non-default) and unprefixed (default 3456) branches.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'server', 'server.mjs');

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

// A fake `tmux` on PATH: append every invocation's argv (one line per call,
// space-joined — the injected payload itself contains no newlines by design,
// see server.mjs movesSoFar()) to CAPTURE, then exit 0 so the server treats the
// injection as successful.
const FAKE_DIR = join(tmpdir(), `chess-tmux-test-${process.pid}`);
const FAKE_TMUX = join(FAKE_DIR, 'tmux');
const CAPTURE = join(FAKE_DIR, 'capture.log');
// Plain sh, not Node: an extensionless Node script needs module-syntax
// detection to run as ESM, which Node 18 doesn't have.
const FAKE_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> '${CAPTURE}'
exit 0
`;

// The injected `-l` payload containing `needle`: server.mjs calls
// `send-keys -t <target> -l <text>`, so the text is the token after `-l`.
// Poll because injection is fire-and-forget after the HTTP reply returns.
async function capturedPayload(needle, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const log = await readFile(CAPTURE, 'utf8').catch(() => '');
    for (const line of log.split('\n')) {
      const args = line.split(' ');
      const i = args.indexOf('-l');
      if (i >= 0 && line.slice(line.indexOf('-l') + 3).includes(needle)) {
        return line.slice(line.indexOf('-l') + 3);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function gameFile(port) {
  return join(__dirname, '..', '.run', `game-${port}.json`);
}

async function startServer(port) {
  await rm(gameFile(port), { force: true });
  await writeFile(CAPTURE, ''); // fresh capture per server — never read a prior run's payload
  const p = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CHESS_PORT: String(port),
      CHESS_TMUX_TARGET: 'chess-test:0',
      CHESS_RESUME: '0',
      PATH: `${FAKE_DIR}:${process.env.PATH}`,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/state'); return p; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  p.kill('SIGKILL');
  throw new Error(`server did not start on :${port}`);
}

async function playHumanMove(port, san) {
  const res = await fetch(`http://127.0.0.1:${port}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ move: san }),
  });
  return res.status;
}

before(async () => {
  await mkdir(FAKE_DIR, { recursive: true });
  await writeFile(FAKE_TMUX, FAKE_SCRIPT);
  await chmod(FAKE_TMUX, 0o755);
});

after(async () => {
  await rm(FAKE_DIR, { recursive: true, force: true });
});

test('non-default port: injected reply command carries CHESS_PORT=<port>', async () => {
  const port = await freePort();
  let proc;
  try {
    proc = await startServer(port);
    // Human (White) plays e4 -> it becomes Claude's (Black) turn -> server injects.
    assert.equal(await playHumanMove(port, 'e4'), 200);
    const payload = await capturedPayload('claude.mjs');
    assert.ok(payload, 'expected a tmux send-keys payload mentioning claude.mjs');
    assert.match(payload, new RegExp(`CHESS_PORT=${port} node .*claude\\.mjs" move`),
      `injected command must pin CHESS_PORT=${port}; got: ${payload}`);
  } finally {
    proc?.kill('SIGKILL');
    await rm(gameFile(port), { force: true });
  }
});

test('default port 3456: injected reply command has no CHESS_PORT prefix', async (t) => {
  // claude.mjs already defaults to 3456, so a prefix there would be redundant.
  // Only meaningful if 3456 is free — skip cleanly when a real game is running.
  const free = await new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(3456, '127.0.0.1', () => s.close(() => resolve(true)));
  });
  if (!free) return t.skip('port 3456 in use');

  let proc;
  try {
    proc = await startServer(3456);
    assert.equal(await playHumanMove(3456, 'e4'), 200);
    const payload = await capturedPayload('claude.mjs');
    assert.ok(payload, 'expected a tmux send-keys payload mentioning claude.mjs');
    assert.doesNotMatch(payload, /CHESS_PORT=/,
      `default-port command must not carry a CHESS_PORT prefix; got: ${payload}`);
    assert.match(payload, /node .*claude\.mjs" move/);
  } finally {
    proc?.kill('SIGKILL');
    await rm(gameFile(3456), { force: true });
  }
});
