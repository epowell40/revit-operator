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
import { __closeForTests, upsertStepPlanned } from "../src/memory/sqlite_store.js";

function withWorkspace<T>(fn: (root: string) => T): T {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evidence-v1-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { return fn(root); }
  finally {
    __closeForTests();
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

test("certified MCP JSON text projects a complete bounded identity inventory instead of hiding it as opaque text", { concurrency: false }, () => withWorkspace(() => {
  const items = [
    { elementId: 101, category: "Air Terminals", familyName: "Supply Diffuser", typeName: "12 x 12" },
    { elementId: 102, category: "Air Terminals", familyName: "Supply Diffuser", typeName: "12 x 12" },
    { elementId: 103, category: "Air Terminals", familyName: "Return Grille", typeName: "16 x 4" },
    { elementId: 104, category: "Air Terminals", familyName: "Return Grille", typeName: "16 x 4" },
    { elementId: 105, category: "Air Terminals", familyName: "Exhaust Cap", typeName: "4 DIA" }
  ];
  const raw = {
    content: [{
      type: "text",
      text: JSON.stringify({ status: "Ok", count: items.length, itemsComplete: true, scanCapReached: false, items })
    }]
  };
  const stored = storeEvidence({
    scope,
    source: "codex_dynamic_mcp:revit_call_tool",
    media_type: "application/json",
    trust_level: "authoritative_native",
    raw
  }, 4_096);

  assert.equal(stored.projection.key_counts["inventory.total"], 5);
  assert.equal(stored.projection.key_counts["inventory.identity_rows"], 5);
  assert.equal(stored.projection.key_counts["inventory.family_type::Supply Diffuser | 12 x 12"], 2);
  assert.equal(stored.projection.key_counts["inventory.family_type::Return Grille | 16 x 4"], 2);
  assert.equal(stored.projection.key_counts["inventory.family_type::Exhaust Cap | 4 DIA"], 1);
  assert.equal(stored.projection.key_facts["inventory.complete"], true);
  assert.equal(stored.projection.key_facts["inventory.grouping"], "family_name + type_name");
  assert.ok(stored.projection.projected_bytes <= 4_096);
  const fields = retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "confirm the complete native inventory count",
    fields: ["payload.count", "payload.itemsComplete"],
    max_bytes: 1_024
  });
  assert.deepEqual(fields.selection, { "payload.count": 5, "payload.itemsComplete": true });
  const rows = retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "inspect two family and type identity rows",
    item_range: { path: "payload.items", start: 1, count: 2 },
    max_bytes: 2_048
  });
  assert.deepEqual(rows.selection, items.slice(1, 3));
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString("utf8")), raw);
}));

test("normalized native payload retrieval honors the advertised payload root selector", { concurrency: false }, () => withWorkspace(() => {
  const items = [{
    textNoteId: 1_478_627,
    uniqueId: "0fd05cf9-f97f-46ff-8cc3-99ae511f929f-00168fe3",
    text: "Chase for Electrical Conduit\r",
    ownerViewId: 1_363_433,
    ownerViewName: "L4"
  }];
  const normalizedNativePayload = {
    ok: true,
    scope: "active_project",
    itemsComplete: true,
    elementIds: [1_478_627],
    textSamples: ["Chase for Electrical Conduit\r"],
    items
  };
  const stored = storeEvidence({
    scope,
    source: "assignment_kernel_v2:revit_call_tool",
    media_type: "application/json",
    trust_level: "authoritative_native",
    raw: normalizedNativePayload
  }, 4_096);

  const fields = retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "bind the exact TextNote identity for a conditional preview",
    fields: ["payload.itemsComplete", "payload.elementIds", "payload.items"],
    max_bytes: 4_096
  });
  assert.deepEqual(fields.selection, {
    "payload.itemsComplete": true,
    "payload.elementIds": [1_478_627],
    "payload.items": items
  });
  const page = retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "retrieve the single TextNote row for a conditional preview",
    item_range: { path: "payload.items", start: 0, count: 1 },
    max_bytes: 4_096
  });
  assert.deepEqual(page.selection, items);
  assert.equal(page.complete, true);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString("utf8")), normalizedNativePayload);
}));

