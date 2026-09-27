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

test("failed native reference checks reach the dynamic model adapter as unresolved beside known pairs", () => isolated(() => {
  const payload = JSON.parse(fs.readFileSync("test/fixtures/connector-reference-check-failure.json", "utf8"));
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw });
  const bounded = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection] });
  const delivered = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", ...bounded });
  const text = (delivered.contentItems[0] as any).text;
  const graph = JSON.parse(text).evidence_projections[0].connector_graph;
  assert.deepEqual(graph.lists.reciprocal_edges, [[10, 0, 20, 0, 0]]);
  assert(graph.lists.unresolved_references.some((r: any[]) => r[0] === 10 && r[2] === 30 && r[4] === "native_connection_check_unknown"));
  assert.equal(graph.totals.excluded_references, 0);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: text }]);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString()), raw);
}));

test("connector topology crosses native storage, existing budget and dynamic adapter with raw paging intact", () => isolated(() => {
  const payload = { status: "Ok", filter: "allConnectors", requestedCount: 160, scannedElementCount: 160, failedElementCount: 0, matchedElementCount: 160, totalScannedConnectorCount: 160, physicallyConnectedConnectorCount: 0, openPhysicalConnectorCount: 160, connectorScanTruncatedElementCount: 0,
    results: Array.from({ length: 160 }, (_, i) => ({ id: i + 1, ok: true, connectorCount: 1, returnedConnectorCount: 1, connectorScanTruncated: false, connectors: [{ connectorId: 0, connectorIdBasis: "revit_native_connector_id", domain: "DomainHvac", connectorType: "End", origin: [i, 0, 0], isConnected: false, physicalConnectionCount: 0, isPhysicallyConnected: false, connectedTo: [], physicalConnectedTo: [], coordinateSystem: { sourceDetail: "retained native detail".repeat(160) } }] })) };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  for (const trust_level of ["authoritative_native", "host_observed"] as const) {
    const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level, raw }, 8192);
    const budget = { item_bytes: 8192, request_bytes: 8704 };
    const bounded = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection], budget });
    const delivered = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", projections: bounded.projections, omitted: bounded.omitted });
    const text = (delivered.contentItems[0] as any).text;
    const envelope = JSON.parse(text), projection = envelope.evidence_projections[0];
    assert.equal(delivered.success, true); assert.equal(envelope.omitted, 0);
    assert.equal(projection.content_hash, stored.ref.content_hash); assert.equal(projection.evidence_id, stored.ref.evidence_id);
    assert.equal(projection.trust_level, trust_level); assert.equal(projection.inline_payload, undefined);
    if (trust_level === "authoritative_native") {
      assert.equal(projection.connector_graph.totals.owner_components, 160);
      assert.equal(projection.connector_graph.totals.open_hvac_endpoints, 160);
      assert.equal(projection.connector_graph.lists_complete, false);
      assert.equal(projection.connector_graph.coverage.native_reference_scan_complete, null);
    } else assert.equal(projection.connector_graph, undefined);
    assert(Buffer.byteLength(text) <= budget.request_bytes);
    assertBoundedModelEvidencePayload([{ type: "function_call_output", output: text }], budget);
    assert.deepEqual(JSON.parse(readAuthoritativeEvidence(stored.ref, scope).toString()), raw);
    const retrieved = retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Read omitted connector geometry", item_range: { path: "payload.results", start: 159, count: 1 }, max_bytes: 8192 });
    const result = { content: [{ type: "text", text: JSON.stringify({ ok: true, result: retrieved }) }] };
    const expanded = adaptMcpToolCallResultToDynamicResponse(result, { tool: "operator_retrieve_evidence", projections: [stored.projection] });
    assert.deepEqual(JSON.parse((expanded.contentItems[0] as any).text).result.selection[0], payload.results[159]);
    const omitted = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection], budget: { item_bytes: 8192, request_bytes: 1024 } });
    const omittedDelivery = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", projections: omitted.projections, omitted: omitted.omitted });
    assert.equal(JSON.parse((omittedDelivery.contentItems[0] as any).text).omitted, 1);
  }
}));

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

