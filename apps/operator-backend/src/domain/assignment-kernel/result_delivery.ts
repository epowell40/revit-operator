import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { operationUsesCurrentInputsV2 } from "./input_result_freshness.js";
import { operationHasAppliedNativeArtifactV2 } from "./semantic_admissibility.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "./outcome.js";
import { sameAssignmentBindingV2 } from "./identity.js";

export interface AssignmentResultItemV2 {
  label: string;
  observation_id: string;
  /** Exact JSON object keys/array indexes used only to present retained data. */
  path: readonly (string | number)[];
  value: unknown;
  value_source?: "raw_payload" | "deterministic_projection";
  evidence_ref: string;
  payload_hash: string;
  /** Failed read diagnostics can be reported, but never establish success. */
  presentation_kind?: "result" | "diagnostic";
}

export interface AssignmentResultDeliveryV2 {
  items: readonly AssignmentResultItemV2[];
  assessment?: AssignmentAssessmentV2;
}

/** Assistant interpretation of cited values; never evaluator authority. */
export interface AssignmentAssessmentV2 {
  overview: string;
  findings: readonly { priority: "high" | "medium" | "low"; title: string; text: string; evidence_indices: readonly number[] }[];
  limitations: readonly string[];
  questions: readonly string[];
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= max;
}

export function validateAssignmentAssessmentV2(value: unknown, items: readonly AssignmentResultItemV2[]): asserts value is AssignmentAssessmentV2 {
  const a = value as AssignmentAssessmentV2;
  if (!a || typeof a !== "object" || Array.isArray(a)
      || Object.keys(a).some(key => !["overview", "findings", "limitations", "questions"].includes(key))
      || !boundedText(a.overview, 1200) || !Array.isArray(a.findings) || a.findings.length < 1 || a.findings.length > 12
      || !Array.isArray(a.limitations) || a.limitations.length > 8 || a.limitations.some(text => !boundedText(text, 800))
      || !Array.isArray(a.questions) || a.questions.length > 3 || a.questions.some(text => !boundedText(text, 600))) {
    throw new Error("assignment_assessment_invalid");
  }
  for (const finding of a.findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)
        || Object.keys(finding).some(key => !["priority", "title", "text", "evidence_indices"].includes(key))
        || !["high", "medium", "low"].includes(finding.priority) || !boundedText(finding.title, 160) || !boundedText(finding.text, 1200)
        || !Array.isArray(finding.evidence_indices) || finding.evidence_indices.length < 1 || finding.evidence_indices.length > 8
        || new Set(finding.evidence_indices).size !== finding.evidence_indices.length
        || finding.evidence_indices.some((index: number) => !Number.isSafeInteger(index) || index < 1 || index > items.length)) {
      throw new Error("assignment_assessment_finding_invalid");
    }
  }
  // An assessment should present selected answer values, never whole native
  // inventories. The full hash-checked payload remains retained separately.
  const scalar = (item: unknown) => item === null || ["string", "number", "boolean"].includes(typeof item);
  if (items.some(item => JSON.stringify(item.value).length > 800
      || !(scalar(item.value) || (Array.isArray(item.value) && item.value.length <= 12 && item.value.every(scalar))))) {
    throw new Error("assignment_assessment_select_concise_values: select scalar resultItems or small scalar arrays instead of whole reports or inventories");
  }
}

/** One owner for the model index and the canonical presentation validator. */
export function resultObservationEligibilityV2(snapshot: AssignmentSnapshotV2, observationId: string): "result" | "diagnostic" | "ineligible" {
  const observation = snapshot.observations[observationId];
  const operation = observation ? snapshot.operations[observation.operation_id] : undefined;
  if (!observation || !operation || !sameAssignmentBindingV2(snapshot.current_binding, observation.binding)
      || !["native-host", "dynamic-runtime"].includes(observation.authority)
      || operation.settlement_state !== "settled") return "ineligible";
  const applied = operation.requested_effect === "apply" ? operation
    : operation.verification_of_operation_id ? snapshot.operations[operation.verification_of_operation_id] : undefined;
  if (!operationUsesCurrentInputsV2(snapshot, operation) || (applied && !operationUsesCurrentInputsV2(snapshot, applied))) return "ineligible";
  const verifiedArtifact = snapshot.spec.requested_effect === "apply" && snapshot.spec.result_delivery_required
    && applied && operationHasAppliedNativeArtifactV2(applied)
    && appliedOperationHasVerifiedPostconditionV2(snapshot, applied.operation_id);
  const artifactResult = verifiedArtifact && observation.authority === "native-host"
    && (operation.requested_effect === "apply" && observation.evidence_class === "task_result"
      || operation.requested_effect === "read" && operation.purpose === "verification" && observation.evidence_class === "verification");
  if (!artifactResult && (operation.requested_effect !== "read" || observation.evidence_class !== "task_result")) return "ineligible";
  if (operation.result?.status === "succeeded") return "result";
  if (observation.authority === "dynamic-runtime" && operation.result?.status === "failed_after_dispatch"
      && operation.result.persistent_effect === "none") return "diagnostic";
  return "ineligible";
}