test("Candidate 63 exact target retrieval stays bounded and rejects ambiguous selector contracts", { concurrency: false }, () => withWorkspace(() => {
  const selectedId = 1_478_627;
  const items = Array.from({ length: 50 }, (_, index) => ({
    textNoteId: 1_478_604 + index,
    elementId: 1_478_604 + index,
    uniqueId: `candidate63-text-note-${index.toString().padStart(2, "0")}`,
    text: index === 0
      ? `Unrelated prose containing the partial digits ${selectedId} must not establish target identity.`
      : `Candidate 63 TextNote ${index}`,
    textNormalized: `candidate 63 textnote ${index}`,
    textTypeId: 10_352,
    ownerViewId: 1_363_433,
    ownerViewName: "L4",
    diagnosticPadding: "x".repeat(720)
  }));
  const selected = items.find(item => item.elementId === selectedId)!;
  const stored = storeEvidence({
    scope,
    source: "candidate63:find-text-notes",
    media_type: "application/json",
    trust_level: "authoritative_native",
    verification_relevance: "required",
    raw: {
      ok: true,
      scope: "active_project",
      itemsComplete: true,
      elementIds: items.map(item => item.elementId),
      textSamples: items.slice(0, 20).map(item => item.text),
      items
    }
  }, 4_096);
  assert.ok(stored.ref.byte_count > 30_000);

  assert.throws(() => retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "Read the exact identity, text, type, and owner-view facts for the selected project TextNote candidate.",
    fields: ["payload.items", "payload.count", "payload.total", "payload.truncated"],
    target_subset: [String(selectedId)],
    max_bytes: 8_000
  }), /exactly one active selector/);

  const focused = retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "Read the exact identity, text, type, and owner-view facts for the selected project TextNote candidate.",
    target_subset: [String(selectedId)],
    max_bytes: 30_000
  });
  assert.deepEqual(focused.selection, {
    "payload.elementIds": [selectedId],
    "payload.items": [selected]
  });
  assert.ok(focused.returned_bytes < 2_000);
  assert.equal(focused.complete, false);

  for (const target of ["147862", "14786270", "missing-target"]) {
    assert.throws(() => retrieveEvidence({
      evidence_id: stored.ref.evidence_id,
      scope,
      purpose: "Reject a target which has no exact identity match.",
      target_subset: [target],
      max_bytes: 4_096
    }), /did not match exact target identities/);
  }
  assert.throws(() => retrieveEvidence({
    evidence_id: stored.ref.evidence_id,
    scope,
    purpose: "Reject a partially matched multi-target request atomically.",
    target_subset: [String(selectedId), "missing-target"],
    max_bytes: 4_096
  }), /missing-target/);
}));

test("projection-advertised dotted selection keys remain retrievable from a stored retrieval result", { concurrency: false }, () => withWorkspace(() => {
  const items = [
    { textNoteId: 1_421_361, text: "Autodesk Revit sample project\r" },
    { textNoteId: 1_422_186, text: "Electrical Transformer Pad\r" },
    { textNoteId: 1_422_206, text: "Chase for Electrical Conduits\r" }
  ];
  const original = storeEvidence({
    scope,
    source: "assignment_kernel_v2:revit_call_tool",
    media_type: "application/json",
    trust_level: "authoritative_native",
    raw: { ok: true, itemsComplete: true, items }
  }, 4_096);
  const firstRetrieval = retrieveEvidence({
    evidence_id: original.ref.evidence_id,
    scope,
    purpose: "select exact TextNote candidates for a conditional preview",
    fields: ["payload.items"],
    max_bytes: 4_096
  });
  const storedRetrieval = storeEvidence({
    scope,
    source: "assignment_kernel_v2:operator_retrieve_evidence",
    media_type: "application/json",
    trust_level: "host_observed",
    raw: { content: [{ type: "text", text: JSON.stringify({ ok: true, result: firstRetrieval }) }] }
  }, 4_096);

  const advertisedPath = "payload.result.selection.payload.items";
  assert.equal(storedRetrieval.projection.key_counts[`${advertisedPath}.length`], items.length);
  const secondRetrieval = retrieveEvidence({
    evidence_id: storedRetrieval.ref.evidence_id,
    scope,
    purpose: "read the first two projected TextNote candidates",
    item_range: { path: advertisedPath, start: 0, count: 2 },
    max_bytes: 4_096
  });
  assert.deepEqual(secondRetrieval.selection, items.slice(0, 2));
  assert.equal(secondRetrieval.complete, false);
}));

test("nested inventory projection normalizes snake-case identity fields", { concurrency: false }, () => withWorkspace(() => {
  const raw = { content: [{ type: "text", text: JSON.stringify({
    count: 3,
    itemsComplete: true,
    items: [
      { element_id: 1, category_name: "Mechanical Equipment", family_name: "Fan Coil", type_name: "Small" },
      { element_id: 2, category_name: "Mechanical Equipment", family_name: "Fan Coil", type_name: "Small" },
      { element_id: 3, category_name: "Mechanical Equipment", family_name: "Fan Coil", type_name: "Large" }
    ]
  }) }] };
  const projection = storeEvidence({ scope, source: "neighbor:snake-case-inventory", trust_level: "authoritative_native", raw }).projection;
  assert.equal(projection.key_counts["inventory.family_type::Fan Coil | Small"], 2);
  assert.equal(projection.key_counts["inventory.family_type::Fan Coil | Large"], 1);
  assert.equal(projection.key_counts["inventory.category::Mechanical Equipment"], 3);
  assert.equal(projection.key_facts["inventory.complete"], true);
}));

