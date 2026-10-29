import * as pdfjs from '/vendor/pdfjs/pdf.mjs';
import { me, api, toast, signIn, subscribe, signOut } from '/js/common.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

// Must match lib/exporter.js so the preview covers exactly what the export does.
const COVER_DESCENT = 0.24;
const COVER_ASCENT = 0.9;
const COVER_PAD = 0.04;

const CSS_FONTS = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", Tinos, serif',
  Courier: '"Courier New", Courier, "Liberation Mono", Cousine, monospace',
};
const DOCX_SCALE = 2;
const MAX_DPR = 2;

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), pages: $('pages'), main: $('main'), toolbar: $('toolbar'),
  docName: $('doc-name'), exportMenu: $('export-menu'), exportBtn: $('export-btn'),
  accountMenu: $('account-menu'), accountBtn: $('account-btn'), accountList: $('account-list'),
  format: $('format'), family: $('f-family'), bold: $('f-bold'), italic: $('f-italic'),
  smaller: $('f-smaller'), bigger: $('f-bigger'), size: $('f-size'), color: $('f-color'),
  align: $('f-align'), revert: $('f-revert'), del: $('f-delete'),
  zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomLevel: $('zoom-level'), close: $('close-doc'),
  busy: $('busy'), busyText: $('busy-text'),
  resume: $('resume'), resumeName: $('resume-name'), resumeBtn: $('resume-btn'), resumeDiscard: $('resume-discard'),
};

const state = {
  name: '', bytes: null, pdf: null, pages: [], fit: 1, zoom: 1, tool: 'edit', active: null,
};
const scale = () => state.fit * state.zoom;

// ---------------------------------------------------------------- helpers

function busy(text) {
  els.busy.hidden = !text;
  if (text) els.busyText.textContent = text;
}

function geom(it) {
  const [a, b, c, d, e, f] = it.transform;
  const size = Math.hypot(c, d) || Math.hypot(a, b) || 12;
  const hlen = Math.hypot(a, b) || size;
  const ux = a / hlen, uy = b / hlen;
  return { size, ux, uy, vx: -uy, vy: ux, x: e, y: f, width: Math.max(0, it.width || 0) };
}

// Point at (s along the baseline, t above it) in PDF user space.
const along = (g, s, t) => [g.x + g.ux * s + g.vx * t, g.y + g.uy * s + g.vy * t];

const sameFont = (a, b) => a.family === b.family && !!a.bold === !!b.bold && !!a.italic === !!b.italic;
const sameColor = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.004);
const changed = (it) => it.kind === 'add' || it.text !== it.str || !sameFont(it.font, it.origFont)
  || it.sizeScale !== 1 || !sameColor(it.color, it.origColor);

const toHex = (c) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255);
const cssColor = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

function cssFont(font, px) {
  return `${font.italic ? 'italic ' : ''}${font.bold ? '700 ' : '400 '}${px}px ${CSS_FONTS[font.family] || CSS_FONTS.Helvetica}`;
}

const measureCtx = document.createElement('canvas').getContext('2d');
const metricCache = new Map();
function metrics(font) {
  const key = cssFont(font, 100);
  if (!metricCache.has(key)) {
    measureCtx.font = key;
    const m = measureCtx.measureText('Hg');
    metricCache.set(key, {
      ascent: (m.fontBoundingBoxAscent ?? 91) / 100,
      descent: (m.fontBoundingBoxDescent ?? 21) / 100,
    });
  }
  return metricCache.get(key);
}
function textWidth(font, text, px) {
  measureCtx.font = cssFont(font, 100);
  return (measureCtx.measureText(text).width / 100) * px;
}
// Same idea as the exporter: stretch the replacement font so it covers the
// same width per character as the original.
function ratioFor(it) {
  if (it.kind === 'add' || !it.str.trim() || !it.width) return 1;
  const g = geom(it);
  const w = textWidth(it.font, it.str, g.size);
  return w ? Math.min(1.6, Math.max(0.6, g.width / w)) : 1;
}

const NUMERIC = /^[\s$€£¥(+\-−]*\d[\d,.\s]*[)%]?\s*(CR|DR|-)?\s*$/i;

function detectFont(obj, style) {
  const name = String(obj?.name || '').replace(/^[A-Z]{6}\+/, '');
  const fam = style?.fontFamily || '';
  let family = 'Helvetica';
  const sansName = /sans|arial|helv|verdana|calibri|segoe|roboto|open|lato|tahoma|gothic|futura|frutiger|univers|myriad|inter/i.test(name);
  if (obj?.isMonospace || /courier|mono|consol|menlo|typewriter|ocr/i.test(name) || fam === 'monospace') family = 'Courier';
  else if (!sansName && (/times|georgia|garamond|cambria|roman|serif|minion|palatino|caslon|baskerville|century|tinos|bodoni|didot/i.test(name)
    || obj?.isSerifFont || fam === 'serif')) family = 'Times';
  const bold = !!(obj?.bold || obj?.black) || /bold|black|heavy|semibold|demi|extrab/i.test(name);
  const italic = !!obj?.italic || /italic|oblique/i.test(name);
  return { family, bold, italic };
}

