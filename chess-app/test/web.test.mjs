// DOM-shim tests for web/board.js — drag-and-drop, click-click moves,
// status wording, control guards, draw-offer UI, and history review.
// No server needed: fetch/EventSource are stubbed, so this suite is safe
// to run concurrently with the API/CLI/ctl suites.
//   node --test chess-app/test/web.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ------------------------------------------------------------ tiny DOM shim
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.classSet = new Set();
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.parent = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get classList() {
    const s = this.classSet;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      contains: (c) => s.has(c),
    };
  }
  setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = String(v); }
  getAttribute(k) { return (this.attrs || {})[k] ?? null; }
  removeAttribute(k) { if (this.attrs) delete this.attrs[k]; }
  set className(v) { this.classSet = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classSet].join(' '); }
  set innerHTML(_) { this.children.forEach((c) => { c.parent = null; }); this.children = []; }
  get innerHTML() { return ''; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  addEventListener(t, fn, cap) { (this.listeners[t] = this.listeners[t] || []).push({ fn, cap: !!cap }); }
  removeEventListener(t, fn) { if (this.listeners[t]) this.listeners[t] = this.listeners[t].filter((l) => l.fn !== fn); }
  getBoundingClientRect() { return { width: 64, height: 64, left: 0, top: 0 }; }
  scrollIntoView() {}
  matches(sel) { return matchesSimple(this, sel); }
  closest(sel) { let e = this; while (e) { if (matchesSimple(e, sel)) return e; e = e.parent; } return null; }
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const walk = (el) => {
      for (const c of el.children) {
        if (matchesSimple(c, parts[parts.length - 1]) && ancestorsMatch(c, parts, this)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}
function matchesSimple(el, part) {
  if (!(el instanceof El)) return false;
  const attr = part.match(/\[data-square(?:="([^"]+)")?\]/);
  if (attr && attr[1] !== undefined && el.dataset.square !== attr[1]) return false;
  if (attr && attr[1] === undefined && !('square' in el.dataset)) return false;
  for (const c of part.match(/\.[\w-]+/g) || []) if (!el.classSet.has(c.slice(1))) return false;
  return true;
}
function ancestorsMatch(el, parts, scope) {
  let i = parts.length - 2;
  let e = el.parent;
  while (i >= 0 && e && e !== scope.parent) {
    if (matchesSimple(e, parts[i])) i--;
    e = e.parent;
  }
  return i < 0;
}

// ------------------------------------------------------- board.js bootstrap
const BOARD_SRC = fs.readFileSync(path.join(ROOT, 'web', 'board.js'), 'utf8');
const VENDOR_URL = pathToFileURL(path.join(ROOT, 'web', 'vendor', 'chess.js')).href;

async function boot(initialState, { confirmAnswer = true } = {}) {
  const byId = {};
  const body = new El('body');
  let hover = null;
  const docListeners = {};
  const doc = {
    body,
    // IDs are created lazily so the shim keeps working as index.html grows.
    getElementById: (id) => byId[id] || (byId[id] = new El('div')),
    createElement: (t) => new El(t),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    elementFromPoint: () => hover,
  };
  const winListeners = {};
  const win = {
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { if (winListeners[t]) winListeners[t] = winListeners[t].filter((f) => f !== fn); },
  };
  const posts = [];
  let state = initialState;
  const fetchStub = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => state };
  };
  class ES { constructor() { setTimeout(() => this.onopen && this.onopen(), 0); } close() {} }

  const src = BOARD_SRC.replace("import('./vendor/chess.js')", `import(${JSON.stringify(VENDOR_URL)})`);
  // board.js registers real background timers at module scope (the 5s nudge
  // clock, the 2s poll fallback). Hand it unref'd timers so they still fire
  // during the test but never keep Node's event loop alive — otherwise
  // `node --test` hangs after this suite instead of exiting.
  const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };
  const setIntervalU = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
  const setTimeoutU = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
  const run = new Function(
    'document', 'window', 'fetch', 'EventSource', 'confirm',
    'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', src,
  );
  run(doc, win, fetchStub, ES, () => confirmAnswer,
    setIntervalU, setTimeoutU, clearInterval, clearTimeout);
  await new Promise((r) => setTimeout(r, 80)); // let boot fetch + vendor import settle

  return {
    byId, body, posts,
    setHover: (el) => { hover = el; },
    cell: (sq) => byId.board.querySelector(`[data-square="${sq}"]`),
    pointerDown(cell, x, y) {
      for (const l of cell.listeners.pointerdown || []) {
        l.fn({ pointerType: 'mouse', button: 0, clientX: x, clientY: y, preventDefault() {} });
      }
    },
    pointerMove(x, y) { for (const f of winListeners.pointermove || []) f({ clientX: x, clientY: y, preventDefault() {} }); },
    pointerUp(x, y) { for (const f of [...(winListeners.pointerup || [])]) f({ clientX: x, clientY: y }); },
    click(cell) {
      let stopped = false;
      const ev = { stopPropagation() { stopped = true; }, target: cell };
      for (const l of byId.board.listeners.click || []) if (l.cap) l.fn(ev);
      if (!stopped) for (const l of cell.listeners.click || []) if (!l.cap) l.fn(ev);
    },
    clickButton(id) { for (const l of byId[id].listeners.click || []) l.fn({}); },
    keydown(key) {
      for (const f of docListeners.keydown || []) f({ key, target: null, preventDefault() {} });
    },
    setState(next) { state = next; },
    settle: () => new Promise((r) => setTimeout(r, 30)),
  };
}

const AFTER_E4_E5 = {
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  turn: 'w', claudeColor: 'b', awaitingClaude: false, status: 'playing',
  gameOver: false, resignedBy: null, drawOfferBy: null, drawAgreed: false,
  lastMove: { from: 'e7', to: 'e5', san: 'e5' }, history: ['e4', 'e5'],
};

const FOOLS_MATE = {
  fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
  turn: 'w', claudeColor: 'b', awaitingClaude: false, status: 'checkmate',
  gameOver: true, resignedBy: null, drawOfferBy: null, drawAgreed: false,
  lastMove: { from: 'd8', to: 'h4', san: 'Qh4#' }, history: ['f3', 'e5', 'g4', 'Qh4#'],
};

// ---------------------------------------------------------------- moving

test('drag a legal move posts UCI and cleans up', async () => {
  const t = await boot(AFTER_E4_E5);
  const g1 = t.cell('g1');
  const f3 = t.cell('f3');
  assert.ok(g1 && f3, 'board cells rendered');
  t.pointerDown(g1, 100, 100);
  t.setHover(f3);
  t.pointerMove(140, 60); // past threshold — ghost appears
  const ghost = t.body.children.find((c) => c.classSet.has('drag-ghost'));
  assert.ok(ghost, 'ghost created on drag');
  assert.equal(ghost.textContent, '♘');
  assert.ok(t.byId.board.querySelector('.piece.drag-source'), 'origin piece dimmed');
  assert.ok(t.byId.board.querySelector('.square.drop-target'), 'drop target highlighted');
  t.pointerUp(140, 60);
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/move' && p.body.move === 'g1f3'),
    `legal drag POSTs uci move, got ${JSON.stringify(t.posts)}`);
  assert.ok(!t.body.children.some((c) => c.classSet.has('drag-ghost')), 'ghost removed after drop');
  assert.ok(!t.byId.board.querySelector('.square.drop-target'), 'drop highlight cleared');
});

