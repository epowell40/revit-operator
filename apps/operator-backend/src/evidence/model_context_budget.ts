import type { EvidenceProjectionV1, EvidenceTelemetryEventV1 } from "./evidence_ref.js";
import { appendEvidenceTelemetry } from "./evidence_store.js";
import {reduceNativeCorrectionPage} from './native_correction_projection.js';
import {pageNativeProgramReadForBatch} from './native_program_projection.js';

export const MODEL_EVIDENCE_ENVELOPE_SCHEMA = "revit-operator.model-evidence-envelope.v1" as const;

export type EvidenceContextBudget = { item_bytes: number; request_bytes: number };

export function rawEvidenceItemBudget(budget = getEvidenceContextBudget()): number {
  return Math.min(budget.item_bytes, 8_192);
}

type ModelEvidenceProjectionV1 = Omit<EvidenceProjectionV1, "retrieval"> & {
  retrieval: Omit<EvidenceProjectionV1["retrieval"], "selector_forms">;
};

function modelEvidenceProjection(projection: EvidenceProjectionV1): ModelEvidenceProjectionV1 {
  // Selector instructions already live in the retrieval tool and turn guidance.
  // Keep durable projections (including projected_bytes) and all evidence untouched.
  if (!projection.retrieval || !Object.prototype.hasOwnProperty.call(projection.retrieval, "selector_forms")) {
    return { ...projection };
  }
  const { selector_forms: _selectorForms, ...retrieval } = projection.retrieval;
  return { ...projection, retrieval };
}


function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function getEvidenceContextBudget(): EvidenceContextBudget {
  // A scoped native read should arrive whole when it fits the request. The old
  // 8 KiB projection ceiling split ordinary 15 KiB results into several actor
  // retrieval turns. Leave room for controls/other results inside the unchanged
  // request ceiling; genuinely large inventories retain explicit paging.
  const item_bytes = envInt("OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES", 24_576, 1_024, 65_536);
  const request_bytes = envInt("OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES", 32_768, item_bytes, 262_144);
  return { item_bytes, request_bytes };
}

export function assembleBoundedEvidenceContext(input: {
  projections: EvidenceProjectionV1[];
  session_id: string;
  assignment_id?: string | null;
  model_call_id?: string | null;
  source?: string;
  budget?: EvidenceContextBudget;
}): { projections: EvidenceProjectionV1[]; bytes: number; omitted: number } {
  const budget = input.budget ?? getEvidenceContextBudget();
  const selected: EvidenceProjectionV1[] = [];
  // Reserve the actual wire envelope, including the largest possible omission
  // count, before admitting records. Array-only accounting can fit records
  // whose final serialized response exceeds the caller's request budget.
  let bytes = Buffer.byteLength(JSON.stringify(modelEvidenceEnvelope([], input.projections.length)), "utf8");
  let omitted = 0;
  for (const projection of input.projections) {
    const itemBytes = Buffer.byteLength(JSON.stringify(modelEvidenceProjection(projection)), "utf8");
    const encodedBytes = itemBytes + (selected.length > 0 ? 1 : 0);
    if (itemBytes > budget.item_bytes || bytes + encodedBytes > budget.request_bytes) { omitted++; continue; }
    selected.push(projection);
    bytes += encodedBytes;
  }
  bytes = Buffer.byteLength(JSON.stringify(modelEvidenceEnvelope(selected, omitted)), "utf8");
  if (bytes > budget.request_bytes) throw new Error("Evidence response envelope exceeds the configured request budget.");
  const rawBytes = input.projections.reduce((sum, item) => sum + item.byte_count, 0);
  appendEvidenceTelemetry({
    session_id: input.session_id,
    assignment_id: input.assignment_id ?? null,
    model_call_id: input.model_call_id ?? null,
    source: input.source ?? "model_context",
    raw_evidence_bytes_produced: 0,
    unique_evidence_bytes_stored: 0,
    projected_bytes_sent: bytes,
    duplicate_bytes_avoided: Math.max(0, rawBytes - bytes),
    evidence_items_expanded: 0,
    budget_events: omitted > 0 ? 1 : 0,
    estimated_model_tokens_avoided: Math.floor(Math.max(0, rawBytes - bytes) / 4)
  } satisfies Omit<EvidenceTelemetryEventV1, "schema" | "recorded_at_utc">);
  return { projections: selected, bytes, omitted };
}

export type ModelEvidencePayloadUsage = {
  projected_bytes: number;
  referenced_raw_bytes: number;
  projection_count: number;
};