// ------------------------------------------------------ colour sampling

function pixelReader(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  return (x, y) => {
    const px = Math.min(W - 1, Math.max(0, Math.round(x)));
    const py = Math.min(H - 1, Math.max(0, Math.round(y)));
    const i = (py * W + px) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}

// Most common colour among the samples (the paper colour around a word).
function dominant(samples) {
  const buckets = new Map();
  for (const c of samples) {
    const k = (c[0] >> 4) * 256 + (c[1] >> 4) * 16 + (c[2] >> 4);
    const b = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += c[0]; b.g += c[1]; b.b += c[2];
    buckets.set(k, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.r / best.n / 255, best.g / best.n / 255, best.b / best.n / 255] : [1, 1, 1];
}

function sampleItem(read, vp, it) {
  const g = geom(it);
  const pad = g.size * COVER_PAD;
  const m = g.size * 0.14;
  const s0 = -pad - m, s1 = g.width + pad + m;
  const t0 = -g.size * COVER_DESCENT - m, t1 = g.size * COVER_ASCENT + m;
  const ring = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const s = s0 + ((s1 - s0) * i) / N;
    for (const t of [t0, t1]) ring.push(read(...vp.convertToViewportPoint(...along(g, s, t))));
  }
  for (let i = 0; i <= 6; i++) {
    const t = t0 + ((t1 - t0) * i) / 6;
    for (const s of [s0, s1]) ring.push(read(...vp.convertToViewportPoint(...along(g, s, t))));
  }
  const bg = dominant(ring);
  // Text colour: the inside pixel furthest from the background.
  let best = [0, 0, 0], dist = -1;
  const cols = Math.max(8, Math.min(80, Math.round(g.width / (g.size * 0.15))));
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = read(...vp.convertToViewportPoint(...along(g, (g.width * i) / cols, g.size * (-0.1 + (0.8 * j) / 8))));
      const d = (p[0] / 255 - bg[0]) ** 2 + (p[1] / 255 - bg[1]) ** 2 + (p[2] / 255 - bg[2]) ** 2;
      if (d > dist) { dist = d; best = p; }
    }
  }
  let color = best.map((v) => v / 255);
  // Anti-aliased small text never reaches its true colour; snap near-black.
  if (color.every((v) => v < 0.28)) color = [0, 0, 0];
  return { bg, color };
}

function sampleRect(read, vp, rect) {
  const [x, y, w, h] = rect;
  const m = Math.max(1.5, Math.min(w, h) * 0.08);
  const ring = [];
  for (let i = 0; i <= 20; i++) {
    const fx = x - m + ((w + 2 * m) * i) / 20, fy = y - m + ((h + 2 * m) * i) / 20;
    ring.push(read(...vp.convertToViewportPoint(fx, y - m)), read(...vp.convertToViewportPoint(fx, y + h + m)));
    ring.push(read(...vp.convertToViewportPoint(x - m, fy)), read(...vp.convertToViewportPoint(x + w + m, fy)));
  }
  return dominant(ring);
}

// -------------------------------------------------------------- loading

function commonObj(page, id) {
  try { return page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch { return null; }
}

async function openPdf(bytes, name, saved = null) {
  busy('Opening your PDF…');
  closeDoc(false);
  try {
    let password = '';
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: '/vendor/pdfjs-cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs-fonts/',
      fontExtraProperties: true,
      isEvalSupported: false,
    });
    task.onPassword = (update, reason) => {
      busy(null);
      const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      const p = prompt(again ? 'That password is not right. Try again:' : `${name} is password-protected. Enter its password to open it:`);
      if (p === null) return task.destroy();
      password = p;
      busy('Opening your PDF…');
      update(p);
    };
    const pdf = await task.promise;
    state.pdf = pdf;
    state.password = password;
    state.bytes = bytes;
    state.name = name;
    state.zoom = saved?.zoom || 1;
    const pending = groupByPage(saved);
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      state.pages.push({
        index: i, page, base: page.getViewport({ scale: 1 }), items: null, adds: [], covers: [],
        pending: pending[i] || null, scale: 0, el: null, layer: null, canvas: null, rendering: null,
      });
    }
    const widest = Math.max(...state.pages.map((p) => p.base.width));
    state.fit = Math.min(1.6, Math.max(0.4, (els.main.clientWidth - 40) / widest));
    buildPages();
    els.drop.hidden = true;
    els.pages.hidden = false;
    els.toolbar.hidden = false;
    els.exportMenu.hidden = false;
    els.docName.hidden = false;
    els.docName.textContent = name;
    document.title = `${name} – PDF 4 Edit`;
    updateFormat();
    updateZoom();
    if (!saved) save();
  } catch (err) {
    console.error(err);
    closeDoc();
    if (!/destroyed/i.test(err?.message)) toast('That file could not be opened as a PDF.', true);
  } finally {
    busy(null);
  }
}

