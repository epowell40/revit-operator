import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadImage } from '@napi-rs/canvas';
import { buildCodexVisualInput } from '../src/brains/codex_visual_input.js';

function drawingPdf(count: number) {
  const labels = Array.from({ length: count }, (_, i) => i === 3 ? 'E010 - Distribution' : `E00${i} - Sheet`);
  const objects = ['<< /Type /Catalog /Pages 2 0 R /PageLabels 3 0 R >>',
    `<< /Type /Pages /Kids [${labels.map((_, i) => `${6 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`,
    `<< /Nums [${labels.map((label, i) => `${i} << /P (${label}) >>`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< >>'];
  for (const label of labels) {
    const text = `1 0 0 rg BT /F1 36 Tf 120 120 Td (${label}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 3024 2160] /Resources << /Font << /F1 4 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`);
  }
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

async function withPdf(count: number, action: (attachment: { id: string; relative_path: string; sha256: string }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-pdf-navigation-'));
  const prior = process.env.OPERATOR_WORKSPACE_ROOT; process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const bytes = drawingPdf(count); fs.writeFileSync(path.join(root, 'drawing.pdf'), bytes);
    await action({ id: 'source-drawing', relative_path: 'drawing.pdf', sha256: createHash('sha256').update(bytes).digest('hex') });
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('long binder supplies small navigation previews and stable catalog including an unpreviewed target page', async () => {
  await withPdf(7, async attachment => {
    const result = await buildCodexVisualInput({ user_attachments: [attachment] });
    assert.equal(result.receipts[0]!.preview_mode, 'overview');
    assert.deepEqual(result.receipts[0]!.pages, [1, 2, 3]);
    assert.equal(result.receipts[0]!.page_count, 7);
    assert.match(result.receipts[0]!.reason!, /4 pages still require inspection/);
    const catalogInput = result.input.find(item => item.type === 'text' && item.text.includes('initial_preview_mode'));
    assert(catalogInput && catalogInput.type === 'text');
    const catalog = JSON.parse(catalogInput.text);
    assert.equal(catalog.sha256, attachment.sha256);
    assert.equal(catalog.attachment_id, attachment.id);
    assert.equal(catalog.navigation.pages[3].declared_pdf_page_label, 'E010 - Distribution');
    assert.match(catalog.notice, /no small-text or complete source review/);
    const images = result.input.filter(item => item.type === 'image'); assert.equal(images.length, 3);
    for (const item of images) {
      assert(item.type === 'image' && 'url' in item);
      const image = await loadImage(Buffer.from(item.url.split(',')[1]!, 'base64'));
      assert(Math.max(image.width, image.height) <= 1280);
    }
    const repeated = await buildCodexVisualInput({ user_attachments: [attachment] });
    assert.deepEqual(repeated, result, 'same uploaded bytes produce stable cacheable input, not clocks or random context');
  });
});

test('short document keeps detailed pixels and correct coverage', async () => {
  await withPdf(1, async attachment => {
    const result = await buildCodexVisualInput({ user_attachments: [attachment] });
    assert.equal(result.receipts[0]!.preview_mode, 'detail');
    assert.deepEqual(result.receipts[0]!.pages, [1]);
    const input = result.input.find(item => item.type === 'image'); assert(input && input.type === 'image' && 'url' in input);
    const image = await loadImage(Buffer.from(input.url.split(',')[1]!, 'base64'));
    assert.equal(image.width, 3072);
  });
});

test('changed upload bytes remain rejected before visual evidence admission', async () => {
  await withPdf(7, async attachment => {
    await assert.rejects(buildCodexVisualInput({ user_attachments: [{ ...attachment, sha256: 'f'.repeat(64) }] }), /changed since upload/);
  });
});
