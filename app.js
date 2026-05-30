'use strict';

/* ── Constants ──────────────────────────────────── */
const W = 800;
const H = 600;
const AUTO_DELAY = 3000; // ms after user stops drawing

/* ── Canvas setup (DPR-aware) ───────────────────── */
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
canvas.width  = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

/* ── State ──────────────────────────────────────── */
let strokes = [];          // all completed strokes
let active  = null;        // stroke being drawn right now
let aiActive = false;      // AI request in flight
let autoTimer = null;
let pendingUser = false;   // new user stroke since last AI call
let lastAIStart = -1;      // index into strokes[] where last AI batch started

/* ── DOM refs ───────────────────────────────────── */
const hintEl    = document.getElementById('hint');
const overlayEl = document.getElementById('ai-overlay');
const msgEl     = document.getElementById('message');
const aiBtn     = document.getElementById('ai-btn');
const undoAiBtn = document.getElementById('undo-ai-btn');
const clearBtn  = document.getElementById('clear-btn');
const saveBtn   = document.getElementById('save-btn');
const colorIn   = document.getElementById('brush-color');
const sizeIn    = document.getElementById('brush-size');

/* ── Coordinate mapping ─────────────────────────── */
function toCanvas(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return [
    Math.round((clientX - r.left) * W / r.width),
    Math.round((clientY - r.top)  * H / r.height),
  ];
}

/* ── Drawing events ─────────────────────────────── */
canvas.addEventListener('mousedown',  e => startStroke(e.clientX, e.clientY));
canvas.addEventListener('mousemove',  e => { if (active) addPoint(e.clientX, e.clientY); });
canvas.addEventListener('mouseup',    endStroke);
canvas.addEventListener('mouseleave', endStroke);

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  startStroke(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (active) addPoint(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  endStroke();
}, { passive: false });

function startStroke(cx, cy) {
  if (aiActive) return;
  clearTimeout(autoTimer);
  hintEl.classList.add('hidden');
  active = {
    color:   colorIn.value,
    width:   +sizeIn.value,
    opacity: 1,
    points:  [toCanvas(cx, cy)],
  };
}

function addPoint(cx, cy) {
  const pt   = toCanvas(cx, cy);
  const prev = active.points.at(-1);
  if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 2) {
    active.points.push(pt);
    paint();
  }
}

function endStroke() {
  if (!active) return;
  if (active.points.length >= 2) {
    strokes.push({ ...active, points: [...active.points] });
    pendingUser = true;
  }
  active = null;
  paint();
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => runAI(false), AUTO_DELAY);
}

/* ── Rendering ──────────────────────────────────── */
function paint() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (const s of strokes) drawStroke(s);
  if (active) drawStroke(active);
}

function drawStroke(s) {
  const pts = s.points;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha  = s.opacity ?? 1;
  ctx.strokeStyle  = s.color;
  ctx.lineWidth    = s.width;
  ctx.lineCap      = 'round';
  ctx.lineJoin     = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  ctx.lineTo(pts.at(-1)[0], pts.at(-1)[1]);
  ctx.stroke();
  ctx.restore();
}

/* ── AI interaction ─────────────────────────────── */
aiBtn.addEventListener('click', () => runAI(true));

async function runAI(manual) {
  clearTimeout(autoTimer);
  if (aiActive) return;
  if (!manual && !pendingUser) return;
  if (strokes.length === 0) return;

  aiActive     = true;
  pendingUser  = false;
  aiBtn.disabled     = true;
  undoAiBtn.disabled = true;
  overlayEl.hidden   = false;
  setMsg('');

  try {
    const res = await fetch('/api/draw', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageData: snapshot() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { message, strokes: aiStrokes } = await res.json();

    overlayEl.hidden = true;
    if (message) setMsg(message);

    if (Array.isArray(aiStrokes) && aiStrokes.length > 0) {
      lastAIStart = strokes.length;
      await animateAI(aiStrokes);
      undoAiBtn.disabled = false;
    }
  } catch (e) {
    console.error(e);
    overlayEl.hidden = true;
    setMsg('エラーが発生しました。もう一度お試しください。');
  }

  aiActive   = false;
  aiBtn.disabled = false;
}

/* ── AI stroke animation ────────────────────────── */
async function animateAI(aiStrokes) {
  for (const s of aiStrokes) {
    const stroke = {
      color:   s.color   || '#6c63ff',
      width:   clamp(s.width   ?? 2,    0.5, 12),
      opacity: clamp(s.opacity ?? 0.9, 0.05,  1),
      points:  [],
    };
    strokes.push(stroke);

    const all = s.points;
    await new Promise(done => {
      let i = 0;
      function tick() {
        const chunk = Math.max(1, Math.ceil(all.length / 22));
        for (let j = 0; j < chunk && i < all.length; j++, i++) {
          stroke.points.push(all[i]);
        }
        paint();
        i < all.length ? requestAnimationFrame(tick) : setTimeout(done, 45);
      }
      requestAnimationFrame(tick);
    });
  }
}

/* ── Undo AI ────────────────────────────────────── */
undoAiBtn.addEventListener('click', () => {
  if (lastAIStart < 0) return;
  strokes.splice(lastAIStart);
  lastAIStart = -1;
  undoAiBtn.disabled = true;
  paint();
  setMsg('');
});

/* ── Utilities ──────────────────────────────────── */
function snapshot() {
  const tmp = document.createElement('canvas');
  tmp.width  = W;
  tmp.height = H;
  tmp.getContext('2d').drawImage(canvas, 0, 0, W, H);
  return tmp.toDataURL('image/png');
}

function setMsg(text) {
  msgEl.textContent = text;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/* ── Controls ───────────────────────────────────── */
clearBtn.addEventListener('click', () => {
  clearTimeout(autoTimer);
  strokes     = [];
  active      = null;
  pendingUser = false;
  lastAIStart = -1;
  undoAiBtn.disabled = true;
  hintEl.classList.remove('hidden');
  paint();
  setMsg('');
});

saveBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href     = snapshot();
  a.download = `codraw-${Date.now()}.png`;
  a.click();
});

/* ── Init ───────────────────────────────────────── */
paint();
