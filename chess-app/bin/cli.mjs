#!/usr/bin/env node
/**
 * claude-chess — one command to run the browser chess app you play against an
 * AI coding agent. Published as `npx claude-chess`.
 *
 *   claude-chess [start] [--no-open]  start the server + open the board (default)
 *   claude-chess stop                 stop the server
 *   claude-chess status               is it running? whose turn is it?
 *   claude-chess doctor               check this machine can run it
 *
 * Env: CHESS_PORT (default 3456). tmux is OPTIONAL: run this from inside a tmux
 * pane and it hands off to bin/chess-ctl so the server pushes your moves into
 * the agent's terminal; otherwise it runs the server itself and the agent pulls
 * each move by long-polling (claude.mjs wait). Node 18+.
 *
 * State lives in chess-app/.run/{server.pid,port,server.log} — the same files
 * chess-ctl uses, so the two commands can stop/status each other's servers.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  openSync, closeSync, writeFileSync, readFileSync, existsSync, rmSync,
  mkdirSync, statSync, renameSync, realpathSync, accessSync, constants,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, delimiter } from 'node:path';

// Resolve to the physical location so paths match chess-ctl's `cd && pwd`
// (its is_our_server check compares the absolute server.mjs path from `ps`).
const BIN_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = dirname(BIN_DIR);                 // chess-app
const REPO_ROOT = dirname(APP_DIR);
const SERVER_DIR = join(APP_DIR, 'server');
const SERVER_MJS = join(SERVER_DIR, 'server.mjs');
const CLAUDE_MJS = join(SERVER_DIR, 'claude.mjs');
const CTL = join(BIN_DIR, 'chess-ctl');
const RUN_DIR = join(APP_DIR, '.run');
const PID_FILE = join(RUN_DIR, 'server.pid');
const PORT_FILE = join(RUN_DIR, 'port');
const PANE_FILE = join(RUN_DIR, 'pane');
const LOG_FILE = join(RUN_DIR, 'server.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

// CHESS_PORT wins; else the port a running server was started on (.run/port);
// else the default. Mirrors chess-ctl's port resolution so both agree.
function resolvePort() {
  if (process.env.CHESS_PORT) return Number(process.env.CHESS_PORT);
  try {
    const p = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (p > 0) return p;
  } catch { /* no port file */ }
  return 3456;
}

// Is <cmd> an executable on PATH? Portable (no shell), used to decide whether
// we can hand off to bash/tmux and to report optional tooling in `doctor`.
function onPath(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const d of (process.env.PATH || '').split(delimiter)) {
    if (!d) continue;
    for (const ext of exts) {
      try { accessSync(join(d, cmd + ext), constants.X_OK); return true; } catch { /* keep looking */ }
    }
  }
  return false;
}

// chess.js present in any node_modules the server would resolve (dev keeps it
// in chess-app/server/node_modules; npx hoists it to a parent node_modules).
function serverDepPresent() {
  let dir = SERVER_DIR;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'chess.js', 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Best-effort ownership check before we kill a recorded pid: after a reboot the
// OS may have handed it to something else. On win32 there's no cheap ps, so we
// trust the pidfile + the /api/shutdown call.
function isOurServer(pid) {
  if (process.platform === 'win32') return true;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return (r.stdout || '').includes(SERVER_MJS);
}

// Ownership proof #1 (chess-ctl's owns_port): the pidfile records a live
// server.mjs of ours, and the port file says it was started for THIS port.
function ownsPort(port) {
  let pid = 0;
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()); } catch { return false; }
  if (!(pid > 0 && isAlive(pid) && isOurServer(pid))) return false;
  try { return readFileSync(PORT_FILE, 'utf8').trim() === String(port); } catch { return false; }
}

// Ownership proof #2 (chess-ctl's session_ours): the detached tmux session
// chess-server-<port> hosts our server.mjs — survives a wiped .run/.
function sessionOurs(port) {
  if (!onPath('tmux')) return false;
  const r = spawnSync(
    'tmux',
    ['display-message', '-pt', `chess-server-${port}`, '#{pane_pid}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return false;
  const pid = Number((r.stdout || '').trim());
  return pid > 0 && isOurServer(pid);
}

async function apiState(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function tailLog(n) {
  try { return readFileSync(LOG_FILE, 'utf8').split('\n').slice(-n).join('\n'); }
  catch { return '(no log yet)'; }
}

function rotateLogIfBig() {
  try { if (statSync(LOG_FILE).size > 524288) renameSync(LOG_FILE, `${LOG_FILE}.1`); }
  catch { /* no log yet */ }
}

function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true });
    c.on('error', () => { /* no opener — the URL is printed anyway */ });
    c.unref();
  } catch { /* no opener */ }
}

