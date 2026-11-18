import assert from 'node:assert/strict';
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
const { sanitizePendingAttachments } = await import('../server.js');
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
