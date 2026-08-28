export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA: "revit-operator.assignment-kernel-session-index/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA: "revit-operator.assignment-kernel-session-index-response/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD: "assignment_kernel_v2_session_index";

export interface AssignmentKernelV2SessionIndexBinding {
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  principal_id: string;
  document_fingerprint?: string;
}

export interface AssignmentKernelV2SessionIndexEntry {
  assignment_id: string;
  assignment_version: number;
  binding: AssignmentKernelV2SessionIndexBinding;
  outcome: string;
  terminal: boolean;
}

export interface AssignmentKernelV2SessionIndex {
  schema: typeof ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA;
  session_id: string;
  assignments: readonly AssignmentKernelV2SessionIndexEntry[];
}

export interface AssignmentKernelV2SessionIndexResponse {
  schema: typeof ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA;
  ok: true;
  assignment_kernel_v2_session_index: AssignmentKernelV2SessionIndex;
}

export function parseAssignmentKernelSessionIndexV2(value: unknown): AssignmentKernelV2SessionIndex;
export function assignmentKernelSessionIndexResponseV2(value: unknown): AssignmentKernelV2SessionIndexResponse;
export function parseAssignmentKernelSessionIndexResponseV2(value: unknown): AssignmentKernelV2SessionIndexResponse;