// The line(s) the opponent's terminal needs. In pull mode that's the wait/move
// loop; in push mode the server injects the prompt, so there's nothing to run.
function reportMode(port, push) {
  const base = `http://127.0.0.1:${port}`;
  if (push) {
    console.log('mode: push (tmux) — your moves are injected into the agent\'s terminal');
  } else {
    console.log('mode: pull (no tmux) — the agent long-polls this server for your moves');
    const pfx = port === 3456 ? '' : `CHESS_PORT=${port} `;
    console.log('opponent side — in the agent\'s terminal, loop:');
    console.log(`  ${pfx}node "${CLAUDE_MJS}" wait          # blocks until it's the agent's move`);
    console.log(`  ${pfx}node "${CLAUDE_MJS}" move <san>     # reply with the move`);
  }
  console.log(`open the board at ${base}`);
}

function ensureServerDep() {
  if (serverDepPresent()) return;
  if (!onPath('npm')) {
    console.error('server dependency chess.js is missing and npm was not found.');
    console.error(`install it by hand:  npm --prefix "${SERVER_DIR}" install`);
    process.exit(1);
  }
  console.error('installing server dependency (chess.js), one-time…');
  const r = spawnSync(
    'npm',
    ['--prefix', SERVER_DIR, 'install', '--no-fund', '--no-audit', '--loglevel=error'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0 || !serverDepPresent()) {
    console.error(`npm install failed in ${SERVER_DIR}`);
    process.exit(1);
  }
}

async function cmdStart({ open }) {
  if (nodeMajor() < 18) {
    console.error(`claude-chess needs Node 18 or newer — you have ${process.version}.`);
    console.error('Install a current Node from https://nodejs.org (or: brew install node), then retry.');
    process.exit(1);
  }

  const port = resolvePort();
  const base = `http://127.0.0.1:${port}`;

  // Already up on this port? Report and (re)open the board instead of failing.
  const existing = await apiState(port);
  if (existing) {
    let pid = '';
    try { pid = readFileSync(PID_FILE, 'utf8').trim(); } catch { /* not our pidfile */ }
    console.log(`already running${pid ? ` (pid ${pid})` : ''} — ${base}`);
    if (open) openBrowser(base);
    reportMode(port, !!existing.tmuxTarget);
    return;
  }

  // Inside a tmux pane with bash + tmux + chess-ctl available: hand off so the
  // server injects your moves into this pane (the full push experience).
  const inTmux = !!(process.env.TMUX_PANE || process.env.TMUX);
  if (inTmux && existsSync(CTL) && onPath('bash') && onPath('tmux')) {
    const args = ['start'];
    if (!open) args.push('--no-open');
    const r = spawnSync('bash', [CTL, ...args], { stdio: 'inherit', env: process.env });
    if (r.status === 0) {
      console.log('mode: push (tmux) — your moves are injected into the agent\'s terminal');
    }
    process.exit(r.status ?? 0);
  }

  // Otherwise run the server ourselves, detached, in pull mode.
  ensureServerDep();
  mkdirSync(RUN_DIR, { recursive: true });
  rotateLogIfBig();
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER_MJS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      CHESS_PORT: String(port),
      CHESS_TMUX_TARGET: '',                 // no injection target — pull mode
      CHESS_RESUME: process.env.CHESS_RESUME ?? '1',
    },
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(PID_FILE, String(child.pid));
  writeFileSync(PORT_FILE, String(port));
  // Pull mode has no injection pane; drop any stale pane file so status/stop
  // (here and in chess-ctl) read it as manual mode rather than a dead target.
  rmSync(PANE_FILE, { force: true });

  let up = false;
  for (let i = 0; i < 25; i++) {
    if (!isAlive(child.pid)) {
      console.error('server exited during startup — last log lines:');
      console.error(tailLog(15));
      process.exit(1);
    }
    if (await apiState(port, 800)) { up = true; break; }
    await sleep(200);
  }
  if (!up) {
    console.error(`server did not answer on ${base} after ~5s — check ${LOG_FILE}`);
    process.exit(1);
  }

  console.log(`chess server up: ${base} (pid ${child.pid})`);
  reportMode(port, false);
  if (open) openBrowser(base);
}

