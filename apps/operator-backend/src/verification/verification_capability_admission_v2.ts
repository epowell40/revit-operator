import { isRegularSchedulePresentationEditV2 } from "./regular_schedule_presentation_v2.js";
import { projectParameterBindingReadIdV2 } from './project_parameter_binding_v2.js';
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
  ["/revit/native-api-ops", { semantic_outputs: ["tag.property_values", "tag.created_subject_association", "schedule.presentation_values", "phase_filter.presentation"] }],
  ["/revit/connect-existing-mep-branch", {
    semantic_outputs: [], principal_target_fields: ["mainElementId", "branchElementId", "terminalElementId", "createdFittingId"]
  }],
  ["/revit/get-connectors", {
    semantic_outputs: ["mep.physical_connector_graph"], principal_target_fields: ["id", "elementIds"]
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
    semantic_outputs: ["view.identity", "view.detailing_inventory"],
    principal_target_fields: ["id", "viewId", "viewIds"]
  }],
  ["/revit/inspect-exported-files", { semantic_outputs: ["artifact.file_digest", "artifact.saved_document_state"], principal_target_fields: ["paths"], preferred_target_field: "paths" }],
  ["/revit/visibility", {
    semantic_outputs: ["view.visibility_properties"],
    preferred_target_field: "viewId"
  }],
  ["/revit/find-text-notes", {
    semantic_outputs: ["text_note.value", "text_note.created_attributes"],
    principal_target_fields: ["elementId", "elementIds", "requestedElementIds"],
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
    semantic_outputs: ["element.identity", "element.classification", "element.location", "family.placement", "electrical.circuit_membership"],
    principal_target_fields: ["id", "ids", "elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["revit_get_element_summary", {
    semantic_outputs: ["element.identity", "element.classification", "element.location", "family.placement", "electrical.circuit_membership"],
    principal_target_fields: ["id", "ids", "elementId", "elementIds", "requestedElementIds"],
    contextual_scope_fields: ["viewId"]
  }],
  ["/revit/get-parameters", {
    semantic_outputs: ["element.parameter_values"],
    principal_target_fields: ["id", "elementId", "elementIds", "requestedElementIds"]
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
  if(pathOf(input.operation)==='/revit/project-parameters'){
    const v=objectValue(input.value),b=objectValue(v.body??v),p=objectValue(v.parameter),id=b.parameterId??p.id;
    return {schema:OPERATION_TARGET_SELECTOR_V2_SCHEMA,source:'reviewed_capability_contract',
      principal_target_tokens:Number.isSafeInteger(id)&&Number(id)>0?['id:'+id,'parameterid:'+id]:[],contextual_scope_tokens:[]};
  }
  if(pathOf(input.operation)==='/revit/native-api-mutation-ops'){
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
  if (!contract) {
    return {
      schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
      source: "legacy_generic_fallback",
      principal_target_tokens: [...new Set(input.fallback_target_tokens ?? [])].sort(),
      contextual_scope_tokens: []
    };
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
    const request={...objectValue(input.operation.arguments??{body:value}),path:'/revit/native-api-ops'};
    const returnedNative=Array.isArray(value.operations)&&value.version==='operator.native_api_ops.v2';
    const phaseRead=returnedNative?decodeNativePhaseFilterReadV2(request,value):null;
    const phaseTargets=returnedNative?(phaseRead?[phaseRead.id]:[]):nativePhaseFilterReadTargetsV2(request);
    const booleanTargets=nativeElementBooleanReadTargetsV1(request).filter(token=>!returnedNative
      || nativeElementBooleanReadbackV1(request,value,Number(token.slice(3)),'HasStripedRows','Autodesk.Revit.DB.ViewSchedule')!==undefined);
    const tagTargets = returnedNative
      ? decodeNativeTagPropertyReadV2(input.operation.arguments, value)?.map(item => `id:${item.element_id}`)
        ?? decodeNativeCreatedTagReadV2(input.operation.arguments, value)?.map(item => `id:${item.id}`) ?? []
      : [...nativeTagPropertyReadTargetsV2(value), ...nativeCreatedTagReadTargetsV2(input.operation.arguments ?? {method:'POST',path:'/revit/native-api-ops',body:value})];
    return { schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA, source: "reviewed_capability_contract",
      principal_target_tokens: [...new Set([...tagTargets,...booleanTargets,...phaseTargets.map(id=>'id:'+id)])].sort(), contextual_scope_tokens: [] };
  }
  return {
    schema: OPERATION_TARGET_SELECTOR_V2_SCHEMA,
    source: "reviewed_capability_contract",
    principal_target_tokens: pathOf(input.operation) === "/revit/sheets"
      // Placement IDs are document-global numeric element identities, while
      // the containing sheet is context. Do not emit an unreviewed plural
      // field-name alias that cannot bind to the native affected identity.
      ? tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []).filter(token => token.startsWith("id:"))
      : pathOf(input.operation) === "/revit/inspect-exported-files"
      ? artifactTargetTokensV2(input.value)
      : pathOf(input.operation) === "/revit/visibility"
      ? visibilityTargetTokensV2(input.value)
      : tokensFromReviewedFields(input.value, contract.principal_target_fields ?? []),
    contextual_scope_tokens: tokensFromReviewedFields(input.value, contract.contextual_scope_fields ?? [])
  };
}

function requiredSemanticOutputs(apply: OperationContract): readonly string[] {
  const path = pathOf(apply);
  if(path==='/revit/create-schedule')return ['schedule.created_definition'];
  if(path==='/revit/project-parameters')return ['project_parameter.binding'];
  if (path === '/revit/place-view') return ['sheet.placement_anchors'];
  if (path === '/revit/create-text') return ['text_note.created_attributes'];
  if(path==='/revit/native-api-mutation-ops'&&nativeSchedulePresentationRequestV2(apply.arguments))return ['schedule.presentation_values'];
  if(path==='/revit/native-api-mutation-ops'&&isNativePhaseFilterEditV2(apply.arguments))return ['phase_filter.presentation'];
  if (path === '/revit/configure-schedule' && isRegularSchedulePresentationEditV2(apply.arguments)) return ['schedule.native_presentation'];
  if (path === "/revit/configure-schedule" && isScheduleCellBackgroundEditV2(apply.arguments)) return ["schedule.cell_appearance"];
  if (path === "/revit/assign-electrical-circuit") return ["electrical.circuit_membership"];
  if (path === "/revit/tag-elements" && existingTagRepairRequestV2(apply.arguments))
    return ["tag.property_values"];
  if (path === "/revit/tag-elements" && createdTagRequestV2(apply.arguments)) return ["tag.created_subject_association"];
  if (path === "/revit/connect-existing-mep-branch") return ["mep.physical_connector_graph"];
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
  if (normalizedText(verification.capability_id) !== "revit_call_tool"
      && pathOf(verification).startsWith("/revit/")) return [];
  if(pathOf(verification)==='/revit/project-parameters')return projectParameterBindingReadIdV2(verification.arguments)!==null?contract.semantic_outputs:[];
  if (pathOf(verification) === '/revit/find-text-notes') {
    const args=objectValue(verification.arguments), body=objectValue(args.body??args), ids=body.elementIds;
    return Array.isArray(ids) && ids.length===1 && Number.isSafeInteger(ids[0]) && Number(ids[0])>0
      && body.docId==null && body.familyDocumentId==null ? contract.semantic_outputs
      : contract.semantic_outputs.filter(output=>output!=='text_note.created_attributes');
  }
  if (pathOf(verification) === "/revit/schedules") {
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
    return Array.isArray(paths)&&paths.length===1&&typeof paths[0]==='string'&&/\.(?:rvt|rfa)$/i.test(paths[0])
      ?contract.semantic_outputs:['artifact.file_digest'];
  }
  if (pathOf(verification) === "/revit/native-api-ops")
    return nativePhaseFilterReadTargetsV2(verification.arguments).length ? ['phase_filter.presentation']
      : nativeSchedulePresentationReadTargetsV2(verification.arguments).length ? ['schedule.presentation_values']
      : nativeCreatedTagReadTargetsV2(verification.arguments).length ? ["tag.created_subject_association"]
      : nativeTagPropertyReadTargetsV2(verification.arguments).length ? ["tag.property_values"] : [];
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
  verificationPath: string
): VerificationCapabilityAdmissionV2 {
  const contract = (path: string): OperationContract => path.startsWith("/")
    ? { capability_id: "revit_call_tool", path }
    : { capability_id: path, tool: path };
  return verificationCapabilityAdmissionV2({ apply: contract(applyPath), verification: contract(verificationPath) });
}

export function verificationCapabilityGuidanceV2(apply: OperationContract): string | null {
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
