import { MODEL_EVIDENCE_ENVELOPE_SCHEMA } from "../src/evidence/model_context_budget.js";
export const sheet = (i: number): any => ({
  status: 'Ok', action: 'detail', sheetElementId: i, sheetId: i, viewId: i,
  sheetNumber: `M${i}`, sheetName: `Plan ${i}`, title: `Plan ${i}`, isPlaceholder: false,
  requestedPlacementIds: null, viewportCount: 3, placedViewCount: 3, placedScheduleCount: 1, titleBlockCount: 1,
  sheetOutline: {minU: 0, minV: 0, maxU: 3.5, maxV: 2.5}, viewportIds: [1, 2, 3],
  viewportGeometry: Array.from({length: 3}, (_, j) => ({id: j, geometry: 'x'.repeat(350)})),
  placedViews: [1, 2, 3].map(id => ({id, name: `Plan ${id}`, viewportIds: [id]})),
  placedSchedules: [{id: 4, name: 'Revision', geometry: 'x'.repeat(200)}],
  titleBlocks: [{id: 5, geometry: 'x'.repeat(200)}]
});
export const projection = (i: number): any => ({schema: 'revit-operator.evidence-projection.v1',
  evidence_id: `ev1_sheet${i}`, artifact_ref: `ev1_sheet${i}`, content_hash: 'sha256:' + 'a'.repeat(64),
  byte_count: 2800, media_type: 'application/json', source: 'assignment_kernel_v2:revit_call_tool',
  trust_level: 'authoritative_native', effect_state: null, assignment_id: 'assignment', run_id: 'run',
  attempt_id: 'opv2_' + 'b'.repeat(64), generation: 1, target_scope: [String(i)],
  key_counts: {'placedViews.length': 3}, key_facts: {status: 'Ok', 'placedViews[0].name': 'Plan 1'},
  before_hash: null, after_hash: null, diagnostics: [], verification_relevance: 'required',
  additional_evidence: true, truncated: false, projected_bytes: 5000,
  retrieval: {tool_name: 'operator_retrieve_evidence', max_bytes: 1048576}, inline_payload: sheet(i)});
export const envelope = (p: any) => JSON.stringify({schema: MODEL_EVIDENCE_ENVELOPE_SCHEMA,
  evidence_projections: [p], omitted: 0, retrieval: 'Retrieve missing fields by evidence ID.'});
export const batch = () => Array.from({length: 16}, (_, i) => ({type: 'function_call_output', call_id: `sheet${i}`,
  output: [{type: 'input_text', text: envelope(projection(i + 1))}]}));
