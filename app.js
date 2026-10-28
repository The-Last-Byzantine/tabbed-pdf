// Tabbed PDF: local PDF viewer, page editor, annotator and signer.
// Nothing is uploaded. Rendering uses pdf.js, editing and export use pdf-lib.
//
// Coordinate model
//  - Every annotation is stored in *display points* of its page: origin at the top-left
//    of the page as the user currently sees it, 1 unit = 1 PDF point at 100 % zoom.
//  - A page's display rotation R = (source /Rotate + user rotation) mod 360.
//  - On export, display points are mapped back to the unrotated PDF crop box.

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

const { PDFDocument, rgb, degrees, LineCapStyle, StandardFonts } = PDFLib;
const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#ea580c', '#dc2626', '#facc15', '#16a34a', '#2563eb', '#111827'];
const DEFAULT_PAGE = [595.28, 841.89]; // A4
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const UNDO_LIMIT = 150;
const SIG_KEY = 'tabbedpdf.signature';
const PDFJS_OPTS = {
  cMapUrl: './vendor/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
  isEvalSupported: false,
  useSystemFonts: false,
};

const SYMBOLS = {
  check: { label: '✓', name: 'Check', strokes: [[[0.06, 0.55], [0.38, 0.9], [0.94, 0.1]]] },
  cross: { label: '✗', name: 'Cross', strokes: [[[0.1, 0.1], [0.9, 0.9]], [[0.9, 0.1], [0.1, 0.9]]] },
  dot: { label: '●', name: 'Dot', dot: true },
  circle: { label: '○', name: 'Circle', strokes: [unitCircle(0.5, 0.5, 0.45, 48)] },
  star: { label: '★', name: 'Star', strokes: [unitStar(5)] },
  arrow: { label: '→', name: 'Arrow', strokes: [[[0.04, 0.5], [0.96, 0.5]], [[0.66, 0.18], [0.96, 0.5], [0.66, 0.82]]] },
};

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
let uidCounter = 0;
const uid = () => 'u' + Date.now().toString(36) + (uidCounter++).toString(36);
const clone = (x) => structuredClone(x);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod360 = (n) => ((n % 360) + 360) % 360;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function unitCircle(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}
function unitStar(points) {
  const pts = [];
  for (let i = 0; i <= points * 2; i++) {
    const r = i % 2 === 0 ? 0.48 : 0.2;
    const t = -Math.PI / 2 + (i * Math.PI) / points;
    pts.push([0.5 + r * Math.cos(t), 0.5 + r * Math.sin(t)]);
  }
  return pts;
}

// ---------- app state ----------
const state = {
  tabs: [],
  active: null,
  tool: 'select',
  color: PALETTE[0],
  sw: 2,
  fs: 14,
  symbol: 'check',
  sig: null,
  zoom: 1.25,
  thumbsOpen: true,
  gesture: null,
  io: null,
  thumbIo: null,
};

const tabOf = () => state.active;

function newTab({ name, handle = null, dirty = false }) {
  return {
    id: uid(),
    name,
    handle,
    dirty,
    sources: new Map(), // srcId -> { bytes, pdf }
    pages: [],
    undo: [],
    redo: [],
    selPages: new Set(),
    selItem: null, // { pageUid, itemUid }
    editing: null, // item uid being typed into
    current: 0,
    views: new Map(),
    scrollTop: 0,
    anchor: null,
    layoutToken: 0,
  };
}

function newPage({ src = null, index = 0, blank = null, rot = 0 }) {
  return { uid: uid(), src, index, blank, rot, items: [] };
}

// ---------- undo / redo ----------
function pushUndo(tab) {
  tab.undo.push(clone(tab.pages));
  if (tab.undo.length > UNDO_LIMIT) tab.undo.shift();
  tab.redo = [];
  tab.dirty = true;
}
function popUndo(tab) {
  tab.undo.pop();
}
function undo(tab) {
  if (!tab || !tab.undo.length) return toast('Nothing to undo');
  tab.redo.push(clone(tab.pages));
  tab.pages = tab.undo.pop();
  tab.dirty = true;
  tab.selItem = null;
  tab.editing = null;
  pruneSelection(tab);
  renderAll(tab);
}
function redo(tab) {
  if (!tab || !tab.redo.length) return toast('Nothing to redo');
  tab.undo.push(clone(tab.pages));
  tab.pages = tab.redo.pop();
  tab.dirty = true;
  tab.selItem = null;
  tab.editing = null;
  pruneSelection(tab);
  renderAll(tab);
}
function pruneSelection(tab) {
  const uids = new Set(tab.pages.map((p) => p.uid));
  for (const u of [...tab.selPages]) if (!uids.has(u)) tab.selPages.delete(u);
  if (!tab.selPages.size && tab.pages.length) {
    tab.selPages.add(tab.pages[clamp(tab.current, 0, tab.pages.length - 1)].uid);
  }
}

// ---------- geometry ----------
// Display point (u,v) -> unrotated base coordinates (a,b), top-left origin, for rotation R.
function toBase(u, v, R, Wb, Hb) {
  switch (R) {
    case 90: return [v, Hb - u];
    case 180: return [Wb - u, Hb - v];
    case 270: return [Wb - v, u];
    default: return [u, v];
  }
}

async function pageInfo(tab, pg) {
  let Wb, Hb, ox = 0, oy = 0, srcRot = 0, pdfPage = null;
  if (pg.blank) {
    Wb = pg.blank.w;
    Hb = pg.blank.h;
  } else {
    const src = tab.sources.get(pg.src);
    pdfPage = await src.pdf.getPage(pg.index + 1);
    const [x0, y0, x1, y1] = pdfPage.view;
    Wb = x1 - x0;
    Hb = y1 - y0;
    ox = x0;
    oy = y0;
    srcRot = pdfPage.rotate;
  }
  const R = mod360(srcRot + pg.rot);
  const swap = R % 180 !== 0;
  return { Wb, Hb, ox, oy, R, Wd: swap ? Hb : Wb, Hd: swap ? Wb : Hb, pdfPage };
}

function bboxOf(item) {
  if (item.type === 'ink') {
    const xs = item.pts.map((p) => p[0]);
    const ys = item.pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (item.type === 'arrow') {
    const x = Math.min(item.x1, item.x2), y = Math.min(item.y1, item.y2);
    return { x, y, w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1) };
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

function arrowGeom(item) {
  const { x1, y1, x2, y2 } = item;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const bx = -dx / len, by = -dy / len;
  const hl = Math.max(10, item.sw * 4 + 6);
  const c = Math.cos(Math.PI / 7), s = Math.sin(Math.PI / 7);
  const h1 = [x2 + hl * (bx * c - by * s), y2 + hl * (bx * s + by * c)];
  const h2 = [x2 + hl * (bx * c + by * s), y2 + hl * (-bx * s + by * c)];
  return { line: [[x1, y1], [x2, y2]], head: [h1, [x2, y2], h2] };
}

function ellipsePts(item, n = 64) {
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
  const rx = item.w / 2, ry = item.h / 2;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

function rectPts(item) {
  const { x, y, w, h } = item;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

function symbolStrokes(item) {
  const sym = SYMBOLS[item.kind];
  if (!sym || sym.dot) return [];
  return sym.strokes.map((s) => s.map(([ux, uy]) => [item.x + ux * item.w, item.y + uy * item.h]));
}

// Shapes drawn as display-space polylines, shared by the on-screen view and the export.
function strokesOf(item) {
  switch (item.type) {
    case 'ink': return [item.pts];
    case 'rect': return [rectPts(item)];
    case 'ellipse': return [ellipsePts(item)];
    case 'arrow': { const g = arrowGeom(item); return [g.line, g.head]; }
    case 'symbol': return symbolStrokes(item);
    default: return [];
  }
}

// ---------- translation / rotation of items ----------
function translateItem(item, orig, dx, dy) {
  switch (item.type) {
    case 'ink': item.pts = orig.pts.map(([x, y]) => [x + dx, y + dy]); break;
    case 'arrow':
      item.x1 = orig.x1 + dx; item.y1 = orig.y1 + dy;
      item.x2 = orig.x2 + dx; item.y2 = orig.y2 + dy;
      break;
    default: item.x = orig.x + dx; item.y = orig.y + dy;
  }
}

// Upright items (text, signature, symbol) keep their size and move with their centre.
const UPRIGHT = new Set(['text', 'image', 'symbol']);
function rotateItems(items, Wd, Hd, delta) {
  const d = mod360(delta);
  const map = d === 90 ? (u, v) => [Hd - v, u]
    : d === 270 ? (u, v) => [v, Wd - u]
      : (u, v) => [Wd - u, Hd - v];
  for (const item of items) {
    if (item.type === 'ink') { item.pts = item.pts.map(([x, y]) => map(x, y)); continue; }
    if (item.type === 'arrow') {
      [item.x1, item.y1] = map(item.x1, item.y1);
      [item.x2, item.y2] = map(item.x2, item.y2);
      continue;
    }
    if (UPRIGHT.has(item.type)) {
      const [cx, cy] = map(item.x + item.w / 2, item.y + item.h / 2);
      item.x = cx - item.w / 2;
      item.y = cy - item.h / 2;
      continue;
    }
    const [ax, ay] = map(item.x, item.y);
    const [bx, by] = map(item.x + item.w, item.y + item.h);
    item.x = Math.min(ax, bx); item.y = Math.min(ay, by);
    item.w = Math.abs(bx - ax); item.h = Math.abs(by - ay);
  }
}

// ---------- rendering: pages ----------
function viewerEl() { return $('#viewer'); }

async function layoutPages(tab) {
  const token = ++tab.layoutToken;
  const host = $('#pages');
  const infos = [];
  for (const pg of tab.pages) infos.push(await pageInfo(tab, pg));
  if (token !== tab.layoutToken || tab !== state.active) return false;

  host.textContent = '';
  tab.views = new Map();
  if (state.io) state.io.disconnect();
  state.io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const v = tab.views.get(en.target.dataset.uid);
        if (v) renderCanvas(tab, v);
      }
    }
  }, { root: viewerEl(), rootMargin: '700px 0px' });

  tab.pages.forEach((pg, i) => {
    const info = infos[i];
    const pageEl = el('div', 'page');
    pageEl.dataset.uid = pg.uid;
    pageEl.dataset.index = String(i);
    const canvas = el('canvas', 'pc');
    canvas.setAttribute('aria-label', `Page ${i + 1}`);
    const svg = svgEl('svg', { class: 'ov', viewBox: `0 0 ${info.Wd} ${info.Hd}`, preserveAspectRatio: 'none' });
    pageEl.append(canvas, svg);
    host.append(pageEl);
    const view = { pg, info, el: pageEl, canvas, svg, key: null, task: null };
    tab.views.set(pg.uid, view);
    applyPageSize(view);
    renderOverlay(tab, view);
    state.io.observe(pageEl);
  });

  host.hidden = false;
  $('#empty').hidden = true;
  return true;
}

