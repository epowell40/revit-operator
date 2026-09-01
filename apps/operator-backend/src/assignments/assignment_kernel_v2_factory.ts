import { createHash } from "node:crypto";
import {
  ASSIGNMENT_SPEC_V2_SCHEMA,
  CRITERION_EVIDENCE_POLICY_V2_SCHEMA,
  SEMANTIC_EVIDENCE_CONTRACT_V2,
  sameAssignmentBindingV2,
  type AssignmentBindingV2,
  type AssignmentInputVariableV2,
  type AssignmentSnapshotV2,
  type AssignmentSpecV2,
  type RequestedEffectV2
} from "../domain/assignment-kernel/index.js";
import { getGoal, type GoalRecord } from "../goals/service.js";
import { getRequestAssignmentPrincipalId, requestMatchesAssignmentPrincipalId } from "../request_context.js";
import { missingOpaqueMutationInputs } from "../teammate_mutation_intent_binding.js";
import { createAssignmentKernelV2, getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

export type AssignmentKernelTurnBindingV2 = AssignmentBindingV2 & { kernel_version: 2 };

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strings(value: unknown, max = 80): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(item => text(item, 160)).filter(Boolean))].slice(0, max)
    : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value.normalize("NFC"), "utf8").digest("hex").slice(0, 20)}`;
}

function stableVariableId(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,159}$/.test(normalized)) throw new Error("assignment_kernel_v2_input_variable_invalid");
  return normalized;
}

function requestedEffect(goal: GoalRecord): RequestedEffectV2 {
  const effect = goal.work_budget?.requested_effect;
  if (effect === "read" || effect === "preview" || effect === "apply") return effect;
  throw new Error("assignment_kernel_v2_requested_effect_required");
}

function inventoryCriterionFacts(goal: GoalRecord, configuredFacts: readonly string[] = []): string[] | null {
  if (configuredFacts.some((fact) => fact.startsWith("inventory."))) return [...configuredFacts];
  const source = `${goal.objective}\n${goal.acceptance_criteria.join("\n")}\n${text(goal.work_budget?.source_user_request, 20_000)}`;
  if (!/\b(inventory|quantif(?:y|ication)|count|how many|group(?:ed|ing)?)\b/i.test(source)) return null;
  const grouped = /\b(group(?:ed|ing)?|family|type)\b/i.test(source);
  return ["inventory.complete", "inventory.total", ...(grouped ? ["inventory.group"] : [])];
}

function evidencePolicy(goal: GoalRecord, facts: readonly string[]) {
  const inventoryFacts = inventoryCriterionFacts(goal, facts);
  const requiredFacts = inventoryFacts ?? facts.map((fact) => fact === "result.available" ? "task.result_available" : fact);
  const inventory = requiredFacts.some((fact) => fact.startsWith("inventory."));
  return {
    semantic_fact_requirements: requiredFacts,
    evidence_policy: {
      schema: CRITERION_EVIDENCE_POLICY_V2_SCHEMA,
      allowed_evidence_classes: ["task_result" as const],
      allowed_fulfillment_roles: ["delegated_task_execution" as const],
      allowed_fact_classes: ["domain" as const],
      allowed_capability_ids: inventory
        ? ["revit_call_tool", "inventory.read", "native:POST:/revit/quantify"]
        : [],
      allowed_result_schema_ids: inventory
        ? ["operator-native/POST:/revit/quantify/v2", "operator-capability/inventory.read/v2"]
        : [],
      required_fact_ids: requiredFacts,
      require_native_dispatch: true,
      require_current_generation: true
    }
  };
}

function inputs(goal: GoalRecord): AssignmentInputVariableV2[] {
  const sourceRequest = text(goal.work_budget?.source_user_request, 20_000) || goal.objective;
  const declared = strings(goal.work_budget?.required_user_inputs);
  // An executable preview needs the same authenticated desired state as the
  // later apply. Read-only explanation and inspection requests remain exempt.
  const detected = requestedEffect(goal) !== "read" ? missingOpaqueMutationInputs(sourceRequest) : [];
  return [...new Set([...declared, ...detected].map(stableVariableId))].map(variableId => ({
    variable_id: variableId,
    value_state: "needs_input",
    required: true,
    sensitive: false
  }));
}

function criteria(goal: GoalRecord): AssignmentSpecV2["criteria"] {
  const configured = goal.work_budget?.assignment_kernel_v2_criteria;
  if (configured === undefined || configured === null) {
    if (goal.acceptance_criteria.length !== 1) throw new Error("assignment_kernel_v2_criterion_fact_contract_required");
    const requirement = goal.acceptance_criteria[0]!;
    const contract = evidencePolicy(goal, inventoryCriterionFacts(goal) ?? ["task.result_available"]);
    return [{
      criterion_id: stableId("criterion", requirement), requirement, required: true,
      ...contract,
      accepted_evaluator_authority_ids: ["operator-runtime"],
      accepted_observation_authority_ids: ["native-host", "dynamic-runtime", "operator-evidence-store"]
    }];
  }
  if (!Array.isArray(configured) || configured.length !== goal.acceptance_criteria.length) {
    throw new Error("assignment_kernel_v2_criterion_fact_contract_invalid");
  }
  const remaining = new Set(goal.acceptance_criteria);
  const output = configured.map((candidate) => {
    const row = object(candidate);
    const requirement = text(row.requirement, 1_200);
    const facts = strings(row.semantic_fact_requirements, 32);
    if (!remaining.delete(requirement) || facts.length < 1
        || facts.some(fact => !/^[a-z][a-z0-9_.:-]{0,159}$/.test(fact))) {
      throw new Error("assignment_kernel_v2_criterion_fact_contract_invalid");
    }
    return {
      criterion_id: stableId("criterion", requirement), requirement, required: row.required !== false,
      ...evidencePolicy(goal, facts),
      accepted_evaluator_authority_ids: ["operator-runtime"],
      accepted_observation_authority_ids: ["native-host", "dynamic-runtime", "operator-evidence-store"]
    };
  });
  if (remaining.size > 0) throw new Error("assignment_kernel_v2_criterion_fact_contract_invalid");
  return output;
}

/**
 * Converts the authenticated Goal creation edge into the one immutable V2
 * AssignmentSpec. Identity is injected from the durable Goal envelope; later
 * controllers may consume but never reclassify its requested effect.
 */
export function assignmentSpecFromGoalV2(input: Readonly<{
  goal: GoalRecord;
  run_id: string;
  generation?: number;
  document_fingerprint?: string;
  created_at?: string;
}>): AssignmentSpecV2 {
  const sessionId = text(input.goal.related_session_id, 200);
  // The authenticated request edge owns principal identity. Goal.created_by is
  // retained only as an internal/trusted-call fallback because historical Goal
  // records also use it for non-principal actor labels (for example auto_goal).
  const principalId = text(getRequestAssignmentPrincipalId(), 200) || text(input.goal.created_by, 200);
  const runId = text(input.run_id, 240);
  const documentFingerprint = text(input.document_fingerprint ?? input.goal.work_budget?.document_fingerprint, 500);
  if (!sessionId || !principalId || !runId) throw new Error("assignment_kernel_v2_trusted_binding_required");
  const binding: AssignmentBindingV2 = {
    assignment_id: input.goal.id,
    run_id: runId,
    generation: input.generation ?? 1,
    session_id: sessionId,
    principal_id: principalId,
    ...(documentFingerprint ? { document_fingerprint: documentFingerprint } : {})
  };
  const effect = requestedEffect(input.goal);
  const inputVariables = inputs(input.goal);
  const criterionSpecs = criteria(input.goal);
  return {
    schema: ASSIGNMENT_SPEC_V2_SCHEMA,
    binding,
    source_user_request: input.goal.objective,
    requested_effect: effect,
    semantic_evidence_contract: SEMANTIC_EVIDENCE_CONTRACT_V2,
    criteria: criterionSpecs,
    input_variables: inputVariables,
    work_units: [
      ...(effect === "read" ? [] : [{
        work_unit_id: "work-discovery",
        requested_effect: "read" as const,
        execution_class: "analysis" as const,
        dependency_ids: [] as string[], criterion_ids: criterionSpecs.map(criterion => criterion.criterion_id), input_variable_ids: [] as string[],
        independently_useful: false, safe_to_retain: true, rollback_scope: "none" as const
      }]),
      ...(effect === "apply" ? [{
        work_unit_id: "work-preview",
        requested_effect: "preview" as const,
        execution_class: "coupled_atomic" as const,
        dependency_ids: [] as string[], criterion_ids: criterionSpecs.map(criterion => criterion.criterion_id),
        input_variable_ids: inputVariables.map(variable => variable.variable_id),
        independently_useful: false, safe_to_retain: false, rollback_scope: "operation" as const
      }] : []),
      {
        work_unit_id: "work-primary",
        requested_effect: effect,
        execution_class: effect === "read" ? "analysis" : "independent",
        dependency_ids: [],
        criterion_ids: criterionSpecs.map(criterion => criterion.criterion_id),
        input_variable_ids: inputVariables.map(variable => variable.variable_id),
        independently_useful: true,
        safe_to_retain: true,
        rollback_scope: effect === "apply" ? "operation" : "none"
      },
      ...(effect === "apply" ? [{
        work_unit_id: "work-verification",
        requested_effect: "read" as const,
        execution_class: "analysis" as const,
        dependency_ids: [] as string[], criterion_ids: criterionSpecs.map(criterion => criterion.criterion_id), input_variable_ids: [] as string[],
        independently_useful: false, safe_to_retain: true, rollback_scope: "none" as const
      }] : []),
      {
        work_unit_id: "work-evidence",
        requested_effect: "read" as const,
        execution_class: "analysis" as const,
        dependency_ids: [], criterion_ids: criterionSpecs.map(criterion => criterion.criterion_id), input_variable_ids: [],
        independently_useful: false, safe_to_retain: true, rollback_scope: "none" as const
      }
    ],
    authorization_policy_id: text(input.goal.work_budget?.authorization_policy_id, 240) || "operator-default",
    ...(text(input.goal.work_budget?.deviation_policy_id, 240) ? { deviation_policy_id: text(input.goal.work_budget?.deviation_policy_id, 240) } : {}),
    ...(input.goal.work_budget?.target_binding && typeof input.goal.work_budget.target_binding === "object"
      ? { target_binding: structuredClone(input.goal.work_budget.target_binding as Record<string, unknown>) }
      : {}),
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createAssignmentKernelForGoalV2(input: Parameters<typeof assignmentSpecFromGoalV2>[0]): AssignmentKernelTurnBindingV2 {
  const spec = assignmentSpecFromGoalV2(input);
  const result = createAssignmentKernelV2(input.goal.id, spec, "trusted_assignment_edge");
  return { ...result.snapshot.current_binding, kernel_version: 2 };
}

export function assignmentKernelV2ForBinding(input: Readonly<{
  session_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
}>): { goal: GoalRecord; snapshot: AssignmentSnapshotV2; binding: AssignmentKernelTurnBindingV2 } | null {
  const goal = getGoal(input.assignment_id);
  const snapshot = goal ? getAssignmentKernelSnapshotV2(goal.id) : null;
  if (!goal || !snapshot) return null;
  const requestPrincipalId = getRequestAssignmentPrincipalId();
  if (requestPrincipalId && !requestMatchesAssignmentPrincipalId(
    snapshot.current_binding.principal_id,
    undefined,
    snapshot.current_binding.session_id
  )) return null;
  const proposed: AssignmentBindingV2 = {
    ...snapshot.current_binding,
    assignment_id: input.assignment_id,
    run_id: input.run_id,
    generation: input.generation,
    session_id: input.session_id
  };
  if (!sameAssignmentBindingV2(snapshot.current_binding, proposed)) return null;
  return { goal, snapshot, binding: { ...snapshot.current_binding, kernel_version: 2 } };
}
