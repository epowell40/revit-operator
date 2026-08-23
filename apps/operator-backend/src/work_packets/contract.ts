import type {
  AssignmentAttemptPurpose,
  AssignmentEffectAuthority,
  AssignmentEffectState,
  AssignmentRequestedEffect,
  AssignmentRetryDelta,
  AssignmentVerificationState
} from "../assignments/control_plane.js";

export const VERIFIED_WORK_PACKET_SCHEMA = "revit-operator.verified-work-packet/v1" as const;
export const VERIFIED_WORK_PACKET_VERSION = 1 as const;

export type VerifiedWorkPacketStatus =
  | "verified_complete"
  | "complete_with_issues"
  | "verified_no_op"
  | "blocked_truthfully"
  | "awaiting_clarification"
  | "failed"
  | "rolled_back";

export type VerifiedWorkCriterionStatus = "pass" | "fail" | "uncertain" | "not_applicable";
export type VerifiedWorkTrust =
  | "agent_reported"
  | "native_execution_evidence"
  | "independently_verified"
  | "uncertain_or_missing";

export type PacketEvidenceReference = {
  evidence_id: string;
  content_hash: string | null;
  byte_count: number | null;
  media_type: string | null;
  artifact_location: string | null;
  trust: VerifiedWorkTrust;
  verification_relevance: string | null;
  bounded_summary: string | null;
};

export type VerifiedWorkAcceptanceCriterion = {
  requirement: string;
  status: VerifiedWorkCriterionStatus;
  authority: string;
  trust: VerifiedWorkTrust;
  observed_value: unknown;
  expected_value: unknown;
  evidence_references: PacketEvidenceReference[];
  reason: string;
};

export type VerifiedWorkTarget = {
  identity: string;
  element_id: string | null;
  view_id: string | null;
  sheet_id: string | null;
  family_id: string | null;
  type_id: string | null;
  system_id: string | null;
  room_id: string | null;
  space_id: string | null;
  level_id: string | null;
  host_id: string | null;
  side: string | null;
  orientation: string | null;
  circuit_id: string | null;
  before_state_references: PacketEvidenceReference[];
};

export type VerifiedWorkAction = {
  attempt_id: string;
  run_id: string;
  generation: number;
  purpose: AssignmentAttemptPurpose;
  requested_effect: AssignmentRequestedEffect;
  action_path: string;
  tool_identity: string;
  action_signature: string;
  target_fingerprint: string;
  target_identities: string[];
  affected_target_identities: string[];
  attempt_state: string;
  admission: { state: string; reason: string | null; authority: string | null };
  dispatch: { state: string; reason: string | null; dispatch_id: string | null };
  effect: { state: AssignmentEffectState; reason: string; authority: AssignmentEffectAuthority; authority_id: string | null };
  verification: { state: AssignmentVerificationState; reason: string | null };
  receipt_references: PacketEvidenceReference[];
  evidence_references: PacketEvidenceReference[];
  retry_of_attempt_id: string | null;
  retry_delta: AssignmentRetryDelta | null;
  reconciliation_of_attempt_id: string | null;
  result: string;
  trust: VerifiedWorkTrust;
};

export type VerifiedWorkCollateralCheck = {
  invariant: string;
  status: VerifiedWorkCriterionStatus;
  authority: string;
  trust: VerifiedWorkTrust;
  observed_value: unknown;
  expected_value: unknown;
  evidence_references: PacketEvidenceReference[];
  reason: string;
};

export type VerifiedWorkArtifact = {
  role: "before_capture" | "after_capture" | "highlighted_capture" | "export" | "report" | "raw_evidence" | "other";
  path: string | null;
  content_hash: string | null;
  byte_count: number | null;
  media_type: string | null;
  evidence_reference: PacketEvidenceReference | null;
  navigation_target: string | null;
};

export type VerifiedWorkIssue = {
  kind: "ambiguity" | "safe_blocker" | "product_limitation" | "verification_uncertainty" | "collateral_mutation" | "execution_failure" | "stale_evidence" | "user_action_required";
  summary: string;
  affected_attempt_ids: string[];
  evidence_references: PacketEvidenceReference[];
  user_action_required: string | null;
};

export type VerifiedWorkPacketV1 = {
  schema: typeof VERIFIED_WORK_PACKET_SCHEMA;
  packet_version: typeof VERIFIED_WORK_PACKET_VERSION;
  packet_id: string;
  packet_hash: string;
  parent_packet_id: string | null;
  identity: {
    assignment_id: string;
    run_id: string | null;
    generation: number;
    project_document_fingerprint: string | null;
    created_at: string;
    source_release_identity: string;
  };
  assignment: {
    normalized_user_request: string;
    requested_effect: AssignmentRequestedEffect | null;
    scope: string[];
    exclusions: string[];
    constraints: string[];
    authorization_envelope: Record<string, unknown> | null;
  };
  status: VerifiedWorkPacketStatus;
  status_reason: string;
  grounded_targets: VerifiedWorkTarget[];
  actions: VerifiedWorkAction[];
  acceptance_criteria: VerifiedWorkAcceptanceCriterion[];
  collateral_checks: VerifiedWorkCollateralCheck[];
  artifacts: VerifiedWorkArtifact[];
  issues: VerifiedWorkIssue[];
  rollback: {
    available: boolean | null;
    authority_or_transaction_identity: string | null;
    affected_target_identities: string[];
    completed: boolean;
    evidence_references: PacketEvidenceReference[];
  };
  performance: {
    elapsed_ms: number | null;
    model_calls: number | null;
    revit_calls: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    estimated_cost_usd: number | null;
    telemetry_complete: boolean;
    human_intervention: boolean | null;
  };
  trust_presentation: {
    overall: VerifiedWorkTrust;
    agent_reported: string;
    native_execution_evidence: string;
    independently_verified: string;
    uncertain_or_missing: string;
  };
};

export type PersistedVerifiedWorkPacket = {
  packet: VerifiedWorkPacketV1;
  json_path: string;
  markdown_path: string;
  created: boolean;
};