/** Assemble one model request from already retained tool responses. The
 * per-tool projection budget alone cannot bound a batch. On overflow, omit
 * supporting summaries or optional read accelerators from model-only copies.
 * Retained native data, images, controls, identities and retrieval stay exact. This
 * is presentation, never evidence admission or a replacement for validation.
 */
export function prepareBoundedModelEvidenceInput(input: unknown, budget = getEvidenceContextBudget()): unknown {
  try { assertBoundedModelEvidencePayload(input, budget); return input; }
  catch (error) {
    // Do not sanitize malformed/raw/oversized items into accepted evidence.
    if (!(error instanceof Error) || error.message !== `Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`) throw error;
  }
  if (!Array.isArray(input) || input.length > 256) {
    assertBoundedModelEvidencePayload(input, budget); return input;
  }
  type Slot = { row: number; block: number | null; envelope: any };
  const slots: Slot[] = [];
  const candidates: Array<{ slot: Slot; index: number; compact: any; saving: number }> = [];
  const sheetCores: Array<{ slot: Slot; index: number; compact: any }> = [];
  const committedCores: Array<{ slot: Slot; index: number; compact: any }> = [];
  const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const positiveId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  const isTargetedSheetRead = (v: any): boolean => {
    const ids = v?.requestedPlacementIds;
    return Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && ids.every(positiveId)
      && new Set(ids).size === ids.length;
  };
  const readAccelerator = (p: any): any | null => {
    // This is a presentation fallback, not native evidence admission. Recognize
    // only known inspection/documentation accelerators; never generalize a null
    // effect into read-only authority or omit a write/control/visual payload.
    if (!object(p) || p.schema !== 'revit-operator.evidence-projection.v1'
      || p.effect_state !== null || p.before_hash !== null || p.after_hash !== null
      || typeof p.evidence_id !== 'string' || !/^ev1_[A-Za-z0-9_-]+$/.test(p.evidence_id)
      || p.artifact_ref !== p.evidence_id || !/^sha256:[a-f0-9]{64}$/.test(p.content_hash)
      || typeof p.assignment_id !== 'string' || !p.assignment_id || typeof p.run_id !== 'string' || !p.run_id
      || typeof p.attempt_id !== 'string' || !/^opv2_[a-f0-9]{64}$/.test(p.attempt_id)
      || !Number.isSafeInteger(p.generation) || p.generation < 1
      || !object(p.key_counts) || !object(p.key_facts) || !Array.isArray(p.target_scope)
      || !Array.isArray(p.diagnostics) || !p.diagnostics.every((d: unknown) => typeof d === 'string')
      || p.retrieval?.tool_name !== 'operator_retrieve_evidence'
      || !Number.isSafeInteger(p.retrieval.max_bytes) || p.retrieval.max_bytes <= 0
      || !Object.keys(p).every(k => ['schema', 'evidence_id', 'content_hash', 'byte_count', 'media_type',
        'source', 'trust_level', 'effect_state', 'assignment_id', 'run_id', 'attempt_id', 'generation',
        'target_scope', 'key_counts', 'key_facts', 'before_hash', 'after_hash', 'diagnostics', 'artifact_ref',
        'verification_relevance', 'additional_evidence', 'retrieval', 'truncated', 'projected_bytes',
        'inline_payload', 'tool_documentation'].includes(k))) return null;
    const diagnostic = 'batch_budget: retrieve omitted read fields/contracts by evidence_id; summary is not proof.';
    if (p.source === 'assignment_kernel_v2:revit_call_tool' && p.trust_level === 'authoritative_native'
      && p.media_type === 'application/json') {
      const v = p.inline_payload;
      const targeted = isTargetedSheetRead(v);
      const fields = ['status', 'action', 'sheetElementId', 'sheetId', 'viewId', 'sheetNumber', 'sheetName',
        'title', 'isPlaceholder', 'requestedPlacementIds', 'viewportCount', 'placedViewCount',
        'placedScheduleCount', 'titleBlockCount', 'sheetOutline', 'viewportIds', 'viewportGeometry',
        'placedViews', 'placedSchedules', 'titleBlocks'];
      if (!object(v) || Object.keys(v).length !== fields.length || !Object.keys(v).every(k => fields.includes(k))
        || v.status !== 'Ok' || v.action !== 'detail' || !Number.isSafeInteger(v.sheetElementId) || v.sheetElementId <= 0
        || v.sheetId !== v.sheetElementId || v.viewId !== v.sheetElementId
        || typeof v.sheetNumber !== 'string' || typeof v.sheetName !== 'string' || typeof v.title !== 'string'
        || typeof v.isPlaceholder !== 'boolean'
        || !(targeted ? p.verification_relevance === 'authoritative'
          : p.verification_relevance === 'required' && v.requestedPlacementIds === null)
        || !object(v.sheetOutline) || !['minU', 'minV', 'maxU', 'maxV'].every(k => Number.isFinite(v.sheetOutline[k]))
        || ![['viewportCount', 'viewportIds'], ['viewportCount', 'viewportGeometry'],
          ['placedViewCount', 'placedViews'], ['placedScheduleCount', 'placedSchedules'],
          ['titleBlockCount', 'titleBlocks']].every(([count, rows]) => Array.isArray(v[rows])
            && Number.isSafeInteger(v[count]) && v[count] === v[rows].length)
        || Object.hasOwn(p, 'tool_documentation')) return null;
      if (targeted) return targetedSheetCore(p);
      const {inline_payload: _inline, ...retained} = p;
      return {...retained, truncated: true, diagnostics: [...p.diagnostics, diagnostic]};
    }
    const d = p.tool_documentation;
    if (p.source !== 'assignment_kernel_v2:revit_tool_doc' || p.trust_level !== 'host_observed'
      || !object(d) || d.kind !== 'tool' || d.completion_eligible !== false
      || !Array.isArray(d.tools) || d.tools.length !== 1 || d.returned_tools !== 1 || d.total_tools !== 1
      || !Array.isArray(d.omitted_paths) || !d.omitted_paths.every((v: unknown) => typeof v === 'string')
      || !object(d.tools[0]) || !['GET', 'POST'].includes(d.tools[0].method)
      || typeof d.tools[0].path !== 'string' || !/^\/revit\/[a-z0-9/-]+$/.test(d.tools[0].path)
      || Object.hasOwn(p, 'inline_payload')) return null;
    return {...p, truncated: true, diagnostics: [...p.diagnostics, diagnostic], tool_documentation: {...d,
      tools: [{method: d.tools[0].method, path: d.tools[0].path}], complete: false,
      omitted_paths: [...d.omitted_paths, 'tools[*].contract: batch_budget; retrieve before use']}};
  };
  const targetedSheetCore = (p: any): any | null => {
    const v = p.inline_payload;
    const ids = new Set<number>(v.requestedPlacementIds);
    const viewportGeometry = v.viewportGeometry.filter((row: any) => ids.has(row?.viewportId));
    const placedSchedules = v.placedSchedules.filter((row: any) => ids.has(row?.instanceId));
    const placements = [...viewportGeometry.map((row: any) => row.viewportId), ...placedSchedules.map((row: any) => row.instanceId)];
    if (placements.length !== ids.size || new Set(placements).size !== ids.size) return null;
    const placedViews = v.placedViews.filter((row: any) => Array.isArray(row?.viewportIds)
      && row.viewportIds.some((id: number) => ids.has(id)));
    const geometryFields = ['viewportId', 'viewId', 'viewportType', 'rotation', 'center', 'placementAnchor', 'box'];
    if (!viewportGeometry.every((row: any) => Object.keys(row).every(key => geometryFields.includes(key))
      && positiveId(row.viewId) && object(row.center) && object(row.box)
      && placedViews.some((view: any) => view.viewId === row.viewId && view.viewportIds.includes(row.viewportId)))) return null;
    const fields = ['status', 'action', 'sheetElementId', 'sheetId', 'viewId', 'sheetNumber', 'sheetName',
      'isPlaceholder', 'requestedPlacementIds', 'viewportCount', 'placedViewCount', 'placedScheduleCount', 'titleBlockCount'];
    return {...p, inline_payload: {...Object.fromEntries(fields.map(key => [key, v[key]])),
      viewportGeometry: viewportGeometry.map(({viewportId, viewId, rotation, center, box}: any) => ({viewportId, viewId, rotation, center, box})),
      placedViews, placedSchedules}, ...removeSheetSummaryMirrors(p), truncated: true, additional_evidence: true,
      diagnostics: [...p.diagnostics, 'batch_budget: partial layout for requested placements; retrieve whole sheet by evidence_id.']};
  };
  const removeSheetSummaryMirrors = (p: any) => {
    const v = p.inline_payload;
    const counts: Record<string, unknown> = {}, facts: Record<string, unknown> = {status: v.status};
    for (const name of ['viewportIds', 'viewportGeometry', 'placedViews', 'placedSchedules', 'titleBlocks']) counts[name + '.length'] = v[name].length;
    if (Array.isArray(v.requestedPlacementIds)) counts['requestedPlacementIds.length'] = v.requestedPlacementIds.length;
    v.placedViews.forEach((r: any, i: number) => {
      if (Array.isArray(r?.viewportIds)) counts[`placedViews[${i}].viewportIds.length`] = r.viewportIds.length;
      if (typeof r?.name === 'string') facts[`placedViews[${i}].name`] = r.name;
    });
    v.placedSchedules.forEach((r: any, i: number) => {if (typeof r?.name === 'string') facts[`placedSchedules[${i}].name`] = r.name;});
    v.viewportGeometry.forEach((r: any, i: number) => {
      for (const axis of ['pointXyz', 'basisXXyz', 'basisYXyz', 'basisZXyz']) if (Array.isArray(r?.placementAnchor?.[axis])) counts[`viewportGeometry[${i}].placementAnchor.${axis}.length`] = r.placementAnchor[axis].length;
      for (const k of ['id', 'name']) if (['string', 'number'].includes(typeof r?.viewportType?.[k])) facts[`viewportGeometry[${i}].viewportType.${k}`] = r.viewportType[k];
    });
    // Remove only summaries proven equal to this exact native read. Unknown,
    // contradictory or control-like fields are preserved, never sanitized.
    const withoutMirrors = (actual: any, expected: any) => Object.fromEntries(Object.entries(actual).filter(([k, val]) => !Object.hasOwn(expected, k) || expected[k] !== val));
    return {key_counts: withoutMirrors(p.key_counts, counts), key_facts: withoutMirrors(p.key_facts, facts)};
  };
  const sheetCore = (p: any): any | null => {
    // Keep actual sheet-to-view associations when the full read cannot fit.
    const v = p.inline_payload;
    if (p.source !== 'assignment_kernel_v2:revit_call_tool' || !object(v) || v.action !== 'detail') return null;
    return {...p, ...removeSheetSummaryMirrors(p),
      inline_payload: Object.fromEntries(['status', 'action', 'sheetElementId', 'sheetId', 'viewId', 'sheetNumber', 'sheetName', 'title', 'isPlaceholder', 'viewportCount', 'placedViewCount', 'placedScheduleCount', 'titleBlockCount', 'placedViews'].map(k => [k, v[k]])),
      truncated: true, diagnostics: [...p.diagnostics, 'batch_budget: partial sheet identities, placedViews and counts only; retrieve geometry or missing fields by evidence_id, not preservation proof.']};
  };
  const committedConnectorCore = (p: any): any | null => {
    // Presentation of already retained facts only. Keep the native effect,
    // footprint, controls, diagnostics and all other fields exactly. Only
    // recognized connector snapshots can move behind their existing raw ref.
    // This never admits/verifies an operation or replays a mutation.
    if (!object(p) || p.schema !== 'revit-operator.evidence-projection.v1'
      || p.source !== 'assignment_kernel_v2:revit_call_tool' || p.trust_level !== 'authoritative_native'
      // Legacy projections may leave effect_state null even though the full
      // native payload contains its committed effect. Null is NOT read-only;
      // require that exact committed payload below and leave metadata unchanged.
      || ![null,'applied'].includes(p.effect_state) || p.verification_relevance !== 'required' || p.media_type !== 'application/json'
      || typeof p.evidence_id !== 'string' || !/^ev1_[A-Za-z0-9_-]+$/.test(p.evidence_id)
      || p.artifact_ref !== p.evidence_id || !/^sha256:[a-f0-9]{64}$/.test(p.content_hash)
      || typeof p.assignment_id !== 'string' || !p.assignment_id || typeof p.run_id !== 'string' || !p.run_id
      || !/^opv2_[a-f0-9]{64}$/.test(p.attempt_id) || !Number.isSafeInteger(p.generation) || p.generation<1
      || !Array.isArray(p.target_scope) || !object(p.key_facts) || !object(p.key_counts)
      || !Array.isArray(p.diagnostics) || !p.diagnostics.every((v:unknown)=>typeof v==='string')
      || p.retrieval?.tool_name !== 'operator_retrieve_evidence' || !Number.isSafeInteger(p.retrieval.max_bytes)
      || p.retrieval.max_bytes<=0) return null;
    const v=p.inline_payload,t=v?.transaction,c=v?.changeTracking;
    const ids=(xs:any)=>Array.isArray(xs)&&xs.length<=4096&&xs.every((x:any)=>Number.isSafeInteger(x)&&x>0);
    if (!object(v)||v.success!==true||v.applied!==true||v.dryRun!==false
      ||v.transactionGroupRolledBack!==false||v.failureRollbackRequested!==false
      ||!object(t)||t.status!=='committed'||t.committed!==true
      ||!['added_element_ids','modified_element_ids','deleted_element_ids','affected_element_ids'].every(k=>ids(t[k]))
      ||!object(c)||c.documentChangedObserved!==true||c.exhaustiveChangeInventory!==true||c.captureFailureCount!==0
      ||!Array.isArray(v.nativeFailures)||v.nativeFailures.length||!Array.isArray(v.capturedFailures)||v.capturedFailures.length)return null;
    const xyz=(xs:any)=>Array.isArray(xs)&&xs.length===3&&xs.every(Number.isFinite);
    const exact=(o:any,keys:string[])=>object(o)&&Object.keys(o).every(k=>keys.includes(k));
    const connector=(o:any)=>exact(o,['connectorId','connectorIdBasis','origin','domain','shape','size','physicalConnectedOwnerIds'])
      &&Number.isSafeInteger(o.connectorId)&&o.connectorId>=0&&o.connectorIdBasis==='revit_native_connector_id'
      &&xyz(o.origin)&&typeof o.domain==='string'&&typeof o.shape==='string'&&ids(o.physicalConnectedOwnerIds)
      &&exact(o.size,['kind','diameterFt','widthFt','heightFt'])&&['round','rect'].includes(o.size.kind)
      &&(o.size.kind==='round'?typeof o.size.diameterFt==='number':typeof o.size.widthFt==='number'&&typeof o.size.heightFt==='number')
      &&Object.entries(o.size).every(([k,x])=>k==='kind'||typeof x==='number'&&Number.isFinite(x)&&x>0);
    const peer=(o:any)=>exact(o,['connectorId','connectorIdBasis','origin','connectedOwnerId','connectedConnectorId','connectedConnectorIdBasis','connectedOrigin'])
      &&Number.isSafeInteger(o.connectorId)&&o.connectorId>=0&&o.connectorIdBasis==='revit_native_connector_id'
      &&Number.isSafeInteger(o.connectedOwnerId)&&o.connectedOwnerId>0&&Number.isSafeInteger(o.connectedConnectorId)&&o.connectedConnectorId>=0
      &&o.connectedConnectorIdBasis==='revit_native_connector_id'&&xyz(o.origin)&&xyz(o.connectedOrigin);
    const omitted:string[]=[];
    for(const key of ['terminalConnector','mainInteriorConnectorAfterCommit'])if(Object.hasOwn(v,key)){
      if(!connector(v[key]))return null;omitted.push(key);
    }
    for(const key of ['preexistingMainPhysicalConnections','preexistingTerminalPhysicalConnections'])if(Object.hasOwn(v,key)){
      if(!Array.isArray(v[key])||v[key].length>512||!v[key].every(peer))return null;omitted.push(key);
    }
    if(!omitted.length)return null;
    return {...p,inline_payload:Object.fromEntries(Object.entries(v).filter(([k])=>!omitted.includes(k))),truncated:true,additional_evidence:true,
      diagnostics:[...p.diagnostics,'batch_budget: connector details omitted at '+omitted.join(',')+'; retrieve raw_payload by evidence_id before relying on those facts. Partial details are not connection/preservation verification.']};
  };
  const add = (text: string, row: number, block: number | null) => {
    let envelope: any; try { envelope = JSON.parse(text); } catch { return; }
    if (!object(envelope) || envelope.schema !== MODEL_EVIDENCE_ENVELOPE_SCHEMA
      || !Object.keys(envelope).every(k => ['schema', 'evidence_projections', 'omitted', 'retrieval'].includes(k))
      || !Number.isSafeInteger(envelope.omitted) || envelope.omitted < 0
      || typeof envelope.retrieval !== 'string' || envelope.retrieval.length > 500
      || !Array.isArray(envelope.evidence_projections)) return;
    const slot = {row, block, envelope}; slots.push(slot);
    envelope.evidence_projections.forEach((p: any, index: number) => {
      const programRead = pageNativeProgramReadForBatch(p);
      if (programRead) {
        const saving = bytes(p) - bytes(programRead);
        if (saving > 0) candidates.push({slot, index, compact: programRead, saving});
      }
      const committed=committedConnectorCore(p);
      if(committed)committedCores.push({slot,index,compact:committed});
      const readCompact = readAccelerator(p);
      if (readCompact) {
        const saving = bytes(p) - bytes(readCompact);
        if (saving > 0) candidates.push({slot, index, compact: readCompact, saving});
        const core = isTargetedSheetRead(p.inline_payload) ? readCompact : sheetCore(p);
        if (core) sheetCores.push({slot, index, compact: core});
        return;
      }
      if (!object(p) || p.schema !== 'revit-operator.evidence-projection.v1'
        || p.trust_level !== 'untrusted_caller' || p.verification_relevance !== 'supporting' || p.effect_state !== null
        || typeof p.source !== 'string' || !/^desktop_native_transport:[A-Za-z0-9_-]+:\d+$/.test(p.source)
        || typeof p.evidence_id !== 'string' || !/^ev1_[A-Za-z0-9_-]+$/.test(p.evidence_id)
        || p.artifact_ref !== p.evidence_id || typeof p.content_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(p.content_hash)
        || !object(p.key_counts) || !object(p.key_facts) || !Array.isArray(p.diagnostics)
        || !p.diagnostics.every((d: unknown) => typeof d === 'string')
        || p.retrieval?.tool_name !== 'operator_retrieve_evidence' || !Number.isSafeInteger(p.retrieval.max_bytes)
        || p.retrieval.max_bytes <= 0) return;
      const compact = {...p, key_counts: {}, key_facts: {}, truncated: true, additional_evidence: true,
        diagnostics: [...p.diagnostics, 'summary_fields_omitted_for_batch_budget: key_counts/key_facts are not absence or completion proof. Retrieve missing controls/facts from this evidence_id before relying on them.']};
      // projected_bytes describes the retained projection, not this model-only
      // presentation (as with selector_forms elision above). Raw hashes stay exact.
      const saving = bytes(p) - bytes(compact);
      if (saving > 0) candidates.push({slot, index, compact, saving});
    });
  };
  input.forEach((row, i) => {
    if (row?.type !== 'function_call_output') return;
    if (typeof row.output === 'string') add(row.output, i, null);
    else if (Array.isArray(row.output) && row.output.length <= 64) row.output.forEach((block: any, j: number) => {
      if (block?.type === 'input_text' && typeof block.text === 'string') add(block.text, i, j);
    });
  });
  // Stable largest-saving-first changes the fewest responses. Optional read
  // accelerators remain in durable evidence; controls are never candidates.
  candidates.sort((a, b) => b.saving - a.saving);
  const output = input.slice();
  for (const {slot, index, compact} of candidates.slice(0, 512)) {
    slot.envelope.evidence_projections[index] = compact;
    const row = output[slot.row], text = JSON.stringify(slot.envelope);
    if (slot.block === null) output[slot.row] = {...row, output: text};
    else {
      const content = row.output.slice(); content[slot.block] = {...content[slot.block], text};
      output[slot.row] = {...row, output: content};
    }
    try { assertBoundedModelEvidencePayload(output, budget); return output; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== `Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`) throw error;
    }
  }
  // Preserve legacy fitting batches above. If the whole batch still cannot
  // fit, use compact native associations and remove only mirrored summaries.
  // The repeated canonical usage paragraph is presentation too; keep unknown
  // retrieval instructions untouched and all per-evidence retrieval contracts.
  const coreSlots = new Set<Slot>();
  for (const {slot, index, compact} of sheetCores.slice(0, 512)) {slot.envelope.evidence_projections[index] = compact; coreSlots.add(slot);}
  for (const {slot,index,compact} of committedCores.slice(0,512)){slot.envelope.evidence_projections[index]=compact;coreSlots.add(slot);}
  const canonicalRetrieval = modelEvidenceEnvelope([], 0).retrieval;
  const shortRetrieval = 'Use operator_retrieve_evidence (evidence_id). Honor scope and paging; partial data cannot prove absence or completion.';
  // This exact repeated paragraph is guidance, not a control or fact. Shorten
  // it for all recognized envelopes only at the overflow fallback; keep each
  // projection's scoped retrieval contract and every unknown paragraph exact.
  const hasTargetedSheetRead = sheetCores.some(({compact}) => isTargetedSheetRead(compact.inline_payload));
  if(committedCores.length || hasTargetedSheetRead)for(const slot of slots)if(slot.envelope.retrieval===canonicalRetrieval)coreSlots.add(slot);
  for (const slot of coreSlots) {
    if (slot.envelope.retrieval === canonicalRetrieval) slot.envelope.retrieval = shortRetrieval;
    const row = output[slot.row], text = JSON.stringify(slot.envelope);
    if (slot.block === null) output[slot.row] = {...row, output: text};
    else {const content = row.output.slice(); content[slot.block] = {...content[slot.block], text}; output[slot.row] = {...row, output: content};}
  }
  try { assertBoundedModelEvidencePayload(output, budget); return output; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== `Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`) throw error;
  }
  // Several native calls can finish in one response. Their individually bounded
  // envelopes repeat the same wire header/guidance. Pack adjacent envelopes
  // within each call before failing the entire drafting task. This moves no
  // projection, image, error or control across another content block and drops
  // no native data. Nonzero omission counts/unknown guidance remain untouched.
  const knownEnvelope = (block: any): any | null => {
    if (!object(block) || block.type !== 'input_text' || typeof block.text !== 'string'
      || !Object.keys(block).every(k => ['type', 'text'].includes(k))) return null;
    let e: any; try { e = JSON.parse(block.text); } catch { return null; }
    return object(e) && e.schema === MODEL_EVIDENCE_ENVELOPE_SCHEMA
      && Object.keys(e).every(k => ['schema', 'evidence_projections', 'omitted', 'retrieval'].includes(k))
      && e.omitted === 0 && e.retrieval === canonicalRetrieval
      && Array.isArray(e.evidence_projections) && e.evidence_projections.length > 0
      ? e : null;
  };
  const packed = output.map(row => {
    if (row?.type !== 'function_call_output' || !Array.isArray(row.output)) return row;
    const blocks: any[] = [];
    let adjacent: any | null = null;
    for (const block of row.output) {
      const envelope = knownEnvelope(block);
      if (!envelope) { blocks.push(block); adjacent = null; continue; }
      if (adjacent) adjacent.evidence_projections.push(...envelope.evidence_projections);
      else {
        adjacent = {...envelope, evidence_projections: envelope.evidence_projections.slice(), retrieval: shortRetrieval};
        blocks.push({type:'input_text', text:''});
      }
      blocks[blocks.length - 1] = {type:'input_text', text:JSON.stringify(adjacent)};
    }
    return {...row, output:blocks};
  });
  // After lossless packing, share the remaining budget across optional native
  // correction pages. Keep at least one complete spatial row per readback;
  // paging restarts at the first omitted original row, never a guessed offset.
  // Write receipts, controls, images and durable projections stay untouched.
  for(let step=0;step<256;step++){
    try{assertBoundedModelEvidencePayload(packed,budget);return packed;}
    catch(error){if(!(error instanceof Error)||error.message!==`Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`)throw error;}
    let best:{row:any;index:number;envelope:any;projectionIndex:number;compact:any;size:number}|null=null;
    for(const row of packed){
      if(row?.type!=='function_call_output'||!Array.isArray(row.output))continue;
      for(let i=0;i<row.output.length;i++){
        const block=row.output[i];if(block?.type!=='input_text'||typeof block.text!=='string')continue;
        let e:any;try{e=JSON.parse(block.text);}catch{continue;}
        if(e?.schema!==MODEL_EVIDENCE_ENVELOPE_SCHEMA||e.omitted!==0
          ||!Object.keys(e).every(k=>['schema','evidence_projections','omitted','retrieval'].includes(k))
          ||![canonicalRetrieval,shortRetrieval].includes(e.retrieval)||!Array.isArray(e.evidence_projections))continue;
        e.evidence_projections.forEach((p:any,j:number)=>{
          const compact=reduceNativeCorrectionPage(p),size=bytes(p);
          if(compact&&bytes(compact)<size&&(!best||size>best.size))best={row,index:i,envelope:e,projectionIndex:j,compact,size};
        });
      }
    }
    if(!best)break;
    const selected=best as {row:any;index:number;envelope:any;projectionIndex:number;compact:any};
    selected.envelope.evidence_projections[selected.projectionIndex]=selected.compact;
    // packed has fresh rows/arrays; the input and retained records are not edited.
    selected.row.output=selected.row.output.slice();
    selected.row.output[selected.index]={...selected.row.output[selected.index],text:JSON.stringify(selected.envelope)};
  }
  // Irreducible/unknown data still fails closed. Keep the existing item/request
  // caps, all call IDs and per-projection source/hash/scope/retrieval contracts.
  assertBoundedModelEvidencePayload(packed, budget); return packed;
}

