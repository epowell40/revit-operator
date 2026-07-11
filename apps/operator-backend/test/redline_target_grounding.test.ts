import assert from "node:assert/strict";
import test from "node:test";
import { adaptRedlineAnalyzeToAecIntentEvidence } from "../src/redline/redline_analyze_evidence.js";
import { groundRedlineEvidenceTarget } from "../src/redline/redline_target_grounding.js";

const options = { id: "marked-unit405", created_at: "2026-07-11T00:00:00.000Z", sha256: "a".repeat(64) };
const analyze: any = { ok: true, file_path: "artifacts/uploads/marked-unit405-12x10-duct.pdf", full_path: "C:\\private\\marked-unit405-12x10-duct.pdf", kind: "pdf", bytes: 1, page_count: 1, primary_sheet_number: "M104", likely_sheet: true, pages: [{ page: 1, text_excerpt: "M104", text_chars: 4, sheet_candidates: [] }], pdf_annotations: [], route_candidates: [], suggested_revit_calls: [
  { method: "POST", path: "/revit/sheets", body: { action: "detail", sheetNumber: "M104", includePlacedViews: true, includeViewports: true, includeViewportGeometry: true, includeTitleBlocks: true, includeSheetOutline: true } },
  { method: "POST", path: "/revit/get-titleblock-info", body: { sheetNumber: "M104" } }
] };
function evidence() { return adaptRedlineAnalyzeToAecIntentEvidence(structuredClone(analyze), options); }
function context(overrides: Record<string, unknown> = {}) {
  const actions = [{ action_id: "sheets-1", method: "POST", path: "/revit/sheets", body: structuredClone(analyze.suggested_revit_calls[0].body) }, { action_id: "titleblock-1", method: "POST", path: "/revit/get-titleblock-info", body: { sheetNumber: "M104" } }];
  const results = [
    { action_id: "sheets-1", method: "POST", path: "/revit/sheets", status: "done", result_json: { status: "Ok", action: "detail", sheetElementId: 104, sheetId: 104, viewId: 104, sheetNumber: "M104", sheetName: "HVAC PLAN", isPlaceholder: false, titleBlockCount: 1, titleBlocks: [{ elementId: 901, typeId: 77, familyName: "A1", typeName: "24x36" }], placedViewCount: 2, placedViews: [{ viewId: 501, name: "Level 4 HVAC", viewType: "EngineeringPlan", scale: 100, viewportIds: [3001] }, { viewId: 502, name: "Legend", viewType: "Legend", scale: 1, viewportIds: [3002] }] } },
    { action_id: "titleblock-1", method: "POST", path: "/revit/get-titleblock-info", status: "done", result_json: { ok: true, sheetId: 104, sheetViewId: 104, sheetNumber: "M104", titleblockInstanceId: 901, titleblockCount: 1, titleblockTypeId: 77 } }
  ];
  return { actions, results, ...overrides };
}
function assertUnchanged(input: any, trusted: any) { const output = groundRedlineEvidenceTarget(input, trusted)!; assert.deepEqual(output, input); }

test("grounds unique M104 handler-shaped discovery using only an eligible placed model view", () => {
  const input = evidence(), output = groundRedlineEvidenceTarget(input, context())!;
  assert.equal(output.target.status, "ambiguous"); assert.deepEqual(output.target.sheet, { number: "M104", id: 104 }); assert.deepEqual(output.target.view, { id: 501, name: "Level 4 HVAC" }); assert.notEqual(output.target.view?.id, 104);
  assert.deepEqual(output.target.document, input.target.document); assert.deepEqual(output.evidence, input.evidence); assert.deepEqual(output.intent, input.intent); assert.deepEqual(output.verification, input.verification); assert.equal(JSON.stringify(output).includes("titleblockInstanceId"), false);
});