test('drag to an illegal square does not post', async () => {
  const t = await boot(AFTER_E4_E5);
  t.pointerDown(t.cell('g1'), 100, 100);
  t.setHover(t.cell('g4'));
  t.pointerMove(160, 40);
  t.pointerUp(160, 40);
  await t.settle();
  assert.equal(t.posts.length, 0, `no POST expected, got ${JSON.stringify(t.posts)}`);
  assert.ok(!t.byId.board.querySelector('.piece.drag-source'), 'drag state cleaned up');
});

test('sub-threshold press stays a click; click-click move posts', async () => {
  const t = await boot(AFTER_E4_E5);
  const d2 = t.cell('d2');
  t.pointerDown(d2, 100, 100);
  t.pointerUp(101, 101); // < threshold — click handler takes it
  t.click(d2);
  await t.settle();
  assert.ok(t.cell('d2').classSet.has('selected'), 'square selected via click');
  assert.equal(t.posts.length, 0, 'no POST from bare selection');
  t.click(t.cell('d4'));
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/move' && p.body.move === 'd2d4'),
    'click-click move POSTs');
});

test('click on a non-target square deselects without posting', async () => {
  const t = await boot(AFTER_E4_E5);
  t.click(t.cell('g1'));
  await t.settle();
  assert.ok(t.cell('g1').classSet.has('selected'));
  t.click(t.cell('g4')); // knight cannot reach g4
  await t.settle();
  assert.equal(t.posts.length, 0, 'illegal click-click never round-trips');
  assert.ok(!t.cell('g1').classSet.has('selected'), 'selection cleared');
});

