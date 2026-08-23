import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAuthoritativeEvidence,
  readEvidenceRef,
  retrieveEvidence,
  storeEvidence
} from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload, modelEvidenceEnvelope } from "../src/evidence/model_context_budget.js";
import { __clearServerPlannedActionsForTests, normalizeIncomingToolResults, registerServerPlannedActions } from "../src/revit_batch/tool_result_normalization.js";

function withWorkspace<T>(fn: (root: string) => T): T {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evidence-v1-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { return fn(root); }
  finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const scope = { session_id: "session-evidence", assignment_id: "assignment-a", run_id: "run-a", attempt_id: "attempt-a", generation: 2 };

test("509-air-device inventory is projected under budget and remains byte-for-byte recoverable", { concurrency: false }, () => withWorkspace(() => {
  const inventory = {
    count: 509,
    category: "Air Terminals",
    elements: Array.from({ length: 509 }, (_, index) => ({
      elementId: 800_000 + index,
      familyName: `Supply Diffuser ${index % 7}`,
      level: `Level ${1 + (index % 8)}`,
      flow: 125 + index
    }))
  };
  const raw = JSON.stringify(inventory);
  const stored = storeEvidence({ scope, source: "regression:509-air-device-inventory", media_type: "application/json", trust_level: "authoritative_readback", raw }, 4_096);
  assert.ok(stored.projection.projected_bytes <= 4_096);
  assert.equal(stored.projection.key_counts.count, 509);
  assert.equal(stored.projection.additional_evidence, true);
  assert.equal(readAuthoritativeEvidence(stored.ref, scope).toString("utf8"), raw);
  const page = retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "inspect the first two grounded devices", item_range: { path: "elements", start: 0, count: 2 }, max_bytes: 4_096 });
  assert.equal((page.selection as unknown[]).length, 2);
  assert.equal(page.complete, false);
}));

test("large Dynamic Revit and nested delegated receipts retain raw evidence while exposing compact facts", { concurrency: false }, () => withWorkspace(() => {
  const dynamic = {
    schema: "dynamic-revit.evidence.v1",
    effect_state: "applied",
    before_hash: "a".repeat(64),
    after_hash: "b".repeat(64),
    snapshot: { elementCount: 40_000, elements: Array.from({ length: 4_000 }, (_, id) => ({ id, value: `v-${id}` })) },
    receipts: Array.from({ length: 80 }, (_, id) => ({ id: `nested-${id}`, status: "completed", request_dispatched: true, targetId: 1000 + id })),
    logs: "dynamic-log-line\n".repeat(30_000)
  };
  const stored = storeEvidence({ scope, source: "dynamic_revit_program", trust_level: "authoritative_native", verification_relevance: "authoritative", raw: dynamic }, 8_192);
  assert.equal(stored.projection.effect_state, "applied");
  assert.equal(stored.projection.before_hash, "a".repeat(64));
  assert.equal(stored.projection.after_hash, "b".repeat(64));
  assert.ok(stored.projection.projected_bytes <= 8_192);
  const receipts = retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "verify nested receipt 10 through 12", item_range: { path: "receipts", start: 10, count: 3 }, max_bytes: 8_192 });
  assert.equal((receipts.selection as unknown[]).length, 3);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString("utf8")), dynamic);
}));

test("oversized raw result above the legacy 12 MiB threshold is never copied into the bounded model request", { concurrency: false }, () => withWorkspace(() => {
  const raw = JSON.stringify({ status: "completed", result: "x".repeat(12 * 1024 * 1024 + 8_192) });
  const stored = storeEvidence({ scope, source: "oversized_native_result", trust_level: "host_observed", raw }, 4_096);
  const context = assembleBoundedEvidenceContext({ projections: [stored.projection], session_id: scope.session_id, assignment_id: scope.assignment_id, budget: { item_bytes: 4_096, request_bytes: 4_096 } });
  assert.equal(context.projections.length, 1);
  assert.ok(context.bytes <= 4_096);
  assert.equal(readAuthoritativeEvidence(stored.ref, scope).toString("utf8"), raw);
  assert.throws(() => assertBoundedModelEvidencePayload([{ type: "function_call_output", output: raw }], { item_bytes: 4_096, request_bytes: 8_192 }), /store it and send an EvidenceRef/);
  assert.throws(() => assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify({ evidence_id: stored.ref.evidence_id, raw: "x".repeat(6_000) }) }], { item_bytes: 4_096, request_bytes: 8_192 }), /store it and send an EvidenceRef/);
}));

