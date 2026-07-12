/* Board UI for claude-chess.
 * All legality lives on the server (chess.js); this file only renders state,
 * collects clicks, and POSTs UCI moves. State arrives via SSE with a polling
 * fallback. */

const API = {
  state: '/api/state',
  move: '/api/move',
  newGame: '/api/new',
  undo: '/api/undo',
  resign: '/api/resign',
  draw: '/api/draw',
  nudge: '/api/nudge',
  events: '/events',
  shutdown: '/api/shutdown',
};

const PIECES = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};

// Spoken piece names for screen-reader square labels (piece key like "wp").
const PIECE_NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
function squareLabel(sq, piece) {
  if (!piece) return `${sq}, empty`;
  return `${sq}, ${piece[0] === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece[1]]}`;
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

let state = null;          // last server snapshot
let selected = null;       // selected square name, e.g. "e2"
let pollTimer = null;
let engine = null;         // client-side chess.js mirror of state.fen (hints only)
let ChessCtor = null;
let replay = null;         // {fens, moves} from replaying state.history (review + highlights)
let viewPly = null;        // null = live; otherwise the ply (0..history.length) being reviewed
let drag = null;           // active pointer drag: {from, piece, pieces, startX, startY, moved, ghost, size}
let suppressClick = false; // eat the click that trails a completed drag

// The server stays the sole authority on legality; the local engine only
// powers move hints and check highlighting, so the UI degrades gracefully
// if the vendored module fails to load.
import('./vendor/chess.js')
  .then((m) => { ChessCtor = m.Chess; syncEngine(); render(); })
  .catch(() => {});

function syncEngine() {
  engine = null;
  replay = null;
  if (!ChessCtor || !state) return;
  try { engine = new ChessCtor(state.fen); } catch { /* bad FEN — no hints */ }
  // Replay the SAN history so past positions can be reviewed and the last
  // move's from/to squares highlighted. Any mismatch degrades to no replay.
  try {
    const e = new ChessCtor();
    const fens = [e.fen()];
    const moves = [];
    for (const san of state.history || []) {
      moves.push(e.move(san));
      fens.push(e.fen());
    }
    replay = { fens, moves };
  } catch { replay = null; }
}

// ------------------------------------------------------------ history review

function livePly() {
  return ((state && state.history) || []).length;
}

function shownPly() {
  return replay && viewPly !== null ? Math.min(viewPly, livePly()) : livePly();
}

function reviewing() {
  return !!replay && viewPly !== null && viewPly < livePly();
}

function displayedFen() {
  return reviewing() ? replay.fens[shownPly()] : state.fen;
}

function gotoPly(ply) {
  if (!replay) return;
  const max = livePly();
  const clamped = Math.max(0, Math.min(ply, max));
  viewPly = clamped === max ? null : clamped;
  selected = null;
  render();
}

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status-bar');
const errorEl = document.getElementById('error-bar');
const historyEl = document.getElementById('history');
const takebackBtn = document.getElementById('takeback');
const resignBtn = document.getElementById('resign');
const offerDrawBtn = document.getElementById('offer-draw');
const drawBannerEl = document.getElementById('draw-banner');
const nudgeBannerEl = document.getElementById('nudge-banner');
const nudgeBtn = document.getElementById('nudge');

// ---------------------------------------------------------------- state I/O

async function fetchState() {
  const res = await fetch(API.state);
  if (!res.ok) throw new Error(`state fetch failed (${res.status})`);
  applyState(await res.json());
}

let esRetryMs = 1000; // reconnect backoff, doubles up to 15s, resets on open

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(() => fetchState().catch(showDisconnected), 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function connectEvents() {
  const es = new EventSource(API.events);
  es.onmessage = (ev) => {
    try {
      applyState(JSON.parse(ev.data));
    } catch { /* ignore malformed frames */ }
  };
  es.onerror = () => {
    // SSE down (server restarting) — poll while it's out. The browser retries
    // the stream itself unless it gave up (CLOSED); then we recreate it with
    // backoff so a restarted server picks the live stream back up.
    startPolling();
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(connectEvents, esRetryMs);
      esRetryMs = Math.min(esRetryMs * 2, 15000);
    }
  };
  es.onopen = () => {
    esRetryMs = 1000;
    stopPolling();
    // The stream's initial event carries state, but refresh in case this is a
    // reconnect to a server that changed while we were polling.
    fetchState().catch(() => {});
  };
}

function applyState(next) {
  const sound = soundFor(state, next);
  trackAwaiting(state, next);
  state = next;
  selected = null;
  viewPly = null; // a live update always snaps the view back to the present
  if (drag) cancelDrag(); // board changed under the pointer — abandon the drag
  syncEngine();
  render();
  if (sound) playSound(sound);
}

// ------------------------------------------------------------- nudge (stall)

// The tmux injection can be lost (pane busy, prompt cleared). When it is,
// awaitingClaude stays true with no state change; after a grace period we
// surface a button that asks the server to re-inject the your-turn prompt.
const NUDGE_AFTER_MS = 30000;
let awaitingSince = null; // when the current wait for Claude started

function trackAwaiting(prev, next) {
  if (!next.awaitingClaude) {
    awaitingSince = null;
    return;
  }
  const histLen = (next.history || []).length;
  const prevLen = prev ? (prev.history || []).length : -1;
  if (!prev || !prev.awaitingClaude || histLen !== prevLen) awaitingSince = Date.now();
}

function nudgeDue() {
  return !!(state && state.awaitingClaude && !gameOver() &&
    awaitingSince !== null && Date.now() - awaitingSince >= NUDGE_AFTER_MS);
}

// State only changes on server events, so the stall clock needs its own tick.
setInterval(() => {
  if (state && nudgeBannerEl.hidden === nudgeDue()) renderControls();
}, 5000);

nudgeBtn.addEventListener('click', () => {
  awaitingSince = Date.now(); // restart the clock; re-show only if still stuck
  renderControls();
  postAction(API.nudge, null, 'Could not nudge Claude.');
});

function showDisconnected() {
  statusEl.textContent = 'Connection lost — retrying…';
  statusEl.className = 'status-bar over';
}

// ------------------------------------------------------------------- sounds

// Everything is synthesized with WebAudio, so there are no assets to load and
// the whole feature degrades to silence where audio is unavailable.
let muted = false;
try { muted = localStorage.getItem('chess-muted') === '1'; } catch { /* no storage */ }
let audioCtx = null;

function getAudio() {
  if (muted) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    try { audioCtx = new AC(); } catch { return null; }
  }
  // Autoplay policy leaves the context suspended until a user gesture; ask
  // every time so the first post-gesture sound unsticks it.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx.state === 'running' ? audioCtx : null;
}

