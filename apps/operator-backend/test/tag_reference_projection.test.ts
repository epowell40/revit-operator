import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectTagReferences } from "../src/evidence/tag_reference_projection.js";
import { projectEvidence } from "../src/evidence/evidence_projection.js";
import { storeEvidence, retrieveEvidence, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload } from "../src/evidence/model_context_budget.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { EVIDENCE_REF_SCHEMA, type EvidenceRefV1 } from "../src/evidence/evidence_ref.js";

const scope = { session_id: "tag-table", assignment_id: "tag-assignment", run_id: "tag-run", generation: 1 };
const ref: EvidenceRefV1 = { schema: EVIDENCE_REF_SCHEMA, evidence_id: "evidence:tag-table", content_hash: "sha256:tag-table",
  byte_count: 1, media_type: "application/json", source: "native:element-summary", trust_level: "authoritative_native",
  ...scope, attempt_id: "read", target_scope: [], bounded_summary: "", key_typed_facts: {}, artifact_location: "fixture",
  redaction_status: "not_needed", secret_screening_status: "passed", created_at_utc: "2026-10-20T00:00:00Z",
  verification_relevance: "supporting", relationships: [] };

function fixture(size = 116): any {
  return { result: Array.from({ length: size }, (_, i) => ({ id: 10000 + i, found: true, uniqueId: `tag-uid-${i}`,
    name: "Long unused element description ".repeat(30), className: "IndependentTag", category: "Equipment Tags",
    typeId: 500, familyName: "Equipment Tag", typeName: "Standard", boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
    tagReferences: { schema: "operator.tag_references.v1", applicable: true, complete: true, orphaned: false,
      enumerationFailed: false, totalReferences: 1, returned: 1, unresolvedReferences: 0, truncated: false, limit: 16,
      ownerView: { elementId: i < size - 12 ? 50 : 60, uniqueId: i < size - 12 ? "other-view" : "target-view",
        name: i < size - 12 ? "Other View" : "Target View", phaseId: 2, phaseName: "New Construction" },
      items: [{ identityKey: `host:${20000 + i}`, resolved: true, documentScope: "host", linkInstanceId: null,
        elementId: 20000 + i, uniqueId: `subject-uid-${i}`, name: "Referenced equipment description ".repeat(20),
        familyName: "Equipment", typeName: "Typical", phase: { available: true, hasPhases: true,
          createdPhaseId: 2, createdPhaseName: "New Construction", demolishedPhaseId: null, demolishedPhaseName: null,
          statusInOwnerViewPhase: "New", statusError: null }, hostViewPhaseComparable: true, hostViewPhaseLimitation: null }], errors: [] }
  })) };
}
function unpack(table: any) {
  return table.rows.map(([tagId, type, view, state, refs]: any[], index: number) => {
    const v = view === null ? null : table.owner_views[view];
    return { index, tagId, type: type === null ? null : table.tag_types[type], view: v === null ? null : {
      ...(v[3] & 1 ? { elementId: v[0] } : {}), ...(v[3] & 2 ? { name: v[1] } : {}),
      ...(v[2] === null ? {} : table.owner_phases[v[2]]) },
      state: table.reference_states[state], refs: refs.map(([elementId, facts]: any[]) => ({ elementId, ...table.reference_facts[facts] })) };
  });
}

