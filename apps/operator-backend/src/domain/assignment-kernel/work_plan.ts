import { verifiedNativeWorkTargetIdentitiesV2 } from "./verified_work_targets.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "./outcome.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import { kernelAssertV2 } from "./errors.js";

export type AssignmentWorkPlanItemV2 = Readonly<{
  item_id: string; description: string; source_basis: string; declared_at: string;
  kind?: "edit" | "inspection"; depends_on?: readonly string[]; inspection?: WorkPlanInspectionV2;
  operation_ids: readonly string[]; completed_at?: string;
}>;
export type AssignmentWorkPlanV2 = Readonly<{
  schema: "revit-operator.assignment-work-plan/v2";
  items: readonly AssignmentWorkPlanItemV2[]; assumptions: readonly string[];
}>;
export type WorkPlanInspectionV2 = Readonly<{ observation_ids: readonly string[]; target_ids: readonly string[] }>;
export type WorkPlanDeclarationV2 = Readonly<{
  items: readonly { item_id: string; description: string; source_basis: string; kind?: "edit" | "inspection"; depends_on?: readonly string[] }[];
  assumptions: readonly string[];
}>;
const validText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0
  && new TextEncoder().encode(v).byteLength <= max && !/[\u0000-\u0008]/.test(v);

/** Scope is a model interpretation. Completion needs host-verified operations;
 * existing scope is append-only and cannot silently disappear after a restart. */
export function declareWorkPlanV2(snapshot: AssignmentSnapshotV2, declaration: WorkPlanDeclarationV2, occurredAt: string): AssignmentWorkPlanV2 {
  kernelAssertV2(snapshot.spec.requested_effect === "apply", "work_plan_effect_unsupported", "This work plan tracks model edits.");
  kernelAssertV2(Array.isArray(declaration.items) && declaration.items.length > 0 && declaration.items.length <= 128
    && Array.isArray(declaration.assumptions) && declaration.assumptions.length <= 16
    && declaration.assumptions.every(value => validText(value, 800)), "work_plan_invalid", "Provide bounded scope items and assumptions.");
  const prior = snapshot.work_plan?.items ?? [];
  kernelAssertV2(prior.length > 0 || !Object.values(snapshot.operations).some(op => op.requested_effect === "apply" && op.dispatch_state !== "not_dispatched"),
    "work_plan_after_apply", "Declare the drawing scope before its first edit.");
  const ids = new Set(prior.map(item => item.item_id));
  const added = declaration.items.map(item => {
    kernelAssertV2(item && typeof item.item_id === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(item.item_id)
      && validText(item.description, 800) && validText(item.source_basis, 800) && !ids.has(item.item_id),
      "work_plan_item_invalid", "Use unique stable item IDs and source descriptions; existing items cannot be replaced or removed.");
    kernelAssertV2(item.kind === undefined || item.kind === "edit" || item.kind === "inspection", "work_plan_kind_invalid", "Use edit or inspection.");
    kernelAssertV2(item.kind === "inspection" ? Array.isArray(item.depends_on) && item.depends_on.length > 0 && item.depends_on.length <= 128
      && new Set(item.depends_on).size === item.depends_on.length && item.depends_on.every((id:string) => [...prior, ...declaration.items].some(p => p.item_id === id && p.kind !== "inspection"))
      : item.depends_on === undefined, "work_plan_dependencies_invalid", "Inspections must name edit items whose completed work they inspect.");
    ids.add(item.item_id);
    return { ...item, declared_at: occurredAt, operation_ids: [] };
  });
  kernelAssertV2(ids.size <= 128 && (!snapshot.spec.work_plan_required || prior.length > 0 || added.length >= 2),
    "work_plan_scope_incomplete", "Break the multi-part request into at least two independently verifiable work items.");
  const assumptions = [...new Set([...(snapshot.work_plan?.assumptions ?? []), ...declaration.assumptions])];
  kernelAssertV2(assumptions.length <= 32, "work_plan_assumption_limit", "Retain existing assumptions; the plan has reached its bounded assumption limit.");
  return { schema: "revit-operator.assignment-work-plan/v2", items: [...prior, ...added], assumptions };
}