function groupByPage(saved) {
  const out = {};
  if (!saved) return out;
  const get = (i) => (out[i] ||= { items: [], adds: [], covers: [] });
  for (const e of saved.items || []) get(e.page).items.push(e);
  for (const a of saved.adds || []) get(a.page).adds.push(a);
  for (const c of saved.covers || []) get(c.page).covers.push(c);
  return out;
}

let observer;
function buildPages() {
  els.pages.innerHTML = '';
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = state.pages[Number(en.target.dataset.index)];
      p.visible = en.isIntersecting;
      if (en.isIntersecting) renderPage(p);
    }
  }, { root: els.main, rootMargin: '800px 0px' });
  for (const p of state.pages) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = p.index;
    const layer = document.createElement('div');
    layer.className = `layer tool-${state.tool}`;
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = `Page ${p.index + 1} of ${state.pages.length}`;
    el.append(layer, num);
    p.el = el;
    p.layer = layer;
    bindLayer(p);
    sizePage(p);
    els.pages.append(el);
    observer.observe(el);
  }
}

function sizePage(p) {
  p.el.style.width = `${Math.floor(p.base.width * scale())}px`;
  p.el.style.height = `${Math.floor(p.base.height * scale())}px`;
}

function renderPage(p) {
  if (p.scale === scale() && p.canvas) return p.rendering || Promise.resolve();
  if (p.rendering && p.renderingScale === scale()) return p.rendering;
  const target = scale();
  p.renderingScale = target;
  const run = (async () => {
    await p.prev;
    if (target !== scale()) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const vp = p.page.getViewport({ scale: target * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await p.page.render({
      canvasContext: canvas.getContext('2d', { willReadFrequently: !p.items }),
      viewport: vp,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    }).promise;
    if (!p.items) await extract(p, canvas, vp);
    p.canvas?.remove();
    p.el.insertBefore(canvas, p.layer);
    p.canvas = canvas;
    p.scale = target;
    layoutPage(p);
  })().catch((err) => console.error('render', err)).finally(() => {
    if (p.rendering === run) p.rendering = null;
  });
  p.prev = run;
  p.rendering = run;
  return run;
}

async function extract(p, canvas, vp) {
  const content = await p.page.getTextContent();
  const read = pixelReader(canvas);
  const items = [];
  content.items.forEach((raw, idx) => {
    if (!raw.str || !raw.str.trim() || !raw.transform) return;
    const font = detectFont(commonObj(p.page, raw.fontName), content.styles[raw.fontName]);
    const it = {
      id: `${p.index}:${idx}`, page: p.index, idx, kind: 'orig',
      str: raw.str, text: raw.str, transform: raw.transform.slice(), width: raw.width,
      font, origFont: { ...font }, sizeScale: 1,
      align: NUMERIC.test(raw.str) ? 'right' : 'left',
    };
    const { bg, color } = sampleItem(read, vp, it);
    it.coverColor = bg;
    it.color = color;
    it.origColor = color.slice();
    items.push(it);
  });
  p.items = items;
  // Re-apply edits saved earlier in this browser.
  if (p.pending) {
    const byIdx = new Map(items.map((it) => [it.idx, it]));
    for (const e of p.pending.items) {
      const it = byIdx.get(e.idx);
      if (!it) continue;
      Object.assign(it, { text: e.text, font: e.font, sizeScale: e.sizeScale, color: e.color, align: e.align });
    }
    p.adds = p.pending.adds.map((a) => newAdd(p, a));
    p.covers = p.pending.covers.map((c) => ({ ...c, page: p.index, id: uid() }));
    p.pending = null;
  }
}

let uidN = 0;
const uid = () => `n${++uidN}`;

function newAdd(p, a) {
  const font = a.font || { family: 'Helvetica', bold: false, italic: false };
  return {
    id: uid(), page: p.index, kind: 'add', str: '', text: a.text || '', transform: a.transform, width: 0,
    font, origFont: { ...font }, sizeScale: a.sizeScale || 1, color: a.color || [0, 0, 0],
    origColor: [0, 0, 0], coverColor: [1, 1, 1], align: 'left',
  };
}

// ------------------------------------------------------------- overlays

function layoutPage(p) {
  if (!p.items) return;
  const vp = p.page.getViewport({ scale: scale() });
  // Existing text elements are moved, never re-created, so a run being
  // edited keeps focus while the page re-renders.
  p.layer.querySelectorAll('.erase-box').forEach((el) => el.remove());
  p.layer.prepend(...p.covers.map((c) => coverEl(p, c, vp)));
  for (const it of [...p.items, ...p.adds]) {
    if (!it.el) makeItemEl(p, it);
    placeItem(it, vp);
    if (it.el.parentNode !== p.layer) p.layer.append(it.el);
  }
}

function makeItemEl(p, it) {
  const el = document.createElement('div');
  el.className = 't';
  if (it.kind === 'add') el.classList.add('added');
  const hit = document.createElement('div');
  hit.className = 'hit';
  const cover = document.createElement('div');
  cover.className = 'cover';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.contentEditable = 'true';
  txt.spellcheck = false;
  txt.textContent = it.text;
  txt.setAttribute('role', 'textbox');
  txt.setAttribute('aria-label', it.kind === 'add' ? 'New text' : `Text: ${it.str}`);
  el.append(hit, cover, txt);
  it.el = el;
  it.txt = txt;
  it.cover = cover;
  it.hit = hit;

  hit.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'edit') return;
    e.preventDefault();
    focusItem(it, e.clientX, e.clientY);
  });
  txt.addEventListener('focus', () => {
    setActive(it);
    el.classList.add('focus', 'live');
  });
  txt.addEventListener('blur', () => {
    el.classList.remove('focus');
    if (it.kind === 'add' && !it.text.trim()) {
      if (state.active === it) setActive(null);
      return removeAdd(p, it);
    }
    refreshClasses(it);
  });
  txt.addEventListener('input', () => {
    if (txt.querySelector('*')) txt.textContent = txt.textContent;
    it.text = txt.textContent.replace(/\n/g, ' ');
    refreshClasses(it);
    if (it.kind === 'add') placeItem(it, p.page.getViewport({ scale: scale() }));
    save();
  });
  txt.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  });
  txt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const all = [...p.items, ...p.adds];
      const next = all[all.indexOf(it) + 1];
      if (next) focusItem(next); else txt.blur();
    } else if (e.key === 'Escape') {
      txt.blur();
    }
  });
  return el;
}