test("all returned tag IDs, ownership, types and native subject phases fit the existing item budget", () => {
  const raw = fixture(), original = structuredClone(raw);
  const scopedRef = { ...ref, target_scope: Array.from({ length: 32 }, (_, i) => `retained-native-identity-00000000-0000-0000-${i.toString().padStart(12, "0")}`) };
  const beforeRef = structuredClone(scopedRef), p = projectEvidence(scopedRef, raw, 8192);
  const table: any = p.inline_payload;
  assert.equal(table.schema, "revit-operator.tag-reference-presentation/v1");
  assert.equal(table.coverage.returned_rows_complete, true); assert.equal(table.coverage.whole_project_coverage_proven, false);
  assert.equal(table.rows.length, 116); assert.equal(p.truncated, true); assert(p.projected_bytes <= 8192);
  assert.deepEqual(table.evidence_scope_display, { displayed_keys: 4, retained_keys: 32, complete: false });
  assert.deepEqual(scopedRef, beforeRef); assert.equal(p.evidence_id, scopedRef.evidence_id); assert.equal(p.content_hash, scopedRef.content_hash);
  const rows = unpack(table); assert.deepEqual(rows.map((r: any) => r.tagId), raw.result.map((r: any) => r.id));
  assert.deepEqual(rows.map((r: any) => r.index), raw.result.map((_: any, i: number) => i));
  assert.equal(rows.filter((r: any) => r.view.elementId === 60).length, 12);
  for (const [i, row] of rows.entries()) {
    const native = raw.result[i], { uniqueId: _viewUid, ...view } = native.tagReferences.ownerView; assert.deepEqual(row.view, view);
    assert.deepEqual(row.type, { typeId: native.typeId, familyName: native.familyName, typeName: native.typeName });
    assert.equal(row.refs[0].elementId, native.tagReferences.items[0].elementId);
    assert.deepEqual(row.refs[0].phase, native.tagReferences.items[0].phase);
    assert.equal(row.refs[0].hostViewPhaseComparable, true);
  }
  assert.deepEqual(raw, original);
});

test("local and linked copies of the same ID retain distinct namespace and unproved phase mapping", () => {
  const raw = fixture(1), tag = raw.result[0].tagReferences;
  const linked = structuredClone(tag.items[0]); linked.documentScope = "linked"; linked.linkInstanceId = 90;
  linked.identityKey = "link:90:20000"; linked.hostViewPhaseComparable = false;
  linked.hostViewPhaseLimitation = "linked_phase_mapping_not_evaluated"; linked.phase.statusInOwnerViewPhase = null;
  tag.items.push(linked); tag.returned = tag.totalReferences = 2;
  const rows = unpack(projectTagReferences(raw, 8192));
  assert.equal(rows[0].refs.length, 2); assert.equal(rows[0].refs[0].elementId, rows[0].refs[1].elementId);
  assert.equal(rows[0].refs[0].documentScope, "host"); assert.equal(rows[0].refs[1].linkInstanceId, 90);
  assert.equal(rows[0].refs[1].hostViewPhaseComparable, false); assert.equal(rows[0].refs[1].phase.statusInOwnerViewPhase, null);
  assert.match(rows[0].refs[1].hostViewPhaseLimitation, /not_evaluated/);
});

test("orphan, unresolved, unavailable phase and truncated coverage survive folding without inferred eligibility", () => {
  const raw = fixture(3);
  const first = raw.result[0].tagReferences; first.orphaned = true; first.complete = false;
  const second = raw.result[1].tagReferences; second.items[0].resolved = false; second.unresolvedReferences = 1;
  second.complete = false; second.items[0].reason = "referenced_element_unavailable"; delete second.items[0].phase;
  const third = raw.result[2].tagReferences; third.complete = false; third.totalReferences = 2; third.truncated = true;
  third.items[0].phase = { available: false, error: "phase_read_failed:InvalidOperationException" };
  const rows = unpack(projectTagReferences(raw, 8192));
  assert.equal(rows[0].state.orphaned, true); assert.equal(rows[0].state.complete, false);
  assert.equal(rows[1].refs[0].resolved, false); assert.equal(rows[1].refs[0].reason, "referenced_element_unavailable");
  assert.equal(Object.hasOwn(rows[1].refs[0], "phase"), false);
  assert.equal(rows[2].state.truncated, true); assert.equal(rows[2].state.totalReferences, 2);
  assert.equal(rows[2].refs[0].phase.available, false);
});

test("missing elements and non-tag rows remain visible rather than becoming a proved empty target set", () => {
  const raw = fixture(3); raw.result[1] = { id: 10001, found: false, error: "Element not found" };
  raw.result[2].tagReferences = { schema: "operator.tag_references.v1", applicable: false, complete: false, reason: "element_is_not_an_independent_tag" };
  const rows = unpack(projectTagReferences(raw, 8192)); assert.equal(rows.length, 3);
  assert.equal(rows[1].state.found, false); assert.equal(rows[1].type, null);
  assert.equal(rows[2].state.applicable, false); assert.equal(rows[2].state.complete, false);
});

