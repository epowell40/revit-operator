export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA: "revit-operator.assignment-kernel-session-index/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA: "revit-operator.assignment-kernel-session-index-response/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD: "assignment_kernel_v2_session_index";
export const OPERATION_RESULT_SEMANTIC_GAP_V2_SCHEMA: "revit-operator.operation-result-semantic-gap/v2";

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

export const ASSIGNMENT_KERNEL_V2_CONTROL_EVIDENCE_SCHEMA: "revit-operator.assignment-kernel-control-evidence/v2";

export interface AssignmentKernelControlCapabilityV2 {
  readonly capability_id: string;
  readonly durable_result_evidence: boolean;
  readonly collection_fields: readonly string[];
}

export interface AssignmentKernelControlEvidenceFactV2 {
  readonly fact_id:
    | "control.capability_discovery_status"
    | "control.capability_available"
    | "control.evidence_retrieval_status"
    | "control.evidence_selection_available";
  readonly fact_class: "control";
  readonly value: string | boolean;
  readonly cardinality?: "many";
  readonly identity_dimensions?: readonly string[];
  readonly dimensions: Readonly<Record<string, string>>;
}

export const ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS: readonly string[];
export const ASSIGNMENT_KERNEL_V2_DURABLE_CONTROL_EVIDENCE_PRODUCER_IDS: readonly string[];
export function assignmentKernelControlCapabilityV2(capabilityId: unknown): AssignmentKernelControlCapabilityV2 | null;
export function isAssignmentKernelControlCapabilityV2(capabilityId: unknown): boolean;
export function isAssignmentKernelDurableControlEvidenceProducerV2(capabilityId: unknown): boolean;
export function assignmentKernelControlEvidenceFactsV2(
  capabilityId: unknown,
  value: unknown
): readonly AssignmentKernelControlEvidenceFactV2[];
