import { ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import type { AssignmentBindingV2 } from "../identity.js";

export { ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA };

export type ExecutionFailureClassV2 = "provider" | "transport" | "runtime" | "canceled" | "resource_exhausted";
export type ExecutionFailurePhaseV2 =
  | "request_validation"
  | "runtime_setup"
  | "provider_start"
  | "provider_turn"
  | "response_handoff";

export interface ExecutionFailureV2 {
  schema: typeof ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA;
  failure_id: string;
  binding: AssignmentBindingV2;
  error_class: ExecutionFailureClassV2;
  phase: ExecutionFailurePhaseV2;
  code: string;
}

export function executionFailureCodeV2(errorClass: ExecutionFailureClassV2): string {
  if (errorClass === "transport") return "provider_transport_failed";
  if (errorClass === "canceled") return "execution_canceled";
  if (errorClass === "resource_exhausted") return "provider_resource_exhausted";
  if (errorClass === "runtime") return "assignment_runtime_failed";
  return "provider_execution_failed";
}

export function executionFailureOutcomeV2(errorClass: ExecutionFailureClassV2): "blocked" | "failed" {
  return errorClass === "provider" || errorClass === "runtime" ? "failed" : "blocked";
}
