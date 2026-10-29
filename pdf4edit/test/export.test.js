'use strict';
// Run with: npm test
// Checks that exports only change what was edited. The pixel comparison
// needs poppler's pdftoppm and Python with Pillow; it's skipped without them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { exportEdited, exportFillable, exportDocx } = require('../lib/exporter');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'statement.pdf'));

async function textItems(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const { items } = await page.getTextContent();
  const out = items.filter((i) => i.str.trim()).map((i) => ({ str: i.str, transform: i.transform, width: i.width }));
  await doc.destroy();
  return out;
}

function edit(item, text, extra = {}) {
  return {
    page: 0, kind: 'orig', transform: item.transform, width: item.width, origText: item.str, text,
    font: { family: 'Helvetica' }, sizeScale: 1, color: [0, 0, 0], coverColor: [1, 1, 1], align: 'right', ...extra,
  };
}

function hasTools() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Bounding box [x0, y0, x1, y1] (pixels at 72 dpi, top-left origin) of
// everything that differs between the two PDFs' first pages.
function diffBox(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4e-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), a);
  fs.writeFileSync(path.join(dir, 'b.pdf'), b);
  for (const n of ['a', 'b']) execFileSync('pdftoppm', ['-r', '72', '-png', '-singlefile', path.join(dir, `${n}.pdf`), path.join(dir, n)]);
  const out = execFileSync('python3', ['-c', `
from PIL import Image, ImageChops
a = Image.open('${dir}/a.png').convert('RGB'); b = Image.open('${dir}/b.png').convert('RGB')
print(ImageChops.difference(a, b).point(lambda v: 255 if v > 24 else 0).getbbox())`]).toString().trim();
  fs.rmSync(dir, { recursive: true, force: true });
  return out === 'None' ? null : JSON.parse(out.replace(/[()]/g, (c) => (c === '(' ? '[' : ']')));
}

test('exporting with no edits leaves every page pixel-identical', { skip: !hasTools() }, async () => {
  const out = await exportEdited(FIXTURE, { texts: [], covers: [] });
  assert.strictEqual(diffBox(FIXTURE, out), null);
});

test('an edit only changes pixels around the edited text', { skip: !hasTools() }, async () => {
  const items = await textItems(FIXTURE);
  const target = items.find((i) => i.str === '-86.40');
  assert.ok(target, 'fixture has the amount');
  const out = await exportEdited(FIXTURE, { texts: [edit(target, '-1,286.40')] });
  const box = diffBox(FIXTURE, out);
  assert.ok(box, 'something changed');
  const [x0, y0, x1, y1] = box;
  const [, , , size, e, f] = target.transform;
  const height = (await PDFDocument.load(FIXTURE)).getPage(0).getHeight();
  // Vertically confined to the edited line.
  assert.ok(y0 >= height - f - size * 1.1 && y1 <= height - f + size * 0.4, `rows ${y0}-${y1}`);
  // Nothing right of the original right edge changed; the longer number grew leftwards.
  assert.ok(x1 <= e + target.width + 2, `right edge ${x1} vs ${e + target.width}`);
  assert.ok(x0 < e, 'grew leftwards');

  const after = await textItems(out);
  const added = after.find((i) => i.str === '-1,286.40');
  assert.ok(added, 'new text is real, selectable text');
  assert.ok(Math.abs(added.transform[4] + added.width - (e + target.width)) < 0.5, 'right-aligned to the same edge');
  assert.ok(Math.abs(added.transform[5] - f) < 1e-6, 'same baseline');
});

test('untouched text keeps exactly the same position', async () => {
  const items = await textItems(FIXTURE);
  const target = items.find((i) => i.str === 'Grocery Market #42');
  const out = await exportEdited(FIXTURE, { texts: [edit(target, 'Grocery Market #42 (Main St)', { align: 'left' })] });
  const after = await textItems(out);
  for (const it of items) {
    if (it === target) continue;
    const same = after.find((a) => a.str === it.str && a.transform.every((v, i) => Math.abs(v - it.transform[i]) < 1e-6));
    assert.ok(same, `"${it.str}" did not move`);
  }
  const edited = after.find((a) => a.str === 'Grocery Market #42 (Main St)');
  assert.ok(edited);
  assert.ok(Math.abs(edited.transform[4] - target.transform[4]) < 1e-6 && Math.abs(edited.transform[5] - target.transform[5]) < 1e-6, 'same baseline origin');
});

test('fillable export turns every run into a form field', async () => {
  const items = await textItems(FIXTURE);
  const out = await exportFillable(FIXTURE, { texts: items.map((i) => edit(i, i.str, { align: 'left' })) });
  const doc = await PDFDocument.load(out);
  const fields = doc.getForm().getFields();
  assert.strictEqual(fields.length, items.length);
  assert.deepStrictEqual(fields.map((f) => f.getText()).sort(), items.map((i) => i.str).sort());
});

test('owner-restricted PDFs are decrypted before editing', async () => {
  const { PDFDocument: Cantoo } = require('@cantoo/pdf-lib');
  const doc = await Cantoo.load(FIXTURE);
  doc.encrypt({ userPassword: '', ownerPassword: 'secret', permissions: { modifying: false } });
  const locked = await doc.save();
  await assert.rejects(PDFDocument.load(locked), /encrypted/i);
  const out = await exportEdited(locked, { texts: [] });
  const after = await textItems(out);
  assert.ok(after.some((i) => i.str === 'Northfield Credit Union'));
});

test('word export produces a .docx', async () => {
  const buf = await exportDocx({ pages: [{ width: 612, height: 792, texts: [{ x: 72, baseline: 100, size: 11, text: 'Hello', width: 30 }] }] });
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');
});