function applyPageSize(view) {
  const z = state.zoom;
  view.el.style.width = view.info.Wd * z + 'px';
  view.el.style.height = view.info.Hd * z + 'px';
}

async function renderCanvas(tab, view) {
  const { info, pg, canvas } = view;
  const key = `${state.zoom}|${info.R}|${pg.src}|${pg.index}|${pg.blank ? pg.blank.w + 'x' + pg.blank.h : ''}`;
  if (view.key === key) return;
  if (view.task) view.task.cancel();
  view.key = key;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = state.zoom * dpr;
  canvas.width = Math.max(1, Math.round(info.Wd * scale));
  canvas.height = Math.max(1, Math.round(info.Hd * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!info.pdfPage) return;
  const viewport = info.pdfPage.getViewport({ scale, rotation: info.R });
  const task = info.pdfPage.render({ canvasContext: ctx, viewport });
  view.task = task;
  try {
    await task.promise;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn('Render failed', e);
  }
}

function renderOverlay(tab, view) {
  const { pg, info, el: pageEl, svg } = view;
  const z = state.zoom;
  svg.textContent = '';
  for (const t of pageEl.querySelectorAll(':scope > .txt')) t.remove();
  const sel = tab.selItem && tab.selItem.pageUid === pg.uid ? tab.selItem.itemUid : null;
  for (const item of pg.items) {
    if (item.type === 'text') {
      pageEl.append(makeTextEl(tab, item, z, sel === item.uid));
      continue;
    }
    svg.append(makeSvgItem(item, z));
    if (sel === item.uid) svg.append(selectionEl(item, z));
  }
  pageEl.classList.toggle('tool-draw', state.tool !== 'select');
  pageEl.classList.toggle('tool-select', state.tool === 'select');
  pageEl.classList.toggle('current', tab.pages[tab.current]?.uid === pg.uid);
  void info;
}

function renderAllOverlays(tab) {
  for (const v of tab.views.values()) renderOverlay(tab, v);
}

function makeSvgItem(item, z) {
  const g = svgEl('g', { 'data-uid': item.uid });
  const common = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (item.type === 'highlight') {
    g.append(svgEl('rect', { x: item.x, y: item.y, width: item.w, height: item.h, fill: item.color, opacity: 0.38, style: 'mix-blend-mode:multiply' }));
  } else if (item.type === 'image') {
    g.append(svgEl('image', { href: item.data, x: item.x, y: item.y, width: item.w, height: item.h, preserveAspectRatio: 'none' }));
  } else if (item.type === 'symbol' && SYMBOLS[item.kind]?.dot) {
    const r = Math.min(item.w, item.h) / 2;
    g.append(svgEl('circle', { cx: item.x + item.w / 2, cy: item.y + item.h / 2, r, fill: item.color }));
  } else if (item.type === 'rect' || item.type === 'ellipse' || item.type === 'ink' || item.type === 'arrow' || item.type === 'symbol') {
    const sw = item.sw || 2;
    // Invisible wide hit area so thin lines are easy to pick.
    for (const pts of strokesOf(item)) {
      const pl = svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), ...common, stroke: 'transparent', 'stroke-width': sw + 10 / z, class: 'hit', style: 'pointer-events:stroke' });
      g.append(pl);
    }
    if (item.type === 'rect') g.append(svgEl('polyline', { points: rectPts(item).concat([rectPts(item)[0]]).map((p) => p.join(',')).join(' '), ...common, stroke: item.color, 'stroke-width': sw }));
    else if (item.type === 'ellipse') g.append(svgEl('polyline', { points: ellipsePts(item).concat([ellipsePts(item)[0]]).map((p) => p.join(',')).join(' '), ...common, stroke: item.color, 'stroke-width': sw }));
    else {
      for (const pts of strokesOf(item)) {
        g.append(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), ...common, stroke: item.color, 'stroke-width': sw }));
      }
    }
  }
  for (const c of g.children) c.style.pointerEvents ||= 'visiblePainted';
  // Hit areas must receive events even though the overlay itself is pointer-events:none.
  for (const c of g.querySelectorAll('.hit')) c.style.pointerEvents = 'stroke';
  return g;
}

function selectionEl(item, z) {
  const b = bboxOf(item);
  const g = svgEl('g', { class: 'selection', 'pointer-events': 'none' });
  g.append(svgEl('rect', {
    x: b.x - 2 / z, y: b.y - 2 / z, width: b.w + 4 / z, height: b.h + 4 / z,
    fill: 'none', stroke: '#dc2626', 'stroke-width': 1.25, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke',
  }));
  if (!['ink', 'arrow'].includes(item.type)) {
    const hs = 9 / z;
    g.append(svgEl('rect', {
      x: b.x + b.w - hs / 2, y: b.y + b.h - hs / 2, width: hs, height: hs,
      fill: '#dc2626', stroke: '#fff', 'stroke-width': 1 / z, 'data-handle': 'se', style: 'pointer-events:all; cursor:nwse-resize',
    }));
  }
  return g;
}

function makeTextEl(tab, item, z, selected) {
  const d = el('div', 'txt' + (selected ? ' sel' : ''));
  d.dataset.uid = item.uid;
  d.style.left = item.x * z + 'px';
  d.style.top = item.y * z + 'px';
  d.style.fontSize = item.fs * z + 'px';
  d.style.color = item.color;
  d.style.minWidth = item.w * z + 'px';
  d.textContent = item.text;
  if (tab.editing === item.uid) {
    d.contentEditable = 'true';
    d.spellcheck = true;
    queueMicrotask(() => { d.focus(); placeCaretAtEnd(d); });
  }
  return d;
}

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------- rendering: thumbnails ----------
function renderThumbs(tab) {
  const list = $('#thumblist');
  list.textContent = '';
  if (state.thumbIo) state.thumbIo.disconnect();
  state.thumbIo = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) renderThumbCanvas(tab, en.target.dataset.uid);
    }
  }, { root: $('#thumbs'), rootMargin: '300px 0px' });

  tab.pages.forEach((pg, i) => {
    const view = tab.views.get(pg.uid);
    const t = el('div', 'thumb');
    t.draggable = true;
    t.dataset.uid = pg.uid;
    t.dataset.index = String(i);
    t.setAttribute('role', 'button');
    t.setAttribute('aria-label', `Page ${i + 1}`);
    const wrap = el('div', 'thumb-canvas-wrap');
    if (view) wrap.style.aspectRatio = `${view.info.Wd} / ${view.info.Hd}`;
    const c = el('canvas');
    wrap.append(c);
    t.append(wrap, el('div', 'thumb-num', String(i + 1)));
    list.append(t);
    state.thumbIo.observe(t);
  });
  updateThumbSelection(tab);
}

