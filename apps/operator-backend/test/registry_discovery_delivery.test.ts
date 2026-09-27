import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { storeEvidence, retrieveEvidence, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload } from "../src/evidence/model_context_budget.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { operationFulfillmentRoleForAdmissionV2, fulfillmentRoleCanCarryTaskCriteriaV2, evidenceClassForFulfillmentRoleV2 } from "../src/domain/assignment-kernel/semantic_admissibility.js";

const scope = { session_id: "registry-delivery", assignment_id: "registry-assignment", run_id: "registry-run", generation: 1 };
const source = "assignment_kernel_v2:revit_tool_registry";
const fixture = (name: "small" | "oversized") => JSON.parse(fs.readFileSync(`test/fixtures/registry-${name}-retained.json`, "utf8"));
const wrap = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const payload = (raw: any) => JSON.parse(raw.content[0].text);
function isolated(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-registry-delivery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function retained(raw: unknown, bytes = 8192) {
  return storeEvidence({ scope, source, trust_level: "host_observed", verification_relevance: "supporting", raw }, bytes);
}
function delivered(raw: unknown, projections: any[], omitted = 0, tool = "revit_tool_registry") {
  const result = adaptMcpToolCallResultToDynamicResponse(raw, { tool, projections, omitted });
  assert.equal(result.contentItems.length, 1);
  return JSON.parse((result.contentItems[0] as any).text);
}

test("retained small registry contract reaches the model intact without a second retrieval", () => isolated(() => {
  const raw = fixture("small");
  assert.equal(createHash("sha256").update(JSON.stringify(raw)).digest("hex"), "0220c6b0a5afe0fef09b04b91b3229667eb7bd2542a9a23d7225da8e75e8d34f");
  assert.equal(Buffer.byteLength(raw.content[0].text), 5165);
  const stored = retained(raw);
  const bounded = assembleBoundedEvidenceContext({ projections: [stored.projection], ...scope });
  const actual = delivered(raw, bounded.projections, bounded.omitted);
  assert.deepEqual(actual, payload(raw));
  assert.deepEqual(actual.items[0].request_schema, payload(raw).items[0].request_schema);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString()), raw);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(actual) }]);
}));

test("retained oversized registry supplies exact atomic input schema in bounded documentation", () => isolated(() => {
  const raw = fixture("oversized");
  assert.equal(createHash("sha256").update(JSON.stringify(raw)).digest("hex"), "79e7a5d25a4433c581e61363fcfb37c762833f179532fcb34a85dcb78f56a506");
  assert.equal(Buffer.byteLength(raw.content[0].text), 7576);
  const stored = retained(raw);
  const bounded = assembleBoundedEvidenceContext({ projections: [stored.projection], ...scope });
  const actual = delivered(raw, bounded.projections, bounded.omitted);
  assert.equal(actual.schema, "revit-operator.model-evidence-envelope.v1");
  const doc = actual.evidence_projections[0].tool_documentation;
  assert.ok(doc, "registry must not disappear behind a generic reference");
  assert.equal(doc.kind, "catalog");
  assert.equal(doc.completion_eligible, false);
  assert.deepEqual(doc.tools[0].request_schema, payload(raw).items[0].request_schema);
  assert.equal(doc.tools[0].path, "/revit/find-elements");
  assert.ok(doc.omitted_paths.includes("payload.items[0].response_schema"));
  assert.equal(doc.complete, false);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(actual) }]);
}));

test("registry schemas have priority over verbose description and are never truncated to fit", () => isolated(() => {
  const original = payload(fixture("small"));
  original.items[0].description = "Long explanation ".repeat(1000);
  const stored = retained(wrap(original), 4096);
  const doc = stored.projection.tool_documentation!;
  assert.ok(doc);
  assert.deepEqual(doc.tools[0]!.request_schema, original.items[0].request_schema);
  assert.equal(doc.tools[0]!.description, undefined);
  assert.ok(doc.omitted_paths.includes("payload.items[0].description"));
  assert.ok(stored.projection.projected_bytes <= 4096);

  original.items[0].request_schema = { type: "object", properties: { value: { enum: Array.from({ length: 600 }, (_, i) => `whole-choice-${i}`) } } };
  const oversized = retained(wrap(original), 4096);
  const limited = oversized.projection.tool_documentation!;
  assert.ok(limited);
  assert.equal(limited.tools[0]!.request_schema, undefined);
  assert.ok(limited.omitted_paths.includes("payload.items[0].request_schema"));
  assert.equal(limited.complete, false);
  const recovered = retrieveEvidence({ scope, evidence_id: oversized.ref.evidence_id, purpose: "Read omitted exact request schema", fields: ["payload.items[0].request_schema"], max_bytes: 32768 });
  assert.deepEqual((recovered.selection as any)["payload.items[0].request_schema"], original.items[0].request_schema);
}));