function tone(ctx, freq, start, dur, type = 'triangle', gain = 0.12) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + start;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

const SOUNDS = {
  move: (c) => tone(c, 260, 0, 0.08),
  capture: (c) => { tone(c, 200, 0, 0.06, 'square', 0.08); tone(c, 150, 0.05, 0.09, 'square', 0.08); },
  check: (c) => { tone(c, 660, 0, 0.09); tone(c, 880, 0.1, 0.14); },
  end: (c) => { tone(c, 523, 0, 0.15); tone(c, 659, 0.12, 0.15); tone(c, 784, 0.24, 0.3); },
  notify: (c) => { tone(c, 587, 0, 0.12); tone(c, 494, 0.13, 0.18); },
};

function playSound(name) {
  const ctx = getAudio();
  if (!ctx) return;
  try { SOUNDS[name](ctx); } catch { /* audio backend hiccup — stay silent */ }
}

function soundFor(prev, next) {
  // Diff consecutive snapshots to pick a cue; the first snapshot (page load /
  // reconnect) and shrinking histories (undo, new game) stay silent.
  if (!prev || !next) return null;
  if (!gameOver(prev) && gameOver(next)) return 'end';
  const hist = next.history || [];
  if (hist.length > (prev.history || []).length) {
    const san = hist[hist.length - 1] || '';
    if (san.includes('+')) return 'check';
    if (san.includes('x')) return 'capture';
    return 'move';
  }
  if (next.drawOfferBy === next.claudeColor && prev.drawOfferBy !== next.claudeColor) return 'notify';
  return null;
}

// ---------------------------------------------------------------- rendering

function parseFen(fen) {
  // Returns map of square name -> piece key like "wp"/"bk".
  const board = {};
  const placement = fen.split(' ')[0];
  const ranks = placement.split('/');
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      board[FILES[file] + (8 - r)] = color + ch.toLowerCase();
      file++;
    }
  }
  return board;
}