async function renderThumbCanvas(tab, pageUid) {
  const thumb = $(`#thumblist .thumb[data-uid="${pageUid}"]`);
  const view = tab.views.get(pageUid);
  if (!thumb || !view || thumb.dataset.done === 'yes') return;
  thumb.dataset.done = 'yes';
  const canvas = thumb.querySelector('canvas');
  const cssW = 150;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = (cssW * dpr) / view.info.Wd;
  canvas.width = Math.round(view.info.Wd * scale);
  canvas.height = Math.round(view.info.Hd * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (view.info.pdfPage) {
    try {
      await view.info.pdfPage.render({ canvasContext: ctx, viewport: view.info.pdfPage.getViewport({ scale, rotation: view.info.R }) }).promise;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(e);
    }
  }
}

function updateThumbSelection(tab) {
  const current = tab.pages[tab.current]?.uid;
  for (const t of $$('#thumblist .thumb')) {
    t.classList.toggle('sel', tab.selPages.has(t.dataset.uid));
    t.classList.toggle('current', t.dataset.uid === current);
  }
}

function renderStatus(tab) {
  const n = tab ? tab.pages.length : 0;
  $('#stat-pages').textContent = tab ? `${n} page${n === 1 ? '' : 's'}` : '0 pages';
  $('#stat-page').textContent = tab && n ? `Page ${tab.current + 1} of ${n}` : '—';
  $('#stat-zoom').textContent = `${Math.round(state.zoom * 100)}%`;
  $('#stat-tool').textContent = TOOL_NAMES[state.tool] || state.tool;
  const sel = tab && tab.selPages.size ? ` · ${tab.selPages.size} selected` : '';
  $('#stat-page').textContent += sel;
  $('#stat-dirty').textContent = tab && tab.dirty ? 'Unsaved changes' : '';
  const name = tab ? tab.name + (tab.dirty ? ' ●' : '') : 'No document open';
  $('#filename').textContent = tab ? tab.name : 'No document open';
  $('#filename').classList.toggle('dirty', !!(tab && tab.dirty));
  document.title = tab ? `${tab.dirty ? '• ' : ''}${tab.name} · Tabbed PDF` : 'Tabbed PDF';
  void name;
}

const TOOL_NAMES = {
  select: 'Select', highlight: 'Highlight', ink: 'Pen', text: 'Text', rect: 'Rectangle',
  ellipse: 'Ellipse', arrow: 'Arrow', sign: 'Signature', symbol: 'Symbol',
};

// ---------- tabs ----------
function renderTabs() {
  const bar = $('#tabs');
  bar.textContent = '';
  bar.hidden = state.tabs.length === 0;
  for (const tab of state.tabs) {
    const b = el('div', 'doc-tab' + (tab === state.active ? ' active' : ''));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(tab === state.active));
    b.tabIndex = 0;
    b.append(el('span', 'tname', tab.name));
    if (tab.dirty) b.append(el('span', 'dirty', '●'));
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = 'Close document';
    x.setAttribute('aria-label', `Close ${tab.name}`);
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });
    b.append(x);
    b.addEventListener('click', () => activate(tab));
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(tab); });
    bar.append(b);
  }
}

async function activate(tab) {
  state.active = tab;
  state.gesture = null;
  renderTabs();
  $('#empty').hidden = !!tab;
  $('#pages').hidden = !tab;
  if (!tab) {
    $('#pages').textContent = '';
    $('#thumblist').textContent = '';
    renderStatus(null);
    return;
  }
  const ok = await layoutPages(tab);
  if (!ok) return;
  renderThumbs(tab);
  renderStatus(tab);
  const viewer = viewerEl();
  viewer.scrollTop = tab.scrollTop || 0;
  scheduleViewportCheck();
}

function closeTab(tab) {
  if (tab.dirty && !window.confirm(`Close “${tab.name}” without saving?`)) return;
  const i = state.tabs.indexOf(tab);
  state.tabs.splice(i, 1);
  for (const src of tab.sources.values()) src.pdf.destroy();
  if (state.active === tab) {
    const next = state.tabs[i] || state.tabs[i - 1] || null;
    activate(next);
  } else {
    renderTabs();
  }
}

function addTab(tab) {
  state.tabs.push(tab);
  activate(tab);
}

// ---------- opening, creating, inserting ----------
async function loadPdfJs(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(0), ...PDFJS_OPTS }).promise;
}

async function openBytes(name, bytes, handle = null) {
  let pdf;
  try {
    pdf = await loadPdfJs(bytes);
  } catch (e) {
    const msg = e?.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password in another app, then open it here.'
      : `Could not open “${name}”. It may be damaged or not a PDF.`;
    return toast(msg, true);
  }
  const tab = newTab({ name, handle });
  const srcId = 's' + uid();
  tab.sources.set(srcId, { bytes, pdf });
  tab.pages = Array.from({ length: pdf.numPages }, (_, i) => newPage({ src: srcId, index: i }));
  if (!tab.pages.length) return toast('That PDF has no pages.', true);
  addTab(tab);
  toast(`Opened ${name}`);
}

async function newBlankDocument() {
  const doc = await PDFDocument.create();
  doc.addPage(DEFAULT_PAGE);
  const bytes = await doc.save();
  const tab = newTab({ name: `Untitled-${state.tabs.length + 1}.pdf`, dirty: true });
  const pdf = await loadPdfJs(bytes);
  const srcId = 's' + uid();
  tab.sources.set(srcId, { bytes, pdf });
  tab.pages = [newPage({ src: srcId, index: 0 })];
  addTab(tab);
}

async function insertBytes(tab, bytes) {
  let pdf;
  try {
    pdf = await loadPdfJs(bytes);
  } catch {
    return toast('That file is not a readable PDF.', true);
  }
  pushUndo(tab);
  const srcId = 's' + uid();
  tab.sources.set(srcId, { bytes, pdf });
  const at = clamp(tab.current, 0, tab.pages.length - 1) + 1;
  const added = Array.from({ length: pdf.numPages }, (_, i) => newPage({ src: srcId, index: i }));
  tab.pages.splice(at, 0, ...added);
  tab.selPages = new Set(added.map((p) => p.uid));
  tab.current = at;
  renderAll(tab);
  toast(`Inserted ${added.length} page${added.length === 1 ? '' : 's'}`);
}

async function openPicker() {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'PDF files', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const file = await handle.getFile();
      return openBytes(file.name, new Uint8Array(await file.arrayBuffer()), handle);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn(e);
    }
  }
  $('#fileinput').click();
}

async function openFile(file, handle = null) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return toast('Only PDF files can be opened here.', true);
  }
  await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), handle);
}

// ---------- page operations ----------
function selectedPageUids(tab) {
  if (tab.selPages.size) return tab.pages.filter((p) => tab.selPages.has(p.uid)).map((p) => p.uid);
  return [tab.pages[tab.current]?.uid].filter(Boolean);
}

function setSelection(tab, uids) {
  tab.selPages = new Set(uids);
  updateThumbSelection(tab);
  renderStatus(tab);
}

async function rotateSelected(tab, delta) {
  const uids = selectedPageUids(tab);
  if (!uids.length) return;
  pushUndo(tab);
  for (const u of uids) {
    const pg = tab.pages.find((p) => p.uid === u);
    const info = await pageInfo(tab, pg);
    pg.rot = mod360(pg.rot + delta);
    rotateItems(pg.items, info.Wd, info.Hd, delta);
  }
  await renderAll(tab);
}

async function orientSelected(tab, want) {
  const uids = selectedPageUids(tab);
  const pagesToTurn = [];
  for (const u of uids) {
    const pg = tab.pages.find((p) => p.uid === u);
    const info = await pageInfo(tab, pg);
    const isLandscape = info.Wd > info.Hd;
    if ((want === 'landscape') !== isLandscape && info.Wd !== info.Hd) pagesToTurn.push(pg);
  }
  if (!pagesToTurn.length) return toast(`Already ${want}`);
  pushUndo(tab);
  for (const pg of pagesToTurn) {
    const info = await pageInfo(tab, pg);
    pg.rot = mod360(pg.rot + 90);
    rotateItems(pg.items, info.Wd, info.Hd, 90);
  }
  await renderAll(tab);
}

function addBlankPage(tab) {
  const at = clamp(tab.current, 0, tab.pages.length - 1);
  const cur = tab.views.get(tab.pages[at].uid)?.info;
  const size = cur ? [cur.Wd, cur.Hd] : DEFAULT_PAGE;
  pushUndo(tab);
  const pg = newPage({ blank: { w: size[0], h: size[1] } });
  tab.pages.splice(at + 1, 0, pg);
  tab.current = at + 1;
  tab.selPages = new Set([pg.uid]);
  renderAll(tab);
}

function deleteSelectedPages(tab) {
  const uids = new Set(selectedPageUids(tab));
  if (!uids.size) return;
  if (uids.size >= tab.pages.length) return toast('A PDF needs at least one page. Add a page first.', true);
  pushUndo(tab);
  const firstIndex = tab.pages.findIndex((p) => uids.has(p.uid));
  tab.pages = tab.pages.filter((p) => !uids.has(p.uid));
  tab.current = clamp(firstIndex, 0, tab.pages.length - 1);
  tab.selPages = new Set([tab.pages[tab.current].uid]);
  tab.selItem = null;
  renderAll(tab);
}