function refreshClasses(it) {
  const c = changed(it);
  it.el.classList.toggle('edited', c && it.kind !== 'add');
  it.el.classList.toggle('live', c || it.el.classList.contains('focus'));
}

function placeItem(it, vp) {
  const g = geom(it);
  const s = vp.scale;
  const [ox, oy] = vp.convertToViewportPoint(g.x, g.y);
  const [px, py] = vp.convertToViewportPoint(g.x + g.ux, g.y + g.uy);
  const angle = Math.atan2(py - oy, px - ox);
  const sizePx = g.size * s;
  const fontPx = sizePx * it.sizeScale;
  const m = metrics(it.font);
  const ratio = ratioFor(it);
  const widthPx = it.kind === 'add'
    ? Math.max(sizePx * 0.6, textWidth(it.font, it.text || ' ', fontPx) * ratio)
    : g.width * s;
  const pad = sizePx * COVER_PAD;
  const el = it.el;
  el.classList.toggle('right', it.align === 'right' && it.kind !== 'add');
  Object.assign(el.style, {
    left: `${ox}px`, top: `${oy}px`, width: `${widthPx}px`, height: '0px',
    transform: Math.abs(angle) > 1e-3 ? `rotate(${angle}rad)` : '',
  });
  const box = {
    left: `${-pad}px`, top: `${-COVER_ASCENT * sizePx}px`,
    width: `${widthPx + pad * 2}px`, height: `${(COVER_ASCENT + COVER_DESCENT) * sizePx}px`,
  };
  Object.assign(it.hit.style, box);
  Object.assign(it.cover.style, box, { background: cssColor(it.coverColor) });
  Object.assign(it.txt.style, {
    font: cssFont(it.font, fontPx),
    lineHeight: `${(m.ascent + m.descent) * fontPx}px`,
    top: `${-m.ascent * fontPx}px`,
    transform: Math.abs(ratio - 1) > 0.005 ? `scaleX(${ratio})` : '',
  });
  it.el.style.setProperty('--c', cssColor(it.color));
  if (it.kind === 'add') it.hit.style.display = 'none';
  refreshClasses(it);
}

function coverEl(p, c, vp) {
  const [x, y, w, h] = c.rect;
  const [ax, ay] = vp.convertToViewportPoint(x, y);
  const [bx, by] = vp.convertToViewportPoint(x + w, y + h);
  const el = document.createElement('div');
  el.className = 'erase-box';
  Object.assign(el.style, {
    left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`,
    width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px`, background: cssColor(c.color),
  });
  el.addEventListener('pointerdown', (e) => {
    if (state.tool === 'erase') return;
    e.preventDefault();
    e.stopPropagation();
    document.activeElement?.blur?.();
    setActive({ ...c, kind: 'cover', el, pageObj: p, ref: c });
  });
  c.el = el;
  return el;
}