test("structured-content and direct element inventories project equivalent typed family/type counts", { concurrency: false }, () => withWorkspace(() => {
  const payload = {
    count: 4,
    truncated: false,
    elements: [
      { id: 1, category: "Doors", family: "Single Flush", type: "36 x 84" },
      { id: 2, category: "Doors", family: "Single Flush", type: "36 x 84" },
      { id: 3, category: "Doors", family: "Double Flush", type: "72 x 84" },
      { id: 4, category: "Doors", family: "Double Flush", type: "72 x 84" }
    ]
  };
  const direct = storeEvidence({ scope, source: "neighbor:direct-inventory", trust_level: "authoritative_native", raw: payload }).projection;
  const structured = storeEvidence({ scope, source: "neighbor:structured-content", trust_level: "authoritative_native", raw: {
    structuredContent: JSON.stringify(payload)
  } }).projection;
  for (const projection of [direct, structured]) {
    assert.equal(projection.key_counts["inventory.total"], 4);
    assert.equal(projection.key_counts["inventory.family_type::Single Flush | 36 x 84"], 2);
    assert.equal(projection.key_counts["inventory.family_type::Double Flush | 72 x 84"], 2);
    assert.equal(projection.key_facts["inventory.complete"], true);
  }
}));

test("incomplete nested inventory exposes useful counts without claiming completeness", { concurrency: false }, () => withWorkspace(() => {
  const raw = { content: [{ type: "text", text: JSON.stringify({
    count: 12,
    itemsComplete: false,
    scanCapReached: true,
    items: [
      { elementId: 1, category: "Lighting Fixtures", familyName: "Pendant", typeName: "Round" },
      { elementId: 2, category: "Lighting Fixtures", familyName: "Pendant", typeName: "Round" }
    ]
  }) }] };
  const projection = storeEvidence({ scope, source: "negative:partial-inventory", trust_level: "authoritative_native", raw }).projection;
  assert.equal(projection.key_counts["inventory.total"], 12);
  assert.equal(projection.key_counts["inventory.identity_rows"], 2);
  assert.equal(projection.key_facts["inventory.complete"], false);
}));

test("ordinary prose and malformed JSON remain opaque and cannot manufacture inventory truth", { concurrency: false }, () => withWorkspace(() => {
  for (const [index, text] of ["509 devices in seven groups", '{"count":509,"items":['].entries()) {
    const projection = storeEvidence({ scope, source: `unrelated:opaque-text-${index}`, trust_level: "host_observed", raw: {
      content: [{ type: "text", text }]
    } }).projection;
    assert.equal(projection.key_counts["inventory.total"], undefined);
    assert.equal(projection.key_facts["inventory.complete"], undefined);
  }
}));

test("MCP errors and contradictory structured payloads cannot manufacture projected or retrievable inventory truth", { concurrency: false }, () => withWorkspace(() => {
  const convincing = { count: 2, itemsComplete: true, items: [
    { elementId: 1, familyName: "Forged", typeName: "A" },
    { elementId: 2, familyName: "Forged", typeName: "A" }
  ] };
  const inputs = [
    { isError: true, content: [{ type: "text", text: JSON.stringify(convincing) }] },
    { structuredContent: convincing, content: [{ type: "text", text: JSON.stringify({ ...convincing, count: 999 }) }] },
    { content: [
      { type: "text", text: JSON.stringify(convincing) },
      { type: "text", text: JSON.stringify(convincing) }
    ] },
    { payload: convincing, content: [{ type: "text", text: "not structured JSON" }] }
  ];
  for (const [index, raw] of inputs.entries()) {
    const stored = storeEvidence({ scope, source: `negative:mcp-envelope-${index}`, trust_level: "host_observed", raw });
    assert.equal(stored.projection.key_counts["inventory.total"], undefined);
    assert.equal(stored.projection.key_facts["inventory.complete"], undefined);
    const focused = retrieveEvidence({
      evidence_id: stored.ref.evidence_id,
      scope,
      purpose: "confirm that a conflicting MCP envelope has no selectable payload",
      fields: ["payload.count"],
      max_bytes: 512
    });
    assert.deepEqual(focused.selection, { "payload.count": null });
  }
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
  assert.equal(stored.projection.generation, scope.generation);
  assert.equal(stored.projection.retrieval.tool_name, "operator_retrieve_evidence");
  assert.ok(stored.projection.retrieval.selector_forms.includes("fields"));
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope: { ...scope, assignment_id: "assignment-b" }, purpose: "read target", fields: ["targetId"] }), /outside the requested Assignment scope/);
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope: { ...scope, generation: scope.generation! + 1 }, purpose: "read target", fields: ["targetId"] }), /outside the requested Assignment generation/);
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
  const plannedAction = {
    action_id: "action-1",
    method: "GET",
    path: "/revit/find-elements",
    request_effect: "read" as const,
    assignment_id: scope.assignment_id,
    assignment_run_id: scope.run_id,
    attempt_id: scope.attempt_id,
    assignment_generation: scope.generation,
    target_fingerprint: "category:air-terminals"
  };
  registerServerPlannedActions(scope.session_id, [plannedAction]);
  upsertStepPlanned(scope.session_id, "message-action-1", "inventory", [plannedAction]);
  __clearServerPlannedActionsForTests();
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