test('last move squares are highlighted', async () => {
  const t = await boot(AFTER_E4_E5);
  assert.ok(t.cell('e7').classSet.has('last-move'));
  assert.ok(t.cell('e5').classSet.has('last-move'));
});

// ---------------------------------------------------------------- status

test('checkmate wording — human mated sees Claude wins', async () => {
  const t = await boot(FOOLS_MATE);
  assert.equal(t.byId['status-bar'].textContent, 'Checkmate — Claude wins.');
});

test('checkmate wording — Claude mated sees you win', async () => {
  const t = await boot({ ...FOOLS_MATE, claudeColor: 'w' });
  assert.equal(t.byId['status-bar'].textContent, 'Checkmate — you win!');
});

test('stalemate and bare-draw wording', async () => {
  const t = await boot({ ...AFTER_E4_E5, status: 'stalemate', gameOver: true });
  assert.equal(t.byId['status-bar'].textContent, 'Draw — stalemate.');
  const d = await boot({ ...AFTER_E4_E5, status: 'draw', gameOver: true });
  assert.equal(d.byId['status-bar'].textContent, 'Draw.');
});

test('resignation wording names who resigned', async () => {
  const you = await boot({ ...AFTER_E4_E5, status: 'resigned', gameOver: true, resignedBy: 'w' });
  assert.equal(you.byId['status-bar'].textContent, 'Game over — you resigned. Claude wins.');
  const claude = await boot({ ...AFTER_E4_E5, status: 'resigned', gameOver: true, resignedBy: 'b' });
  assert.equal(claude.byId['status-bar'].textContent, 'Game over — Claude resigned. You win!');
});

test('in-check status and king highlight', async () => {
  // 1.f3 e5 2.g4 Qh4+ but with Ke2 escape available? Use a simple check: after
  // 1.e4 e5 2.Qh5 Nc6 3.Qxf7+ is mate-ish; instead use a known non-mate check.
  const t = await boot({
    ...AFTER_E4_E5,
    fen: 'rnb1kbnr/pppp1ppp/8/4p3/4PP1q/8/PPPP2PP/RNBQKBNR w KQkq - 1 3',
    status: 'check', history: ['e4', 'e5', 'f4', 'Qh4+'],
    lastMove: { from: 'd8', to: 'h4', san: 'Qh4+' },
  });
  assert.equal(t.byId['status-bar'].textContent, 'Your move — you are in check!');
  assert.ok(t.cell('e1').classSet.has('in-check'), 'checked king square highlighted');
});

// ---------------------------------------------------------------- controls