/** Presentation never manufactures semantic facts or changes criterion truth. */
export function validateResultDeliveryV2(snapshot: AssignmentSnapshotV2, delivery: AssignmentResultDeliveryV2): void {
  if (!snapshot.spec.result_delivery_required || !["read", "apply"].includes(snapshot.spec.requested_effect)) {
    throw new Error("assignment_result_delivery_not_required");
  }
  if (!Array.isArray(delivery.items) || delivery.items.length < 1 || delivery.items.length > 32
      || JSON.stringify(delivery).length > 32_000) throw new Error("assignment_result_delivery_invalid");
  for (const item of delivery.items) {
    const observation = snapshot.observations[item.observation_id];
    const operation = observation ? snapshot.operations[observation.operation_id] : undefined;
    const eligibility = resultObservationEligibilityV2(snapshot, item.observation_id);
    const diagnostic = item.presentation_kind === "diagnostic" && eligibility === "diagnostic"
      && item.value_source !== "deterministic_projection"
      && ["execution_status", "diagnostics", "logs"].includes(String(item.path?.[0]));
    if ((item.value_source !== undefined && !["raw_payload", "deterministic_projection"].includes(item.value_source))
        || (item.value_source === "deterministic_projection" && (item.path?.length !== 2
          || !["key_counts", "key_facts"].includes(String(item.path[0]))
          || !["string", "number", "boolean"].includes(typeof item.value) && item.value !== null))
        || (item.presentation_kind === "diagnostic" && !diagnostic)
        || (item.presentation_kind !== undefined && !["result", "diagnostic"].includes(item.presentation_kind))
        || !item.label?.trim() || item.label.length > 160 || item.value === undefined
        || !Array.isArray(item.path) || item.path.length < 1 || item.path.length > 24) {
      throw new Error("assignment_result_item_invalid");
    }
    if (!observation || (!diagnostic && eligibility !== "result")
        || item.evidence_ref !== observation.raw_payload_ref || item.payload_hash !== observation.raw_payload_hash) {
      throw new Error("assignment_result_observation_ineligible");
    }
  }
  if (snapshot.spec.result_assessment_required && !delivery.assessment) throw new Error("assignment_result_assessment_required");
  if (delivery.assessment !== undefined) validateAssignmentAssessmentV2(delivery.assessment, delivery.items);
}

export function renderResultDeliveryV2(delivery: AssignmentResultDeliveryV2): string {
  if (delivery.assessment) {
    const a = delivery.assessment;
    const priorities = { high: 0, medium: 1, low: 2 };
    const findings = [...a.findings].sort((left, right) => priorities[left.priority] - priorities[right.priority]);
    const evidence = delivery.items.map((item, i) => `- [${i + 1}] ${item.label}${item.presentation_kind === "diagnostic" ? " (failed run)" : ""}: ${Array.isArray(item.value) ? item.value.join(", ") : String(item.value)}`).join("\n");
    return ["## Assessment", a.overview,
      ...findings.map(finding => `### ${finding.priority[0]!.toUpperCase() + finding.priority.slice(1)} priority: ${finding.title}\n${finding.text} ${finding.evidence_indices.map(index => `[${index}]`).join(" ")}`),
      ...(a.limitations.length ? ["## Not verified", a.limitations.map(text => `- ${text}`).join("\n")] : []),
      ...(a.questions.length ? ["## Questions", a.questions.map((text, i) => `${i + 1}. ${text}`).join("\n")] : []),
      "## Model evidence", evidence].join("\n\n");
  }
  return delivery.items.map(item => `- ${item.label}${item.presentation_kind === "diagnostic" ? " (failed run)" : ""}: ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`).join("\n");
}
