export const EVIDENCE_REF_SCHEMA = "revit-operator.evidence-ref.v1" as const;
export const EVIDENCE_PROJECTION_SCHEMA = "revit-operator.evidence-projection.v1" as const;
export const EVIDENCE_RETRIEVAL_SCHEMA = "revit-operator.evidence-retrieval.v1" as const;
export const EVIDENCE_TELEMETRY_SCHEMA = "revit-operator.evidence-telemetry.v1" as const;

export type EvidenceTrustLevel =
  | "untrusted_caller"
  | "host_observed"
  | "trusted_projection"
  | "authoritative_native"
  | "authoritative_readback";

export type EvidenceVerificationRelevance = "none" | "supporting" | "required" | "authoritative";

export type EvidenceScope = {
  session_id: string;
  assignment_id?: string | null;
  run_id?: string | null;
  attempt_id?: string | null;
  generation?: number | null;
};

export type EvidenceRelationship = {
  evidence_id: string;
  relation: "parent" | "derived_from" | "before" | "after" | "receipt_for" | "capture_for";
};

export type EvidenceRefV1 = {
  schema: typeof EVIDENCE_REF_SCHEMA;
  evidence_id: string;
  content_hash: string;
  byte_count: number;
  media_type: string;
  source: string;
  trust_level: EvidenceTrustLevel;
  assignment_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  generation: number | null;
  session_id: string;
  target_scope: string[];
  bounded_summary: string;
  key_typed_facts: Record<string, string | number | boolean | null>;
  artifact_location: string;
  redaction_status: "not_needed" | "screened";
  secret_screening_status: "passed";
  created_at_utc: string;
  verification_relevance: EvidenceVerificationRelevance;
  relationships: EvidenceRelationship[];
};

export type EvidenceProjectionV1 = {
  schema: typeof EVIDENCE_PROJECTION_SCHEMA;
  evidence_id: string;
  content_hash: string;
  byte_count: number;
  media_type: string;
  source: string;
  trust_level: EvidenceTrustLevel;
  effect_state: "none" | "unknown" | "applied" | null;
  assignment_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  target_scope: string[];
  key_counts: Record<string, number>;
  key_facts: Record<string, string | number | boolean | null>;
  before_hash: string | null;
  after_hash: string | null;
  diagnostics: string[];
  artifact_ref: string;
  verification_relevance: EvidenceVerificationRelevance;
  additional_evidence: boolean;
  projected_bytes: number;
  truncated: boolean;
};

export type EvidenceStoreInput = {
  scope: EvidenceScope;
  source: string;
  media_type?: string;
  trust_level: EvidenceTrustLevel;
  target_scope?: string[];
  bounded_summary?: string;
  verification_relevance?: EvidenceVerificationRelevance;
  relationships?: EvidenceRelationship[];
  raw: Buffer | string | unknown;
};

export type EvidenceStoreResult = {
  ref: EvidenceRefV1;
  projection: EvidenceProjectionV1;
  stored_unique_bytes: number;
  duplicate_bytes_avoided: number;
};

export type EvidenceRetrievalRequest = {
  schema?: typeof EVIDENCE_RETRIEVAL_SCHEMA;
  evidence_id: string;
  scope: EvidenceScope;
  fields?: string[];
  item_range?: { path: string; start: number; count: number };
  text_range?: { start: number; length: number };
  target_subset?: string[];
  image?: boolean;
  max_bytes?: number;
  purpose: string;
};

export type EvidenceRetrievalResult = {
  schema: typeof EVIDENCE_RETRIEVAL_SCHEMA;
  evidence_ref: EvidenceRefV1;
  selection: unknown;
  returned_bytes: number;
  complete: boolean;
};

export type EvidenceTelemetryEventV1 = {
  schema: typeof EVIDENCE_TELEMETRY_SCHEMA;
  recorded_at_utc: string;
  session_id: string;
  assignment_id: string | null;
  model_call_id: string | null;
  source: string;
  raw_evidence_bytes_produced: number;
  unique_evidence_bytes_stored: number;
  projected_bytes_sent: number;
  duplicate_bytes_avoided: number;
  evidence_items_expanded: number;
  budget_events: number;
  estimated_model_tokens_avoided: number | null;
};
