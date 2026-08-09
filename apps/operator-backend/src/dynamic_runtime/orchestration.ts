import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DYNAMIC_REPAIR_FEEDBACK_SCHEMA = "dynamic_program_repair_feedback/v1" as const;
export const DYNAMIC_CONTEXT_BUNDLE_SCHEMA = "dynamic_program_context_bundle/v1" as const;
export const DYNAMIC_CONTEXT_APPROVAL_SCHEMA = "dynamic_program_context_approval/v1" as const;
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

export type DynamicContextScope = "company" | "project" | "user";

export type DynamicContextApprovalV1 = {
  schema: typeof DYNAMIC_CONTEXT_APPROVAL_SCHEMA;
  record_id: string;
  scope: DynamicContextScope;
  semantic_summary: string;
  content_hash: string;
  provenance_hash: string;
  company_hash: string;
  project_hash: string | null;
  user_hash: string | null;
  principal_hash: string;
  issued_at_utc: string;
  expires_at_utc: string;
  revocation_id: string;
  signer_key_id: string;
  nonce: string;
  signature: string;
};

export type ApprovedDynamicContextEntry = {
  scope: "company" | "project" | "user";
  semantic_summary: string;
  content_hash: string;
  provenance_hash: string;
  approval_hash: string;
  approved_for_model_context: true;
};

export type DynamicContextBindings = {
  company_hash: string;
  project_hash: string | null;
  user_hash: string | null;
  principal_hash: string;
};

const VERIFIED_CONTEXT = Symbol("verified-dynamic-context");
type VerifiedDynamicContextEntry = ApprovedDynamicContextEntry & {
  readonly [VERIFIED_CONTEXT]: true;
  readonly record_id: string;
  readonly revocation_id: string;
  readonly expires_at_utc: string;
};

export type DynamicProgramContextBundleV1 = {
  schema: typeof DYNAMIC_CONTEXT_BUNDLE_SCHEMA;
  entries: ReadonlyArray<Readonly<ApprovedDynamicContextEntry>>;
  bundle_hash: string;
  informs_model_reasoning_only: true;
  authorization_granted: false;
};

export type DynamicContextRevocationAuthority = {
  revoke(revocationId: string): void;
  isRevoked(revocationId: string): boolean;
};

export class DynamicContextApprovalAuthority {
  private readonly verified = new WeakSet<object>();

  constructor(private readonly key: Buffer, private readonly signerKeyId: string, private readonly revocations: DynamicContextRevocationAuthority) {
    if (!Buffer.isBuffer(key) || key.length < 32 || !/^sha256:[0-9a-f]{64}$/.test(signerKeyId)
      || !revocations || typeof revocations.revoke !== "function" || typeof revocations.isRevoked !== "function") {
      throw new Error("Dynamic context approval authority requires a 256-bit key, canonical key id, and trusted durable revocation authority.");
    }
  }

  issue(args: Omit<DynamicContextApprovalV1, "schema" | "content_hash" | "issued_at_utc" | "expires_at_utc" | "signer_key_id" | "nonce" | "signature"> & {
    issued_at: Date;
    expires_at: Date;
  }): Readonly<DynamicContextApprovalV1> {
    const issued = args.issued_at.toISOString();
    const expires = args.expires_at.toISOString();
    const unsigned: Omit<DynamicContextApprovalV1, "signature"> = {
      schema: DYNAMIC_CONTEXT_APPROVAL_SCHEMA,
      record_id: args.record_id,
      scope: args.scope,
      semantic_summary: args.semantic_summary.trim(),
      content_hash: sha256(args.semantic_summary.trim()),
      provenance_hash: args.provenance_hash,
      company_hash: args.company_hash,
      project_hash: args.project_hash,
      user_hash: args.user_hash,
      principal_hash: args.principal_hash,
      issued_at_utc: issued,
      expires_at_utc: expires,
      revocation_id: args.revocation_id,
      signer_key_id: this.signerKeyId,
      nonce: randomBytes(24).toString("base64url")
    };
    this.validateShape(unsigned, args.issued_at, false);
    if (args.expires_at.getTime() <= args.issued_at.getTime() || args.expires_at.getTime() - args.issued_at.getTime() > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Dynamic context approval lifetime is invalid.");
    }
    return Object.freeze({ ...unsigned, signature: this.sign(unsigned) });
  }