function movePages(tab, uids, dir) {
  const set = new Set(uids);
  const pages = tab.pages.slice();
  let changed = false;
  if (dir < 0) {
    for (let i = 1; i < pages.length; i++) {
      if (set.has(pages[i].uid) && !set.has(pages[i - 1].uid)) {
        [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
        changed = true;
      }
    }
  } else {
    for (let i = pages.length - 2; i >= 0; i--) {
      if (set.has(pages[i].uid) && !set.has(pages[i + 1].uid)) {
        [pages[i], pages[i + 1]] = [pages[i + 1], pages[i]];
        changed = true;
      }
    }
  }
  if (!changed) return;
  pushUndo(tab);
  tab.pages = pages;
  tab.current = pages.findIndex((p) => set.has(p.uid));
  renderAll(tab);
}

// Drag-and-drop reorder of a set of pages, inserting before the page at dropIndex.
function dropPages(tab, uids, dropIndex) {
  const set = new Set(uids);
  const moving = tab.pages.filter((p) => set.has(p.uid));
  if (!moving.length) return;
  const remaining = tab.pages.filter((p) => !set.has(p.uid));
  const before = tab.pages.slice(0, dropIndex).filter((p) => set.has(p.uid)).length;
  const insertAt = clamp(dropIndex - before, 0, remaining.length);
  const next = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
  if (next.every((p, i) => p === tab.pages[i])) return;
  pushUndo(tab);
  tab.pages = next;
  tab.current = next.indexOf(moving[0]);
  renderAll(tab);
}

// ---------- rendering orchestration ----------
async function renderAll(tab) {
  if (tab !== state.active) return;
  const keepScroll = viewerEl().scrollTop;
  const ok = await layoutPages(tab);
  if (!ok) return;
  viewerEl().scrollTop = keepScroll;
  renderThumbs(tab);
  renderStatus(tab);
  renderTabs();
  scheduleViewportCheck();
}

function setZoom(z, keepAnchor = true) {
  const tab = tabOf();
  const newZoom = clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM);
  if (newZoom === state.zoom) return;
  const viewer = viewerEl();
  const ratio = keepAnchor ? newZoom / state.zoom : 1;
  const scroll = viewer.scrollTop * ratio;
  state.zoom = newZoom;
  if (!tab) return renderStatus(null);
  tab.scrollTop = scroll;
  renderAll(tab).then(() => {
    viewer.scrollTop = scroll;
    renderStatus(tab);
  });
}

function fitWidth() {
  const tab = tabOf();
  if (!tab) return;
  const cur = tab.views.get(tab.pages[tab.current]?.uid)?.info;
  const avail = viewerEl().clientWidth - 40;
  if (!cur) return;
  setZoom(clamp(avail / cur.Wd, MIN_ZOOM, 3));
}

function scheduleViewportCheck() {
  requestAnimationFrame(updateCurrentFromScroll);
}

function updateCurrentFromScroll() {
  const tab = tabOf();
  if (!tab || !tab.views.size) return;
  if (Date.now() < (state.pinCurrentUntil || 0)) return;
  const top = viewerEl().getBoundingClientRect().top;
  let idx = 0;
  tab.pages.forEach((pg, i) => {
    const v = tab.views.get(pg.uid);
    if (!v) return;
    if (v.el.getBoundingClientRect().top - top < 80) idx = i;
  });
  if (idx !== tab.current) {
    tab.current = idx;
    updateThumbSelection(tab);
    renderStatus(tab);
    $$('.page').forEach((p) => p.classList.toggle('current', p.dataset.uid === tab.pages[idx].uid));
  }
  tab.scrollTop = viewerEl().scrollTop;
}

// ---------- items ----------
function findItem(tab, pageUid, itemUid) {
  const pg = tab.pages.find((p) => p.uid === pageUid);
  if (!pg) return null;
  const item = pg.items.find((i) => i.uid === itemUid);
  return item ? { pg, item } : null;
}

function selectItem(tab, pageUid, itemUid) {
  tab.selItem = itemUid ? { pageUid, itemUid } : null;
  if (itemUid) {
    const found = findItem(tab, pageUid, itemUid);
    if (found) {
      state.color = found.item.color || state.color;
      if (found.item.sw) state.sw = found.item.sw;
      if (found.item.fs) state.fs = found.item.fs;
      syncControls();
    }
  }
  renderAllOverlays(tab);
  renderStatus(tab);
}

function deleteSelectedItem(tab) {
  if (!tab || !tab.selItem) return toast('Select an annotation first');
  const { pageUid, itemUid } = tab.selItem;
  const pg = tab.pages.find((p) => p.uid === pageUid);
  if (!pg) return;
  pushUndo(tab);
  pg.items = pg.items.filter((i) => i.uid !== itemUid);
  tab.selItem = null;
  renderAllOverlays(tab);
  renderStatus(tab);
}

function setItemProp(tab, key, value) {
  if (!tab || !tab.selItem) return;
  const found = findItem(tab, tab.selItem.pageUid, tab.selItem.itemUid);
  if (!found || found.item[key] === value) return;
  pushUndo(tab);
  found.item[key] = value;
  renderAllOverlays(tab);
}

// ---------- pointer interaction ----------
function localPoint(e, pageEl) {
  const rect = pageEl.getBoundingClientRect();
  return { u: (e.clientX - rect.left) / state.zoom, v: (e.clientY - rect.top) / state.zoom };
}

function onPointerDown(e) {
  const tab = tabOf();
  if (!tab || e.button !== 0) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  if (e.target.closest('[contenteditable="true"]')) return; // typing in a text box
  const pageUid = pageEl.dataset.uid;
  const view = tab.views.get(pageUid);
  if (!view) return;
  const idx = tab.pages.findIndex((p) => p.uid === pageUid);
  if (idx !== tab.current) {
    tab.current = idx;
    updateThumbSelection(tab);
    renderStatus(tab);
  }
  const p = localPoint(e, pageEl);
  let hitEl = e.target.closest('[data-uid]');
  if (hitEl === pageEl) hitEl = null; // the page itself is not an item
  const handle = e.target.closest('[data-handle]');

  if (state.tool === 'select') {
    if (handle && tab.selItem) {
      e.preventDefault();
      const found = findItem(tab, tab.selItem.pageUid, tab.selItem.itemUid);
      if (!found) return;
      pushUndo(tab);
      beginGesture(tab, 'resize', pageEl, pageUid, found.item.uid, p, e, clone(found.item));
      return;
    }
    if (hitEl && hitEl.dataset.uid) {
      e.preventDefault();
      const itemUid = hitEl.dataset.uid;
      if (!tab.selItem || tab.selItem.itemUid !== itemUid) selectItem(tab, pageUid, itemUid);
      const found = findItem(tab, pageUid, itemUid);
      if (!found) return;
      pushUndo(tab);
      beginGesture(tab, 'move', pageEl, pageUid, itemUid, p, e, clone(found.item));
      return;
    }
    if (tab.selItem) {
      tab.selItem = null;
      renderAllOverlays(tab);
      renderStatus(tab);
    }
    return;
  }

  e.preventDefault();
  const tool = state.tool;
  const color = state.color;
  const sw = state.sw;

  if (tool === 'text') {
    pushUndo(tab);
    const item = { uid: uid(), type: 'text', x: p.u, y: p.v, w: 160, h: state.fs * 1.4, text: '', color, fs: state.fs };
    view.pg.items.push(item);
    tab.selItem = { pageUid, itemUid: item.uid };
    tab.editing = item.uid;
    renderOverlay(tab, view);
    return;
  }
  if (tool === 'sign') {
    if (!state.sig) return toast('Create a signature first (Sign & symbols tab)', true);
    pushUndo(tab);
    const w = 170;
    const h = w * (state.sig.h / state.sig.w);
    const item = { uid: uid(), type: 'image', x: p.u - w / 2, y: p.v - h / 2, w, h, data: state.sig.data };
    view.pg.items.push(item);
    tab.selItem = { pageUid, itemUid: item.uid };
    renderAllOverlays(tab);
    renderStatus(tab);
    return;
  }
  if (tool === 'symbol') {
    pushUndo(tab);
    const size = 36;
    const item = { uid: uid(), type: 'symbol', kind: state.symbol, x: p.u - size / 2, y: p.v - size / 2, w: size, h: size, color, sw: Math.max(sw, 2) };
    view.pg.items.push(item);
    tab.selItem = { pageUid, itemUid: item.uid };
    renderAllOverlays(tab);
    renderStatus(tab);
    return;
  }

  // Drawing tools: create the item now, reshape it while the pointer moves.
  pushUndo(tab);
  let item;
  if (tool === 'ink') item = { uid: uid(), type: 'ink', pts: [[p.u, p.v]], color, sw };
  else if (tool === 'arrow') item = { uid: uid(), type: 'arrow', x1: p.u, y1: p.v, x2: p.u, y2: p.v, color, sw };
  else if (tool === 'highlight') item = { uid: uid(), type: 'highlight', x: p.u, y: p.v, w: 0, h: 0, color };
  else item = { uid: uid(), type: tool, x: p.u, y: p.v, w: 0, h: 0, color, sw };
  view.pg.items.push(item);
  beginGesture(tab, 'draw', pageEl, pageUid, item.uid, p, e, null);
}