for (const discoveryTool of ["revit_search_tools", "revit_tool_doc", "operator_discover_capabilities"]) test(`bounded ${discoveryTool} instructions are directly readable but oversized and omitted responses stay projected`, () => isolated(() => {
  const payload = { matches: [{ method: "POST", path: "/revit/activate-view", description: "Open an exact view; this does not modify model data." }] };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const projection = storeEvidence({ scope, source: "assignment_kernel_v2:revit_search_tools", trust_level: "host_observed", raw }).projection;
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: discoveryTool, projections: [projection], omitted: 0 });
  assert.deepEqual(JSON.parse((response.contentItems[0] as any).text), payload);
  for (const context of [ { projections: [], omitted: 1 }, { projections: [projection], omitted: 1 } ]) {
    const blocked = adaptMcpToolCallResultToDynamicResponse(raw, { tool: discoveryTool, ...context });
    assert.equal(JSON.parse((blocked.contentItems[0] as any).text).schema, "revit-operator.model-evidence-envelope.v1");
  }
  const oversized = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: JSON.stringify({ documentation: "x".repeat(30_000) }) }] }, { tool: discoveryTool, projections: [projection], omitted: 0 });
  assert.equal(JSON.parse((oversized.contentItems[0] as any).text).schema, "revit-operator.model-evidence-envelope.v1");
}));

test("C48 oversized partial catalogue reaches the working model through projection rather than disappearing into a reference", () => isolated(() => {
  const raw=JSON.parse(fs.readFileSync("test/fixtures/c48-partial-tool-catalog.json","utf8"));
  assert.equal(Buffer.byteLength(raw.content[0].text),7299,"exercise the actual oversized delivery path");
  const stored=storeEvidence({scope,source:"assignment_kernel_v2:revit_search_tools",trust_level:"host_observed",raw});
  const budget=assembleBoundedEvidenceContext({projections:[stored.projection],...scope});
  const delivered=adaptMcpToolCallResultToDynamicResponse(raw,{tool:"revit_search_tools",projections:budget.projections,omitted:budget.omitted});
  const text=delivered.contentItems.filter(item=>item.type==="inputText").map((item:any)=>item.text).join("\n");
  const envelope=JSON.parse(text);
  assert.equal(envelope.schema,"revit-operator.model-evidence-envelope.v1");
  assert.match(text,/\/revit\/place-families/);assert.match(text,/\/revit\/open-family-doc/);
  const doc=envelope.evidence_projections[0].tool_documentation;
  assert.equal(doc.returned_tools,6);assert.equal(doc.completion_eligible,false);
  assert.equal(Object.hasOwn(doc.tools.find((tool:any)=>tool.path==="/revit/place-families"),"required_fields"),false);
  assert(doc.omitted_paths.some((item:string)=>item.endsWith("required_fields")));
  assertBoundedModelEvidencePayload([{type:"function_call_output",output:text}]);
}));

test("model presentation removes only selector instructions without changing durable evidence or expansion", () => isolated(() => {
  const payload = { status: "Ok", items: [{ id: 41, diameterFt: 0.5, label: "風", actualNull: null }] };
  const raw = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw });
  const original = JSON.stringify(stored.projection);
  const retainedBytes = readAuthoritativeEvidence(stored.ref, scope);
  const beforeSelection = retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Read the target diameter", fields: ["payload.items[0].diameterFt"] });
  Object.freeze(stored.projection.retrieval.selector_forms);
  Object.freeze(stored.projection.retrieval);
  Object.freeze(stored.projection);
  const envelope = modelEvidenceEnvelope([stored.projection], 2);
  const expected = JSON.parse(original);
  delete expected.retrieval.selector_forms;
  assert.deepEqual(envelope.evidence_projections, [expected]);
  assert.notEqual(envelope.evidence_projections[0], stored.projection);
  assert.notEqual(envelope.evidence_projections[0]!.retrieval, stored.projection.retrieval);
  assert.equal(envelope.omitted, 2);
  assert.equal(JSON.stringify(stored.projection), original);
  assert.ok(stored.projection.retrieval.selector_forms.includes("fields"));
  assert.deepEqual(readAuthoritativeEvidence(stored.ref, scope), retainedBytes);
  const afterSelection = retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Read the same target diameter after presentation", fields: ["payload.items[0].diameterFt"] });
  assert.deepEqual(afterSelection.selection, beforeSelection.selection);
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", projections: [stored.projection], omitted: 2 });
  assert.deepEqual(JSON.parse((response.contentItems[0] as any).text), envelope);
}));

