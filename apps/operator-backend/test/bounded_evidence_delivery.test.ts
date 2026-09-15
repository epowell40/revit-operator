import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeEvidence, retrieveEvidence, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload, modelEvidenceEnvelope } from "../src/evidence/model_context_budget.js";
import { adaptMcpToolCallResultToDynamicResponse, attachDynamicObservationContext } from "../src/brains/codex_dynamic_result_adapter.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

const scope = { session_id: "bounded-result", assignment_id: "assignment-bounded", run_id: "run-bounded", generation: 1 };
function isolated(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-bounded-delivery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("small native capture arrives intact through store, budget and model adapter without another retrieval", () => isolated(() => {
  const payload = { sheetNumber: "M102", sheetViewId: 1363562, region: "titleblock", export: { viewName: "HVAC L2 - Team Review", mapping: null }, warnings: ["Sheet mapping unavailable"] };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw });
  const bounded = assembleBoundedEvidenceContext({ projections: [stored.projection], ...scope });
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", projections: bounded.projections, omitted: bounded.omitted });
  const envelope = JSON.parse((response.contentItems[0] as any).text);
  assert.deepEqual(envelope.evidence_projections[0].inline_payload, payload);
  assert.equal(envelope.evidence_projections[0].content_hash, stored.ref.content_hash);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString()), raw);
  const observation = { schema: "revit-operator.model-observation-index/v2", observations: [{ observation_id: "obsv2_capture", evidence_class: "task_result" }] };
  attachDynamicObservationContext(response, "revit_call_tool", JSON.stringify(observation));
  assert.deepEqual(JSON.parse((response.contentItems.at(-1) as any).text), observation);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(envelope) }]);
}));

test("large, ambiguous and untrusted results retain references and cannot smuggle a direct payload", () => isolated(() => {
  const large = { items: Array.from({ length: 1000 }, (_, id) => ({ id, name: "Long equipment designation" })) };
  for (const [raw, trust_level] of [
    [large, "authoritative_native"],
    [{ content: [{ type: "text", text: '{"name":"A"}' }, { type: "text", text: '{"name":"B"}' }] }, "authoritative_native"],
    [{ content: [{ type: "text", text: '{"name":"A"}' }], structuredContent: { name: "B" } }, "authoritative_native"],
    [{ status: "complete", name: "caller-asserted" }, "untrusted_caller"]
  ] as const) {
    const stored = storeEvidence({ scope, source: "bounded:neighbor", trust_level, raw });
    assert.equal((stored.projection as any).inline_payload, undefined);
  }
  const stored = storeEvidence({ scope, source: "bounded:large", trust_level: "authoritative_native", raw: large });
  assert.equal((retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope, purpose: "Read the first two equipment rows", item_range: { path: "items", start: 0, count: 2 } }).selection as any[]).length, 2);
  assert.throws(() => retrieveEvidence({ evidence_id: stored.ref.evidence_id, scope: { ...scope, session_id: "other" }, purpose: "Wrong owner", fields: ["items"] }), /scope|session/i);
}));

test("inline payload is all-or-nothing within UTF-8 item and whole-response budgets", () => isolated(() => {
  const raw = { label: "風".repeat(400), status: "read", actualNull: null };
  const stored = storeEvidence({ scope, source: "bounded:utf8", trust_level: "authoritative_native", raw }, 1600);
  assert.equal((stored.projection as any).inline_payload, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.projection)) <= 1600);
  const full = storeEvidence({ scope, source: "bounded:utf8-full", trust_level: "authoritative_native", raw }, 8192);
  assert.deepEqual((full.projection as any).inline_payload, raw);
  const bounded = assembleBoundedEvidenceContext({ projections: [full.projection, full.projection], ...scope, budget: { item_bytes: 8192, request_bytes: 3500 } });
  assert.ok(Buffer.byteLength(JSON.stringify(modelEvidenceEnvelope(bounded.projections, bounded.omitted))) <= 3500);
  assert.ok(bounded.omitted > 0);
}));

test("bounded discovery instructions are directly readable but oversized and omitted responses stay projected", () => isolated(() => {
  const payload = { matches: [{ method: "POST", path: "/revit/activate-view", description: "Open an exact view; this does not modify model data." }] };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const projection = storeEvidence({ scope, source: "assignment_kernel_v2:revit_search_tools", trust_level: "host_observed", raw }).projection;
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_search_tools", projections: [projection], omitted: 0 });
  assert.deepEqual(JSON.parse((response.contentItems[0] as any).text), payload);
  for (const context of [ { projections: [], omitted: 1 }, { projections: [projection], omitted: 1 } ]) {
    const blocked = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_search_tools", ...context });
    assert.equal(JSON.parse((blocked.contentItems[0] as any).text).schema, "revit-operator.model-evidence-envelope.v1");
  }
  const oversized = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: JSON.stringify({ documentation: "x".repeat(30_000) }) }] }, { tool: "revit_tool_doc", projections: [projection], omitted: 0 });
  assert.equal(JSON.parse((oversized.contentItems[0] as any).text).schema, "revit-operator.model-evidence-envelope.v1");
}));
