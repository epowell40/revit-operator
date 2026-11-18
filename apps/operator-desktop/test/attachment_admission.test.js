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
const { app, configureOperatorDesktopTestHooks, sanitizePendingAttachments, toComputerInputMessage } = await import('../server.js');
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

test('the desktop run fits an in-limit Unicode brief alongside the full attachment budget', async () => {
  const pending_attachments = [file('first.txt', '', Buffer.alloc(262144).toString('base64')),
    file('second.txt', '', Buffer.alloc(270330 - 262144).toString('base64'))];
  const prefix = 'Use both reference files. ';
  const tail = ' Keep the original model unchanged.';
  const prompt = prefix + '参'.repeat(16_000 - prefix.length - tail.length) + tail;
  const briefs = [];
  configureOperatorDesktopTestHooks({computerRunTestHooks: {
    enableSidecarAssignment: true,
    buildHybridBackendContext: async ({bootstrapModelRequestText}) => {
      briefs.push(bootstrapModelRequestText);
      throw new Error('Fixture stops before backend intake');
    },
  }});
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const run = body => fetch(`http://127.0.0.1:${server.address().port}/api/computer/run`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    const response = await run({prompt, pending_attachments});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Fixture stops before backend intake/);
    assert.deepEqual(briefs, [prompt]);

    const tooLong = await run({prompt: prompt + '参', pending_attachments});
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).error, /16,000 characters/);
    const tooLarge = await run({prompt, pending_attachments, padding: 'x'.repeat(100_000)});
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, 'request_body_too_large');
    assert.deepEqual(briefs, [prompt]);
  } finally {
    configureOperatorDesktopTestHooks();
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

test('short registered UTF-8 references reach the desktop actor without an eager file block', () => {
  const sessionId = 'current-text-session';
  const makeAttachment = (id, name, source) => {
    const bytes = Buffer.from(source);
    const [entry] = sanitizePendingAttachments([{ ...file(name, '', bytes.toString('base64')), id }]);
    return { ...entry, backendAttachment: {
      id, session_id: sessionId, filename: name, mime: entry.mime, bytes: bytes.length,
      relative_path: `artifacts/uploads/${id}-${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex')
    } };
  };
  const json = makeAttachment('example-one', 'schedule.json', '{"equipment":"ERV-12","supply_cfm":140}');
  const csvBody = '室,CFM\n' + '東,140\n'.repeat(700);
  const csv = makeAttachment('example-two', 'schedule.csv', csvBody);
  const text = makeAttachment('example-three', 'notes.txt', 'Matching tag labels: 東 and West.\n');
  const reader = { type: 'function', name: 'native__operator_read_attachment', parameters: {
    type: 'object', required: ['attachment_id'], properties: {
      attachment_id: { type: 'string' }, mode: { enum: ['overview', 'detail', 'text', 'vector'] },
      start_char: { type: 'integer' }, max_text_bytes: { type: 'integer', maximum: 16384 }
    }
  } };
  const delivery = { sessionId, tools: [reader] };
  const message = { role: 'user', text: 'Read both schedule examples and the notes.', attachments: [json, csv, text] };
  const render = (msg = message, attachmentDelivery = delivery, includeBinaryAttachments = true) =>
    toComputerInputMessage(msg, { attachmentDelivery, includeBinaryAttachments }).content;
  const fileNames = blocks => blocks.filter(block => block.type === 'input_file').map(block => block.filename);
  const refs = blocks => blocks.filter(block => block.text?.startsWith('RETAINED TEXT'))
    .map(block => JSON.parse(block.text.split('\n').at(-1)));
  const rendered = render();
  assert.equal(rendered[0].text, message.text);
  assert.deepEqual(fileNames(rendered), []);
  assert.deepEqual(refs(rendered).map(ref => ref.attachment_id), message.attachments.map(entry => entry.id));
  assert.deepEqual(refs(rendered).map(ref => ref.sha256), message.attachments.map(entry => entry.backendAttachment.sha256));
  assert.equal(refs(rendered)[0].text, '{"equipment":"ERV-12","supply_cfm":140}');
  assert.equal(refs(rendered)[1].text, csvBody);
  assert.equal(refs(rendered)[2].text, 'Matching tag labels: 東 and West.\n');
  assert(refs(rendered).every(ref => ref.original_access_verified === false));

  const mismatched = { ...json, dataBase64: Buffer.from('{"equipment":"ERV-12","supply_cfm":940}').toString('base64') };
  assert.deepEqual(fileNames(render({ ...message, attachments: [mismatched, csv, text] })), ['schedule.json']);
  const large = makeAttachment('large', 'large.csv', csvBody.repeat(2));
  assert.deepEqual(fileNames(render({ ...message, attachments: [json, large] })), ['large.csv']);
  const binary = makeAttachment('binary', 'binary.txt', Buffer.from([0xff, 0x00, 0x01]));
  assert.deepEqual(fileNames(render({ ...message, attachments: [binary] })), ['binary.txt']);
  assert.deepEqual(fileNames(render(message, { sessionId: 'foreign', tools: [reader] })), message.attachments.map(entry => entry.filename));
  assert.deepEqual(fileNames(render(message, { sessionId, tools: [] })), message.attachments.map(entry => entry.filename));
  assert.deepEqual(refs(render(message, delivery, false)), []);
});

test('the desktop actor receives the matching registered workbook inspector and keeps the file', () => {
  const sessionId = 'current-workbook-session';
  const filename = 'Circuit assignment.xlsx';
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const bytes = Buffer.from('synthetic workbook fixture');
  const [attachment] = sanitizePendingAttachments([{ ...file(filename, mime, bytes.toString('base64')), id: 'book-1' }]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relative_path = 'artifacts/uploads/20261118143237_Circuit assignment.xlsx';
  const inspection_hint = { method: 'POST', path: '/revit/inspect-excel-source',
    body: { sourcePath: relative_path, section: 'worksheets', expectedSourceSha256: sha256 } };
  attachment.backendAttachment = {
    id: attachment.id, filename, mime, bytes: bytes.length, relative_path, sha256, session_id: sessionId,
    source_access: {
      schema: 'operator.attachment-source-access.v1', attachment_id: attachment.id, filename,
      source_sha256: sha256, original_access_verified: false, inspection_hint,
    },
  };
  const caller = { type: 'function', name: 'native__revit_call_tool',
    parameters: { type: 'object', properties: {method: {enum: ['GET', 'POST']}, path: {type: 'string'}, body: {type: 'object'}} } };
  const delivery = {sessionId, tools: [caller]};
  const render = (upload, context = delivery, includeBinaryAttachments = true) => {
    return toComputerInputMessage({role: 'user', text: 'Read the three references.', attachments: [upload]},
      {attachmentDelivery: context, includeBinaryAttachments}).content;
  };
  const refs = blocks => JSON.parse(blocks.find(block => block.text?.startsWith('RETAINED ORIGINAL')).text.split('\n').at(-1));
  const messages = render(attachment);
  assert.deepEqual(refs(messages)[0].inspection_hint, inspection_hint);
  assert.equal(refs(messages)[0].original_access_verified, false);
  assert.ok(messages.some(block => block.type === 'input_file' && block.filename === filename));
  assert.match(messages.map(block => block.text).join(' '), /native__revit_call_tool/);

  for (const [label, mutate] of Object.entries({
    foreignSession: row => { row.backendAttachment.session_id = 'earlier-session'; },
    foreignAttachment: row => { row.backendAttachment.source_access.attachment_id = 'book-2'; },
    wrongSource: row => { row.backendAttachment.source_access.inspection_hint.body.sourcePath = 'artifacts/uploads/another.xlsx'; },
    wrongHash: row => { row.backendAttachment.source_access.inspection_hint.body.expectedSourceSha256 = 'a'.repeat(64); },
    forgedRoute: row => { row.backendAttachment.source_access.inspection_hint.path = '/revit/save-as'; },
    staleBytes: row => { row.dataBase64 = Buffer.alloc(bytes.length, 65).toString('base64'); },
    unsupportedPath: row => { row.backendAttachment.relative_path = '../other.xlsx'; row.backendAttachment.source_access.inspection_hint.body.sourcePath = '../other.xlsx'; },
  })) {
    const copy = structuredClone(attachment);
    mutate(copy);
    assert.equal(refs(render(copy))[0].inspection_hint, undefined, label);
  }
  assert.equal(refs(render(attachment, {sessionId, tools: []}))[0].inspection_hint, undefined);
  assert.equal(refs(render(attachment, delivery, false))[0].inspection_hint, undefined);
});
