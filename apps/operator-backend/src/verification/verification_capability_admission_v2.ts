import { drawingSpecInspectionReadIdV2 } from './drawing_spec_import_v2.js';
import {DETAIL_LINE_GEOMETRY_SEMANTIC_V2,isNativeDetailLineGraphEditV2,nativeDetailLineGraphRequestV2,detailLineOwnerReadRequestV2}from'./native_detail_line_graph_v2.js';
import {excelTableInspectionReadIdV2,EXCEL_TABLE_PART_SEMANTIC_V2} from './excel_table_import_v2.js';
import {vectorDetailInspectionReadIdV2,VECTOR_DETAIL_PART_SEMANTIC_V2} from './vector_detail_import_v2.js';
import {deletionRequestV2,deletionReadTargetsV2,nativeAbsentElementIdsV2,DELETION_SEMANTIC_OUTPUT_V2}from './deletion_contract_v2.js';
import { isRegularSchedulePresentationEditV2 } from "./regular_schedule_presentation_v2.js";
import { projectParameterBindingReadIdV2 } from './project_parameter_binding_v2.js';
import {expandNativeAccessoryReadbackV2} from './native_preservation_snapshot_v2.js';
/**
 * Versioned application contract for post-apply verification capabilities.
 *
 * The Assignment Kernel owns the generic rule that postconditions require
 * target-bound authoritative evidence. This adapter owns Revit-specific
 * knowledge about which reviewed capability result shapes can expose each
 * desired-state semantic output.
 */

import { isExcludedEvidenceContainerV2 } from "./verification_payload_boundary_v2.js";
import { visibilityTargetTokensV2 } from "./visibility_view_contract_v2.js";
import { artifactTargetTokensV2 } from "./native_artifact_contract_v2.js";
import { decodeNativeTagPropertyReadV2, nativeTagPropertyReadTargetsV2, existingTagRepairRequestV2 } from "./tag_property_readback_v2.js";
import { createdTagRequestV2, decodeNativeCreatedTagReadV2, nativeCreatedTagReadTargetsV2 } from "./created_tag_postcondition_v2.js";
import { nativeElementBooleanReadTargetsV1, nativeElementBooleanReadbackV1 } from './native_element_property_readback_v1.js';
import { isScheduleCellBackgroundEditV2 } from './schedule_cell_appearance_v2.js';
import {nativeSchedulePresentationRequestV2,nativeSchedulePresentationReadTargetsV2,nativeSchedulePresentationObservedTargetsV2} from './native_schedule_presentation_v2.js';
import {isNativePhaseFilterEditV2,nativePhaseFilterReadTargetsV2,decodeNativePhaseFilterReadV2}from './native_phase_filter_v2.js';
import {familySessionVerificationTargetsV2} from './family_session_verification_v2.js';
import {familyLabelStyleReadTargetV2, familyLabelStyleTargetTokensV2} from './family_label_style_v2.js';
import {VECTOR_STROKE_CAD_SEMANTIC_V2,vectorStrokeCadReadRequestV2,isVectorStrokeCadSourcePathV2} from './vector_stroke_cad_readback_v2.js';

export const VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA =
  "revit-operator.verification-capability-admission/v2" as const;

export type VerificationCapabilityAdmissionV2 = Readonly<{
  schema: typeof VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA;
  admissible: boolean;
  reason: string;
  required_semantic_outputs: readonly string[];
  provided_semantic_outputs: readonly string[];
  admissible_readback_paths: readonly string[];
}>;

export const OPERATION_TARGET_SELECTOR_V2_SCHEMA =
  "revit-operator.operation-target-selector/v2" as const;

export type OperationTargetSelectorV2 = Readonly<{
  schema: typeof OPERATION_TARGET_SELECTOR_V2_SCHEMA;
  source: "reviewed_capability_contract" | "legacy_generic_fallback";
  principal_target_tokens: readonly string[];
  contextual_scope_tokens: readonly string[];
}>;

type OperationContract = Readonly<{
  capability_id?: unknown;
  arguments?: unknown;
  method?: unknown;
  path?: unknown;
  tool?: unknown;
  target_id?: unknown;
}>;

const TEXT_NOTE_MUTATION_PATHS = new Set([
  "/revit/replace-text-note",
  "/revit/set-text-note-text",
  "revit_replace_text_note"
]);

const PARAMETER_MUTATION_PATHS = new Set([
  "/revit/set-parameter",
  "/revit/set-parameters",
  "/revit/set-type-parameters",
  "/revit/update-panel-parameter",
  "/revit/update-parameter-by-query",
  "revit_set_parameters",
  "revit_set_type_parameters"
]);

type RevitRouteContractV2 = Readonly<{
  semantic_outputs: readonly string[];
  principal_target_fields?: readonly string[];
  contextual_scope_fields?: readonly string[];
  preferred_target_field?: string;
}>;

/**
 * One reviewed contract owns both what a route can prove and which identifiers
 * name the affected subject. Scope/filter identifiers deliberately stay
 * separate: a view containing an element is not the element changed by an
 * apply, and therefore cannot bind its postcondition readback.
 */