  revoke(revocationId: string): void {
    if (!boundedText(revocationId, 160)) throw new Error("Dynamic context revocation id is invalid.");
    this.revocations.revoke(revocationId);
  }

  verify(record: DynamicContextApprovalV1, bindings: DynamicContextBindings, now = new Date()): VerifiedDynamicContextEntry {
    this.validateShape(record, now, true);
    if (record.signer_key_id !== this.signerKeyId || this.revocations.isRevoked(record.revocation_id)) throw new Error("Dynamic context approval signer or revocation state is invalid.");
    const { signature, ...unsigned } = record;
    const expected = this.sign(unsigned);
    const left = Buffer.from(expected, "utf8"); const right = Buffer.from(signature, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Dynamic context approval signature is invalid.");
    if (record.content_hash !== sha256(record.semantic_summary.trim())) throw new Error("Dynamic context approval content digest is invalid.");
    requireHash(bindings.company_hash, "bindings.company_hash"); requireHash(bindings.principal_hash, "bindings.principal_hash");
    if (bindings.project_hash !== null) requireHash(bindings.project_hash, "bindings.project_hash");
    if (bindings.user_hash !== null) requireHash(bindings.user_hash, "bindings.user_hash");
    if (record.company_hash !== bindings.company_hash || record.principal_hash !== bindings.principal_hash
      || (record.scope !== "company" && record.project_hash !== bindings.project_hash)
      || (record.scope === "user" && record.user_hash !== bindings.user_hash)) {
      throw new Error("Dynamic context approval is outside the current company, project, user, or principal scope.");
    }
    const entry = Object.freeze({
      scope: record.scope,
      semantic_summary: record.semantic_summary.trim(),
      content_hash: record.content_hash,
      provenance_hash: record.provenance_hash,
      approval_hash: sha256(canonicalContextApproval(record)),
      approved_for_model_context: true as const,
      record_id: record.record_id,
      revocation_id: record.revocation_id,
      expires_at_utc: record.expires_at_utc,
      [VERIFIED_CONTEXT]: true as const
    });
    this.verified.add(entry);
    return entry;
  }

  buildBundle(entries: readonly VerifiedDynamicContextEntry[], now = new Date()): DynamicProgramContextBundleV1 {
    return buildVerifiedDynamicContextBundle(entries, entry => this.verified.has(entry), entry => {
      if (this.revocations.isRevoked(entry.revocation_id) || now.getTime() >= Date.parse(entry.expires_at_utc)) {
        throw new Error("Dynamic context approval was revoked or expired before bundle construction.");
      }
    });
  }

  private sign(value: Omit<DynamicContextApprovalV1, "signature">): string {
    return `hmac-sha256:${createHmac("sha256", this.key).update(canonicalContextApproval(value), "utf8").digest("hex")}`;
  }

  private validateShape(record: Omit<DynamicContextApprovalV1, "signature"> | DynamicContextApprovalV1, now: Date, enforceTime: boolean): void {
    if (!record || record.schema !== DYNAMIC_CONTEXT_APPROVAL_SCHEMA || !boundedText(record.record_id, 160)
      || !["company", "project", "user"].includes(record.scope) || !boundedText(record.semantic_summary, 2000)
      || !boundedText(record.revocation_id, 160) || !/^[A-Za-z0-9_-]{32}$/.test(record.nonce)
      || !/^sha256:[0-9a-f]{64}$/.test(record.signer_key_id)) throw new Error("Dynamic context approval shape is invalid.");
    requireHash(record.content_hash, "content_hash"); requireHash(record.provenance_hash, "provenance_hash");
    requireHash(record.company_hash, "company_hash"); requireHash(record.principal_hash, "principal_hash");
    if (record.project_hash !== null) requireHash(record.project_hash, "project_hash");
    if (record.user_hash !== null) requireHash(record.user_hash, "user_hash");
    if (record.scope !== "company" && record.project_hash === null) throw new Error("Project and user context must bind a project.");
    if (record.scope === "user" && record.user_hash === null) throw new Error("User context must bind a user.");
    const issued = Date.parse(record.issued_at_utc); const expires = Date.parse(record.expires_at_utc);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 30 * 24 * 60 * 60 * 1000) throw new Error("Dynamic context approval timestamps are invalid.");
    if (enforceTime && (now.getTime() < issued || now.getTime() >= expires)) throw new Error("Dynamic context approval is not currently valid.");
    if ("signature" in record && !/^hmac-sha256:[0-9a-f]{64}$/.test(record.signature)) throw new Error("Dynamic context approval signature shape is invalid.");
  }
}