function beginGesture(tab, kind, pageEl, pageUid, itemUid, p, e, orig) {
  state.gesture = { kind, tab, pageEl, pageUid, itemUid, sx: p.u, sy: p.v, orig, moved: false, pointerId: e.pointerId };
}

function onPointerMove(e) {
  const g = state.gesture;
  if (!g) return;
  const tab = g.tab;
  const p = localPoint(e, g.pageEl);
  const found = findItem(tab, g.pageUid, g.itemUid);
  const view = tab.views.get(g.pageUid);
  if (!found || !view) return;
  const { item } = found;
  const dx = p.u - g.sx;
  const dy = p.v - g.sy;
  if (!g.moved && Math.hypot(dx, dy) < 1.5 && g.kind !== 'draw') return;
  g.moved = true;

  if (g.kind === 'move') {
    translateItem(item, g.orig, dx, dy);
  } else if (g.kind === 'resize') {
    item.w = Math.max(6, g.orig.w + dx);
    item.h = Math.max(6, g.orig.h + dy);
  } else if (g.kind === 'draw') {
    switch (item.type) {
      case 'ink': item.pts.push([p.u, p.v]); break;
      case 'arrow': item.x2 = p.u; item.y2 = p.v; break;
      default: {
        const x0 = g.sx, y0 = g.sy;
        item.x = Math.min(x0, p.u);
        item.y = Math.min(y0, p.v);
        item.w = Math.abs(p.u - x0);
        item.h = Math.abs(p.v - y0);
        if (e.shiftKey && (item.type === 'rect' || item.type === 'ellipse')) {
          const s = Math.max(item.w, item.h);
          item.w = s; item.h = s;
        }
      }
    }
  }
  renderOverlay(tab, view);
}

function onPointerUp() {
  const g = state.gesture;
  if (!g) return;
  state.gesture = null;
  const tab = g.tab;
  if (g.kind === 'draw') {
    const found = findItem(tab, g.pageUid, g.itemUid);
    if (found) {
      const { item } = found;
      const tooSmall = item.type === 'ink' ? item.pts.length < 2
        : item.type === 'arrow' ? Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 4
          : item.w < 3 && item.h < 3;
      if (tooSmall) {
        found.pg.items = found.pg.items.filter((i) => i.uid !== item.uid);
        popUndo(tab);
        tab.dirty = tab.undo.length > 0;
      } else {
        tab.selItem = null;
      }
    }
    renderAllOverlays(tab);
    renderStatus(tab);
  } else if (!g.moved) {
    popUndo(tab);
  } else {
    // Gesture changed the document: snapshot is already recorded at the start.
    renderStatus(tab);
  }
}

function onDoubleClick(e) {
  const tab = tabOf();
  if (!tab || state.tool !== 'select') return;
  const t = e.target.closest('.txt');
  if (!t) return;
  tab.editing = t.dataset.uid;
  const pageUid = t.closest('.page').dataset.uid;
  tab.selItem = { pageUid, itemUid: t.dataset.uid };
  renderOverlay(tab, tab.views.get(pageUid));
}

function onTextFocusOut(e) {
  const t = e.target;
  if (!t.classList || !t.classList.contains('txt') || t.contentEditable !== 'true') return;
  const tab = tabOf();
  if (!tab) return;
  const pageEl = t.closest('.page');
  const found = findItem(tab, pageEl.dataset.uid, t.dataset.uid);
  tab.editing = null;
  if (!found) return;
  const text = t.innerText.replace(/\n$/, '');
  if (!text.trim()) {
    found.pg.items = found.pg.items.filter((i) => i.uid !== found.item.uid);
    if (tab.selItem?.itemUid === found.item.uid) tab.selItem = null;
    // The empty item was created with an undo snapshot: drop it so Undo has nothing to do.
    if (tab.undo.length) popUndo(tab);
  } else {
    if (found.item.text !== text) {
      found.item.text = text;
      tab.dirty = true;
    }
  }
  renderAllOverlays(tab);
  renderStatus(tab);
}

// ---------- thumbnails interaction ----------
let lastThumbIndex = null;
function onThumbClick(e) {
  const tab = tabOf();
  const t = e.target.closest('.thumb');
  if (!tab || !t) return;
  const index = Number(t.dataset.index);
  if (e.shiftKey && lastThumbIndex != null) {
    const [a, b] = [Math.min(lastThumbIndex, index), Math.max(lastThumbIndex, index)];
    setSelection(tab, tab.pages.slice(a, b + 1).map((p) => p.uid));
  } else if (e.ctrlKey || e.metaKey) {
    const set = new Set(tab.selPages);
    if (set.has(t.dataset.uid)) set.delete(t.dataset.uid); else set.add(t.dataset.uid);
    if (!set.size) set.add(t.dataset.uid);
    setSelection(tab, [...set]);
  } else {
    setSelection(tab, [t.dataset.uid]);
  }
  lastThumbIndex = index;
  tab.current = index;
  updateThumbSelection(tab);
  renderStatus(tab);
  const view = tab.views.get(t.dataset.uid);
  if (view) {
    // Keep the clicked page as current while the viewer scrolls to it.
    state.pinCurrentUntil = Date.now() + 500;
    view.el.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}

let dragUids = null;
let dropTarget = null;
function clearDropMarks() {
  for (const t of $$('#thumblist .thumb')) t.classList.remove('drop-before', 'drop-after');
}
function onThumbDragStart(e) {
  const tab = tabOf();
  const t = e.target.closest('.thumb');
  if (!tab || !t) return;
  dragUids = tab.selPages.has(t.dataset.uid) ? [...tab.selPages] : [t.dataset.uid];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'tabbedpdf-pages');
  t.classList.add('dragging');
}
function onThumbDragOver(e) {
  if (!dragUids) return;
  e.preventDefault();
  const t = e.target.closest('.thumb');
  clearDropMarks();
  if (!t) return;
  const r = t.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  t.classList.add(before ? 'drop-before' : 'drop-after');
  const i = Number(t.dataset.index);
  dropTarget = before ? i : i + 1;
}
function onThumbDrop(e) {
  e.preventDefault();
  const tab = tabOf();
  clearDropMarks();
  if (tab && dragUids && dropTarget != null) dropPages(tab, dragUids, dropTarget);
  dragUids = null;
  dropTarget = null;
}
function onThumbDragEnd() {
  clearDropMarks();
  for (const t of $$('#thumblist .thumb.dragging')) t.classList.remove('dragging');
  dragUids = null;
  dropTarget = null;
}

// ---------- saving & exporting ----------
let fontBytesPromise = null;
function loadFontBytes() {
  fontBytesPromise ||= fetch('./vendor/fonts/DejaVuSans.ttf').then((r) => r.arrayBuffer());
  return fontBytesPromise;
}

async function sourceLib(tab, srcId, cache) {
  if (!cache.has(srcId)) {
    const src = tab.sources.get(srcId);
    cache.set(srcId, await PDFDocument.load(src.bytes.slice(0), { ignoreEncryption: false }));
  }
  return cache.get(srcId);
}

function dataUrlBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Build the output PDF for the given page entries. Annotations are drawn as vectors.
async function buildPdf(tab, pages) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(await loadFontBytes(), { subset: true });
  const libs = new Map();
  const images = new Map();

  // Copy each source's pages in one call so shared resources are not duplicated per page.
  const wanted = new Map();
  for (const pg of pages) {
    if (pg.blank) continue;
    if (!wanted.has(pg.src)) wanted.set(pg.src, []);
    wanted.get(pg.src).push(pg.index);
  }
  const copiedBySrc = new Map();
  for (const [srcId, indices] of wanted) {
    const lib = await sourceLib(tab, srcId, libs);
    copiedBySrc.set(srcId, { list: await out.copyPages(lib, indices), next: 0 });
  }

  for (const pg of pages) {
    const info = await pageInfo(tab, pg);
    let page;
    if (pg.blank) {
      page = out.addPage([info.Wb, info.Hb]);
    } else {
      const bucket = copiedBySrc.get(pg.src);
      page = out.addPage(bucket.list[bucket.next++]);
    }
    page.setRotation(degrees(info.R));
    const { Wb, Hb, ox, oy, R } = info;
    const P = (u, v) => {
      const [a, b] = toBase(u, v, R, Wb, Hb);
      return { x: ox + a, y: oy + Hb - b };
    };

    for (const item of pg.items) {
      try {
        await drawItemPdf(out, page, item, { P, R, font, images });
      } catch (err) {
        console.warn('Skipped an annotation that could not be exported', item.type, err);
      }
    }
  }
  return out.save();
}