function playerColor() {
  // The human plays the opposite color from Claude (server reports claudeColor).
  return state && state.claudeColor === 'w' ? 'black' : 'white';
}

function orientedSquares() {
  // Squares in render order (top-left first) for the player's orientation.
  const squares = [];
  const flipped = playerColor() === 'black';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row + 1 : 8 - row;
      squares.push(FILES[file] + rank);
    }
  }
  return squares;
}

function lastMoveSquares() {
  const ply = shownPly();
  if (ply === 0) return [];
  if (replay) {
    const m = replay.moves[ply - 1];
    return [m.from, m.to];
  }
  const lm = state && state.lastMove;
  if (lm) {
    if (typeof lm === 'string' && lm.length >= 4) return [lm.slice(0, 2), lm.slice(2, 4)];
    if (lm.from && lm.to) return [lm.from, lm.to];
  }
  // Fallback: derive the destination square from the last SAN in history.
  const san = ((state && state.history) || [])[ply - 1];
  if (!san) return [];
  const m = san.replace(/[+#!?]+$/, '').match(/([a-h][1-8])(=[QRBN])?$/);
  return m ? [m[1]] : [];
}

function legalTargets(from) {
  // Squares the selected piece may move to, per the local engine (hints only).
  if (!engine) return {};
  const targets = {};
  try {
    for (const m of engine.moves({ square: from, verbose: true })) {
      targets[m.to] = m.captured ? 'capture' : 'move';
    }
  } catch { /* engine out of sync — no hints */ }
  return targets;
}

function checkedKingSquare(fen, pieces) {
  if (!ChessCtor) return null;
  let turn;
  try {
    const e = new ChessCtor(fen);
    if (!e.inCheck()) return null;
    turn = e.turn();
  } catch { return null; }
  const king = turn + 'k';
  return Object.keys(pieces).find((sq) => pieces[sq] === king) || null;
}

function render() {
  if (!state) return;
  const fen = displayedFen();
  const pieces = parseFen(fen);
  const highlight = lastMoveSquares();
  const flipped = playerColor() === 'black';
  const hints = selected && !reviewing() ? legalTargets(selected) : {};
  const checkedSq = checkedKingSquare(fen, pieces);

  boardEl.innerHTML = '';
  orientedSquares().forEach((sq, i) => {
    const cell = document.createElement('div');
    const fileIdx = FILES.indexOf(sq[0]);
    const rank = Number(sq[1]);
    cell.className = 'square ' + ((fileIdx + rank) % 2 === 0 ? 'dark' : 'light');
    cell.dataset.square = sq;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', squareLabel(sq, pieces[sq]));
    if (highlight.includes(sq)) cell.classList.add('last-move');
    if (sq === selected) cell.classList.add('selected');
    if (hints[sq]) cell.classList.add(hints[sq] === 'capture' ? 'hint-capture' : 'hint');
    if (sq === checkedSq) cell.classList.add('in-check');

    const piece = pieces[sq];
    if (piece) {
      const span = document.createElement('span');
      span.className = 'piece ' + (piece[0] === 'w' ? 'white' : 'black');
      span.textContent = PIECES[piece];
      cell.appendChild(span);
    }

    // Coordinate labels on the two visible edges.
    const col = i % 8, row = Math.floor(i / 8);
    if (row === 7) {
      const f = document.createElement('span');
      f.className = 'coord file';
      f.textContent = sq[0];
      cell.appendChild(f);
    }
    if (col === 0) {
      const r = document.createElement('span');
      r.className = 'coord rank';
      r.textContent = sq[1];
      cell.appendChild(r);
    }

    cell.addEventListener('click', () => onSquareClick(sq, pieces));
    cell.addEventListener('pointerdown', (e) => onPointerDown(e, sq, pieces));
    boardEl.appendChild(cell);
  });
  void flipped; // orientation handled in orientedSquares()

  // A rerender mid-drag (e.g. selecting the origin square) rebuilds the cells,
  // so the origin piece's dimming has to be reapplied.
  if (drag && drag.moved) {
    const origin = boardEl.querySelector(`[data-square="${drag.from}"] .piece`);
    if (origin) origin.classList.add('drag-source');
  }

  renderStatus();
  renderHistory();
  renderCaptured(pieces);
  renderControls();
}

function renderControls() {
  // Mirror the server's 409 guards so the buttons read as unavailable
  // instead of failing on click (the server stays authoritative).
  const history = state.history || [];
  takebackBtn.disabled = gameOver() || state.awaitingClaude || history.length === 0;
  resignBtn.disabled = gameOver();
  offerDrawBtn.disabled = gameOver() || !!state.drawOfferBy;
  // Claude's pending offer is answered from a banner; our own just waits.
  drawBannerEl.hidden = gameOver() || state.drawOfferBy !== state.claudeColor;
  nudgeBannerEl.hidden = !nudgeDue();
}

// ------------------------------------------------------------ captured pieces

const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function capturedFor(pieces, color) {
  // Pieces of `color` missing from the board (clamped: promotions can raise counts).
  const counts = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const pc of Object.values(pieces)) {
    if (pc[0] === color && pc[1] in counts) counts[pc[1]]++;
  }
  const captured = [];
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    for (let i = counts[t]; i < START_COUNTS[t]; i++) captured.push(t);
  }
  return captured;
}

