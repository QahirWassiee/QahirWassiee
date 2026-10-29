'use strict';
// Applies edits to a PDF without re-laying-out anything.
//
// The original PDF is loaded and every page keeps its original content stream
// untouched. Edits are appended as a separate content stream on top:
//   1. a cover rectangle painted in the colour sampled from behind the
//      original text, so the old words disappear, then
//   2. the new text drawn with the original text matrix (same baseline, same
//      size, same rotation), stretched so the glyphs take the same width per
//      character as the original font did.
// Nothing outside an edited region is touched, so it cannot move.

const {
  PDFDocument, StandardFonts, TextAlignment, rgb, degrees,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize,
  setTextMatrix, showText, setFillingRgbColor, rectangle, fill,
  concatTransformationMatrix,
} = require('pdf-lib');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, FrameAnchorType,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, LineRuleType,
  TextWrappingType,
} = require('docx');

// Cover box relative to the baseline, in units of font size.
const COVER_DESCENT = 0.24;
const COVER_ASCENT = 0.9;
const COVER_PAD = 0.04;
// Distance from the top of an exact-height Word line to its baseline.
const DOCX_BASELINE = 0.95;

const FONT_TABLE = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

function fontKey(f = {}) {
  const family = FONT_TABLE[f.family] ? f.family : 'Helvetica';
  return FONT_TABLE[family][(f.bold ? 1 : 0) + (f.italic ? 2 : 0)];
}

class FontCache {
  constructor(doc) { this.doc = doc; this.fonts = new Map(); this.ok = new Map(); }
  async get(f) {
    const key = fontKey(f);
    if (!this.fonts.has(key)) this.fonts.set(key, await this.doc.embedFont(StandardFonts[key]));
    return this.fonts.get(key);
  }
  // Standard fonts only cover WinAnsi; swap anything else for a close
  // equivalent so a stray character never breaks an export.
  clean(font, text) {
    const map = { '−': '-', '‐': '-', '‑': '-', ' ': ' ', '\t': ' ' };
    let out = '';
    for (const ch of String(text)) {
      const c = map[ch] || ch;
      const k = font.name + c;
      if (!this.ok.has(k)) {
        try { font.encodeText(c); this.ok.set(k, true); } catch { this.ok.set(k, false); }
      }
      out += this.ok.get(k) ? c : '?';
    }
    return out;
  }
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function color(c, d = [0, 0, 0]) {
  if (!Array.isArray(c) || c.length < 3) return d;
  return c.slice(0, 3).map((v) => Math.min(1, Math.max(0, num(v))));
}

// Baseline geometry of a text run from its pdf.js transform.
function geometry(item) {
  const [a, b, c, d, e, f] = (item.transform || []).map((v) => num(v));
  const size = Math.hypot(c, d) || Math.hypot(a, b) || 12;
  const hlen = Math.hypot(a, b) || size;
  const ux = a / hlen, uy = b / hlen;          // baseline direction
  const vx = -uy, vy = ux;                      // up direction
  return { size, ux, uy, vx, vy, x: e, y: f, width: Math.max(0, num(item.width)) };
}

function coverOps(g, rectColor) {
  const [r, gr, b] = color(rectColor, [1, 1, 1]);
  const pad = g.size * COVER_PAD;
  return [
    pushGraphicsState(),
    setFillingRgbColor(r, gr, b),
    concatTransformationMatrix(g.ux, g.uy, g.vx, g.vy, g.x, g.y),
    rectangle(-pad, -g.size * COVER_DESCENT, g.width + pad * 2, g.size * (COVER_DESCENT + COVER_ASCENT)),
    fill(),
    popGraphicsState(),
  ];
}

// Horizontal stretch that makes the standard font occupy the same width the
// original font did for the original text.
function widthRatio(font, item, g) {
  const orig = String(item.origText || '');
  if (!orig.trim() || !g.width) return 1;
  const w = font.widthOfTextAtSize(orig, g.size);
  if (!w) return 1;
  return Math.min(1.6, Math.max(0.6, g.width / w));
}

function textOps(page, font, fontName, item, g, cache) {
  const text = cache.clean(font, item.text || '');
  if (!text) return [];
  const ratio = num(item.ratio, 0) > 0 ? num(item.ratio) : widthRatio(font, item, g);
  const size = g.size * (num(item.sizeScale, 1) || 1);
  const newWidth = font.widthOfTextAtSize(text, size) * ratio;
  let ox = g.x, oy = g.y;
  if (item.align === 'right' && g.width) {
    ox += g.ux * (g.width - newWidth);
    oy += g.uy * (g.width - newWidth);
  }
  const [r, gr, b] = color(item.color);
  return [
    pushGraphicsState(),
    setFillingRgbColor(r, gr, b),
    beginText(),
    setFontAndSize(fontName, 1),
    setTextMatrix(g.ux * size * ratio, g.uy * size * ratio, g.vx * size, g.vy * size, ox, oy),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState(),
  ];
}

function validPage(pages, i) {
  const n = Math.floor(num(i, -1));
  return n >= 0 && n < pages.length ? pages[n] : null;
}

// Many statements and letters are encrypted with an owner password that only
// restricts editing (they open without a password). pdf-lib can't read
// encrypted files, so those are decrypted first with the @cantoo fork.
async function load(bytes, password = '') {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (!/encrypted/i.test(err.message)) throw err;
  }
  const { PDFDocument: Decryptor, PDFDict, PDFName } = require('@cantoo/pdf-lib');
  let plain;
  try {
    const enc = await Decryptor.load(bytes, { password: String(password || ''), updateMetadata: false });
    // The old encryption dictionary is left behind unreferenced; drop it.
    for (const [ref, obj] of enc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of('Filter')) === PDFName.of('Standard') && obj.has(PDFName.of('O'))) {
        enc.context.delete(ref);
      }
    }
    plain = await enc.save({ useObjectStreams: false });
  } catch (err) {
    throw Object.assign(new Error('This PDF is encrypted and could not be unlocked.'), { code: 'password' });
  }
  return PDFDocument.load(plain, { updateMetadata: false });
}