function drawPolylinePdf(page, P, pts, color, sw, closed = false) {
  const list = closed ? [...pts, pts[0]] : pts;
  for (let i = 0; i < list.length - 1; i++) {
    const a = P(list[i][0], list[i][1]);
    const b = P(list[i + 1][0], list[i + 1][1]);
    page.drawLine({ start: a, end: b, thickness: sw, color: hexToRgb(color), lineCap: LineCapStyle.Round });
  }
}

async function drawItemPdf(out, page, item, { P, R, font, images }) {
  switch (item.type) {
    case 'highlight': {
      const corners = rectPts(item).map(([u, v]) => P(u, v));
      const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      page.drawRectangle({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, color: hexToRgb(item.color), opacity: 0.38, borderWidth: 0 });
      return;
    }
    case 'rect':
    case 'ellipse':
    case 'ink':
    case 'arrow':
      for (const pts of strokesOf(item)) {
        const closed = item.type === 'rect' || item.type === 'ellipse';
        drawPolylinePdf(page, P, pts, item.color, item.sw, closed);
      }
      return;
    case 'symbol': {
      if (SYMBOLS[item.kind]?.dot) {
        const c = P(item.x + item.w / 2, item.y + item.h / 2);
        const r = Math.min(item.w, item.h) / 2;
        page.drawLine({ start: c, end: c, thickness: 2 * r, color: hexToRgb(item.color), lineCap: LineCapStyle.Round });
        return;
      }
      for (const pts of strokesOf(item)) drawPolylinePdf(page, P, pts, item.color, item.sw);
      return;
    }
    case 'text': {
      const fs = item.fs;
      item.text.split('\n').forEach((line, i) => {
        if (!line) return;
        const at = P(item.x, item.y + 1 + fs + i * fs * 1.2);
        page.drawText(line, { x: at.x, y: at.y, size: fs, font, color: hexToRgb(item.color), rotate: degrees(R) });
      });
      return;
    }
    case 'image': {
      if (!images.has(item.data)) {
        const bytes = dataUrlBytes(item.data);
        const img = item.data.startsWith('data:image/png')
          ? await out.embedPng(bytes)
          : await out.embedJpg(bytes);
        images.set(item.data, img);
      }
      const img = images.get(item.data);
      const bl = P(item.x, item.y + item.h);
      page.drawImage(img, { x: bl.x, y: bl.y, width: item.w, height: item.h, rotate: degrees(R) });
      return;
    }
    default:
  }
}