function materialPoints(list) {
  return list.reduce((sum, t) => sum + PIECE_VALUES[t], 0);
}

function renderCaptured(pieces) {
  const mine = playerColor()[0];
  const theirs = mine === 'w' ? 'b' : 'w';
  // Each bar shows what that side has captured: top = opponent's captures
  // (my missing pieces), bottom = my captures (their missing pieces).
  const byTop = capturedFor(pieces, mine);
  const byBottom = capturedFor(pieces, theirs);
  const diff = materialPoints(byBottom) - materialPoints(byTop);
  fillCapturedBar('captured-top', byTop, mine, diff < 0 ? -diff : 0);
  fillCapturedBar('captured-bottom', byBottom, theirs, diff > 0 ? diff : 0);
}

function fillCapturedBar(id, list, victimColor, lead) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  for (const t of list) {
    const span = document.createElement('span');
    span.className = 'captured-piece';
    span.textContent = PIECES[victimColor + t];
    el.appendChild(span);
  }
  if (lead > 0) {
    const span = document.createElement('span');
    span.className = 'material-lead';
    span.textContent = `+${lead}`;
    el.appendChild(span);
  }
}

function gameOver(snap = state) {
  if (typeof snap.gameOver === 'boolean') return snap.gameOver;
  const s = (snap.status || '').toLowerCase();
  return ['checkmate', 'stalemate', 'draw', 'over', 'resigned'].some((w) => s.includes(w));
}

function myTurn() {
  return state.turn === playerColor()[0];
}

function renderStatus() {
  if (reviewing()) {
    statusEl.textContent =
      `Reviewing move ${shownPly()} of ${livePly()} — click the board or press End to return`;
    statusEl.className = 'status-bar waiting';
    return;
  }
  let text;
  const s = (state.status || '').toLowerCase();
  if (gameOver()) {
    if (state.resignedBy) {
      text = state.resignedBy === playerColor()[0]
        ? 'Game over — you resigned. Claude wins.'
        : 'Game over — Claude resigned. You win!';
    } else if (s.includes('checkmate')) {
      // The side to move is the one that got mated.
      text = myTurn() ? 'Checkmate — Claude wins.' : 'Checkmate — you win!';
    } else if (s.includes('stalemate')) {
      text = 'Draw — stalemate.';
    } else if (state.drawAgreed) {
      text = 'Draw agreed.';
    } else if (s.includes('draw')) {
      // statusDetail carries the rule that ended it ("draw by threefold
      // repetition", "fifty-move rule", "insufficient material").
      const reason = (state.statusDetail || '').replace(/^draw by\s+/i, '');
      text = reason ? `Draw — ${reason}.` : 'Draw.';
    } else {
      text = `Game over — ${state.statusDetail || state.status}`;
    }
  } else if (myTurn()) {
    text = s.includes('check') ? 'Your move — you are in check!' : 'Your move';
  } else {
    text = 'Claude is thinking…';
  }
  if (!gameOver() && state.drawOfferBy === playerColor()[0]) {
    text += ' — draw offer sent (moving withdraws it)';
  }
  statusEl.textContent = text;
  statusEl.className = 'status-bar' + (gameOver() ? ' over' : myTurn() ? ' yours' : ' waiting');
}