// edits: { texts: [...], covers: [...] }
async function exportEdited(bytes, edits = {}, password = '') {
  const doc = await load(bytes, password);
  const pages = doc.getPages();
  const cache = new FontCache(doc);

  for (const cv of edits.covers || []) {
    const page = validPage(pages, cv.page);
    if (!page) continue;
    const [x, y, w, h] = (cv.rect || []).map((v) => num(v));
    const [r, g, b] = color(cv.color, [1, 1, 1]);
    page.pushOperators(pushGraphicsState(), setFillingRgbColor(r, g, b), rectangle(x, y, w, h), fill(), popGraphicsState());
  }

  for (const item of edits.texts || []) {
    const page = validPage(pages, item.page);
    if (!page) continue;
    const g = geometry(item);
    if (item.kind !== 'add') page.pushOperators(...coverOps(g, item.coverColor));
    const font = await cache.get(item.font);
    const name = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(...textOps(page, font, name, item, g, cache));
  }

  return doc.save({ useObjectStreams: false });
}

// Every text run becomes a form field, so the result can be edited in any
// PDF reader (Acrobat, Preview, Chrome...).
async function exportFillable(bytes, data = {}, password = '') {
  const doc = await load(bytes, password);
  const pages = doc.getPages();
  const cache = new FontCache(doc);
  const form = doc.getForm();

  for (const cv of data.covers || []) {
    const page = validPage(pages, cv.page);
    if (!page) continue;
    const [x, y, w, h] = (cv.rect || []).map((v) => num(v));
    const [r, g, b] = color(cv.color, [1, 1, 1]);
    page.pushOperators(pushGraphicsState(), setFillingRgbColor(r, g, b), rectangle(x, y, w, h), fill(), popGraphicsState());
  }

  let n = 0;
  for (const item of data.texts || []) {
    const page = validPage(pages, item.page);
    if (!page) continue;
    const g = geometry(item);
    const font = await cache.get(item.font);
    if (item.kind !== 'add') page.pushOperators(...coverOps(g, item.coverColor));
    const text = cache.clean(font, item.text || '');
    const size = g.size * (num(item.sizeScale, 1) || 1);
    const angle = Math.round((Math.atan2(g.uy, g.ux) * 180) / Math.PI);
    const textW = font.widthOfTextAtSize(text, size);
    const width = Math.max(g.width, textW) + size * 0.5;
    const height = size * 1.3;
    // pdf-lib lays single-line text out 1pt in from the edge and centred
    // vertically; offset the box so the text lands on the original baseline.
    const lift = 1 + (height - 2) / 2 - font.heightAtSize(size, { descender: false }) / 2;
    const right = item.align === 'right' && item.kind !== 'add' && g.width > 0;
    const shift = right ? g.width + 1 - width : -1;
    const field = form.createTextField(`text_${item.page + 1}_${++n}`);
    field.setText(text);
    if (right) field.setAlignment(TextAlignment.Right);
    field.addToPage(page, {
      x: g.x + g.ux * shift - g.vx * lift,
      y: g.y + g.uy * shift - g.vy * lift,
      width, height, font,
      textColor: rgb(...color(item.color)),
      borderWidth: 0,
      borderColor: undefined,
      backgroundColor: undefined,
      rotate: degrees(angle),
    });
    field.setFontSize(size);
    field.updateAppearances(font);
  }
  return doc.save({ useObjectStreams: false });
}