async function cmdStop() {
  const port = resolvePort();
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;

  // Ownership guard, symmetric with chess-ctl stop's: never shut down a server
  // this install didn't start (another clone's live game on the shared default
  // port). The pidfile or the tmux session must prove the server is ours.
  const ours = ownsPort(port) || sessionOurs(port);
  if (!ours && (await apiState(port))) {
    console.error(`a server answers on ${base} but it wasn't started by this claude-chess — leaving it untouched`);
    console.error(`stop it yourself (curl -X POST ${base}/api/shutdown) or point CHESS_PORT at your instance`);
    process.exit(1);
  }

  if (ours) {
    // Ask the server to exit cleanly, then reap whatever survives below.
    try {
      await fetch(`${base}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) });
      stopped = true;
    } catch { /* not up, or already gone */ }
    await sleep(200);
  }

  let pid = 0;
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()); } catch { /* no pidfile */ }
  if (pid > 0 && isAlive(pid) && isOurServer(pid)) {
    try { process.kill(pid); } catch { /* already gone */ }
    await sleep(150);
    if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    stopped = true;
  }
  // A chess-ctl-started server lives in a detached tmux session; clear it only
  // when that session hosts our server (the same ownership proof as above).
  if (sessionOurs(port)) {
    spawnSync('tmux', ['kill-session', '-t', `chess-server-${port}`], { stdio: 'ignore' });
    stopped = true;
  }
  for (const f of [PID_FILE, PORT_FILE, PANE_FILE]) rmSync(f, { force: true });

  console.log(stopped ? 'chess server stopped.' : 'no chess server was running (state files cleaned).');
}

async function cmdStatus() {
  const port = resolvePort();
  const base = `http://127.0.0.1:${port}`;
  const s = await apiState(port);
  if (!s) { console.log('not running'); process.exit(1); }

  let pid = '';
  try { pid = readFileSync(PID_FILE, 'utf8').trim(); } catch { /* not our pidfile */ }
  console.log(`running${pid ? ` (pid ${pid})` : ''} — ${base}`);
  console.log(s.tmuxTarget ? `mode: push (tmux target ${s.tmuxTarget})` : 'mode: pull (no tmux)');
  const who = (c) => (c === 'w' ? 'White' : 'Black');
  console.log(
    `turn: ${who(s.turn)} | agent: ${who(s.claudeColor)} | status: ${s.status}` +
    (s.awaitingClaude ? ' | awaiting the agent\'s move' : ''),
  );
  if (s.drawOfferBy) {
    console.log(`draw offer pending from ${s.drawOfferBy === s.claudeColor ? 'the agent' : 'you'}`);
  }
  console.log(`fen: ${s.fen}`);
  if (s.history && s.history.length) console.log(`moves: ${s.history.join(' ')}`);
}

async function cmdDoctor() {
  let fails = 0;
  let warns = 0;
  const pass = (m) => console.log(`  ok    ${m}`);
  const warn = (m) => { console.log(`  note  ${m}`); warns++; };
  const fail = (m) => { console.log(`  FAIL  ${m}`); fails++; };
  const info = (m) => console.log(`        ${m}`);

  console.log('claude-chess doctor\n');

  console.log('Required');
  if (nodeMajor() >= 18) pass(`node ${process.version}`);
  else { fail(`node ${process.version} is too old — need v18 or newer`); info('https://nodejs.org  (or: brew install node)'); }

  if (serverDepPresent()) pass('server dependency chess.js is installed');
  else { warn('server dependency chess.js not installed yet — it installs on first start'); info(`or run:  npm --prefix "${SERVER_DIR}" install`); }

  console.log('\nOptional');
  // tmux is optional: with it (inside a session) the server pushes your moves
  // into the agent's pane; without it the agent pulls them. Both are supported.
  if (onPath('tmux')) {
    if (process.env.TMUX_PANE || process.env.TMUX) pass('tmux — inside a session (moves can be pushed to the agent)');
    else pass('tmux available (start `tmux new -s chess` to push moves; otherwise the agent pulls)');
  } else {
    info('tmux not found — optional; the agent pulls moves by long-polling (pull mode) and everything works');
  }

  if (process.platform === 'win32' || onPath('open') || onPath('xdg-open')) pass('a browser opener is available (the board opens itself)');
  else { warn('no browser opener found — open the board URL by hand'); }

  const port = resolvePort();
  if (await apiState(port)) pass(`a chess server is answering on port ${port}`);
  else info(`no chess server on port ${port} yet — start one with:  claude-chess`);

  console.log('\nThe /chess skill');
  if (existsSync(join(REPO_ROOT, '.claude', 'skills', 'chess', 'SKILL.md'))) pass('the /chess skill ships with this package');
  else warn('/chess skill not found alongside this package');

  console.log('');
  if (fails > 0) {
    console.log(`not ready — ${fails} required item(s) missing above.`);
    process.exit(1);
  }
  console.log(warns > 0
    ? `ready to play (${warns} optional note(s) above).`
    : 'everything looks good — ready to play.');
  console.log('\nStart a game:  claude-chess    (then open the printed URL)');
}

function printUsage(stream) {
  (stream || process.stdout).write([
    'usage: claude-chess [start] [--no-open]   start the server and open the board (default)',
    '       claude-chess stop                  stop the server',
    '       claude-chess status                whether it is running and whose turn it is',
    '       claude-chess doctor                check this machine can run it',
    '',
    'env: CHESS_PORT (default 3456)',
    '',
  ].join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const positional = argv.filter((a) => !a.startsWith('-'));
  const cmd = positional[0] || 'start';

  if (flags.has('-h') || flags.has('--help') || cmd === 'help') { printUsage(); return; }

  const open = !flags.has('--no-open');
  switch (cmd) {
    case 'start': await cmdStart({ open }); break;
    case 'stop': await cmdStop(); break;
    case 'status': await cmdStatus(); break;
    case 'doctor': await cmdDoctor(); break;
    default:
      console.error(`unknown command: ${cmd}`);
      printUsage(process.stderr);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});
