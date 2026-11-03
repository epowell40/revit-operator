import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { storeEvidence, retrieveEvidence } from "../src/evidence/evidence_store.js";
import { handleEvidenceHttpRoute } from "../src/evidence/evidence_http_routes.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

const scope = { session_id: "recovery-session", assignment_id: "recovery-assignment", run_id: "recovery-run", generation: 1 };
function fixture(t: test.TestContext, raw: string | Record<string, unknown>) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-recovery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { __closeForTests(); if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior; fs.rmSync(root, {recursive: true, force: true}); });
  const stored = storeEvidence({scope, source: "native:retained-observation", trust_level: "authoritative_native", raw});
  const base = {scope, evidence_id: stored.ref.evidence_id, purpose: "Read a focused observation", max_bytes: 4096};
  return {root, stored, base};
}

test("JSON-escaped text refusal supplies a usable smaller read without clipping or raising limits", t => {
  const raw = JSON.stringify({source: 'quotes " and slashes \\ '.repeat(600)});
  const {stored, base} = fixture(t, raw);
  let message = "";
  assert.throws(() => retrieveEvidence({...base, text_range: {start: 0, length: 4000}}), error => {
    message = String(error); return /exceeds 4096-byte limit/.test(message);
  });
  assert.match(message, /JSON-encoded UTF-8/);
  const length = Number(message.match(/recommended length: (\d+)/)?.[1]);
  assert.ok(length > 0 && length < 4000);
  const recovered = retrieveEvidence({...base, text_range: {start: 0, length}});
  assert.equal(recovered.selection, Buffer.from(raw).subarray(0, length).toString("utf8"));
  assert.ok(recovered.returned_bytes <= 4096);
  assert.equal(recovered.complete, false);
  assert.equal(recovered.evidence_ref.content_hash, stored.ref.content_hash);
});

test("nonzero text offsets and control-character expansion get a bounded recommendation", t => {
  const raw = 'prefix' + '\u0000"\\\n'.repeat(2000);
  const {base} = fixture(t, raw);
  let message = "";
  assert.throws(() => retrieveEvidence({...base, max_bytes: 64, text_range: {start: 6, length: 64}}), e => {message = String(e); return true;});
  const length = Number(message.match(/recommended length: (\d+)/)?.[1]);
  assert.ok(length > 0 && length < 64);
  const next = retrieveEvidence({...base, max_bytes: 64, text_range: {start: 6, length}});
  assert.equal(next.selection, Buffer.from(raw).subarray(6, 6 + length).toString("utf8"));
  assert.ok(next.returned_bytes <= 64);
});

test("oversized fields stay rejected; guidance does not echo retained content", t => {
  const {base} = fixture(t, {large: {detail: "PRIVATE_MARKER".repeat(2000)}, small: 4});
  assert.throws(() => retrieveEvidence({...base, fields: ["large"]}), e => {
    const message = String(e);
    assert.match(message, /narrower leaf fields/);
    assert.doesNotMatch(message, /PRIVATE_MARKER|recommended length/);
    return true;
  });
  assert.deepEqual(retrieveEvidence({...base, fields: ["small"]}).selection, {small: 4});
});

test("foreign scope and corrupt source fail before any size diagnosis", t => {
  const {root, stored, base} = fixture(t, '"'.repeat(10000));
  assert.throws(() => retrieveEvidence({...base, scope: {...scope, session_id: "foreign"}, text_range: {start: 0, length: 4000}}), e => {
    assert.doesNotMatch(String(e), /recommended length|JSON-encoded|Retained shape hints/); return true;
  });
  fs.writeFileSync(path.join(root, stored.ref.artifact_location), "changed");
  assert.throws(() => retrieveEvidence({...base, text_range: {start: 0, length: 4000}}), e => {
    assert.doesNotMatch(String(e), /recommended length|JSON-encoded|Retained shape hints/); return true;
  });
});

test("ordinary fitting text retains exact selection, byte accounting and completeness", t => {
  const {stored, base} = fixture(t, "plain text");
  const result = retrieveEvidence({...base, text_range: {start: 0, length: 100}});
  assert.equal(result.selection, "plain text");
  assert.equal(result.returned_bytes, 12);
  assert.equal(result.complete, true);
  assert.equal(result.evidence_ref.content_hash, stored.ref.content_hash);
});

test("wrong array path and oversized envelope expose bounded usable paths, never values", t => {
  const {base, stored} = fixture(t, {results: [{elementId: 12, connectors: Array.from({length: 40}, (_, i) => ({id: i, detail: 'PRIVATE_MARKER'.repeat(20)}))}]});
  for (const selector of [{item_range: {path: 'payload.items', start: 0, count: 2}}, {fields: ['payload']}]) {
    assert.throws(() => retrieveEvidence({...base, ...selector}), error => {
      const message = String(error);
      assert.match(message, /Retained shape hints/);
      assert.match(message, /results:array/);
      assert.match(message, /results\[0\]\.connectors:array/);
      assert.doesNotMatch(message, /PRIVATE_MARKER/);
      assert.ok(Buffer.byteLength(message) < 2400);
      return true;
    });
  }
  const recovered = retrieveEvidence({...base, item_range: {path: 'results[0].connectors', start: 0, count: 2, fields: ['id']}});
  assert.equal(recovered.evidence_ref.content_hash, stored.ref.content_hash);
  assert.equal(recovered.complete, false);
  assert.equal(recovered.pagination?.next_start, 2);
  assert.deepEqual((recovered.selection as any[]).map(r => r.values.id), [0, 1]);
});

test("oversized selected row suggests nested paging without silently clipping it", t => {
  const {base} = fixture(t, {results: [{elementId: 12, connectors: Array.from({length: 30}, () => ({description: 'x'.repeat(300)}))}]});
  assert.throws(() => retrieveEvidence({...base, item_range: {path: 'results', start: 0, count: 1, fields: ['elementId', 'connectors']}}), error => {
    assert.match(String(error), /One evidence row exceeds/);
    assert.match(String(error), /results\[0\]\.connectors:array/);
    assert.doesNotMatch(String(error), /xxx/);
    return true;
  });
});

test("shape diagnosis remains bounded and cannot become a completeness or value dump", t => {
  const raw = Object.fromEntries(Array.from({length: 200}, (_, i) => [`field${i}`, {nested: [{secret: 'DO_NOT_ECHO', rows: [1, 2]}]}]));
  const {base} = fixture(t, raw);
  assert.throws(() => retrieveEvidence({...base, item_range:{path:'missing',start:0,count:1}}), error => {
    const message = String(error);
    assert.ok(Buffer.byteLength(message) < 2400);
    assert.match(message, /partial paths\/types only, not model completeness/);
    assert.doesNotMatch(message, /DO_NOT_ECHO|field199/);
    return true;
  });
  assert.throws(() => retrieveEvidence({...base, item_range:{path:'__proto__',start:0,count:1}}), error => {
    assert.doesNotMatch(String(error), /Retained shape hints/); return true;
  });
});

test("model-facing HTTP failure preserves recoverable hint and current scope", async t => {
  const {base} = fixture(t, '"'.repeat(10000));
  const server = http.createServer(async (req, res) => { await handleEvidenceHttpRoute(req, res, new URL(req.url || "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/evidence/retrieve`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({...base, text_range: {start: 0, length: 4000}})});
    assert.equal(response.status, 400);
    const body = await response.json() as {error: string};
    assert.match(body.error, /recommended length: 2000/);
    assert.match(body.error, /same start/);
    assert.doesNotMatch(body.error, /native_postcondition_verified|whole_task_verified/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