test("before/after snapshots, timeout recovery, visual captures, and focused retrieval retain authoritative forms", { concurrency: false }, () => withWorkspace(() => {
  const before = storeEvidence({ scope, source: "state_snapshot:before", trust_level: "authoritative_readback", raw: { state: "before", targetId: 42, count: 1 } });
  const after = storeEvidence({ scope, source: "state_snapshot:after", trust_level: "authoritative_readback", relationships: [{ evidence_id: before.ref.evidence_id, relation: "after" }], raw: { state: "after", targetId: 42, count: 2 } });
  const timeout = storeEvidence({ scope, source: "timeout_recovery", trust_level: "host_observed", verification_relevance: "required", raw: { effect_state: "unknown", request_dispatched: true, reconciliation_required: true, targetId: 42 } });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const image = storeEvidence({ scope, source: "visual_capture", media_type: "image/png", trust_level: "host_observed", relationships: [{ evidence_id: after.ref.evidence_id, relation: "capture_for" }], raw: png });
  assert.equal(timeout.projection.effect_state, "unknown");
  const fields = retrieveEvidence({ evidence_id: timeout.ref.evidence_id, scope, purpose: "decide whether reconciliation is mandatory", fields: ["effect_state", "request_dispatched", "reconciliation_required"], max_bytes: 1_024 });
  assert.deepEqual(fields.selection, { effect_state: "unknown", request_dispatched: true, reconciliation_required: true });
  const selectedImage = retrieveEvidence({ evidence_id: image.ref.evidence_id, scope, purpose: "vision verification of target 42", image: true, max_bytes: 1_024 });
  assert.equal(Buffer.from((selectedImage.selection as any).data_base64, "base64").equals(png), true);
}));

test("content-addressed reuse deduplicates bytes and survives restart-style ref reconstruction", { concurrency: false }, () => withWorkspace(() => {
  const input = { scope, source: "repeated_snapshot", trust_level: "host_observed" as const, raw: { count: 509, stable: true } };
  const first = storeEvidence(input);
  const second = storeEvidence(input);
  assert.equal(first.ref.evidence_id, second.ref.evidence_id);
  assert.equal(first.stored_unique_bytes, first.ref.byte_count);
  assert.equal(second.stored_unique_bytes, 0);
  assert.equal(second.duplicate_bytes_avoided, first.ref.byte_count);
  assert.deepEqual(readEvidenceRef(first.ref.evidence_id), first.ref);
  assert.equal(readAuthoritativeEvidence(readEvidenceRef(first.ref.evidence_id), scope).toString("utf8"), JSON.stringify(input.raw));
  const differentTrust = storeEvidence({ ...input, trust_level: "untrusted_caller" });
  assert.notEqual(differentTrust.ref.evidence_id, first.ref.evidence_id);
  assert.equal(differentTrust.stored_unique_bytes, 0);
  assert.equal(differentTrust.ref.trust_level, "untrusted_caller");
}));

test("scope fencing, path traversal protection, bounded purpose, and secret screening fail closed", { concurrency: false }, () => withWorkspace(root => {
  const stored = storeEvidence({ scope, source: "scope_test", trust_level: "host_observed", raw: { targetId: 9, safe: true } });
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope: { ...scope, assignment_id: "assignment-b" }, purpose: "read target", fields: ["targetId"] }), /outside the requested Assignment scope/);
  assert.throws(() => retrieveEvidence({ evidence_id: "../../secrets", scope, purpose: "read target", fields: ["targetId"] }), /Invalid evidence_id/);
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "all evidence", fields: ["targetId"] }), /Focused evidence retrieval purpose/);
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "read target", fields: ["__proto__.polluted"] }), /Invalid typed field path/);
  const other = storeEvidence({ scope, source: "other_object", trust_level: "host_observed", raw: { targetId: 10, safe: false } });
  const forgedRef = { ...stored.ref, artifact_location: other.ref.artifact_location, content_hash: other.ref.content_hash, byte_count: other.ref.byte_count };
  assert.equal(readAuthoritativeEvidence(forgedRef, scope).toString("utf8"), JSON.stringify({ targetId: 9, safe: true }));
  const objectsBefore = fs.readdirSync(path.join(root, "evidence", "objects", "sha256"), { recursive: true }).length;
  assert.throws(() => storeEvidence({ scope, source: "secret_test", trust_level: "untrusted_caller", raw: { api_key: `sk-${"a".repeat(32)}` } }), /secret screening/);
  const objectsAfter = fs.readdirSync(path.join(root, "evidence", "objects", "sha256"), { recursive: true }).length;
  assert.equal(objectsAfter, objectsBefore);
}));