function focusItem(it, x, y) {
  const clicked = x !== undefined;
  it.el.classList.add('live');
  it.txt.focus({ preventScroll: clicked });
  const range = document.createRange();
  let placed = false;
  if (clicked) {
    const pos = document.caretPositionFromPoint?.(x, y);
    const r = pos ? null : document.caretRangeFromPoint?.(x, y);
    const node = pos ? pos.offsetNode : r?.startContainer;
    if (node && it.txt.contains(node)) {
      range.setStart(node, pos ? pos.offset : r.startOffset);
      range.collapse(true);
      placed = true;
    }
  }
  if (!placed) {
    // Keyboard navigation selects the whole run so typing replaces it.
    range.selectNodeContents(it.txt);
    if (clicked) range.collapse(false);
  }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function removeAdd(p, it) {
  p.adds = p.adds.filter((a) => a !== it);
  it.el.remove();
  save();
}

// Tools that act on the page itself: adding text and erasing.
function bindLayer(p) {
  let draft = null;
  p.layer.addEventListener('pointerdown', (e) => {
    if (e.target !== p.layer || !p.items) {
      return;
    }
    const box = p.layer.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    if (state.tool === 'add') {
      e.preventDefault();
      const vp = p.page.getViewport({ scale: scale() });
      const size = state.lastAddSize || 11;
      const base = vp.convertToPdfPoint(x, y + size * scale() * 0.35);
      const right = vp.convertToPdfPoint(x + 1, y + size * scale() * 0.35);
      const up = vp.convertToPdfPoint(x, y + size * scale() * 0.35 - 1);
      const ul = Math.hypot(right[0] - base[0], right[1] - base[1]);
      const ux = (right[0] - base[0]) / ul, uy = (right[1] - base[1]) / ul;
      const vl = Math.hypot(up[0] - base[0], up[1] - base[1]);
      const vx = (up[0] - base[0]) / vl, vy = (up[1] - base[1]) / vl;
      const it = newAdd(p, { transform: [ux * size, uy * size, vx * size, vy * size, base[0], base[1]] });
      p.adds.push(it);
      makeItemEl(p, it);
      placeItem(it, vp);
      p.layer.append(it.el);
      focusItem(it);
    } else if (state.tool === 'erase') {
      e.preventDefault();
      p.layer.setPointerCapture(e.pointerId);
      const d = document.createElement('div');
      d.className = 'erase-draft';
      p.layer.append(d);
      draft = { x, y, d, box };
      moveDraft(e);
    } else {
      document.activeElement?.blur?.();
      setActive(null);
    }
  });
  const moveDraft = (e) => {
    if (!draft) return;
    const x = e.clientX - draft.box.left, y = e.clientY - draft.box.top;
    Object.assign(draft.d.style, {
      left: `${Math.min(x, draft.x)}px`, top: `${Math.min(y, draft.y)}px`,
      width: `${Math.abs(x - draft.x)}px`, height: `${Math.abs(y - draft.y)}px`,
    });
    draft.ex = x; draft.ey = y;
  };
  p.layer.addEventListener('pointermove', moveDraft);
  p.layer.addEventListener('pointerup', () => {
    if (!draft) return;
    const { x, y, ex = x, ey = y, d } = draft;
    d.remove();
    draft = null;
    if (Math.abs(ex - x) < 3 || Math.abs(ey - y) < 3) return;
    const vp = p.page.getViewport({ scale: scale() });
    const a = vp.convertToPdfPoint(x, y), b = vp.convertToPdfPoint(ex, ey);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
    const hi = p.page.getViewport({ scale: p.canvas.width / p.base.width });
    const color = sampleRect(pixelReader(p.canvas), hi, rect);
    p.covers.push({ id: uid(), page: p.index, rect, color });
    layoutPage(p);
    save();
  });
}

// ------------------------------------------------------------- format bar

function setActive(obj) {
  if (state.active?.kind === 'cover') state.active.el.classList.remove('sel');
  state.active = obj;
  if (obj?.kind === 'cover') obj.el.classList.add('sel');
  updateFormat();
}

function updateFormat() {
  const a = state.active;
  const text = a && a.kind !== 'cover';
  els.format.classList.toggle('disabled', !a);
  for (const b of [els.family, els.bold, els.italic, els.smaller, els.bigger, els.align, els.revert]) b.disabled = !text;
  els.color.disabled = !text;
  els.del.disabled = !a;
  if (!text) {
    els.size.textContent = '–';
    els.bold.classList.remove('on');
    els.italic.classList.remove('on');
    return;
  }
  els.family.value = a.font.family;
  els.bold.classList.toggle('on', !!a.font.bold);
  els.italic.classList.toggle('on', !!a.font.italic);
  els.size.textContent = `${(geom(a).size * a.sizeScale).toFixed(1)} pt`;
  els.color.value = `#${toHex(a.color)}`;
  els.color.parentElement.style.setProperty('--swatch', els.color.value);
  els.align.textContent = a.align === 'right' ? '⇥' : '⇤';
  els.align.title = a.align === 'right'
    ? 'Right edge stays fixed (good for numbers in columns). Click to keep the left edge fixed.'
    : 'Left edge stays fixed. Click to keep the right edge fixed instead.';
  els.align.disabled = a.kind === 'add';
  els.revert.disabled = a.kind === 'add' || !changed(a);
}

function modify(fn) {
  const a = state.active;
  if (!a || a.kind === 'cover') return;
  fn(a);
  const p = state.pages[a.page];
  placeItem(a, p.page.getViewport({ scale: scale() }));
  if (a.kind === 'add') state.lastAddSize = geom(a).size * a.sizeScale;
  updateFormat();
  save();
}

// Keep the caret in the text while clicking format buttons.
for (const b of [els.bold, els.italic, els.smaller, els.bigger, els.align, els.revert, els.del]) {
  b.addEventListener('mousedown', (e) => e.preventDefault());
}
els.family.addEventListener('change', () => modify((a) => { a.font = { ...a.font, family: els.family.value }; }));
els.bold.addEventListener('click', () => modify((a) => { a.font = { ...a.font, bold: !a.font.bold }; }));
els.italic.addEventListener('click', () => modify((a) => { a.font = { ...a.font, italic: !a.font.italic }; }));
const resize = (dir) => modify((a) => {
  const size = geom(a).size;
  const next = Math.max(4, Math.min(144, Math.round((size * a.sizeScale + dir * 0.5) * 2) / 2));
  a.sizeScale = Math.abs(next - size) < 0.01 ? 1 : next / size;
});
els.smaller.addEventListener('click', () => resize(-1));
els.bigger.addEventListener('click', () => resize(1));
els.color.addEventListener('input', () => modify((a) => { a.color = fromHex(els.color.value); }));
els.align.addEventListener('click', () => modify((a) => { a.align = a.align === 'right' ? 'left' : 'right'; }));
els.revert.addEventListener('click', () => modify((a) => {
  a.text = a.str;
  a.txt.textContent = a.str;
  a.font = { ...a.origFont };
  a.sizeScale = 1;
  a.color = a.origColor.slice();
}));
els.del.addEventListener('click', deleteActive);

function deleteActive() {
  const a = state.active;
  if (!a) return;
  const p = state.pages[a.page];
  if (a.kind === 'cover') {
    p.covers = p.covers.filter((c) => c !== a.ref);
    setActive(null);
    layoutPage(p);
    save();
  } else if (a.kind === 'add') {
    setActive(null);
    removeAdd(p, a);
  } else {
    modify((it) => { it.text = ''; it.txt.textContent = ''; });
  }
}

document.addEventListener('keydown', (e) => {
  const inText = e.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
  if (!inText && state.active?.kind === 'cover' && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteActive();
  }
});

// ---------------------------------------------------------------- tools

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  for (const p of state.pages) if (p.layer) p.layer.className = `layer tool-${tool}`;
}
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function updateZoom() {
  els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}