test('control buttons mirror server guards', async () => {
  const fresh = await boot({ ...AFTER_E4_E5, history: [], lastMove: null, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
  assert.equal(fresh.byId.takeback.disabled, true, 'takeback disabled with empty history');
  const waiting = await boot({ ...AFTER_E4_E5, awaitingClaude: true, turn: 'b' });
  assert.equal(waiting.byId.takeback.disabled, true, 'takeback disabled while awaiting Claude');
  const over = await boot(FOOLS_MATE);
  assert.equal(over.byId.takeback.disabled, true, 'takeback disabled after game over');
  assert.equal(over.byId.resign.disabled, true, 'resign disabled after game over');
  assert.equal(over.byId['offer-draw'].disabled, true, 'offer-draw disabled after game over');
  const live = await boot(AFTER_E4_E5);
  assert.equal(live.byId.takeback.disabled, false);
  assert.equal(live.byId.resign.disabled, false);
  assert.equal(live.byId['offer-draw'].disabled, false);
});

test('takeback posts to /api/undo; resign confirms then posts', async () => {
  const t = await boot(AFTER_E4_E5);
  t.clickButton('takeback');
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/undo'));
  t.clickButton('resign');
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/resign' && p.body.by === 'human'));
});

test('resign is aborted when the confirm dialog is declined', async () => {
  const t = await boot(AFTER_E4_E5, { confirmAnswer: false });
  t.clickButton('resign');
  await t.settle();
  assert.ok(!t.posts.some((p) => p.url === '/api/resign'), 'no resign POST after cancel');
});

// ---------------------------------------------------------------- draw UI

test('offer-draw posts an offer and the sent-offer note appears', async () => {
  const t = await boot(AFTER_E4_E5);
  t.clickButton('offer-draw');
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/draw' && p.body.action === 'offer' && p.body.by === 'human'));
  const pending = await boot({ ...AFTER_E4_E5, drawOfferBy: 'w' });
  assert.match(pending.byId['status-bar'].textContent, /draw offer sent/);
  assert.equal(pending.byId['offer-draw'].disabled, true, 'no double offers');
  assert.equal(pending.byId['draw-banner'].hidden, true, 'own offer shows no banner');
});

test("Claude's pending offer shows the banner; accept/decline post", async () => {
  const t = await boot({ ...AFTER_E4_E5, drawOfferBy: 'b' });
  assert.equal(t.byId['draw-banner'].hidden, false, 'banner visible for claude offer');
  assert.equal(t.byId['offer-draw'].disabled, true);
  t.clickButton('draw-accept');
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/draw' && p.body.action === 'accept' && p.body.by === 'human'));
  t.clickButton('draw-decline');
  await t.settle();
  assert.ok(t.posts.some((p) => p.url === '/api/draw' && p.body.action === 'decline' && p.body.by === 'human'));
});

test('agreed draw wording and banner hidden after game over', async () => {
  const t = await boot({ ...AFTER_E4_E5, status: 'draw', gameOver: true, drawAgreed: true, drawOfferBy: 'b' });
  assert.equal(t.byId['status-bar'].textContent, 'Draw agreed.');
  assert.equal(t.byId['draw-banner'].hidden, true, 'banner suppressed once game is over');
});

// ------------------------------------------------------------ history review

test('arrow keys review past positions without posting', async () => {
  const t = await boot(AFTER_E4_E5);
  t.keydown('ArrowLeft');
  await t.settle();
  assert.match(t.byId['status-bar'].textContent, /Reviewing move 1 of 2/);
  // e5 not yet played at ply 1 — black pawn back home on e7.
  assert.ok(t.cell('e7').querySelector('.piece'), 'reviewed position shows earlier board');
  t.click(t.cell('e2'));
  t.click(t.cell('e3'));
  await t.settle();
  assert.equal(t.posts.length, 0, 'no POST while reviewing');
  t.keydown('End');
  await t.settle();
  assert.match(t.byId['status-bar'].textContent, /Your move/);
});

test('board click returns from review to live', async () => {
  const t = await boot(AFTER_E4_E5);
  t.keydown('Home');
  await t.settle();
  assert.match(t.byId['status-bar'].textContent, /Reviewing move 0 of 2/);
  t.click(t.cell('a1'));
  await t.settle();
  assert.match(t.byId['status-bar'].textContent, /Your move/);
});

// ---------------------------------------------------------- SSE reconnection
// Fake timers and a scripted EventSource are injected as function parameters
// (they shadow the globals inside board.js), so backoff schedules can be
// advanced deterministically without real waiting or global monkey-patching.
async function bootNet() {
  const byId = {};
  const body = new El('body');
  const doc = {
    body,
    getElementById: (id) => byId[id] || (byId[id] = new El('div')),
    createElement: (t) => new El(t),
    addEventListener() {},
    elementFromPoint: () => null,
  };
  const win = { addEventListener() {}, removeEventListener() {} };

  let now = 0;
  const timers = [];
  let nextId = 1;
  const fakeSetTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, fn, interval: null, id: nextId }); return nextId++; };
  const fakeSetInterval = (fn, ms) => { timers.push({ at: now + ms, fn, interval: ms, id: nextId }); return nextId++; };
  const fakeClear = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.interval) due.at = now + due.interval;
      else timers.splice(timers.indexOf(due), 1);
      due.fn();
      await Promise.resolve(); await Promise.resolve(); // let fetch promises settle
    }
    now = end;
  }

  const net = { up: true, stateFetches: 0 };
  const fetchStub = async (url) => {
    if (!net.up) throw new Error('ECONNREFUSED');
    if (url === '/api/state') { net.stateFetches++; return { ok: true, json: async () => ({ ...AFTER_E4_E5 }) }; }
    return { ok: true, json: async () => ({}) };
  };

  const sources = [];
  class ScriptedES {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; sources.push(this); }
    close() { this.readyState = 2; }
    emitOpen() { this.readyState = 1; this.onopen && this.onopen(); }
    emitError(closed) { if (closed) this.readyState = 2; this.onerror && this.onerror(); }
    emitState() { this.onmessage && this.onmessage({ data: JSON.stringify(AFTER_E4_E5) }); }
  }

  // The vendor engine is not under test here; strip its dynamic import so the
  // boot is fully deterministic under the fake clock.
  const src = BOARD_SRC.replace(/import\('\.\/vendor\/chess\.js'\)[\s\S]*?\.catch\(\(\) => \{\}\);/, '');
  const run = new Function(
    'document', 'window', 'fetch', 'EventSource', 'confirm',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', src,
  );
  run(doc, win, fetchStub, ScriptedES, () => true,
    fakeSetTimeout, fakeSetInterval, fakeClear, fakeClear);
  await advance(1);

  // Count only the poll interval (2000ms). board.js also runs a permanent
  // module-scope nudge clock (setInterval 5000ms); it's always active and is
  // not what these SSE/polling assertions are measuring.
  const activeIntervals = () => timers.filter((t) => t.interval === 2000).length;
  return { sources, advance, activeIntervals, net, statusEl: byId['status-bar'] };
}