export function buildApprovedDynamicContextBundle(_entries: ReadonlyArray<Readonly<ApprovedDynamicContextEntry>>): DynamicProgramContextBundleV1 {
  throw new Error("Unauthenticated context entries are not accepted; verify approvals through DynamicContextApprovalAuthority first.");
}

function buildVerifiedDynamicContextBundle(entries: readonly VerifiedDynamicContextEntry[], verified: (entry: object) => boolean,
  revalidate: (entry: VerifiedDynamicContextEntry) => void): DynamicProgramContextBundleV1 {
  if (!Array.isArray(entries) || entries.length > 64) throw new Error("Dynamic context entry count is invalid.");
  const normalized = entries.map(entry => {
    if (!entry || !verified(entry) || entry[VERIFIED_CONTEXT] !== true || !["company", "project", "user"].includes(entry.scope) || entry.approved_for_model_context !== true
      || !boundedText(entry.semantic_summary, 2000)) throw new Error("Dynamic context entry is not approved and bounded.");
    revalidate(entry);
    requireHash(entry.content_hash, "content_hash"); requireHash(entry.provenance_hash, "provenance_hash"); requireHash(entry.approval_hash, "approval_hash");
    return { ...entry, semantic_summary: entry.semantic_summary.trim() };
  });
  const recordIds = normalized.map(entry => entry.record_id);
  if (new Set(recordIds).size !== recordIds.length) throw new Error("Dynamic context bundle contains duplicate or conflicting approval records.");
  const canonical = normalized
    .map(entry => [entry.scope, entry.content_hash, entry.provenance_hash, entry.approval_hash, entry.semantic_summary].join("\n"))
    .sort().join("\n--\n");
  const publicEntries = normalized.map(entry => Object.freeze({
    scope: entry.scope,
    semantic_summary: entry.semantic_summary,
    content_hash: entry.content_hash,
    provenance_hash: entry.provenance_hash,
    approval_hash: entry.approval_hash,
    approved_for_model_context: true as const
  }));
  return Object.freeze({
    schema: DYNAMIC_CONTEXT_BUNDLE_SCHEMA,
    entries: Object.freeze(publicEntries),
    bundle_hash: sha256(`${DYNAMIC_CONTEXT_BUNDLE_SCHEMA}\n${canonical}`),
    informs_model_reasoning_only: true,
    authorization_granted: false
  });
}

function canonicalContextApproval(value: Omit<DynamicContextApprovalV1, "signature"> | DynamicContextApprovalV1): string {
  return [value.schema, value.record_id, value.scope, value.semantic_summary.trim(), value.content_hash, value.provenance_hash,
    value.company_hash, value.project_hash ?? "", value.user_hash ?? "", value.principal_hash, value.issued_at_utc,
    value.expires_at_utc, value.revocation_id, value.signer_key_id, value.nonce].join("\n");
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