function setZoom(z) {
  state.zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  updateZoom();
  for (const p of state.pages) {
    sizePage(p);
    layoutPage(p);
    if (p.visible) renderPage(p);
  }
  save();
}
els.zoomIn.addEventListener('click', () => setZoom(state.zoom + 0.1));
els.zoomOut.addEventListener('click', () => setZoom(state.zoom - 0.1));

// ------------------------------------------------------------- persistence
// The open document and its edits are kept in this browser (IndexedDB) so
// nothing is lost on refresh or on the trip to checkout.

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pdf4edit', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('docs', mode);
    const req = fn(tx.objectStore('docs'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}

function snapshot() {
  const items = [], adds = [], covers = [];
  for (const p of state.pages) {
    if (p.pending) {
      items.push(...p.pending.items);
      adds.push(...p.pending.adds);
      covers.push(...p.pending.covers);
      continue;
    }
    for (const it of p.items || []) {
      if (changed(it) || it.align !== (NUMERIC.test(it.str) ? 'right' : 'left')) {
        items.push({ page: p.index, idx: it.idx, text: it.text, font: it.font, sizeScale: it.sizeScale, color: it.color, align: it.align });
      }
    }
    for (const a of p.adds) if (a.text.trim()) adds.push({ page: p.index, transform: a.transform, text: a.text, font: a.font, sizeScale: a.sizeScale, color: a.color });
    for (const c of p.covers) covers.push({ page: p.index, rect: c.rect, color: c.color });
  }
  return { items, adds, covers };
}

let saveTimer;
function save(now = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    if (!state.bytes) return;
    try {
      await idbDo('readwrite', (s) => s.put({ name: state.name, bytes: state.bytes, zoom: state.zoom, edits: snapshot(), at: Date.now() }, 'current'));
    } catch (err) { console.warn('save', err); }
  };
  if (now) return run();
  saveTimer = setTimeout(run, 500);
}

async function loadSaved() {
  try { return await idbDo('readonly', (s) => s.get('current')); } catch { return null; }
}