// data.pages: [{ width, height (pt), image: Buffer(png), texts: [{ x, baseline,
//   size, text, family, bold, italic, color: 'RRGGBB', width, spacing }] }]
// x is the left edge and baseline the text baseline, both measured from the page's
// top-left corner.
async function exportDocx(data) {
  const PT = 20; // twips per point
  const sections = data.pages.map((p) => {
    const W = num(p.width, 612), H = num(p.height, 792);
    const children = [];
    if (p.image) {
      children.push(new Paragraph({
        children: [new ImageRun({
          type: 'png',
          data: p.image,
          transformation: { width: W * 96 / 72, height: H * 96 / 72 },
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
            behindDocument: true,
            allowOverlap: true,
            wrap: { type: TextWrappingType.NONE },
          },
        })],
      }));
    }
    for (const t of p.texts || []) {
      const size = Math.max(1, num(t.size, 11));
      const line = size * 1.2;
      const family = { Times: 'Times New Roman', Courier: 'Courier New' }[t.family] || 'Arial';
      children.push(new Paragraph({
        frame: {
          type: 'absolute',
          position: { x: Math.round(num(t.x) * PT), y: Math.round((num(t.baseline) - size * DOCX_BASELINE) * PT) },
          width: Math.round((num(t.width) * 1.15 + size * 2) * PT),
          height: Math.round(line * PT),
          anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
        },
        spacing: { before: 0, after: 0, line: Math.round(line * PT), lineRule: LineRuleType.EXACT },
        children: [new TextRun({
          text: String(t.text || ''),
          size: Math.round(size * 2),
          font: family,
          bold: !!t.bold,
          italics: !!t.italic,
          color: /^[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '000000',
          // Extra space per character (pt) so the line spans its original width.
          characterSpacing: Math.round(Math.max(-size, Math.min(size, num(t.spacing))) * PT) || undefined,
        })],
      }));
    }
    if (!children.length) children.push(new Paragraph({}));
    return {
      properties: {
        page: {
          size: { width: Math.round(W * PT), height: Math.round(H * PT) },
          margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 },
        },
      },
      children,
    };
  });
  const doc = new Document({ creator: 'PDF 4 Edit', sections });
  return Packer.toBuffer(doc);
}

module.exports = { exportEdited, exportFillable, exportDocx, geometry, COVER_DESCENT, COVER_ASCENT, COVER_PAD };