const REVIT_ROUTE_CONTRACTS = new Map<string, RevitRouteContractV2>([
  ['/revit/load-family', {semantic_outputs: []}],
  ['/revit/save-family-doc', {semantic_outputs: []}],
  ['/revit/load-family-doc', {semantic_outputs: []}],
  ['/revit/reload-family-edit-session', {semantic_outputs: []}],
  ['/revit/set-family-label-style', {semantic_outputs: []}],
  ['/revit/inspect-family-label-styles', {semantic_outputs: ['family_session.label_style']}],
  ['/revit/import-vector-detail',{semantic_outputs:[],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewId']}],
  ['/revit/import-vector-annotations',{semantic_outputs:[],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewId']}],
  ['/revit/inspect-vector-detail',{semantic_outputs:[VECTOR_DETAIL_PART_SEMANTIC_V2],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewId']}],
  ['/revit/import-excel-output',{semantic_outputs:[],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewId']}],
  ['/revit/inspect-excel-import',{semantic_outputs:[EXCEL_TABLE_PART_SEMANTIC_V2],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewId']}],
  ['/revit/import-drawing-spec',{semantic_outputs:[],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewIds']}],
  ['/revit/inspect-drawing-spec',{semantic_outputs:['drawing_spec.source_text_format_and_bounds'],principal_target_fields:['manifestElementId'],contextual_scope_fields:['viewIds']}],
  ['/revit/project-parameters', {semantic_outputs:['project_parameter.binding'],principal_target_fields:['parameterId']}],
  ["/revit/place-view", {semantic_outputs: [], principal_target_fields: ["id"], contextual_scope_fields: ["sheetId", "viewId"]}],
  ["/revit/create-text", {semantic_outputs: [], principal_target_fields: ["textNoteId"], contextual_scope_fields: ["viewId"]}],
  ["/revit/schedules", { semantic_outputs: ["schedule.cell_appearance","schedule.created_definition","view.identity"], principal_target_fields: ["scheduleId", "id"] }],
  ["/revit/create-schedule", { semantic_outputs: [], principal_target_fields: ["viewId","scheduleId","id"], contextual_scope_fields: ["sourceScheduleId","sheetId"] }],
  ["/revit/sheets", {
    semantic_outputs: ["sheet.placement_anchors"],
    principal_target_fields: ["placementIds", "instanceId", "viewportId"],
    contextual_scope_fields: ["sheetId", "sheetElementId"]
  }],
  ["/revit/update-schedule-cell", { semantic_outputs: [], principal_target_fields: ["sourceElementId", "affectedElementIds"], contextual_scope_fields: ["scheduleId"] }],
  ["/revit/native-api-ops", { semantic_outputs: ["tag.property_values", "tag.created_subject_association", "schedule.presentation_values", "phase_filter.presentation",DELETION_SEMANTIC_OUTPUT_V2] }],
  ['/revit/delete',{semantic_outputs:[],principal_target_fields:['ids','requestedIds']}],
  ["/revit/connect-existing-mep-branch", {
    semantic_outputs: [], principal_target_fields: ["mainElementId", "secondMainElementId", "teeElementId", "branchElementId", "terminalElementId", "createdFittingId", "createdBridgeId", "accessoryTypeId", "createdAccessoryId", "createdDuctId"]
  }],
  ["/revit/get-connectors", {
    semantic_outputs: ["mep.physical_connector_graph"], principal_target_fields: ["id", "elementIds"]
  }],
  ["/revit/place-mep-accessory-interactively", {
    semantic_outputs: [], principal_target_fields: ["accessoryTypeId", "elementId"], contextual_scope_fields: ["viewId"]
  }],
  ["revit_get_connectors", {
    semantic_outputs: ["mep.physical_connector_graph"], principal_target_fields: ["id", "elementIds"]
  }],
  ["/revit/duplicate-view", {
    semantic_outputs: [],
    principal_target_fields: ["viewId"],
    contextual_scope_fields: ["sourceViewId"]
  }],
  ["/revit/views", {
    semantic_outputs: ["view.identity"],
    principal_target_fields: ["id", "ids"]
  }],
  ["/revit/view-owned-detailing", {
    semantic_outputs: ["view.identity", "view.detailing_inventory",DETAIL_LINE_GEOMETRY_SEMANTIC_V2],
    principal_target_fields: ["id", "viewId", "viewIds"]
  }],
  ["/revit/inspect-exported-files", { semantic_outputs: ["artifact.file_digest", "artifact.saved_document_state", "family_session.saved_artifact"], principal_target_fields: ["paths"], preferred_target_field: "paths" }],
  ["/revit/visibility", {
    semantic_outputs: ["view.visibility_properties"],
    preferred_target_field: "viewId"
  }],
  ["/revit/find-text-notes", {
    semantic_outputs: ["text_note.value", "text_note.created_attributes"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds", "preservationScheduleIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["revit_find_text_notes", {
    semantic_outputs: ["text_note.value"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["/revit/find-family-text-notes", {
    semantic_outputs: ["text_note.value"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["familyDocumentId", "ownerViewId"],
    preferred_target_field: "elementId"
  }],
  ["/revit/get-element-summary", {
    semantic_outputs: ["element.identity", "element.classification", "element.location", "family.placement", "family.loaded_identity", "electrical.circuit_membership"],
    principal_target_fields: ["id", "ids", "elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["revit_get_element_summary", {
    semantic_outputs: ["element.identity", "element.classification", "element.location", "family.placement", "family.loaded_identity", "electrical.circuit_membership"],
    principal_target_fields: ["id", "ids", "elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["/revit/get-parameters", {
    semantic_outputs: ["element.parameter_values"],
    principal_target_fields: ["id", "elementId", "elementIds", "requestedElementIds", "preservationScheduleIds"]
  }],
  ["revit_get_parameters", {
    semantic_outputs: ["element.parameter_values"],
    principal_target_fields: ["id", "elementId", "elementIds", "requestedElementIds"]
  }],
  ["/revit/verify-parameter-on-sheet", {
    semantic_outputs: ["element.parameter_values", "sheet.identity"],
    principal_target_fields: ["sheetViewId", "sheetId", "elementId"]
  }],
  ["/revit/set-parameter", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/set-parameters", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["revit_set_parameters", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/set-type-parameters", {
    semantic_outputs: [],
    principal_target_fields: ["typeId", "typeIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["revit_set_type_parameters", {
    semantic_outputs: [],
    principal_target_fields: ["typeId", "typeIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/update-panel-parameter", {
    semantic_outputs: [],
    principal_target_fields: ["panelId", "elementId", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/update-parameter-by-query", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"]
  }],
  ["/revit/replace-text-note", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }],
  ["revit_replace_text_note", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }],
  ["/revit/set-text-note-text", {
    semantic_outputs: [],
    principal_target_fields: ["elementId", "elementIds", "affectedElementIds", "updatedElementIds"],
    contextual_scope_fields: ["viewId", "ownerViewId"]
  }]
]);

// Typed schedule reads have the same reviewed outputs and argument predicates as their native route.
REVIT_ROUTE_CONTRACTS.set("revit_list_schedules", REVIT_ROUTE_CONTRACTS.get("/revit/schedules")!);

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pathOf(value: OperationContract): string {
  // Typed MCP operations carry the alias in capability_id and do not persist a
  // duplicate path/tool field. Treat that alias as the reviewed contract key
  // so typed and generic compositions make the same admission decision.
  return normalizedText(value.path ?? value.tool ?? value.capability_id);
}

function normalizedField(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function tokensFromReviewedFields(value: unknown, fields: readonly string[]): readonly string[] {
  const admitted = new Map(fields.map((field) => [normalizedField(field), normalizedField(field)]));
  const tokens = new Set<string>();
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (depth > 10 || tokens.size >= 128 || node === null || node === undefined) return;
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), key, depth + 1); return; } catch {}
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        if (isExcludedEvidenceContainerV2(childKey)) continue;
        visit(child, childKey, depth + 1);
      }
      return;
    }
    const field = admitted.get(normalizedField(key));
    if (!field) return;
    const scalar = String(node).trim().toLowerCase();
    if (!scalar || scalar.length > 260 || /[\u0000-\u001f\u007f]/.test(scalar)) return;
    tokens.add(`${field}:${scalar}`);
    if (/^-?\d+$/.test(scalar)) tokens.add(`id:${scalar}`);
  };
  visit(value);
  return [...tokens].sort();
}

/**
 * Extract the principal affected identity using the same reviewed capability
 * contract that admits the verification result. Unknown routes retain the
 * bounded legacy fallback; known routes fail closed instead of treating a
 * scope/filter ID as the affected subject.
 */
export function operationTargetSelectorV2(input: Readonly<{
  operation: OperationContract;
  value: unknown;
  fallback_target_tokens?: readonly string[];
}>): OperationTargetSelectorV2 {
  if (['/revit/save-family-doc','/revit/load-family-doc','/revit/reload-family-edit-session','/revit/load-family'].includes(pathOf(input.operation)))
    return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',principal_target_tokens:familySessionVerificationTargetsV2(input.value),contextual_scope_tokens:[]};
  if (['/revit/set-family-label-style', '/revit/inspect-family-label-styles'].includes(pathOf(input.operation)))
    return {schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA, source: 'reviewed_capability_contract',
      principal_target_tokens: familyLabelStyleTargetTokensV2(input.value), contextual_scope_tokens: []};
  if(pathOf(input.operation)==='/revit/project-parameters'){
    const v=objectValue(input.value),b=objectValue(v.body??v),p=objectValue(v.parameter),id=b.parameterId??p.id;
    return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:Number.isSafeInteger(id)&&Number(id)>0?['id:'+id,'parameterid:'+id]:[],contextual_scope_tokens:[]};
  }
  if(pathOf(input.operation)==='/revit/native-api-mutation-ops'){
    if(isNativeDetailLineGraphEditV2(input.operation.arguments??input.value)){
      const graph=nativeDetailLineGraphRequestV2(input.operation.arguments??input.value);
      return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',principal_target_tokens:graph?['id:'+graph.viewId]:[],contextual_scope_tokens:[]};
    }
    const deletion=deletionRequestV2({...objectValue(input.operation.arguments??{body:input.value}),path:pathOf(input.operation)});
    if(deletion)return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',principal_target_tokens:deletion.ids.map(id=>'id:'+id).sort(),contextual_scope_tokens:[]};
    const g=nativeSchedulePresentationRequestV2(input.operation.arguments??input.value,input.value);
    if(g)return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',principal_target_tokens:g.scheduleIds.map(id=>'id:'+id),contextual_scope_tokens:[]};
    if(nativeSchedulePresentationRequestV2(input.operation.arguments??input.value))return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',principal_target_tokens:[],contextual_scope_tokens:[]};
  }
  if(pathOf(input.operation)==='/revit/native-api-ops'){
    const ids=nativeSchedulePresentationReadTargetsV2(input.operation.arguments??input.value);
    if(ids.length)return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:(nativeSchedulePresentationObservedTargetsV2(input.value).length?nativeSchedulePresentationObservedTargetsV2(input.value):nativeSchedulePresentationReadTargetsV2(input.value)).map(id=>'id:'+id),contextual_scope_tokens:[]};
  }
  if (pathOf(input.operation) === '/revit/configure-schedule' && isRegularSchedulePresentationEditV2(input.operation.arguments)) {
    const v=objectValue(input.value), body=objectValue(v.body??v), schedule=objectValue(v.schedule);
    return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:tokensFromReviewedFields({scheduleId:body.scheduleId??schedule.id},['scheduleId']),contextual_scope_tokens:[]};
  }
  if (pathOf(input.operation) === "/revit/configure-schedule" && isScheduleCellBackgroundEditV2(input.operation.arguments)) {
    return { schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA, source: "reviewed_capability_contract",
      principal_target_tokens: tokensFromReviewedFields(input.value, ["scheduleId"]), contextual_scope_tokens: [] };
  }
  if (pathOf(input.operation) === "/revit/tag-elements" && Number.isSafeInteger(objectValue(input.value).repairExistingTagId)) {
    return { schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA, source: "reviewed_capability_contract",
      principal_target_tokens: tokensFromReviewedFields(input.value, ["repairExistingTagId"]),
      contextual_scope_tokens: tokensFromReviewedFields(input.value, ["viewId"]) };
  }
  const contract = REVIT_ROUTE_CONTRACTS.get(pathOf(input.operation));
  if(pathOf(input.operation)==='/revit/link-cad'&&isVectorStrokeCadSourcePathV2(objectValue(input.value).sourcePath))return{
    schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
    principal_target_tokens:tokensFromReviewedFields(input.value,['elementId']),
    contextual_scope_tokens:tokensFromReviewedFields(input.value,['viewId','ownerViewId'])};
  if (!contract) {
    return {
      schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
      source: "legacy_generic_fallback",
      principal_target_tokens: [...new Set(input.fallback_target_tokens ?? [])].sort(),
      contextual_scope_tokens: []
    };
  }
  if(pathOf(input.operation)==='/revit/view-owned-detailing'){
    const value=objectValue(input.value);
    if(value.cadTargetOnly===true||value.schema==='revit-operator.cad-geometry-target/v1')return{
      schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:tokensFromReviewedFields(value,['cadElementId','requestedCadElementId']),
      contextual_scope_tokens:tokensFromReviewedFields(value,['viewId','requestedViewId'])};
  }
  if (pathOf(input.operation) === "/revit/duplicate-view") {
    // The request's viewId names the source. The native result uses viewId for
    // the newly created view and sourceViewId for the source. Never let a
    // source-only request bind a post-apply observation of the source.
    const created = tokensFromReviewedFields(input.value, ["sourceViewId"]).length > 0;
    return {
      schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
      source: "reviewed_capability_contract",
      principal_target_tokens: created ? tokensFromReviewedFields(input.value, ["viewId"]) : [],
      contextual_scope_tokens: created
        ? tokensFromReviewedFields(input.value, ["sourceViewId"])
        : tokensFromReviewedFields(input.value, ["viewId"])
    };
  }
  if (pathOf(input.operation) === "/revit/native-api-ops") {
    const value = objectValue(input.value);
    const request={method:input.operation.method??'POST',...objectValue(input.operation.arguments??{body:value}),path:'/revit/native-api-ops'};
    const returnedNative=Array.isArray(value.operations)&&value.version==='operator.native_api_ops.v2';
    const phaseRead=returnedNative?decodeNativePhaseFilterReadV2(request,value):null;
    const phaseTargets=returnedNative?(phaseRead?[phaseRead.id]:[]):nativePhaseFilterReadTargetsV2(request);
    const booleanTargets=nativeElementBooleanReadTargetsV1(request).filter(token=>!returnedNative
      || nativeElementBooleanReadbackV1(request,value,Number(token.slice(3)),'HasStripedRows','Autodesk.Revit.DB.ViewSchedule')!==undefined);
    // A creation-association graph also looks up the tagged subject as context.
    // That lookup is not a second changed target or a deletion absence probe.
    const createdTagTargets = nativeCreatedTagReadTargetsV2(request);
    const tagTargets = returnedNative
      ? decodeNativeTagPropertyReadV2(input.operation.arguments, value)?.map(item => `id:${item.element_id}`)
        ?? decodeNativeCreatedTagReadV2(input.operation.arguments, value)?.map(item => `id:${item.id}`) ?? []
      : [...nativeTagPropertyReadTargetsV2(value), ...nativeCreatedTagReadTargetsV2(input.operation.arguments ?? {method:'POST',path:'/revit/native-api-ops',body:value})];
    return { schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA, source: "reviewed_capability_contract",
      principal_target_tokens: [...new Set([...tagTargets,...booleanTargets,...phaseTargets.map(id=>'id:'+id),
        ...(createdTagTargets.length?[]:returnedNative?nativeAbsentElementIdsV2(request,value):deletionReadTargetsV2(request)).map(id=>'id:'+id)])].sort(), contextual_scope_tokens: [] };
  }
  if(pathOf(input.operation)==='/revit/get-connectors' && (objectValue(input.value).includeNativePlacementState===true
    ||Object.hasOwn(objectValue(input.value),'nativePlacementState')
    ||['operator.native_preservation_json.v1','operator.native_preservation_json.v2'].includes(String(objectValue(input.value).schema)))) {
    const value=objectValue(input.value);
    // Native readback may be a bounded lossless codec envelope. Inspect its
    // returned scope, never the request echoed in operation.arguments. This
    // projection grants no proof; source/digest, exact scope and the complete
    // independent preservation comparator remain mandatory at settlement.
    let observed:Record<string,any>|undefined;
    if(value.includeNativePlacementState!==true)try{
      const state=objectValue(expandNativeAccessoryReadbackV2(value).nativePlacementState);
      if(state.schema==='operator.native_accessory_placement_state.v1'&&state.complete===true)observed=state;
    }catch{/* Malformed/oversized/damaged codecs remain targetless. */}
    const changed=value.includeNativePlacementState===true?value.placementChangedIds:observed?.requestedChangedIds;
    const cohort=value.includeNativePlacementState===true?value.elementIds:observed?.requestedElementIds;
    const valid=(a:unknown,max:number):a is number[]=>Array.isArray(a)&&a.length<=max
      &&a.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(a).size===a.length;
    // A full native placement read contains unchanged system owners as context.
    // Its explicit changed-owner cohort is the verification target, including
    // non-connector owners. Do not truncate it via the generic 128-token scan.
    // These request tokens grant no proof: admission separately requires the
    // exact native-bound full read scope and the unchanged semantic comparator.
    return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:valid(changed,1024)&&changed.length&&valid(cohort,5000)&&cohort.length
        ?changed.map(n=>'id:'+n).sort():[],contextual_scope_tokens:[]};
  }
  if(['/revit/get-parameters','/revit/get-element-summary'].includes(pathOf(input.operation)??'')) {
    const value=objectValue(input.value), scope=objectValue(value.schedulePreservation);
    if(value.preservationScheduleIds!==undefined||value.schedulePreservation!==undefined) {
      const summary=pathOf(input.operation)==='/revit/get-element-summary';
      const targets=Array.isArray(value.elementIds)?value.elementIds:Array.isArray(value.items)?value.items.map((x:any)=>x?.id):summary&&Array.isArray(value.result)?value.result.map((x:any)=>x?.id):[];
      const schedules=value.preservationScheduleIds??scope.requestedElementIds;
      const valid=(a:unknown,max:number):a is number[]=>Array.isArray(a)&&a.length<=max&&a.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(a).size===a.length;
      return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
        principal_target_tokens:valid(targets,summary?500:100)&&targets.length&&valid(schedules,32)?[...new Set([...targets,...schedules])].sort((a,b)=>a-b).map(n=>'id:'+n):[],contextual_scope_tokens:[]};
    }
  }
  return {
    schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
    source: "reviewed_capability_contract",
    principal_target_tokens: pathOf(input.operation) === '/revit/find-text-notes'
      && (Array.isArray(objectValue(input.value).preservationScheduleIds) || objectValue(input.value).schedulePreservation != null)
      // These are exact document-global IDs. A new field-name alias is not a
      // second semantic target and must not prevent the strict cohort match.
      ? tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []).filter(token => token.startsWith('id:'))
      : pathOf(input.operation) === "/revit/sheets"
      // Placement IDs are document-global numeric element identities, while
      // the containing sheet is context. Do not emit an unreviewed plural
      // field-name alias that cannot bind to the native affected identity.
      ? tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []).filter(token => token.startsWith("id:"))
      : pathOf(input.operation) === "/revit/inspect-exported-files"
      ? [...artifactTargetTokensV2(input.value),...familySessionVerificationTargetsV2(input.value)]
      : pathOf(input.operation) === "/revit/visibility"
      ? visibilityTargetTokensV2(input.value)
      : tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []),
    contextual_scope_tokens: tokensFromReviewedFields(input.value, contract.contextual_scope_fields ?? [])
  };
}

function requiredSemanticOutputs(apply: OperationContract): readonly string[] {
  const path = pathOf(apply);
  if(path==='/revit/link-cad'&&isVectorStrokeCadSourcePathV2(objectValue(objectValue(apply.arguments).body).sourcePath))return [VECTOR_STROKE_CAD_SEMANTIC_V2];
  if (path === '/revit/save-family-doc') return ['family_session.saved_artifact'];
  if (['/revit/load-family-doc','/revit/reload-family-edit-session','/revit/load-family'].includes(path)) return ['family.loaded_identity'];
  if (path === '/revit/set-family-label-style') return ['family_session.label_style'];
  if(deletionRequestV2({...objectValue(apply.arguments),path}))return [DELETION_SEMANTIC_OUTPUT_V2];
  if(path==='/revit/create-schedule')return ['schedule.created_definition'];
  if(path==='/revit/import-drawing-spec')return ['drawing_spec.source_text_format_and_bounds'];
  if(path==='/revit/import-excel-output')return [EXCEL_TABLE_PART_SEMANTIC_V2];
  if(path==='/revit/import-vector-detail'||path==='/revit/import-vector-annotations')return [VECTOR_DETAIL_PART_SEMANTIC_V2];
  if(path==='/revit/project-parameters')return ['project_parameter.binding'];
  if (path === '/revit/place-view') return ['sheet.placement_anchors'];
  if (path === '/revit/create-text') return ['text_note.created_attributes'];
  if(path==='/revit/native-api-mutation-ops'&&isNativeDetailLineGraphEditV2(apply.arguments))return[DETAIL_LINE_GEOMETRY_SEMANTIC_V2];
  if(path==='/revit/native-api-mutation-ops'&&nativeSchedulePresentationRequestV2(apply.arguments))return ['schedule.presentation_values'];
  if(path==='/revit/native-api-mutation-ops'&&isNativePhaseFilterEditV2(apply.arguments))return ['phase_filter.presentation'];
  if (path === '/revit/configure-schedule' && isRegularSchedulePresentationEditV2(apply.arguments)) return ['schedule.native_presentation'];
  if (path === "/revit/configure-schedule" && isScheduleCellBackgroundEditV2(apply.arguments)) return ["schedule.cell_appearance"];
  if (path === "/revit/assign-electrical-circuit") return ["electrical.circuit_membership"];
  if (path === "/revit/tag-elements" && existingTagRepairRequestV2(apply.arguments))
    return ["tag.property_values"];
  if (path === "/revit/tag-elements" && createdTagRequestV2(apply.arguments)) return ["tag.created_subject_association"];
  if (path === "/revit/connect-existing-mep-branch") return ["mep.physical_connector_graph"];
  if (path === "/revit/place-mep-accessory-interactively") return ["mep.physical_connector_graph"];
  if (path === "/revit/duplicate-view") {
    const args = objectValue(apply.arguments);
    const body = objectValue(args.body);
    return body.withDetailing === false ? ["view.identity"] : ["view.identity", "view.detailing_inventory"];
  }
  if (path === "/revit/create-family-instance") return ["family.placement"];
  if (TEXT_NOTE_MUTATION_PATHS.has(path)) return ["text_note.value"];
  if (path === "/revit/update-schedule-cell" || PARAMETER_MUTATION_PATHS.has(path)) return ["element.parameter_values"];
  if (path === "/revit/visibility") return ["view.visibility_properties"];
  if (path === '/revit/save-as') return ['artifact.file_digest','artifact.saved_document_state'];
  if (path === "/revit/export-pdf" || path === "/revit/print" || path === "/revit/export-elements-xlsx") return ["artifact.file_digest"];
  return [];
}

function providedSemanticOutputs(verification: OperationContract): readonly string[] {
  const contract = REVIT_ROUTE_CONTRACTS.get(pathOf(verification));
  if (!contract) return [];
  if (pathOf(verification) === '/revit/inspect-family-label-styles')
    return normalizedText(verification.capability_id) === 'revit_call_tool' && familyLabelStyleReadTargetV2(verification.arguments) ? contract.semantic_outputs : [];
  if (normalizedText(verification.capability_id) !== "revit_call_tool"
      && pathOf(verification).startsWith("/revit/")) return [];
  if(pathOf(verification)==='/revit/view-owned-detailing'&&vectorStrokeCadReadRequestV2(verification.arguments))return [...contract.semantic_outputs,VECTOR_STROKE_CAD_SEMANTIC_V2];
  if(pathOf(verification)==='/revit/view-owned-detailing')return detailLineOwnerReadRequestV2(verification.arguments)!==null?contract.semantic_outputs:contract.semantic_outputs.filter(s=>s!==DETAIL_LINE_GEOMETRY_SEMANTIC_V2);
  if(pathOf(verification)==='/revit/inspect-drawing-spec')return drawingSpecInspectionReadIdV2(verification.arguments)!==null?contract.semantic_outputs:[];
  if(pathOf(verification)==='/revit/inspect-excel-import')return excelTableInspectionReadIdV2(verification.arguments)!==null?contract.semantic_outputs:[];
  if(pathOf(verification)==='/revit/inspect-vector-detail')return vectorDetailInspectionReadIdV2(verification.arguments)!==null?contract.semantic_outputs:[];
  if(pathOf(verification)==='/revit/project-parameters')return projectParameterBindingReadIdV2(verification.arguments)!==null?contract.semantic_outputs:[];
  if (pathOf(verification) === '/revit/find-text-notes') {
    const args=objectValue(verification.arguments), body=objectValue(args.body??args), ids=body.elementIds;
    return Array.isArray(ids) && ids.length===1 && Number.isSafeInteger(ids[0]) && Number(ids[0])>0
      && body.docId==null && body.familyDocumentId==null ? contract.semantic_outputs
      : contract.semantic_outputs.filter(output=>output!=='text_note.created_attributes');
  }
  if (["/revit/schedules", "revit_list_schedules"].includes(pathOf(verification))) {
    const args=objectValue(verification.arguments), body=objectValue(args.body??args);
    if(body.action==='detail'&&Number.isSafeInteger(body.scheduleId)&&Number(body.scheduleId)>0&&body.includeFields!==false)
      return ['schedule.created_definition','view.identity'];
    if(body.action==='presentation'&&Number.isSafeInteger(body.scheduleId)&&Number(body.scheduleId)>0
      && Object.keys(body).every(k=>['action','scheduleId'].includes(k)))return ['schedule.native_presentation'];
    return body.action==='cell_styles' && Number.isSafeInteger(body.scheduleId) && Number(body.scheduleId)>0
      && Array.isArray(body.cells) && body.cells.length>0 && body.cells.length<=64 ? ['schedule.cell_appearance'] : [];
  }
  if(pathOf(verification)==='/revit/inspect-exported-files'){
    const args=objectValue(verification.arguments), body=objectValue(args.body??args), paths=body.paths;
    if (Object.hasOwn(body,'familyDocumentId')) return typeof body.familyDocumentId === 'string' && /^[a-f0-9]{32}$/.test(body.familyDocumentId)
      && Array.isArray(paths) && paths.length===1 && typeof paths[0]==='string' && /\.rfa$/i.test(paths[0])
      ? ['artifact.file_digest','family_session.saved_artifact'] : [];
    return Array.isArray(paths)&&paths.length===1&&typeof paths[0]==='string'&&/\.(?:rvt|rfa)$/i.test(paths[0])
      ?['artifact.file_digest','artifact.saved_document_state']:['artifact.file_digest'];
  }
  if (pathOf(verification) === "/revit/native-api-ops")
    return nativePhaseFilterReadTargetsV2(verification.arguments).length ? ['phase_filter.presentation']
      : nativeSchedulePresentationReadTargetsV2(verification.arguments).length ? ['schedule.presentation_values']
      : nativeCreatedTagReadTargetsV2(verification.arguments).length ? ["tag.created_subject_association"]
      : nativeTagPropertyReadTargetsV2(verification.arguments).length ? ["tag.property_values"]
      : deletionReadTargetsV2(verification.arguments).length ? [DELETION_SEMANTIC_OUTPUT_V2] : [];
  if (pathOf(verification) === "/revit/get-element-summary") {
    const args = objectValue(verification.arguments), body = objectValue(args.body ?? args);
    return body.includeElectricalCircuitMembership === true ? contract.semantic_outputs
      : contract.semantic_outputs.filter(output => output !== "electrical.circuit_membership");
  }
  return contract.semantic_outputs;
}

function routesProviding(required: readonly string[]): readonly string[] {
  if (required.length === 0) return [];
  return [...REVIT_ROUTE_CONTRACTS.entries()]
    .filter(([, contract]) => required.every((semanticOutput) => contract.semantic_outputs.includes(semanticOutput)))
    .map(([path]) => path)
    .sort();
}

export function verificationCapabilityAdmissionV2(input: Readonly<{
  apply: OperationContract;
  verification: OperationContract;
}>): VerificationCapabilityAdmissionV2 {
  const required = requiredSemanticOutputs(input.apply);
  const provided = providedSemanticOutputs(input.verification);
  const admissibleReadbackPaths = routesProviding(required);
  if (required.length === 0) {
    return {
      schema: VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
      admissible: true,
      reason: "no_reviewed_semantic_output_constraint",
      required_semantic_outputs: [],
      provided_semantic_outputs: provided,
      admissible_readback_paths: []
    };
  }
  const missing = required.filter((semanticOutput) => !provided.includes(semanticOutput));
  return {
    schema: VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
    admissible: missing.length === 0,
    reason: missing.includes("text_note.value") ? "text_note_value_unavailable" : "required_semantic_output_unavailable",
    required_semantic_outputs: required,
    provided_semantic_outputs: provided,
    admissible_readback_paths: admissibleReadbackPaths
  };
}

export function verificationCapabilityAdmissionForPathsV2(
  applyPath: string,
  verificationPath: string,
  applyArguments?: unknown,
  verificationArguments?: unknown
): VerificationCapabilityAdmissionV2 {
  const contract = (path: string, args: unknown): OperationContract => path.startsWith("/")
    ? { capability_id: "revit_call_tool", path, arguments: { body: args } }
    : { capability_id: path, tool: path, arguments: args };
  return verificationCapabilityAdmissionV2({ apply: contract(applyPath, applyArguments), verification: contract(verificationPath, verificationArguments) });
}

export function verificationCapabilityGuidanceV2(apply: OperationContract): string | null {
  if (normalizedText(apply.capability_id)==='operator_run_dynamic_revit_program' && objectValue(objectValue(apply.arguments).native_program).entry_type)
    return ' Native C# parameter_checks declare desired text fields in the original call. The host separately reads those exact element IDs and native parameter names, then compares actual values; program return strings and code-alignment review are not this proof. The contract does not cover unchecked collateral targets or arbitrary geometry. Missing original checks cannot be added retroactively by replaying a committed edit. Keep the actual work and report the precise verification gap.';
  if(pathOf(apply)==='/revit/place-mep-accessory-interactively')return ' End the owned native placement prompt and consume its original result once. Use the provided separate get-connectors read plan with includeNativePlacementState=true and its exact physical/type/system/schedule/changed-ID scopes. Revit chooses the split IDs; do not guess their numeric order or replay insertion. Native fitted ports, reciprocal new connections, original spans, remote geometry and prescribed data must match independently. Existing remote side-tap geometry and mixed equipment port domains must remain unchanged; computed flow changes are observations, not proof of unchanged engineering performance. Incomplete or uncovered collateral stays unverified. Review the affected work and save the accepted result as requested.';
  if(pathOf(apply)==='/revit/connect-existing-mep-branch'&&objectValue(objectValue(apply.arguments).body??apply.arguments).connectionMode==='replace_tee_with_takeoff')
    return ' After a committed tee replacement, use the provided independent POST /revit/get-connectors read plan with includeTeeReplacementState=true. elementIds contains only the three surviving ducts/flex and the new bridge/takeoff. replacementRemovedIds carries the deleted tee and native-bound dependents; replacementTypeIds and preservationScheduleIds cover the preserved types and schedules. Do not send deleted, logical, type or schedule IDs to connector managers. Keep all references, coordinates and flex geometry. One current native callback must establish actual absence, fitted reciprocal topology, bridge span, retained parameters/far connections and ancillary preservation; apply-local success cannot verify. Review the affected sheet and save the accepted result as requested. Never repeat a committed replacement for proof.';
  if(pathOf(apply)==='/revit/connect-existing-mep-branch'&&objectValue(objectValue(apply.arguments).body??apply.arguments).connectionMode==='insert_inline_accessory')
    return ' After a committed inline insertion, use the provided independent read plan: POST /revit/get-connectors with includeInlineAccessoryState=true, exact physical host/split/accessory/remote elementIds and exact preservationScheduleIds from the native preservationBefore scope. Keep full references, coordinates, flex geometry and maxConnectorsPerElement=512. Do not send schedule/type IDs to connector managers. The native callback independently checks actual fitted dimensions, reciprocal connections, split span, far peers and unchanged parameter/type/schedule state. Apply-local success does not verify; incomplete or changed collateral remains unverified. Review affected-sheet appearance separately and save the accepted result as requested. Never repeat a committed insertion to obtain proof.';
  if(pathOf(apply)==='/revit/native-api-mutation-ops'&&isNativeDetailLineGraphEditV2(apply.arguments))return ' For a complete literal straight-detail-line graph only, the host attempts a separate POST /revit/view-owned-detailing with exact owner viewId and limit5000. Complete native owner inventory must match every newly committed line UID, owner and endpoint. This proves straight geometry only, not PDF/source equivalence, pen weight/color/style, clipping, typography or visual fidelity. Mixed graphs, collateral changes and incomplete or mismatching reads stay unverified. Never repeat the committed lines to obtain proof.';
  if (pathOf(apply) === '/revit/load-family') return ' For a new file load with overwriteParameterValues=false, verify the returned native familyId and ALL symbol IDs with a separate POST /revit/get-element-summary. Identity only does not prove source-file byte equivalence, overwritten content, label bindings, tag placement or whole-task completion. If the committed receipt includes complete unchanged schedulePreservation, include those modified schedule IDs in elementIds and preservationScheduleIds in that same independent read. Missing, changed or unsupported collateral remains unverified; existing-family replacement and deletions are not covered. Never load again merely to verify.';
  if (pathOf(apply) === '/revit/save-family-doc') return ' Verify once with POST /revit/inspect-exported-files, paths=[the exact saved native RFA path], familyDocumentId=the same tracked session. Match stable bytes/SHA256 and clean saved family state. An arbitrary inactive RFA is not an eligible active-document read. Never save again merely to verify.';
  if (['/revit/load-family-doc','/revit/reload-family-edit-session'].includes(pathOf(apply))) return ' Verify the native loadedFamilyId with a separate POST /revit/get-element-summary, elementIds=[loadedFamilyId]. This proves loaded identity only. After successful load, close the exact tracked family session with POST /revit/close-doc, familyDocumentId=that session, saveChanges=false, before inspecting the effective loaded project family. Use the loaded symbol IDs for scoped instance reassignment; verify typography and target-view appearance separately.';
  if (pathOf(apply) === '/revit/set-family-label-style') return ' Verify with a separate POST /revit/inspect-family-label-styles using the exact familyDocumentId session and labelTypeId. The fresh read must match expectedTypeUniqueId and all requested style values. This proves only the edited family session. Save As a distinct workspace RFA, load it, assign only the intended project tags and inspect their effective loaded family plus target-view appearance before claiming project completion. Never repeat a committed style edit merely to verify it.';
  if(deletionRequestV2({...objectValue(apply.arguments),path:pathOf(apply)}))return ' The host attempts a separate read of the complete retained deletion set, including dependent IDs. Native GetElement reads are batched at sixteen operations; every returned element must explicitly be null. Missing/truncated results, a parent-only check, the apply-local deletionVerified flag and screenshots cannot establish the full absence postcondition. Preserve an unverified committed change and obtain fresh scoped readback; never repeat its deletion merely to verify it. This structural check does not certify that the selected objects were the correct user targets.';
  if(pathOf(apply)==='/revit/import-drawing-spec')return ' Inspect the returned manifestElementId with POST /revit/inspect-drawing-spec and the same sourcePath. Its complete source/native check is separate from the paged note details. Inspect reported source ranges, expected runs and actual native identities to correct known mismatches; do not repeat an uncertain import. Source text/character-format/bounds checks do not establish visual fidelity or sheet placement.';
  if(pathOf(apply)==='/revit/import-excel-output')return ' Inspect the returned manifestElementId AND exact partIndex with POST /revit/inspect-excel-import and the same sourcePath. This verifies only that source/native table part, not all parts, sheet placement, visual fidelity or engineering values. Continue remainingPartIndices using the fresh importSnapshotSha256; never duplicate a committed part or retry an uncertain mutation. Review actual work-area visuals and save/reopen separately.';
  if(pathOf(apply)==='/revit/save-as')return ' Verify the exact output from the native Save As receipt with one separate POST /revit/inspect-exported-files, paths=[the saved RVT/RFA path]. Only the actual active saved document is eligible. Compare stable byte size/SHA256 and saved_document path, native session/project identity and is_modified=false; unknown, changing or dirty state remains unverified. This confirms a saved artifact, not completion of all model-content or visual tasks. Do not save again solely to verify or ask the user to reopen a successfully saved model.';
  if (pathOf(apply) === "/revit/tag-elements" && existingTagRepairRequestV2(apply.arguments))
    return " Verify the repaired existing tag with a separate POST /revit/native-api-ops read: Document.GetElement(ElementId) for repairExistingTagId, then read OwnerViewId plus every requested HasLeader, TagHeadPosition and LeaderEndCondition property from that exact IndependentTag handle. The fresh owner view and all requested values must match the admitted edit; the apply result cannot verify itself. Leader-end or elbow edits need reference-bound readback and remain unverified by this property check. Do not repeat a committed edit to verify it.";
  if (pathOf(apply) === "/revit/create-schedule") return " Inspect the created schedule using POST /revit/schedules with action=detail and scheduleId from the create result. Compare its name, category, ordered field names and hidden flags with the request. Inspect filterDefinitions and sortGroupDefinitions when requested, and page through table rows if the task requires complete contents or totals. A truncated row sample cannot establish all contents. Creation alone does not prove sheet placement; inspect the exact destination sheet separately when placement was requested. Do not create another schedule merely to verify the existing one.";
  if (pathOf(apply) === "/revit/connect-existing-mep-branch") return " Verify the existing main and branch/terminal plus any created takeoff fitting with one POST /revit/get-connectors, elementIds=[all affected IDs], includeAllRefs=true, onlyOpenPhysicalConnectors=false, maxConnectorsPerElement=512. The fresh native read must expose reciprocal native connector IDs for the new physical connection and preserve every prior main and branch connection. Logical references and apply-local success flags cannot prove connectivity. Additional family-name/workset constraints need separate reviewed readback and cannot be certified by this graph alone. Never reapply a committed connection to obtain verification.";
  if (pathOf(apply) === "/revit/duplicate-view") return " For a native Schedule copy with withDetailing=false, inspect POST /revit/schedules, action=detail, exact new scheduleId, includeFields=true, includeDefinitionSnapshot=true. The host compares the actual copied definition against the retained pre-transaction source; another source read after duplication cannot replace missing pre-clone evidence. Other views: verify the newly created view and source together with POST /revit/view-owned-detailing, viewIds=[source viewId, new viewId from the create result]. The native read must return both exact view IDs, the new requested name, complete nontruncated owner-view inventories, and matching nonempty annotation signatures when WithDetailing was requested. The create response, current view, /revit/views alone, and image filename do not prove copied annotations.";
  if (pathOf(apply) === "/revit/create-family-instance") return " Verify every created family instance with POST /revit/get-element-summary, elementIds=[all created instance IDs], or revit_get_element_summary with ids=[all created instance IDs]. The native readback must match model-space XYZ in feet, family/type, requested level, rotation and batch spacing. The create response only identifies the new elements; its coordinates cannot independently verify placement. Connector reads alone cannot verify the insertion point. View-based placement needs a separate verification contract.";
  if (["/revit/mep-route-workflow", "/revit/create-duct", "/revit/create-mep-route", "/revit/existing-conditions-mep-draft-workflow"].includes(pathOf(apply))) return " For explicit world XYZ ducts in model feet, prefer one POST /revit/get-connectors with includeVerificationParameters=true, includeAllRefs=true, includeCoordinateSystem=true, onlyOpenPhysicalConnectors=false and all created duct/fitting elementIds (maximum 500 unique IDs). This single native callback returns parameters and the physical graph together. Legacy fallback: first POST /revit/get-parameters with names=[System Classification,Reference Level,Width,Height,Diameter], then POST /revit/get-connectors with elementIds covering ALL created ducts and fittings and includeAllRefs=true. The combined native reads must match the admitted geometry, type, level, system and sizes. A polyline branch requires connectSegments=true and every internal fitting connection; endpoints may explicitly be open construction stages or required existing connections. Read both ducts and fittings in the same batches. Open construction stages do not establish completed-system connectivity. Parameters alone cannot verify connections. This does not certify PDF interpretation or visual review. Inspect the delivered post-change image separately; a JSON evidence ID is not an image ID. Never repeat an applied route merely to verify it.";
  if (["/revit/export-pdf", "/revit/print", "/revit/export-elements-xlsx"].includes(pathOf(apply))) return " Verify the exact exported files with POST /revit/inspect-exported-files, paths=[every output path from the native artifact receipt]. The readback must match every file path, byte size and SHA256. Do not export again to verify an existing export.";
  const required = requiredSemanticOutputs(apply);
  if (required.length === 0) return null;
  const paths = routesProviding(required);
  const target = normalizedText(apply.target_id);
  const numericTarget = target.match(/^id:(\d+)$/)?.[1];
  const selectors = paths.flatMap((path) => {
    const contract = REVIT_ROUTE_CONTRACTS.get(path);
    return contract?.preferred_target_field ? [`${path}.${contract.preferred_target_field}`] : [];
  });
  const exactSelector = numericTarget && selectors.length > 0
    ? ` Bind the exact affected subject with ${selectors.join(" or ")}=${numericTarget}; ${pathOf(apply) === "/revit/visibility" ? "use action=get and read the returned view.id and requested property." : "contextual scope fields such as viewId do not establish affected-target identity."}`
    : "";
  return ` Required semantic outputs: ${required.join(", ")}. Reviewed readback routes: ${paths.join(", ")}.${exactSelector}`;
}