test("byte limited presentations expose a source cursor and never claim all rows or the whole project", () => {
  const raw = fixture(200);
  for (const [i, row] of raw.result.entries()) row.tagReferences.ownerView = { elementId: i + 1, name: "Unique view ".repeat(30) + i, phaseId: 2 };
  const p = projectEvidence(ref, raw, 8192), table: any = p.inline_payload;
  assert.equal(table.schema, "revit-operator.tag-reference-presentation/v1");
  assert(table.rows.length > 0 && table.rows.length < 200); assert.equal(table.coverage.returned_rows_complete, false);
  assert.equal(table.coverage.native_returned_rows, 200); assert.equal(table.source_retrieval.next_start, table.rows.length);
  assert.equal(table.source_retrieval.path, "payload.result"); assert.equal(p.truncated, true); assert(p.projected_bytes <= 8192);
});

test("malformed identities and contradictory native coverage do not produce a convincing compact cohort", () => {
  for (const mutate of [
    (r: any) => { r.result.push(structuredClone(r.result[0])); },
    (r: any) => { r.result[0].tagReferences.returned = 2; },
    (r: any) => { r.result[0].tagReferences.complete = false; },
    (r: any) => { r.result[0].tagReferences.items[0].identityKey = "link:90:20000"; },
    (r: any) => { r.result[0].tagReferences.items[0].elementId = Number.MAX_SAFE_INTEGER + 1; }
  ]) { const raw = fixture(1); mutate(raw); assert.equal(projectTagReferences(raw, 8192), null); }
  assert.equal(projectTagReferences({ result: [] }, 8192), null);
  assert.equal(projectTagReferences(fixture(), 128), null);
});

test("untrusted or conflicting MCP data cannot gain native table authority", () => {
  const raw = fixture();
  assert.equal((projectEvidence({ ...ref, trust_level: "host_observed" }, raw).inline_payload as any)?.schema, undefined);
  const conflict = { structuredContent: raw, content: [{ type: "text", text: JSON.stringify(fixture(2)) }] };
  assert.equal((projectEvidence(ref, conflict).inline_payload as any)?.schema, undefined);
});

test("native storage, provider adapter and exact source retrieval retain bindings and original evidence", t => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT, workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-tag-table-"));
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  t.after(() => { __closeForTests(); if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous; fs.rmSync(workspace, { recursive: true, force: true }); });
  const payload = fixture(), raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw }, 8192);
  const before = readAuthoritativeEvidence(stored.ref, scope), budget = { item_bytes: 8192, request_bytes: 8704 };
  const context = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection], budget });
  const delivered = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", ...context });
  const output = (delivered.contentItems[0] as any).text, envelope = JSON.parse(output), projection = envelope.evidence_projections[0];
  assert.equal(projection.inline_payload.rows.length, 116); assert.equal(projection.assignment_id, scope.assignment_id);
  assert.equal(projection.run_id, scope.run_id); assert.equal(projection.content_hash, stored.ref.content_hash);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output }], budget);
  const read = retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Check exact target identity and native phase",
    item_range: { path: "payload.result", start: 104, count: 12, fields: ["id", "uniqueId", "tagReferences.items[0].phase"] }, max_bytes: 8192 });
  assert.equal(read.pagination?.returned_count, 12); assert.equal((read.selection as any[])[0].values.uniqueId, "tag-uid-104");
  assert.throws(() => retrieveEvidence({ scope: { ...scope, run_id: "other-run" }, evidence_id: stored.ref.evidence_id,
    purpose: "Try a foreign run", fields: ["payload.result"] }), /scope|run/i);
  assert.throws(() => retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Unreviewed IDs are not target identities",
    target_subset: ["10104"], max_bytes: 8192 }), /did not match exact target identities/);
  assert.deepEqual(readAuthoritativeEvidence(stored.ref, scope), before); assert.deepEqual(JSON.parse(before.toString()), raw);
});