test("small registry cannot bypass item omission or whole-response omission", () => isolated(() => {
  const raw = fixture("small");
  const stored = retained(raw);
  for (const projections of [[], [stored.projection]]) {
    const actual = delivered(raw, projections, 1);
    assert.equal(actual.schema, "revit-operator.model-evidence-envelope.v1");
    assert.equal(actual.items, undefined);
  }
  const bounded = assembleBoundedEvidenceContext({ projections: [stored.projection], ...scope, budget: { item_bytes: 1024, request_bytes: 1500 } });
  assert.equal(bounded.omitted, 1);
  assert.equal(delivered(raw, bounded.projections, bounded.omitted).items, undefined);
}));

test("registry delivery does not promote caller, unrelated or ambiguous metadata", () => isolated(() => {
  const raw = fixture("small");
  for (const variation of [
    { source, trust_level: "untrusted_caller" as const, raw },
    { source: "caller:revit_tool_registry", trust_level: "host_observed" as const, raw },
    { source, trust_level: "host_observed" as const, raw: { ...raw, structuredContent: { version: "different" } } },
    { source, trust_level: "host_observed" as const, raw: { content: [...raw.content, { type: "text", text: "{}" }] } }
  ]) {
    const stored = storeEvidence({ scope, ...variation });
    assert.equal(stored.projection.tool_documentation, undefined);
    assert.equal(delivered(variation.raw, [stored.projection]).schema, "revit-operator.model-evidence-envelope.v1");
  }
  const stored = retained(raw);
  assert.equal(delivered(raw, [stored.projection], 0, "revit_call_tool").schema, "revit-operator.model-evidence-envelope.v1");
  assert.throws(() => retrieveEvidence({ scope: { ...scope, session_id: "other" }, evidence_id: stored.ref.evidence_id, purpose: "Read tool metadata", fields: ["payload.items"] }), /scope|session/i);
}));

test("registry documentation preserves discovery trust and cannot become task-result authority", () => isolated(() => {
  const raw = fixture("oversized");
  const stored = retained(raw);
  const doc = stored.projection.tool_documentation!;
  assert.ok(doc);
  assert.equal(doc.completion_eligible, false);
  assert.equal(stored.projection.trust_level, "host_observed");
  assert.equal(stored.projection.verification_relevance, "supporting");
  assert.equal(stored.projection.effect_state, null);
  assert.deepEqual(stored.projection.key_facts, {});
  assert.deepEqual(stored.projection.target_scope, []);
  assert.equal(stored.projection.inline_payload, undefined);
  const role = operationFulfillmentRoleForAdmissionV2({ purpose: "discovery", capability_id: "revit_tool_registry" });
  assert.equal(role, "supporting_control");
  assert.equal(evidenceClassForFulfillmentRoleV2(role), "control");
  assert.equal(fulfillmentRoleCanCarryTaskCriteriaV2(role), false);
}));

test("wrong versions and malformed registry rows do not acquire tool-documentation projection", () => isolated(() => {
  const original = payload(fixture("oversized"));
  for (const invalid of [
    { ...original, version: "caller.registry.v1" },
    { ...original, items: [{ ...original.items[0], path: "/admin/unfiltered" }] },
    { ...original, items: [{ ...original.items[0], required_fields: [42] }] },
    { ...original, items: Array(101).fill(original.items[0]) }
  ]) assert.equal(retained(wrap(invalid)).projection.tool_documentation, undefined);
}));

test("schema-free registry retains catalog identity without inventing input requirements", () => isolated(() => {
  const original = payload(fixture("small"));
  const item = original.items[0];
  original.items = [{ method: item.method, path: item.path, description: "d".repeat(7000) }];
  const stored = retained(wrap(original));
  const doc = stored.projection.tool_documentation!;
  assert.ok(doc);
  assert.equal(doc.tools[0]!.path, item.path);
  assert.equal(Object.hasOwn(doc.tools[0]!, "required_fields"), false);
  assert.equal(Object.hasOwn(doc.tools[0]!, "request_schema"), false);
  assert.ok(doc.omitted_paths.includes("payload.items[0].request_schema"));
  assert.equal(doc.complete, false);
}));

test("empty registry pages remain readable while errors retain their correction contract", () => isolated(() => {
  const original = payload(fixture("small"));
  const empty = wrap({ ...original, items: [], returned: 0 });
  const stored = retained(empty);
  assert.deepEqual(delivered(empty, [stored.projection]), payload(empty));
  const raw = { ...wrap({ error: "registry_unavailable", message: "Catalog refresh failed" }), isError: true };
  const failure = retained(raw);
  assert.equal(failure.projection.tool_documentation, undefined);
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_tool_registry", projections: [failure.projection] });
  assert.equal(response.success, false);
  assert.deepEqual(JSON.parse((response.contentItems[0] as any).text), payload(raw));
}));