test('SSE drop while browser auto-retries starts polling; reopen stops it', async (t) => {
  const n = await bootNet();
  assert.equal(n.sources.length, 1, 'one EventSource on boot');
  n.sources[0].emitOpen();
  n.sources[0].emitState();
  await n.advance(1);
  assert.equal(n.statusEl.textContent, 'Your move');
  assert.equal(n.activeIntervals(), 0, 'no polling while the stream is open');
  // Stream drops but the browser keeps retrying (readyState CONNECTING):
  // we poll in the meantime and must NOT stack a manual reconnect on top.
  n.sources[0].readyState = 0;
  n.sources[0].emitError(false);
  await n.advance(1);
  assert.equal(n.activeIntervals(), 1, 'polling started');
  assert.equal(n.sources.length, 1, 'no manual reconnect while browser retries');
  n.sources[0].emitOpen();
  await n.advance(1);
  assert.equal(n.activeIntervals(), 0, 'polling stopped when the stream reopened');
});

test('CLOSED stream reconnects with doubling backoff and honest status', async () => {
  const n = await bootNet();
  n.sources[0].emitOpen();
  await n.advance(1);
  n.net.up = false;
  n.sources[0].emitError(true); // browser gave up — manual backoff takes over
  await n.advance(1);
  assert.equal(n.activeIntervals(), 1, 'polling while disconnected');
  await n.advance(2100); // one failed poll tick (2s) + first retry (1s)
  assert.equal(n.statusEl.textContent, 'Connection lost — retrying…');
  assert.equal(n.sources.length, 2, 'reconnect attempted after 1s backoff');
  n.sources[1].emitError(true);
  await n.advance(2100);
  assert.equal(n.sources.length, 3, 'backoff doubled to 2s before the next attempt');
});

test('reopen after an outage refreshes state and resets the backoff', async () => {
  const n = await bootNet();
  n.sources[0].emitOpen();
  await n.advance(1);
  n.net.up = false;
  n.sources[0].emitError(true);
  await n.advance(3200); // outage long enough for one failed poll + one retry
  const es = n.sources.at(-1);
  n.net.up = true;
  const before = n.net.stateFetches;
  es.emitOpen();
  es.emitState();
  await n.advance(1);
  assert.equal(n.activeIntervals(), 0, 'polling stopped after reconnect');
  assert.ok(n.net.stateFetches > before, 'state refetched on reopen (server may have changed)');
  assert.equal(n.statusEl.textContent, 'Your move');
  // Backoff must reset after a successful open: next death retries at ~1s.
  const count = n.sources.length;
  es.emitError(true);
  await n.advance(1100);
  assert.equal(n.sources.length, count + 1, 'backoff reset to 1s after a successful open');
});

test('game-over board blocks selection and drags', async () => {
  const t = await boot(FOOLS_MATE);
  t.click(t.cell('e2'));
  await t.settle();
  assert.ok(!t.cell('e2').classSet.has('selected'), 'no selection after game over');
  t.pointerDown(t.cell('e2'), 100, 100);
  t.pointerMove(160, 40);
  assert.ok(!t.body.children.some((c) => c.classSet.has('drag-ghost')), 'no drag after game over');
  t.pointerUp(160, 40);
});