test("compact presentation uses exact UTF-8 item and aggregate byte limits including envelope overhead", () => isolated(() => {
  const stored = storeEvidence({ scope, source: "bounded:compact-budget", trust_level: "authoritative_native", raw: { label: "風é", id: 41 } });
  const original = JSON.stringify(stored.projection);
  const expected = JSON.parse(original);
  delete expected.retrieval.selector_forms;
  const itemBytes = Buffer.byteLength(JSON.stringify(expected), "utf8");
  const oneEnvelope = { ...modelEvidenceEnvelope([]), evidence_projections: [expected] };
  const requestBytes = Buffer.byteLength(JSON.stringify(oneEnvelope), "utf8");
  assert.ok(Buffer.byteLength(original, "utf8") > itemBytes);
  const exact = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection], budget: { item_bytes: itemBytes, request_bytes: requestBytes } });
  assert.equal(exact.projections.length, 1);
  assert.equal(exact.omitted, 0);
  assert.equal(exact.bytes, requestBytes);
  assert.equal(exact.bytes, Buffer.byteLength(JSON.stringify(modelEvidenceEnvelope(exact.projections, exact.omitted)), "utf8"));
  const usage = assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(oneEnvelope) }], { item_bytes: itemBytes, request_bytes: requestBytes });
  assert.equal(usage.projected_bytes, requestBytes);
  for (const budget of [
    { item_bytes: itemBytes - 1, request_bytes: requestBytes },
    { item_bytes: itemBytes, request_bytes: requestBytes - 1 }
  ]) {
    const blocked = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection], budget });
    assert.equal(blocked.projections.length, 0);
    assert.equal(blocked.omitted, 1);
    assert.equal(blocked.bytes, Buffer.byteLength(JSON.stringify(modelEvidenceEnvelope([], 1)), "utf8"));
  }
  const pairBytes = Buffer.byteLength(JSON.stringify({ ...oneEnvelope, evidence_projections: [expected, expected] }), "utf8");
  const pair = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection, stored.projection], budget: { item_bytes: itemBytes, request_bytes: pairBytes } });
  assert.equal(pair.projections.length, 2);
  assert.equal(pair.bytes, pairBytes);
  const short = assembleBoundedEvidenceContext({ ...scope, projections: [stored.projection, stored.projection], budget: { item_bytes: itemBytes, request_bytes: pairBytes - 1 } });
  assert.equal(short.projections.length, 1);
  assert.equal(short.omitted, 1);
  assert.equal(JSON.stringify(stored.projection), original);
}));

test("selector trim leaves errors, images, focused retrieval and omitted response behavior intact", () => isolated(() => {
  const raw = { content: [{ type: "text", text: JSON.stringify({ status: "Ok", viewId: 41 }) },
    { type: "image", mimeType: "image/png", data: "AA==" }] };
  const stored = storeEvidence({ scope, source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw });
  const context = { tool: "revit_call_tool", projections: [stored.projection], omitted: 0 };
  const response = adaptMcpToolCallResultToDynamicResponse(raw, context);
  assert.deepEqual(response.contentItems.filter(item => item.type === "inputImage"), [{ type: "inputImage", imageUrl: "data:image/png;base64,AA==" }]);
  assert.equal("selector_forms" in JSON.parse((response.contentItems[0] as any).text).evidence_projections[0].retrieval, false);
  const error = { isError: true, content: [{ type: "text", text: '{"error":"native pending","selector_forms":"literal error detail"}' }, raw.content[1]!] };
  assert.deepEqual(adaptMcpToolCallResultToDynamicResponse(error, context), adaptMcpToolCallResultToDynamicResponse(error));
  const selection = { ok: true, result: { schema: "revit-operator.evidence-retrieval.v1", selection: { selector_forms: "actual source data" }, complete: false } };
  const retrieved = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: JSON.stringify(selection) }] }, { ...context, tool: "operator_retrieve_evidence" });
  assert.deepEqual(JSON.parse((retrieved.contentItems[0] as any).text), selection);
  const omitted = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_call_tool", projections: [], omitted: 1 });
  assert.deepEqual(JSON.parse((omitted.contentItems[0] as any).text), modelEvidenceEnvelope([], 1));
  assert.deepEqual(omitted.contentItems.filter(item => item.type === "inputImage"), response.contentItems.filter(item => item.type === "inputImage"));
  const legacy = { schema: "revit-operator.evidence-projection.v1", evidence_id: "ev1_legacy", byte_count: 10 } as any;
  assert.deepEqual(modelEvidenceEnvelope([legacy]).evidence_projections, [legacy]);
  assert.notEqual(modelEvidenceEnvelope([legacy]).evidence_projections[0], legacy);
}));