test("verifier can recover a required fact deliberately absent from the deterministic model projection", { concurrency: false }, () => withWorkspace(() => {
  const raw = { ordinary: { count: 3 }, deep: { payload: { rareNeededFact: "orientation_is_reversed" } } };
  const stored = storeEvidence({ scope, source: "verifier_independence", trust_level: "authoritative_readback", verification_relevance: "authoritative", raw }, 2_048);
  assert.equal(Object.values(stored.projection.key_facts).includes("orientation_is_reversed"), false);
  const authoritative = JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString("utf8"));
  assert.equal(authoritative.deep.payload.rareNeededFact, "orientation_is_reversed");
  const focused = retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "verify exact orientation postcondition", fields: ["deep.payload.rareNeededFact"], max_bytes: 512 });
  assert.deepEqual(focused.selection, { "deep.payload.rareNeededFact": "orientation_is_reversed" });
}));

test("model request assembly enforces item and aggregate budgets with explicit omission", { concurrency: false }, () => withWorkspace(() => {
  const projections = Array.from({ length: 20 }, (_, index) => storeEvidence({ scope, source: `budget_item_${index}`, trust_level: "host_observed", raw: { count: index, values: Array.from({ length: 200 }, (__, value) => ({ value })) } }, 1_500).projection);
  const result = assembleBoundedEvidenceContext({ projections, session_id: scope.session_id, assignment_id: scope.assignment_id, model_call_id: "call-budget", budget: { item_bytes: 1_500, request_bytes: 4_000 } });
  assert.ok(result.bytes <= 4_000);
  assert.ok(result.omitted > 0);
  assert.ok(result.projections.length < projections.length);
  const valid = JSON.stringify(modelEvidenceEnvelope(result.projections, result.omitted));
  const usage = assertBoundedModelEvidencePayload([{ type: "function_call_output", output: valid }], { item_bytes: 1_500, request_bytes: 4_000 });
  assert.equal(usage.projection_count, result.projections.length);
  assert.equal(usage.referenced_raw_bytes, result.projections.reduce((sum, projection) => sum + projection.byte_count, 0));
  assert.equal(usage.projected_bytes, Buffer.byteLength(valid));
  const smuggled = JSON.stringify({ ...modelEvidenceEnvelope(result.projections, result.omitted), raw: "x".repeat(6_000) });
  assert.throws(() => assertBoundedModelEvidencePayload([{ type: "function_call_output", output: smuggled }], { item_bytes: 1_500, request_bytes: 12_000 }), /store it and send an EvidenceRef/);
}));

test("incoming native results bind canonical Assignment identity, retain images once, and send refs by default", { concurrency: false }, () => withWorkspace(() => {
  __clearServerPlannedActionsForTests();
  registerServerPlannedActions(scope.session_id, [{
    action_id: "action-1",
    method: "GET",
    path: "/revit/find-elements",
    assignment_id: scope.assignment_id,
    assignment_run_id: scope.run_id,
    attempt_id: scope.attempt_id,
    assignment_generation: scope.generation,
    target_fingerprint: "category:air-terminals"
  }]);
  const imageBytes = Buffer.from("bounded-visual-image");
  const [result] = normalizeIncomingToolResults([{
    action_id: "action-1",
    method: "GET",
    path: "/revit/find-elements",
    status: "done",
    result_json: { count: 509, elements: Array.from({ length: 509 }, (_, id) => ({ elementId: id + 1 })) },
    attachments: [{ kind: "image", mime: "image/png", data_base64: imageBytes.toString("base64") }]
  }], scope.session_id);
  assert.equal(result.evidence_refs?.length, 2);
  assert.equal(result.evidence_refs?.[0]?.assignment_id, scope.assignment_id);
  assert.equal(result.evidence_refs?.[0]?.attempt_id, scope.attempt_id);
  assert.equal(readAuthoritativeEvidence(result.evidence_refs![1]!, scope).equals(imageBytes), true);
  const rawReceipt = JSON.parse(readAuthoritativeEvidence(result.evidence_refs![0]!, scope).toString("utf8"));
  assert.equal(rawReceipt.attachments[0].data_base64, undefined);
  assert.equal(rawReceipt.attachments[0].evidence_id, result.evidence_refs![1]!.evidence_id);
  __clearServerPlannedActionsForTests();
}));
