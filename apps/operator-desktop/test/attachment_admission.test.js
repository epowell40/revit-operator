import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const workspace = mkdtempSync(join(tmpdir(), 'operator-attachment-admission-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
Object.assign(process.env, {
  OPERATOR_DESKTOP_NO_LISTEN: '1',
  OPERATOR_TOKEN: 'attachment-admission-test',
  OPERATOR_WORKSPACE_ROOT: workspace,
  OPERATOR_DESKTOP_MAX_ATTACHMENTS: '3',
  OPERATOR_DESKTOP_MAX_ATTACHMENT_BYTES: String(256 * 1024)
});
const { app, sanitizePendingAttachments, toComputerInputMessage } = await import('../server.js');
const file = (name, mimeType = '', dataBase64 = 'YWJj') => ({ name, mimeType, dataBase64 });

test('preserves every in-limit attachment in original order', () => {
  const input = [file('sheet.pdf', 'application/pdf'), file('markup.PNG', 'image/png'), file('plan.dwg', 'image/vnd.dwg')];
  const rows = sanitizePendingAttachments(input);
  assert.deepEqual(rows.map(row => row.filename), input.map(row => row.name));
  assert.deepEqual(rows.map(row => row.isImage), [false, true, false]);
});

test('rejects the whole submission if it exceeds the attachment count', () => {
  const input = ['a.txt', 'b.csv', 'c.json', 'd.pdf'].map(name => file(name));
  assert.throws(() => sanitizePendingAttachments(input), /at most 3 attachments/);
});

test('routes supported named files by extension and refuses a conflicting unsupported extension', () => {
  const rows = sanitizePendingAttachments([file('sheet.pdf', 'image/png'), file('markup.png', 'application/octet-stream')]);
  assert.deepEqual(rows.map(row => [row.mime, row.isImage]), [['application/pdf', false], ['image/png', true]]);
  assert.throws(() => sanitizePendingAttachments([file('markup.gif', 'image/png')]), /unsupported type/);
  assert.throws(() => sanitizePendingAttachments([file('old-spec.doc', 'application/msword')]), /unsupported type/);
  assert.equal(sanitizePendingAttachments([file('plot', 'image/jpg')])[0].mime, 'image/jpeg');
});

test('enforces the per-file byte ceiling at the boundary', () => {
  const limit = 256 * 1024;
  assert.equal(sanitizePendingAttachments([file('exact.txt', '', Buffer.alloc(limit).toString('base64'))])[0].bytes, limit);
  assert.throws(() => sanitizePendingAttachments([file('larger.txt', '', Buffer.alloc(limit + 1).toString('base64'))]), /exceeds the 262144-byte limit/);
});

test('enforces the aggregate file budget without taking away a maximum-size single file', () => {
  const limit = 256 * 1024;
  const maxCombined = 270330;
  const sized = (name, bytes) => file(name, '', Buffer.alloc(bytes).toString('base64'));
  const large = sized('large.txt', limit);
  const rows = sanitizePendingAttachments([large, sized('second.txt', maxCombined - limit)]);
  assert.equal(rows.reduce((sum, row) => sum + row.bytes, 0), maxCombined);
  assert.throws(() => sanitizePendingAttachments([large, sized('second.txt', maxCombined - limit + 1)]), /combined attachment size/);
});

test('oversized wire request yields a structured JSON admission error', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const data = Buffer.alloc(160000).toString('base64');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({prompt: 'Use both examples.', pending_attachments: [file('a.txt', '', data), file('b.txt', '', data)]}),
    });
    assert.equal(response.status, 413);
    const error = await response.json();
    assert.equal(error.code, 'request_body_too_large');
    assert.match(error.error, /remove a reference/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a single actor message preserves independently addressable references even with duplicate filenames', () => {
  const sessionId = 'multiple-references';
  const attachments = ['example-one', 'example-two'].map((id, index) => {
    const data = Buffer.from(`%PDF-1.4\nProject example ${index + 1}`);
    const [attachment] = sanitizePendingAttachments([{ ...file('Plans.pdf', 'application/pdf', data.toString('base64')), id }]);
    return { ...attachment, backendAttachment: {
      id, session_id: sessionId, bytes: data.length, filename: attachment.filename, mime: attachment.mime,
      sha256: createHash('sha256').update(data).digest('hex'), relative_path: `artifacts/uploads/${id}.pdf`
    } };
  });
  const message = { role: 'user', text: 'Use the two project examples to guide the current model.', attachments };
  const reader = { type: 'function', name: 'native__operator_read_attachment', parameters: {
    type: 'object', properties: { attachment_id: { type: 'string' },
      pages: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 3 },
      mode: { enum: ['overview', 'detail'] } }
  } };
  const input = toComputerInputMessage(message, { attachmentDelivery: { sessionId, tools: [reader] } });
  assert.equal(input.content[0].text, message.text);
  const refs = input.content.filter(item => item.text?.startsWith('RETAINED PDF'))
    .map(item => JSON.parse(item.text.split('\n').at(-1)));
  assert.deepEqual(refs.map(ref => ref.attachment_id), ['example-one', 'example-two']);
  assert.deepEqual(refs.map(ref => ref.sha256), attachments.map(a => a.backendAttachment.sha256));
  assert.ok(!input.content.some(item => item.type === 'input_file'));
});