function renderHistory() {
  historyEl.innerHTML = '';
  const moves = state.history || [];
  const current = shownPly();
  let currentEl = null;
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    for (const j of [i, i + 1]) {
      if (!moves[j]) continue;
      const span = document.createElement('span');
      span.className = 'move' + (j + 1 === current ? ' current' : '');
      span.textContent = moves[j];
      // Clicking a move reviews that position (needs the replay engine).
      if (replay) span.addEventListener('click', () => gotoPly(j + 1));
      if (j + 1 === current) currentEl = span;
      li.appendChild(span);
    }
    historyEl.appendChild(li);
  }
  if (reviewing() && currentEl && currentEl.scrollIntoView) {
    currentEl.scrollIntoView({ block: 'nearest' });
  } else {
    historyEl.scrollTop = historyEl.scrollHeight;
  }
}

// ---------------------------------------------------------------- moving

function onSquareClick(sq, pieces) {
  if (!state) return;
  if (reviewing()) { gotoPly(livePly()); return; }
  if (gameOver() || !myTurn()) return;
  const mine = playerColor()[0];
  const piece = pieces[sq];

  if (selected === sq) {
    selected = null;
    render();
    return;
  }
  if (piece && piece[0] === mine) {
    selected = sq;
    render();
    return;
  }
  if (!selected) return;

  // With the local engine available, a click on a non-target square just
  // deselects instead of round-tripping an obviously illegal move.
  if (engine && !(sq in legalTargets(selected))) {
    selected = null;
    render();
    return;
  }

  tryMove(selected, sq, pieces);
}

function tryMove(from, to, pieces) {
  const mine = playerColor()[0];
  const isPromotion =
    pieces[from] === mine + 'p' &&
    ((mine === 'w' && to[1] === '8') || (mine === 'b' && to[1] === '1'));

  if (isPromotion) {
    askPromotion(mine).then((pc) => (pc ? sendMove(from + to + pc) : render()));
  } else {
    sendMove(from + to);
  }
}

// ------------------------------------------------------------ drag and drop

// Pointer-based dragging alongside click-click: a press that never travels
// past the threshold is left to the click handler; past it, a ghost piece
// follows the pointer and releasing over a square plays the move.
const DRAG_THRESHOLD = 5;

function onPointerDown(e, sq, pieces) {
  if (drag || !state || reviewing() || gameOver() || !myTurn()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const piece = pieces[sq];
  if (!piece || piece[0] !== playerColor()[0]) return;
  drag = { from: sq, piece, pieces, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, size: 64 };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', cancelDrag);
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    if (selected !== drag.from) { selected = drag.from; render(); } // show hints
    const cell = boardEl.querySelector(`[data-square="${drag.from}"]`);
    if (cell) {
      drag.size = cell.getBoundingClientRect().width;
      const pieceEl = cell.querySelector('.piece');
      if (pieceEl) pieceEl.classList.add('drag-source');
    }
    const ghost = document.createElement('span');
    ghost.className = 'drag-ghost ' + (drag.piece[0] === 'w' ? 'white' : 'black');
    ghost.style.fontSize = drag.size * 0.8 + 'px';
    ghost.textContent = PIECES[drag.piece];
    document.body.appendChild(ghost);
    drag.ghost = ghost;
  }
  drag.ghost.style.left = e.clientX - drag.size / 2 + 'px';
  drag.ghost.style.top = e.clientY - drag.size / 2 + 'px';
  setDropTarget(squareAt(e.clientX, e.clientY));
  e.preventDefault();
}

function onPointerUp(e) {
  const d = drag;
  cancelDrag();
  if (!d || !d.moved) return; // plain click — the click handler takes it
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0); // in case no click follows
  const to = squareAt(e.clientX, e.clientY);
  selected = null;
  if (!to || to === d.from || (engine && !(to in legalTargets(d.from)))) {
    render();
    return;
  }
  tryMove(d.from, to, d.pieces);
}

function cancelDrag() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', cancelDrag);
  if (!drag) return;
  if (drag.ghost) drag.ghost.remove();
  setDropTarget(null);
  const pieceEl = boardEl.querySelector('.piece.drag-source');
  if (pieceEl) pieceEl.classList.remove('drag-source');
  drag = null;
}

function squareAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const cell = el && el.closest && el.closest('[data-square]');
  return cell ? cell.dataset.square : null;
}