async function exportBytes(tab, uids = null) {
  const pages = uids ? tab.pages.filter((p) => uids.includes(p.uid)) : tab.pages;
  return buildPdf(tab, pages);
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function writeHandle(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(new Blob([bytes], { type: 'application/pdf' }));
  await w.close();
}

async function saveTab(tab, { asNew = false } = {}) {
  if (!tab) return;
  let bytes;
  try {
    bytes = await exportBytes(tab);
  } catch (e) {
    console.error(e);
    return toast('Could not build the PDF. It may be encrypted or damaged.', true);
  }
  try {
    if (!asNew && tab.handle) {
      await writeHandle(tab.handle, bytes);
    } else if ('showSaveFilePicker' in window) {
      const handle = await window.showSaveFilePicker({
        suggestedName: tab.name,
        types: [{ description: 'PDF file', accept: { 'application/pdf': ['.pdf'] } }],
      });
      await writeHandle(handle, bytes);
      tab.handle = handle;
      tab.name = handle.name;
    } else {
      const name = await askName(tab.name);
      if (!name) return;
      tab.name = name;
      download(bytes, name);
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.error(e);
    return toast('Saving failed. Try Save as…', true);
  }
  tab.dirty = false;
  renderTabs();
  renderStatus(tab);
  toast(`Saved ${tab.name}`);
}

async function exportSelectedPages(tab) {
  if (!tab) return;
  const uids = selectedPageUids(tab);
  const base = tab.name.replace(/\.pdf$/i, '');
  const name = await askName(`${base}-pages.pdf`);
  if (!name) return;
  try {
    download(await exportBytes(tab, uids), name);
    toast(`Exported ${uids.length} page${uids.length === 1 ? '' : 's'}`);
  } catch (e) {
    console.error(e);
    toast('Export failed', true);
  }
}

// Merge every open document, in tab order, into one new document. The originals stay open.
async function mergeOpenDocuments() {
  const sources = state.tabs.slice();
  if (sources.length < 2) return toast('Open at least two documents to merge them.', true);
  const name = await askName('Merged.pdf');
  if (!name) return;
  const merged = newTab({ name, dirty: true });
  try {
    for (const src of sources) {
      // Each source gets its own copy of its file data, so closing an original cannot break the merged document.
      const remap = new Map();
      for (const [srcId, s] of src.sources) {
        const newId = 's' + uid();
        remap.set(srcId, newId);
        merged.sources.set(newId, { bytes: s.bytes, pdf: await loadPdfJs(s.bytes) });
      }
      for (const pg of src.pages) {
        const copy = clone(pg);
        copy.uid = uid();
        if (copy.src) copy.src = remap.get(copy.src);
        merged.pages.push(copy);
      }
    }
  } catch (e) {
    console.error(e);
    return toast('Could not merge the open documents.', true);
  }
  merged.current = 0;
  merged.selPages = new Set([merged.pages[0].uid]);
  addTab(merged);
  toast(`Merged ${sources.length} documents into ${merged.pages.length} pages`);
}

// Save pages as separate PDF files, one per page. Default: every page of the document.
// Pass uids to save only those pages (for example the current selection). File names
// carry the page's position in the document, so they stay in order.
async function splitIntoPages(tab, uids = null) {
  if (!tab) return;
  const wanted = uids ? tab.pages.filter((p) => uids.includes(p.uid)) : tab.pages;
  const n = wanted.length;
  if (!n) return toast('No pages selected.', true);
  if (!uids && n < 2) return toast('This document has only one page.', true);
  if (n > 20 && !window.confirm(`Save ${n} separate PDF files? Your browser may ask permission to download them all.`)) return;
  const base = tab.name.replace(/\.pdf$/i, '');
  const width = String(tab.pages.length).length;
  try {
    for (const pg of wanted) {
      const position = tab.pages.indexOf(pg) + 1;
      const bytes = await exportBytes(tab, [pg.uid]);
      download(bytes, `${base}-${String(position).padStart(width, '0')}.pdf`);
      // Pause between downloads so the browser does not drop any of them.
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    toast(`Saved ${n} separate file${n === 1 ? '' : 's'}`);
  } catch (e) {
    console.error(e);
    toast('Saving separate files failed', true);
  }
}

function askName(defaultName) {
  return new Promise((resolve) => {
    const dlg = $('#namedlg');
    const input = $('#newname');
    input.value = defaultName;
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const ok = dlg.returnValue === 'ok';
      let name = input.value.trim();
      if (ok && name) {
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        resolve(name);
      } else resolve(null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// ---------- signatures ----------
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// Returns a small controller: hasInk() and clear(). The pad itself records only ink.
function initSignaturePad() {
  const pad = $('#sigpad');
  const ctx = pad.getContext('2d');
  let drawing = false;
  let last = null;
  let strokes = 0;
  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height];
  };
  const clear = () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    strokes = 0;
  };
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    pad.setPointerCapture(e.pointerId);
    last = pos(e);
    strokes++;
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2, 0, Math.PI * 2);
    ctx.fill();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const end = () => { drawing = false; };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  $('#sigclear').addEventListener('click', clear);
  return { hasInk: () => strokes > 0, clear };
}
let sigPad = null;

function renderTypedSignature() {
  const c = $('#sigtypecanvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const text = $('#sigtext').value.trim();
  if (!text) return;
  const style = $('#sigfont').value;
  const fonts = {
    cursive: "italic 96px 'Brush Script MT', 'Segoe Script', 'Snell Roundhand', 'URW Chancery L', cursive",
    serif: 'italic 92px Georgia, "DejaVu Serif", serif',
    mono: '64px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  };
  ctx.font = fonts[style];
  ctx.fillStyle = '#111827';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, c.width / 2, c.height / 2, c.width - 40);
}

function setSignature(sig, remember = true) {
  state.sig = sig;
  $('#sigstatus').textContent = sig ? 'Signature ready. Choose “Place signature”, then click a page.' : 'No signature yet.';
  try {
    if (sig && remember) localStorage.setItem(SIG_KEY, JSON.stringify(sig));
    else localStorage.removeItem(SIG_KEY);
  } catch { /* storage unavailable: the signature still works for this session */ }
}

function openSignatureDialog() {
  $('#sigtext').value = '';
  renderTypedSignature();
  showSigTab('draw');
  sigPad.clear();
  $('#sigdlg').showModal();
}

function showSigTab(name) {
  for (const b of $$('.sig-tabs [data-sigtab]')) {
    const on = b.dataset.sigtab === name;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of $$('[data-sigpanel]')) p.hidden = p.dataset.sigpanel !== name;
  state.sigTab = name;
}

async function confirmSignature() {
  const tab = state.sigTab || 'draw';
  const remember = $('#sigsave').checked;
  let sig = null;
  try {
    if (tab === 'draw') {
      if (!sigPad.hasInk()) return toast('Draw your signature first', true);
      const c = trimCanvas($('#sigpad'));
      if (c) sig = { data: c.toDataURL('image/png'), w: c.width, h: c.height };
    } else if (tab === 'type') {
      if (!$('#sigtext').value.trim()) return toast('Type your name first', true);
      const c = trimCanvas($('#sigtypecanvas'));
      if (c) sig = { data: c.toDataURL('image/png'), w: c.width, h: c.height };
    } else {
      const file = $('#sigfile').files[0];
      if (!file) return toast('Choose an image first', true);
      const data = await readAsDataUrl(file);
      const img = await loadImage(data);
      sig = { data, w: img.naturalWidth, h: img.naturalHeight };
    }
  } catch (e) {
    console.error(e);
    return toast('That image could not be read', true);
  }
  if (!sig) return toast('That signature is empty', true);
  setSignature(sig, remember);
  $('#sigdlg').close();
  toast('Signature ready. Choose “Place signature”, then click a page.');
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function loadSavedSignature() {
  try {
    const raw = localStorage.getItem(SIG_KEY);
    if (raw) setSignature(JSON.parse(raw));
  } catch { /* storage unavailable or corrupt */ }
}

// ---------- ribbon, tools, symbols ----------
function showPanel(name) {
  for (const b of $$('#ribbon-tabs [data-panel]')) {
    const on = b.dataset.panel === name;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of $$('#toolbar .panel')) p.classList.toggle('selected', p.dataset.panel === name);
}

function setTool(tool) {
  state.tool = tool;
  if (tool !== 'select') {
    const tab = tabOf();
    if (tab) tab.selItem = null;
  }
  for (const b of $$('[data-tool]')) b.classList.toggle('selected', b.dataset.tool === tool);
  for (const b of $$('[data-symbol]')) b.classList.toggle('selected', tool === 'symbol' && b.dataset.symbol === state.symbol);
  renderStatus(tabOf());
  const tab = tabOf();
  if (tab) renderAllOverlays(tab);
}

function syncControls() {
  for (const b of $$('#swatches .swatch')) b.classList.toggle('selected', b.dataset.color === state.color);
  $('#stroke').value = String(state.sw);
  $('#fontsize').value = String(state.fs);
}

function buildSwatches() {
  const host = $('#swatches');
  host.textContent = '';
  for (const c of PALETTE) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute('aria-label', `Colour ${c}`);
    b.title = c;
    b.addEventListener('click', () => {
      state.color = c;
      syncControls();
      setItemProp(tabOf(), 'color', c);
    });
    host.append(b);
  }
  syncControls();
}

function buildSymbols() {
  const host = $('#symbols');
  host.textContent = '';
  for (const [key, sym] of Object.entries(SYMBOLS)) {
    const b = el('button', 'tool symbol', sym.label);
    b.type = 'button';
    b.dataset.symbol = key;
    b.dataset.tool = 'symbol';
    b.title = `${sym.name}: choose, then click a page`;
    b.setAttribute('aria-label', sym.name);
    b.addEventListener('click', () => {
      state.symbol = key;
      setTool('symbol');
    });
    host.append(b);
  }
}

// ---------- icons (Tabbed family style: 24-unit grid, 1.8 stroke) ----------
const ICON_SVG = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const COMMAND_ICONS = {
  "new": "<path d=\"M6 3h8l4 4v14H6z\"/><path d=\"M14 3v4h4\"/><path d=\"M12 11v6M9 14h6\"/>",
  "open": "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>",
  "save": "<path d=\"M5 3h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z\"/><path d=\"M8 3v5h7V3M8 21v-7h8v7\"/>",
  "saveas": "<path d=\"M5 3h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z\"/><path d=\"M8 3v5h7V3M8 21v-7h8v7\"/><path d=\"M14 16l4.5-4.5 1.5 1.5L15.5 17.5H14z\"/>",
  "export-selected": "<path d=\"M6 3h8l4 4v14H6z\"/><path d=\"M12 17v-6M9.5 13.5 12 11l2.5 2.5\"/>",
  "undo": "<path d=\"M9 14L4 9l5-5\"/><path d=\"M4 9h10a6 6 0 0 1 0 12h-3\"/>",
  "redo": "<path d=\"M15 14l5-5-5-5\"/><path d=\"M20 9H10a6 6 0 0 0 0 12h3\"/>",
  "close-tab": "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><path d=\"M9 9l6 6M15 9l-6 6\"/>",
  "add-page": "<rect x=\"5\" y=\"3\" width=\"14\" height=\"18\" rx=\"1.5\"/><path d=\"M12 8v8M8 12h8\"/>",
  "insert-pdf": "<rect x=\"5\" y=\"3\" width=\"14\" height=\"18\" rx=\"1.5\"/><path d=\"M12 8v7M9 12.5l3 3 3-3\"/>",
  "merge-open": "<path d=\"M4 4h6v5H4zM14 4h6v5h-6z\"/><path d=\"M7 9v3a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V9\"/><path d=\"M12 15v5M9.5 17.5 12 20l2.5-2.5\"/>",
  "save-separate": "<path d=\"M5 5h7v6H5zM12 13h7v6h-7z\"/><path d=\"M9 11v3h3M15 13v-2\"/><path d=\"M3 19h18\" stroke-dasharray=\"1.5 2\"/>",
  "split-pages": "<rect x=\"6\" y=\"3\" width=\"12\" height=\"7\" rx=\"1.2\"/><rect x=\"6\" y=\"14\" width=\"12\" height=\"7\" rx=\"1.2\"/><path d=\"M3 10.5h18\" stroke-dasharray=\"1.5 2\"/>",
  "rotate-left": "<path d=\"M4 12a8 8 0 1 0 2.4-5.7\"/><path d=\"M4 4v5h5\"/>",
  "rotate-right": "<path d=\"M20 12a8 8 0 1 1-2.4-5.7\"/><path d=\"M20 4v5h-5\"/>",
  "portrait": "<rect x=\"7\" y=\"3\" width=\"10\" height=\"18\" rx=\"1.5\"/>",
  "landscape": "<rect x=\"3\" y=\"7\" width=\"18\" height=\"10\" rx=\"1.5\"/>",
  "move-up": "<path d=\"M12 19V5M6 11l6-6 6 6\"/>",
  "move-down": "<path d=\"M12 5v14M6 13l6 6 6-6\"/>",
  "delete-pages": "<path d=\"M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13\"/>",
  "select-all": "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><path d=\"M14 17.5l2 2 4-4\"/>",
  "select": "<path d=\"M5 3l14 8-6 1.5L10.5 19z\"/>",
  "highlight": "<path d=\"M14 4l6 6-7.5 7.5L6.5 11.5z\"/><path d=\"M4 20.5h16\"/>",
  "ink": "<path d=\"M4 20l4-1 11-11-3-3L5 16z\"/><path d=\"M14 6l3 3\"/>",
  "text": "<path d=\"M5 6V4h14v2M12 4v16M9 20h6\"/>",
  "rect": "<rect x=\"4\" y=\"6\" width=\"16\" height=\"12\" rx=\"1.5\"/>",
  "ellipse": "<ellipse cx=\"12\" cy=\"12\" rx=\"8.5\" ry=\"6\"/>",
  "arrow": "<path d=\"M5 19L19 5M10 5h9v9\"/>",
  "delete-item": "<path d=\"M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13\"/>",
  "signature": "<path d=\"M3 17c2-4 3-8 5-8s1 6 3 5 2-4 4-4 1 3 3 3 2-1 3-2\"/><path d=\"M3 20h18\"/>",
  "sign": "<path d=\"M3 17c2-4 3-8 5-8s1 6 3 5\"/><path d=\"M15 12v8M11 16h8\"/>",
  "zoom-out": "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M16 16l4.5 4.5M8 11h6\"/>",
  "zoom-in": "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M16 16l4.5 4.5M8 11h6M11 8v6\"/>",
  "zoom-100": "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"M16 16l4.5 4.5M9 13V9l-1.5 1\"/>",
  "zoom-fit": "<path d=\"M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5\"/>",
  "toggle-thumbs": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"1.5\"/><path d=\"M9 4v16\"/>",
};

// ---------- commands ----------
const COMMANDS = {
  async new() { return newBlankDocument(); },
  open() { return openPicker(); },
  save() { return saveTab(tabOf()); },
  saveas() { return saveTab(tabOf(), { asNew: true }); },
  'export-selected': () => exportSelectedPages(tabOf()),
  undo: () => undo(tabOf()),
  redo: () => redo(tabOf()),
  'close-tab': () => { const t = tabOf(); if (t) closeTab(t); },
  'add-page': () => { const t = tabOf(); if (t) addBlankPage(t); },
  'insert-pdf': () => { if (tabOf()) $('#insertinput').click(); },
  'merge-open': () => mergeOpenDocuments(),
  'split-pages': () => splitIntoPages(tabOf()),
  'save-separate': () => { const t = tabOf(); if (t) splitIntoPages(t, selectedPageUids(t)); },
  'rotate-left': () => rotateSelected(tabOf(), -90),
  'rotate-right': () => rotateSelected(tabOf(), 90),
  portrait: () => orientSelected(tabOf(), 'portrait'),
  landscape: () => orientSelected(tabOf(), 'landscape'),
  'move-up': () => { const t = tabOf(); if (t) movePages(t, selectedPageUids(t), -1); },
  'move-down': () => { const t = tabOf(); if (t) movePages(t, selectedPageUids(t), 1); },
  'delete-pages': () => { const t = tabOf(); if (t) deleteSelectedPages(t); },
  'select-all': () => { const t = tabOf(); if (t) setSelection(t, t.pages.map((p) => p.uid)); },
  'delete-item': () => deleteSelectedItem(tabOf()),
  signature: () => openSignatureDialog(),
  'zoom-in': () => setZoom(state.zoom * 1.2),
  'zoom-out': () => setZoom(state.zoom / 1.2),
  'zoom-100': () => setZoom(1),
  'zoom-fit': () => fitWidth(),
  'toggle-thumbs': () => toggleThumbs(),
};

function toggleThumbs() {
  state.thumbsOpen = !state.thumbsOpen;
  $('#thumbs').classList.toggle('hidden', !state.thumbsOpen);
}

function toast(message, isError = false) {
  let note = $('#toast');
  if (!note) {
    note = el('div', 'toast');
    note.id = 'toast';
    note.setAttribute('role', 'status');
    note.style.cssText = 'position:fixed;left:50%;bottom:52px;transform:translateX(-50%);background:#450a0a;color:#fef2f2;padding:9px 16px;border-radius:8px;font:14px system-ui;z-index:50;box-shadow:0 8px 24px #450a0a66;max-width:90vw;text-align:center';
    document.body.append(note);
  }
  note.textContent = message;
  note.style.background = isError ? '#991b1b' : '#450a0a';
  note.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { note.hidden = true; }, 3600);
}

// ---------- wiring ----------
function wire() {
  // Ribbon tabs
  // Collapsible ribbon: click the tab you are on to hide the commands; click any tab to show them again
  let ribbonHidden = false;
  for (const b of $$('#ribbon-tabs [data-panel]')) {
    b.addEventListener('click', () => {
      const wasOn = b.classList.contains('selected');
      if (ribbonHidden) { ribbonHidden = false; document.body.classList.remove('ribbon-off'); showPanel(b.dataset.panel); }
      else if (wasOn) { ribbonHidden = true; document.body.classList.add('ribbon-off'); }
      else showPanel(b.dataset.panel);
    });
  }

  // Icons on the command buttons; the text stays as the accessible name and tooltip
  for (const b of $$('#toolbar button[data-act], #toolbar button[data-tool]')) {
    if (b.dataset.symbol) continue;
    const key = b.dataset.act || b.dataset.tool;
    const path = COMMAND_ICONS[key];
    if (!path) continue;
    const label = b.textContent.trim();
    if (label) b.setAttribute('aria-label', label);
    if (label && !b.title) b.title = label;
    b.classList.add('ic');
    b.textContent = '';
    b.insertAdjacentHTML('beforeend', ICON_SVG(path));
  }

  // About dialog
  const about = document.getElementById('aboutdlg');
  document.getElementById('aboutbtn')?.addEventListener('click', () => { if (about && !about.open) about.showModal(); });
  about?.addEventListener('click', (e) => { if (e.target === about) about.close(); });

  // Commands (data-act)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = COMMANDS[b.dataset.act];
    if (fn) fn();
  });

  // Tools
  for (const b of $$('#toolbar [data-tool]')) {
    if (b.dataset.symbol) continue;
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }
  // Keep the Symbol buttons' own handler
  $('#stroke').addEventListener('change', (e) => {
    state.sw = Number(e.target.value);
    setItemProp(tabOf(), 'sw', state.sw);
  });
  $('#fontsize').addEventListener('change', (e) => {
    state.fs = Number(e.target.value);
    const tab = tabOf();
    if (tab?.selItem) {
      const found = findItem(tab, tab.selItem.pageUid, tab.selItem.itemUid);
      if (found && found.item.type === 'text') {
        pushUndo(tab);
        found.item.fs = state.fs;
        found.item.h = state.fs * 1.4;
        renderAllOverlays(tab);
      }
    }
  });

  // Page interaction
  const pagesHost = $('#pages');
  pagesHost.addEventListener('pointerdown', onPointerDown);
  pagesHost.addEventListener('dblclick', onDoubleClick);
  pagesHost.addEventListener('focusout', onTextFocusOut);
  pagesHost.addEventListener('keydown', (e) => {
    if (e.target.contentEditable === 'true' && e.key === 'Escape') {
      e.target.blur();
    }
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  viewerEl().addEventListener('scroll', () => scheduleViewportCheck(), { passive: true });

  // Thumbnails
  const thumbs = $('#thumblist');
  thumbs.addEventListener('click', onThumbClick);
  thumbs.addEventListener('dragstart', onThumbDragStart);
  thumbs.addEventListener('dragover', onThumbDragOver);
  thumbs.addEventListener('drop', onThumbDrop);
  thumbs.addEventListener('dragend', onThumbDragEnd);

  // Files
  $('#fileinput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    await openFile(f);
  });
  $('#insertinput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    const tab = tabOf();
    if (!f || !tab) return;
    insertBytes(tab, new Uint8Array(await f.arrayBuffer()));
  });

  // Drag & drop files onto the window
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    viewerEl().classList.add('drop-target');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) viewerEl().classList.remove('drop-target');
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    viewerEl().classList.remove('drop-target');
    const f = [...e.dataTransfer.files].find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
    if (f) await openFile(f);
    else toast('Drop a PDF file to open it', true);
  });

  // Signature dialog
  for (const b of $$('.sig-tabs [data-sigtab]')) b.addEventListener('click', () => showSigTab(b.dataset.sigtab));
  $('#sigtext').addEventListener('input', renderTypedSignature);
  $('#sigfont').addEventListener('change', renderTypedSignature);
  $('#sigok').addEventListener('click', confirmSignature);
  sigPad = initSignaturePad();

  // Enter in the file-name box confirms (the form's first button is Cancel).
  $('#newname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#namedlg').close('ok');
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', onKeyDown);

  // Unsaved changes warning
  window.addEventListener('beforeunload', (e) => {
    if (state.tabs.some((t) => t.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('resize', () => scheduleViewportCheck());
}

function onKeyDown(e) {
  const mod = e.metaKey || e.ctrlKey;
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  const tab = tabOf();

  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); return e.shiftKey ? COMMANDS.saveas() : COMMANDS.save(); }
    if (k === 'o') { e.preventDefault(); return COMMANDS.open(); }
    if (k === 'n') { e.preventDefault(); return COMMANDS.new(); }
    if (typing) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(tab); }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); return redo(tab); }
    if (k === 'a') { e.preventDefault(); return COMMANDS['select-all'](); }
    return;
  }
  if (typing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (tab?.selItem) { e.preventDefault(); deleteSelectedItem(tab); }
    return;
  }
  if (e.key === 'Escape') {
    if (state.tool !== 'select') setTool('select');
    if (tab?.selItem) selectItem(tab, null, null);
    return;
  }
  const map = { v: 'select', h: 'highlight', p: 'ink', t: 'text', r: 'rect', e: 'ellipse', a: 'arrow' };
  const tool = map[e.key.toLowerCase()];
  if (tool && !e.altKey) return setTool(tool);
  if (e.key === '+' || e.key === '=') return setZoom(state.zoom * 1.2);
  if (e.key === '-') return setZoom(state.zoom / 1.2);
  if (e.key === 'PageDown' || e.key === 'PageUp') return;
}

// ---------- service worker ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

// ---------- start ----------
function init() {
  buildSwatches();
  buildSymbols();
  loadSavedSignature();
  wire();
  showPanel('home');
  setTool('select');
  renderTabs();
  renderStatus(null);
  registerServiceWorker();

  // Test/debug hook: exposes the export pipeline without UI.
  window.TabbedPDF = {
    get state() { return state; },
    openBytes,
    exportBytes: (uids) => exportBytes(tabOf(), uids),
    newBlankDocument,
    addItem(pageIndex, item) {
      const tab = tabOf();
      const pg = tab.pages[pageIndex];
      pg.items.push({ uid: uid(), ...item });
      renderAllOverlays(tab);
    },
    rotate: (delta) => rotateSelected(tabOf(), delta),
    setTool,
    COLORS: PALETTE,
  };
}

init();