function closeDoc(clear = true) {
  observer?.disconnect();
  state.pdf?.destroy();
  Object.assign(state, { name: '', bytes: null, password: '', pdf: null, pages: [], active: null });
  els.pages.innerHTML = '';
  els.pages.hidden = true;
  els.toolbar.hidden = true;
  els.exportMenu.hidden = true;
  els.docName.hidden = true;
  els.drop.hidden = false;
  els.resume.hidden = true;
  document.title = 'Editor – PDF 4 Edit';
  if (clear) idbDo('readwrite', (s) => s.delete('current')).catch(() => {});
}
els.close.addEventListener('click', () => {
  if (snapshot().items.length && !confirm('Close this document? Your edits will be discarded.')) return;
  closeDoc();
});

// ------------------------------------------------------------- uploading

async function takeFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return toast('Please choose a PDF file.', true);
  if (file.size > 50 * 1024 * 1024) return toast('Files up to 50 MB are supported.', true);
  await openPdf(new Uint8Array(await file.arrayBuffer()), file.name);
}
els.file.addEventListener('change', () => { takeFile(els.file.files[0]); els.file.value = ''; });
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); if (!els.drop.hidden) els.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); });
}
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) {
    if (state.bytes && !confirm(`Open ${f.name}? The current document will be closed.`)) return;
    takeFile(f);
  }
});

// ---------------------------------------------------------------- export

async function ensureAll(pred = () => true) {
  const todo = state.pages.filter((p) => !p.items && pred(p));
  let n = 0;
  for (const p of todo) {
    busy(`Preparing page ${++n} of ${todo.length}…`);
    for (let tries = 0; !p.items && tries < 3; tries++) await renderPage(p);
    if (!p.items) throw new Error(`Page ${p.index + 1} could not be read.`);
  }
}

function serialize(it) {
  return {
    page: it.page, kind: it.kind, transform: it.transform, width: it.width, origText: it.str,
    text: it.text, font: it.font, sizeScale: it.sizeScale, color: it.color, coverColor: it.coverColor, align: it.align,
  };
}

const allCovers = () => state.pages.flatMap((p) => p.covers.map((c) => ({ page: p.index, rect: c.rect, color: c.color })));

async function buildPdfPayload() {
  await ensureAll((p) => !!p.pending);
  const texts = state.pages.flatMap((p) => [
    ...(p.items || []).filter(changed),
    ...p.adds.filter((a) => a.text.trim()),
  ]).map(serialize);
  return { edits: JSON.stringify({ texts, covers: allCovers() }) };
}

async function buildFillablePayload() {
  await ensureAll();
  const texts = state.pages.flatMap((p) => [...p.items, ...p.adds.filter((a) => a.text.trim())]).map(serialize);
  return { data: JSON.stringify({ texts, covers: allCovers() }) };
}

const upright = (p, it) => {
  const vp = p.base;
  const g = geom(it);
  const [ox, oy] = vp.convertToViewportPoint(g.x, g.y);
  const [px, py] = vp.convertToViewportPoint(g.x + g.ux, g.y + g.uy);
  return Math.abs(py - oy) < 0.02 && px > ox;
};

async function buildDocxPayload() {
  await ensureAll();
  const pages = [];
  const files = {};
  for (const p of state.pages) {
    busy(`Converting page ${p.index + 1} of ${state.pages.length}…`);
    const vp = p.page.getViewport({ scale: DOCX_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    await p.page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    // Paint out erased areas and every upright line of text; the text comes
    // back as real Word text on top.
    for (const c of p.covers) {
      const [x, y, w, h] = c.rect;
      polygon(ctx, vp, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c.color);
    }
    const texts = [];
    for (const it of [...p.items, ...p.adds]) {
      if (!upright(p, it)) continue;
      const g = geom(it);
      if (it.kind !== 'add') {
        const pad = g.size * COVER_PAD;
        polygon(ctx, vp, [
          along(g, -pad, -g.size * COVER_DESCENT), along(g, g.width + pad, -g.size * COVER_DESCENT),
          along(g, g.width + pad, g.size * COVER_ASCENT), along(g, -pad, g.size * COVER_ASCENT),
        ], it.coverColor);
      }
      const text = it.text;
      if (!text.trim()) continue;
      const size = g.size * it.sizeScale;
      const ratio = ratioFor(it);
      const natural = textWidth(it.font, text, size);
      const width = natural * ratio;
      let [x, baseline] = p.base.convertToViewportPoint(g.x, g.y);
      if (it.align === 'right' && it.kind !== 'add') x += g.width - width;
      texts.push({
        x, baseline, size, text, width, family: it.font.family, bold: it.font.bold, italic: it.font.italic,
        color: toHex(it.color), spacing: text.length > 1 ? (width - natural) / text.length : 0,
      });
    }
    pages.push({ width: p.base.width, height: p.base.height, texts });
    files[`page${p.index}`] = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  }
  return { layout: JSON.stringify({ pages }), files };
}

function polygon(ctx, vp, pts, color) {
  ctx.beginPath();
  pts.forEach((pt, i) => {
    const [x, y] = vp.convertToViewportPoint(pt[0], pt[1]);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = cssColor(color);
  ctx.fill();
}

const EXPORTS = {
  pdf: { url: '/api/export/pdf', build: buildPdfPayload, label: 'PDF' },
  fillable: { url: '/api/export/fillable', build: buildFillablePayload, label: 'editable PDF' },
  docx: { url: '/api/export/docx', build: buildDocxPayload, label: 'Word document' },
};

async function runExport(kind) {
  const cfg = EXPORTS[kind];
  document.activeElement?.blur?.();
  let info = await me(true);
  if (!info.user) {
    if (!(await signIn('signup'))) return;
    info = await me(true);
  }
  if (!info.user.subscribed) {
    await subscribe(async () => {
      sessionStorage.setItem('p4e-after-checkout', kind);
      await save(true);
    });
    return;
  }
  try {
    busy(`Creating your ${cfg.label}…`);
    const payload = await cfg.build();
    busy(`Creating your ${cfg.label}…`);
    const form = new FormData();
    form.append('name', state.name);
    if (state.password) form.append('password', state.password);
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'files') for (const [fk, fv] of Object.entries(v)) form.append(fk, fv, `${fk}.png`);
      else form.append(k, v);
    }
    if (kind !== 'docx') form.append('file', new Blob([state.bytes], { type: 'application/pdf' }), 'original.pdf');
    const res = await fetch(cfg.url, { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) { busy(null); return runExport(kind); }
      throw new Error(data.error || 'Export failed.');
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'document';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
    toast(`Downloaded ${name}`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed.', true);
  } finally {
    busy(null);
  }
}

function toggleMenu(menu, btn, open) {
  const isOpen = open ?? !menu.classList.contains('open');
  document.querySelectorAll('.menu.open').forEach((m) => m !== menu && m.classList.remove('open'));
  menu.classList.toggle('open', isOpen);
  btn.setAttribute('aria-expanded', isOpen);
}
els.exportBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.exportMenu, els.exportBtn); });
els.exportMenu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
  toggleMenu(els.exportMenu, els.exportBtn, false);
  runExport(b.dataset.export);
}));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
});