function setDropTarget(sq) {
  const prev = boardEl.querySelector('.square.drop-target');
  if (prev && prev.dataset.square !== sq) prev.classList.remove('drop-target');
  if (sq && (!prev || prev.dataset.square !== sq)) {
    const cell = boardEl.querySelector(`[data-square="${sq}"]`);
    if (cell) cell.classList.add('drop-target');
  }
}

boardEl.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.stopPropagation(); }
}, true);

async function sendMove(uci) {
  selected = null;
  clearError();
  try {
    const res = await fetch(API.move, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: uci }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || `Illegal move: ${uci}`);
      render();
      return;
    }
    // Optimistically refresh; SSE will confirm.
    fetchState().catch(() => {});
  } catch {
    showError('Could not reach the server.');
  }
}

function askPromotion(colorChar) {
  const overlay = document.getElementById('promo-overlay');
  const choices = document.getElementById('promo-choices');
  choices.innerHTML = '';
  overlay.hidden = false;
  return new Promise((resolve) => {
    for (const pc of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.textContent = PIECES[colorChar + pc];
      btn.addEventListener('click', () => { overlay.hidden = true; resolve(pc); });
      choices.appendChild(btn);
    }
    overlay.addEventListener('click', function dismiss(e) {
      if (e.target === overlay) {
        overlay.hidden = true;
        overlay.removeEventListener('click', dismiss);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------- controls

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(clearError, 4000);
}

function clearError() {
  errorEl.hidden = true;
}

async function newGame(color) {
  clearError();
  try {
    const res = await fetch(API.newGame, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Server keys on Claude's color; the human plays the other side.
      body: JSON.stringify({ claudeColor: color === 'white' ? 'b' : 'w' }),
    });
    if (!res.ok) showError('Could not start a new game.');
    fetchState().catch(() => {});
  } catch {
    showError('Could not reach the server.');
  }
}

async function postAction(url, body, failMsg) {
  clearError();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || failMsg);
    }
    fetchState().catch(() => {});
  } catch {
    showError('Could not reach the server.');
  }
}

takebackBtn.addEventListener('click', () =>
  postAction(API.undo, null, 'Could not take back the move.'));
resignBtn.addEventListener('click', () => {
  if (!confirm('Resign this game?')) return;
  postAction(API.resign, { by: 'human' }, 'Could not resign.');
});
offerDrawBtn.addEventListener('click', () =>
  postAction(API.draw, { by: 'human', action: 'offer' }, 'Could not offer a draw.'));
document.getElementById('draw-accept').addEventListener('click', () =>
  postAction(API.draw, { by: 'human', action: 'accept' }, 'Could not accept the draw.'));
document.getElementById('draw-decline').addEventListener('click', () =>
  postAction(API.draw, { by: 'human', action: 'decline' }, 'Could not decline the draw.'));

// Arrow keys step through the game; Home/End jump to the start/present.
document.addEventListener('keydown', (e) => {
  if (!state || !replay) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  const steps = { ArrowLeft: shownPly() - 1, ArrowRight: shownPly() + 1, Home: 0, End: livePly() };
  if (!(e.key in steps)) return;
  e.preventDefault();
  gotoPly(steps[e.key]);
});

const soundBtn = document.getElementById('sound-toggle');

function renderSoundBtn() {
  soundBtn.textContent = muted ? '🔇' : '🔊';
  soundBtn.title = muted ? 'Sounds are off — click to unmute' : 'Sounds are on — click to mute';
  soundBtn.setAttribute('aria-label', soundBtn.title);
  soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
}

soundBtn.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('chess-muted', muted ? '1' : '0'); } catch { /* no storage */ }
  renderSoundBtn();
  if (!muted) playSound('move'); // audible confirmation; also unlocks the context
});
renderSoundBtn();

// Warm the audio context up on the first gesture so Claude's moves are
// audible even before the human has clicked a square.
document.addEventListener('pointerdown', () => { getAudio(); }, { once: true });

document.getElementById('new-white').addEventListener('click', () => newGame('white'));
document.getElementById('new-black').addEventListener('click', () => newGame('black'));
document.getElementById('quit').addEventListener('click', async () => {
  if (!confirm('End the chess session and stop the server?')) return;
  try { await fetch(API.shutdown, { method: 'POST' }); } catch { /* server exits */ }
  statusEl.textContent = 'Session ended. You can close this tab.';
  statusEl.className = 'status-bar over';
});

// ---------------------------------------------------------------- boot

fetchState().catch(showDisconnected);
connectEvents();