export function completeWorkPlanItemV2(snapshot: AssignmentSnapshotV2, itemId: string, operationIds: readonly string[], occurredAt: string, inspection?: WorkPlanInspectionV2): AssignmentWorkPlanV2 {
  const plan = snapshot.work_plan, item = plan?.items.find(candidate => candidate.item_id === itemId);
  kernelAssertV2(Boolean(plan && item && (!item.completed_at || item.kind === "inspection" && !inspectionIsCurrentV2(snapshot, item))), "work_plan_item_not_pending", "Complete an existing unfinished work item.");
  kernelAssertV2(Array.isArray(operationIds) && operationIds.length > 0 && operationIds.length <= 128
    && new Set(operationIds).size === operationIds.length, "work_plan_proof_missing", "Cite every applied operation for this item.");
  if (item!.kind === "inspection") {
    const completed = { ...item!, operation_ids: [...operationIds].sort(), completed_at: occurredAt, inspection };
    kernelAssertV2(inspectionIsCurrentV2(snapshot, completed), "work_plan_inspection_unverified", "Inspect all dependent completed edits with fresh complete native connector reads after the latest edit. This records inspection coverage, not an engineering pass.");
    return { ...plan!, items: plan!.items.map(candidate => candidate.item_id === itemId ? completed : candidate) };
  }
  kernelAssertV2(!inspection, "work_plan_edit_inspection_invalid", "Read-only inspection cannot complete an edit item.");
  const used = new Set(plan!.items.flatMap(candidate => [...candidate.operation_ids]));
  for (const operationId of operationIds) {
    const operation = snapshot.operations[operationId];
    kernelAssertV2(operation && !used.has(operationId) && sameAssignmentBindingV2(operation.binding, snapshot.current_binding)
      && operation.requested_effect === "apply" && operation.persistent_effect === "applied" && operation.settlement_state === "settled"
      && Date.parse(operation.opened_at) >= Date.parse(item!.declared_at)
      && appliedOperationHasVerifiedPostconditionV2(snapshot, operationId),
      "work_plan_operation_unverified", "Each item needs distinct current independently verified work performed after its declaration.");
  }
  return { ...plan!, items: plan!.items.map(candidate => candidate.item_id !== itemId ? candidate
    : { ...candidate, operation_ids: [...operationIds].sort(), completed_at: occurredAt }) };
}

export function inspectionIsCurrentV2(snapshot: AssignmentSnapshotV2, item: AssignmentWorkPlanItemV2): boolean {
  if (item.kind !== "inspection" || !item.completed_at || !item.inspection || !item.depends_on?.length || !item.operation_ids.length) return false;
  const dependencies = item.depends_on.map(id => snapshot.work_plan?.items.find(p => p.item_id === id));
  if (dependencies.some(p => !p || p.kind === "inspection" || !p.completed_at || !p.operation_ids.length || p.operation_ids.some(id => !appliedOperationHasVerifiedPostconditionV2(snapshot,id)))) return false;
  const expected = dependencies.flatMap(p => p!.operation_ids.flatMap(id => verifiedNativeWorkTargetIdentitiesV2(snapshot,id)));
  if (!expected.length || expected.some(id => !item.inspection!.target_ids.includes(id))) return false;
  const lastEdit = Math.max(Date.parse(item.declared_at), ...Object.values(snapshot.operations).filter(op => op.persistent_effect === "applied").map(op => Date.parse(op.result?.completed_at ?? "")));
  return Number.isFinite(lastEdit) && item.operation_ids.every(id => {
    const op = snapshot.operations[id], result = op?.result;
    return op?.requested_effect === "read" && op.persistent_effect === "none" && op.settlement_state === "settled"
      && result?.authority === "native-host" && result.status === "succeeded" && result.dispatch_state === "dispatched"
      && Date.parse(op.opened_at) > lastEdit
      && sameAssignmentBindingV2(op.binding,snapshot.current_binding) && sameAssignmentBindingV2(result.binding,snapshot.current_binding)
      && item.inspection!.observation_ids.some(oid => op.observation_ids.includes(oid) && snapshot.observations[oid]?.authority === "native-host"
        && snapshot.observations[oid]?.raw_payload_hash === result.raw_payload_hash && sameAssignmentBindingV2(snapshot.observations[oid]!.binding,snapshot.current_binding));
  });
}

export function workPlanPendingV2(snapshot: AssignmentSnapshotV2): boolean {
  return Boolean(snapshot.spec.work_plan_required && !snapshot.work_plan
    || snapshot.work_plan && snapshot.work_plan.items.some(item => !item.completed_at
      || (item.kind === "inspection" ? !inspectionIsCurrentV2(snapshot,item) : item.operation_ids.some(id => !appliedOperationHasVerifiedPostconditionV2(snapshot, id)))));
}
