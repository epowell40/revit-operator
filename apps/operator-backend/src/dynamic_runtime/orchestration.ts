import { createHash } from "node:crypto";

export const DYNAMIC_REPAIR_FEEDBACK_SCHEMA = "dynamic_program_repair_feedback/v1" as const;
export const DYNAMIC_CONTEXT_BUNDLE_SCHEMA = "dynamic_program_context_bundle/v1" as const;
export const DYNAMIC_LIFECYCLE_SCHEMA = "dynamic_program_lifecycle/v1" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FAILURE_CLASSES = new Set([
  "compiler", "source_policy", "sandbox", "rpc_validation", "unsupported_operation", "revit_exception",
  "effect_budget", "verification_mismatch", "spatial_evidence"
]);

export type DynamicRepairFeedbackV1 = {
  schema: typeof DYNAMIC_REPAIR_FEEDBACK_SCHEMA;
  attempt_id: string;
  attempt_number: number;
  phase: "preview" | "apply";
  failure_class: string;
  program_hash: string;
  admission_id: string;
  diagnostic_codes: string[];
  failing_element_identity_hashes: string[];
  structured_evidence_hash: string;
  outcome_uncertain: boolean;
};

export type DynamicPreviewRepairPlan = {
  previous_attempt_id: string;
  next_attempt_number: number;
  revised_source_hash: string;
  revised_program_hash: string;
  requires_new_admission: true;
  apply_retry_authorized: false;
};

export function planDynamicPreviewRepair(args: {
  feedback: DynamicRepairFeedbackV1;
  revised_source_hash: string;
  revised_program_hash: string;
  maximum_attempts?: number;
}): DynamicPreviewRepairPlan {
  const maximum = args.maximum_attempts ?? 3;
  const feedback = args.feedback;
  if (!feedback || feedback.schema !== DYNAMIC_REPAIR_FEEDBACK_SCHEMA || feedback.phase !== "preview" || feedback.outcome_uncertain
    || !Number.isSafeInteger(feedback.attempt_number) || feedback.attempt_number < 1 || feedback.attempt_number >= maximum
    || maximum < 1 || maximum > 10 || !FAILURE_CLASSES.has(feedback.failure_class)) {
    throw new Error("Dynamic program repair is not permitted for this phase, outcome, failure, or attempt bound.");
  }
  requireHash(feedback.program_hash, "feedback.program_hash"); requireHash(feedback.structured_evidence_hash, "feedback.structured_evidence_hash");
  requireHash(args.revised_source_hash, "revised_source_hash"); requireHash(args.revised_program_hash, "revised_program_hash");
  if (feedback.program_hash === args.revised_program_hash) throw new Error("Dynamic program repair must produce a distinct program hash.");
  if (!boundedText(feedback.attempt_id, 160) || !boundedText(feedback.admission_id, 160)) throw new Error("Dynamic repair identity is invalid.");
  validateBoundedSet(feedback.diagnostic_codes, 64, 160, false, "diagnostic_codes");
  validateBoundedSet(feedback.failing_element_identity_hashes, 1024, 71, true, "failing_element_identity_hashes");
  return {
    previous_attempt_id: feedback.attempt_id,
    next_attempt_number: feedback.attempt_number + 1,
    revised_source_hash: args.revised_source_hash,
    revised_program_hash: args.revised_program_hash,
    requires_new_admission: true,
    apply_retry_authorized: false
  };
}

export type ApprovedDynamicContextEntry = {
  scope: "company" | "project" | "user";
  semantic_summary: string;
  content_hash: string;
  provenance_hash: string;
  approval_hash: string;
  approved_for_model_context: true;
};

export type DynamicProgramContextBundleV1 = {
  schema: typeof DYNAMIC_CONTEXT_BUNDLE_SCHEMA;
  entries: ApprovedDynamicContextEntry[];
  bundle_hash: string;
  informs_model_reasoning_only: true;
  authorization_granted: false;
};

export function buildApprovedDynamicContextBundle(entries: ApprovedDynamicContextEntry[]): DynamicProgramContextBundleV1 {
  if (!Array.isArray(entries) || entries.length > 64) throw new Error("Dynamic context entry count is invalid.");
  const normalized = entries.map(entry => {
    if (!entry || !["company", "project", "user"].includes(entry.scope) || entry.approved_for_model_context !== true
      || !boundedText(entry.semantic_summary, 2000)) throw new Error("Dynamic context entry is not approved and bounded.");
    requireHash(entry.content_hash, "content_hash"); requireHash(entry.provenance_hash, "provenance_hash"); requireHash(entry.approval_hash, "approval_hash");
    return { ...entry, semantic_summary: entry.semantic_summary.trim() };
  });
  const canonical = normalized
    .map(entry => [entry.scope, entry.content_hash, entry.provenance_hash, entry.approval_hash, entry.semantic_summary].join("\n"))
    .sort().join("\n--\n");
  return {
    schema: DYNAMIC_CONTEXT_BUNDLE_SCHEMA,
    entries: normalized,
    bundle_hash: sha256(`${DYNAMIC_CONTEXT_BUNDLE_SCHEMA}\n${canonical}`),
    informs_model_reasoning_only: true,
    authorization_granted: false
  };
}

export type DynamicLifecyclePhase =
  | "understanding_task" | "inspecting_model" | "preparing_automation" | "previewing" | "preview_ready"
  | "waiting_for_approval" | "applying" | "verifying" | "correcting" | "complete" | "blocked" | "outcome_uncertain";

const NEXT: Record<DynamicLifecyclePhase, DynamicLifecyclePhase[]> = {
  understanding_task: ["inspecting_model", "blocked"],
  inspecting_model: ["preparing_automation", "blocked"],
  preparing_automation: ["previewing", "blocked"],
  previewing: ["preview_ready", "correcting", "blocked"],
  preview_ready: ["waiting_for_approval", "complete", "blocked"],
  waiting_for_approval: ["applying", "blocked"],
  applying: ["verifying", "outcome_uncertain", "blocked"],
  verifying: ["complete", "blocked", "outcome_uncertain"],
  correcting: ["preparing_automation", "blocked"],
  complete: [], blocked: [], outcome_uncertain: []
};

export type DynamicLifecycleStateV1 = {
  schema: typeof DYNAMIC_LIFECYCLE_SCHEMA;
  execution_id: string;
  phase: DynamicLifecyclePhase;
  revision: number;
  evidence_hash: string;
};

export function transitionDynamicLifecycle(previous: DynamicLifecycleStateV1, phase: DynamicLifecyclePhase, evidenceHash: string): DynamicLifecycleStateV1 {
  if (!previous || previous.schema !== DYNAMIC_LIFECYCLE_SCHEMA || !boundedText(previous.execution_id, 160)
    || !Number.isSafeInteger(previous.revision) || previous.revision < 0 || !NEXT[previous.phase]?.includes(phase)) {
    throw new Error("Dynamic Runtime lifecycle transition is invalid.");
  }
  requireHash(evidenceHash, "evidence_hash");
  return { ...previous, phase, revision: previous.revision + 1, evidence_hash: evidenceHash };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requireHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a canonical SHA-256 digest.`);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateBoundedSet(values: unknown, count: number, length: number, hashes: boolean, field: string): void {
  if (!Array.isArray(values) || values.length > count || new Set(values).size !== values.length
    || values.some(value => hashes ? typeof value !== "string" || !SHA256.test(value) : !boundedText(value, length))) {
    throw new Error(`${field} is not a bounded unique collection.`);
  }
}