// --------------------------------------------------------------- account

async function renderAccount() {
  const { user } = await me(true);
  els.accountBtn.textContent = user ? (user.subscribed ? 'Account' : 'Account · Free') : 'Sign in';
  els.accountList.innerHTML = '';
  const add = (label, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `<b></b>${sub ? '<span></span>' : ''}`;
    b.querySelector('b').textContent = label;
    if (sub) b.querySelector('span').textContent = sub;
    b.addEventListener('click', () => { toggleMenu(els.accountMenu, els.accountBtn, false); fn(); });
    els.accountList.append(b);
  };
  if (!user) {
    add('Sign in', null, async () => { await signIn('login'); renderAccount(); });
    add('Create account', null, async () => { await signIn('signup'); renderAccount(); });
    return;
  }
  const who = document.createElement('div');
  who.className = 'who';
  who.innerHTML = '<b></b><br><span></span>';
  who.querySelector('b').textContent = user.email;
  who.querySelector('span').textContent = user.subscribed
    ? `Unlimited plan${user.renews ? ` · renews ${new Date(user.renews).toLocaleDateString()}` : ''}`
    : 'Free: edit now, subscribe to download';
  els.accountList.append(who);
  if (user.subscribed) {
    add('Manage billing', 'Update card or cancel', async () => {
      try { location.href = (await api('/api/billing/portal', {})).url; } catch (err) { toast(err.message, true); }
    });
  } else {
    add('Subscribe – $4.99/month', 'Unlimited downloads', async () => {
      await subscribe(() => save(true));
      renderAccount();
    });
  }
  add('Sign out', null, async () => { await signOut(); renderAccount(); });
}
els.accountBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(els.accountMenu, els.accountBtn); });

// ----------------------------------------------------------------- start

(async function start() {
  const params = new URLSearchParams(location.search);
  const checkout = params.get('checkout');
  const returning = checkout || params.has('subscribed');
  if (returning) history.replaceState(null, '', '/app.html');
  if (checkout) {
    try { await api('/api/billing/confirm', { sessionId: checkout }); } catch (err) { console.warn(err); }
  }
  renderAccount();
  const saved = await loadSaved();
  if (saved?.bytes) {
    const resume = () => openPdf(saved.bytes, saved.name, { ...saved.edits, zoom: saved.zoom });
    if (returning) {
      await resume();
      toast('You’re subscribed. Unlimited downloads are unlocked.');
      const pendingKind = sessionStorage.getItem('p4e-after-checkout');
      sessionStorage.removeItem('p4e-after-checkout');
      if (EXPORTS[pendingKind]) runExport(pendingKind);
    } else {
      els.resume.hidden = false;
      els.resumeName.textContent = saved.name;
      els.resumeBtn.onclick = resume;
      els.resumeDiscard.onclick = () => closeDoc();
    }
  } else if (returning) {
    toast('You’re subscribed. Unlimited downloads are unlocked.');
  }
})();