test("fails closed for strict sheet, titleblock, placed-view, ID, and correlation defects", () => {
  const cases: Array<[string, (v: any) => void]> = [
    ["sheet element mismatch", (v) => { v.results[0].result_json.sheetElementId = 105; }], ["placeholder", (v) => { v.results[0].result_json.isPlaceholder = true; }], ["placed count missing", (v) => { delete v.results[0].result_json.placedViewCount; }], ["placed count mismatch", (v) => { v.results[0].result_json.placedViewCount = 1; }], ["zero view", (v) => { v.results[0].result_json.placedViews = []; v.results[0].result_json.placedViewCount = 0; }], ["multiple model views", (v) => { v.results[0].result_json.placedViews.push({ viewId: 503, name: "Section", viewType: "Section", scale: 100, viewportIds: [3] }); v.results[0].result_json.placedViewCount = 3; }], ["conflicting duplicate view metadata", (v) => { v.results[0].result_json.placedViews.push({ viewId: 501, name: "Level 4 HVAC", viewType: "EngineeringPlan", scale: 50, viewportIds: [3001] }); v.results[0].result_json.placedViewCount = 3; }], ["multiple titleblocks", (v) => { v.results[0].result_json.titleBlockCount = 2; v.results[0].result_json.titleBlocks.push({ elementId: 902, typeId: 78 }); }], ["obsolete instanceId-only titleblock", (v) => { v.results[0].result_json.titleBlocks[0] = { instanceId: 901, typeId: 77 }; }], ["titleblock instance mismatch", (v) => { v.results[1].result_json.titleblockInstanceId = 902; }], ["titleblock type mismatch", (v) => { v.results[1].result_json.titleblockTypeId = 78; }], ["wrong number", (v) => { v.results[1].result_json.sheetNumber = "M105"; }], ["string ID", (v) => { v.results[0].result_json.sheetId = "104"; }], ["nonpositive ID", (v) => { v.results[0].result_json.sheetId = 0; }], ["missing result", (v) => { v.results.pop(); }], ["failed result", (v) => { v.results[0].status = "failed"; }], ["unrelated action", (v) => { v.actions.push({ action_id: "other", method: "POST", path: "/revit/sheets", body: structuredClone(analyze.suggested_revit_calls[0].body) }); }], ["unrelated result", (v) => { v.results.push({ action_id: "other", method: "POST", path: "/revit/sheets", status: "done", result_json: {} }); }]
  ];
  for (const [name, mutate] of cases) { const input = evidence(), trusted = context(); mutate(trusted); assertUnchanged(input, trusted); assert.ok(name); }
});

test("rejects write controls, wrong intent/fingerprint, and invalid canonical JSON while exact replay dedupes", () => {
  for (const mutate of [
    (input: any, v: any) => { input.intent.proposed_actions[0].body.apply = true; }, (input: any, v: any) => { input.intent.proposed_actions[0].body.nested = { dry_run: true }; }, (input: any, v: any) => { input.intent.proposed_actions[0].body.requires_apply = false; }, (input: any, v: any) => { input.intent.proposed_actions[0].requires_apply = true; }, (input: any, v: any) => { input.intent.domain = "mep"; }, (input: any, v: any) => { input.intent.action = "other"; }, (input: any, v: any) => { input.evidence.forEach((item: any) => { delete item.sha256; }); }, (input: any, v: any) => { input.evidence.push({ ...structuredClone(input.evidence[0]), id: "conflict", sha256: "b".repeat(64) }); }, (input: any, v: any) => { v.results[0].result_json.placedViews.push(structuredClone(v.results[0].result_json.placedViews[0])); v.results[0].result_json.placedViewCount = 3; }, (input: any, v: any) => { v.actions.push(structuredClone(v.actions[0])); v.results.push(structuredClone(v.results[0])); }, (input: any, v: any) => { v.actions.push({ action_id: "other", method: "POST", path: "/revit/sheets", body: { action: "detail", sheetNumber: "M104", includePlacedViews: true, includeTitleBlocks: true, flags: [undefined] } }); }
  ]) {
    const input = evidence(), trusted = context(); mutate(input, trusted); const output = groundRedlineEvidenceTarget(input, trusted)!;
    const replayed = trusted.actions.length === 3 && trusted.results.length === 3 && trusted.actions[2]?.action_id === "sheets-1", views = trusted.results[0]?.result_json.placedViews;
    if (replayed || Array.isArray(views) && views.length === 3 && views[2]?.viewId === 501) assert.deepEqual(output.target.view, { id: 501, name: "Level 4 HVAC" }); else assert.deepEqual(output, input);
  }
  const cyclic = context(); cyclic.actions[0].body.self = cyclic.actions[0].body; assert.doesNotThrow(() => assertUnchanged(evidence(), cyclic));
  for (const invalid of [() => { const v = context(); v.actions[0].body.bad = new Date(); return v; }, () => { const v = context(); v.actions[0].body.bad = new Map(); return v; }, () => { const v = context(); v.actions[0].body.bad = Number.NaN; return v; }, () => { const v = context(); v.actions[0].body.bad = "x".repeat(4_001); return v; }]) assert.doesNotThrow(() => assertUnchanged(evidence(), invalid()));
});

test("is provider-neutral, deeply copied, proposal/gate preserving, and has no invocation dependency", () => {
  const input = evidence(), output = groundRedlineEvidenceTarget(input, context())!, provider = evidence(); (provider.origin as any).provider = { name: "other", model: "x" };
  assert.deepEqual(groundRedlineEvidenceTarget(provider, context())!.target, output.target); (input.intent.proposed_actions[0].body as any).changed = true; assert.equal((output.intent.proposed_actions[0].body as any).changed, undefined);
  const originalFetch = globalThis.fetch; (globalThis as any).fetch = () => { throw new Error("invoked"); }; try { assert.deepEqual(groundRedlineEvidenceTarget(evidence(), context())!.target, output.target); } finally { (globalThis as any).fetch = originalFetch; }
  assert.ok(output.intent.proposed_actions.every((proposal) => proposal.requires_apply === false)); assert.ok(output.verification.observed.every((gate) => gate.status === "not_run")); assert.equal(JSON.stringify(output).includes("C:\\private"), false);
});