export function assertBoundedModelEvidencePayload(input: unknown, budget = getEvidenceContextBudget()): ModelEvidencePayloadUsage {
  let totalEvidenceBytes = 0;
  let referencedRawBytes = 0;
  let projectionCount = 0;
  const queue: unknown[] = [input];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const row = value as Record<string, unknown>;
    // Responses can carry native tool text and image blocks together. Apply
    // the same text/projection limits as string outputs; arrays are not an
    // escape hatch around the existing evidence budget.
    if(row.type==='function_call_output'&&Array.isArray(row.output)) {
      for(const item of row.output) {
        if(item?.type==='input_text'&&typeof item.text==='string')
          queue.push({type:'function_call_output',output:item.text});
        else if(item?.type!=='input_image'||typeof item.image_url!=='string')
          throw new Error('Invalid native function output content block.');
      }
    }
    if (row.type === "function_call_output" && typeof row.output === "string") {
      const bytes = Buffer.byteLength(row.output, "utf8");
      let projectionEnvelope: { schema?: unknown; evidence_projections?: unknown; omitted?: unknown; retrieval?: unknown } | null = null;
      try { projectionEnvelope = JSON.parse(row.output); } catch {}
      const envelopeKeys = projectionEnvelope && typeof projectionEnvelope === "object"
        ? Object.keys(projectionEnvelope)
        : [];
      const validEnvelopeShape = projectionEnvelope?.schema === MODEL_EVIDENCE_ENVELOPE_SCHEMA
        && envelopeKeys.every(key => ["schema", "evidence_projections", "omitted", "retrieval"].includes(key))
        && Number.isSafeInteger(projectionEnvelope.omitted)
        && Number(projectionEnvelope.omitted) >= 0
        && typeof projectionEnvelope.retrieval === "string"
        && projectionEnvelope.retrieval.length <= 500;
      const projections = validEnvelopeShape && Array.isArray(projectionEnvelope?.evidence_projections)
        ? projectionEnvelope.evidence_projections
        : [];
      const isEvidenceProjection = validEnvelopeShape && Array.isArray(projectionEnvelope?.evidence_projections) && projections.every(projection => {
        if (!projection || typeof projection !== "object" || (projection as any).schema !== "revit-operator.evidence-projection.v1") return false;
        return Buffer.byteLength(JSON.stringify(projection), "utf8") <= budget.item_bytes;
      });
      // The larger allowance is for retained, scoped projections, not arbitrary
      // raw tool dumps. Keep the raw transport threshold independently bounded.
      const rawItemBytes = rawEvidenceItemBudget(budget);
      if (bytes > rawItemBytes && !isEvidenceProjection) {
        throw new Error(`Raw function_call_output exceeds the ${rawItemBytes}-byte evidence item budget; store it and send an EvidenceRef projection.`);
      }
      if (isEvidenceProjection) {
        totalEvidenceBytes += bytes;
        projectionCount += projections.length;
        referencedRawBytes += projections.reduce((sum, projection) => {
          const byteCount = Number((projection as Record<string, unknown>).byte_count);
          return sum + (Number.isSafeInteger(byteCount) && byteCount >= 0 ? byteCount : 0);
        }, 0);
      }
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") queue.push(child);
  }
  if (totalEvidenceBytes > budget.request_bytes) throw new Error(`Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`);
  return { projected_bytes: totalEvidenceBytes, referenced_raw_bytes: referencedRawBytes, projection_count: projectionCount };
}

export function modelEvidenceEnvelope(projections: EvidenceProjectionV1[], omitted = 0): {
  schema: typeof MODEL_EVIDENCE_ENVELOPE_SCHEMA;
  evidence_projections: ModelEvidenceProjectionV1[];
  omitted: number;
  retrieval: string;
} {
  return {
    schema: MODEL_EVIDENCE_ENVELOPE_SCHEMA,
    evidence_projections: projections.map(modelEvidenceProjection),
    omitted,
    retrieval: "Read inline_payload, scoped helper_findings and visual_work_review first; helper/visual claims are not native or whole-task proof. Honor coverage/paging/scope; retrieve missing whole fields/checks/images. resultItems: raw_payload paths for native keys; source=deterministic_projection with [key_counts or key_facts, exact literal key] for summaries. Never reconstruct IDs or split literal keys."
  };
}
