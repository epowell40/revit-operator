import {
  createHash,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyLike,
  type KeyObject
} from "node:crypto";
import { canonicalJson, type JsonValue } from "../capabilities/tool_certification.js";
import { type Epic0441Campaign, validateEpic0441Campaign } from "./epic0441_campaign.js";

export const EPIC0442_OUTCOMES = [
  "authenticated_live_success",
  "success_after_repair",
  "safe_blocker",
  "incorrect",
  "outcome_unknown",
  "source_only"
] as const;

export type Epic0442Outcome = (typeof EPIC0442_OUTCOMES)[number];
export type Epic0442Representation = "typed_capability_chain" | "dynamic_program";
export type Epic0442RuntimeMode = "local" | "self_hosted" | "development" | "production";

type AuthorityBoundary = {
  authority_id: string;
  authority_scope: "benchmark_scoring_only";
  authorizes_revit_execution: false;
  authorizes_revit_apply: false;
};

export type Epic0442CampaignReceipt = AuthorityBoundary & {
  schema_version: "epic0442_authenticated_campaign_receipt/v1";
  suite_id: string;
  campaign_version: string;
  source_campaign_schema_version: "epic0441_campaign/v1";
  source_campaign_sha256: string;
  campaign_nonce: string;
  issued_unix_seconds: number;
  expires_unix_seconds: number;
  receipt_hash: string;
  signature_base64url: string;
};

export type Epic0442AssignmentReceipt = AuthorityBoundary & {
  schema_version: "epic0442_authenticated_assignment_receipt/v1";
  campaign_receipt_sha256: string;
  assignment_id: string;
  assignment_nonce: string;
  task_id: string;
  config_id: string;
  representation: Epic0442Representation;
  pair_order: 1 | 2;
  fixture_id: string;
  fixture_sha256: string;
  fixture_adapter_sha256: string;
  prompt_id: string;
  prompt_sha256: string;
  substrate: string;
  provider: string;
  model: string;
  action_policy: "preview_only" | "apply_cleanup";
  issued_unix_seconds: number;
  expires_unix_seconds: number;
  receipt_hash: string;
  signature_base64url: string;
};

export type Epic0442ExecutionEvidence = {
  schema_version: "epic0442_execution_evidence/v1";
  evidence_tier: "live" | "source_only";
  source_sha256: string;
  runtime_sha256: string;
  package_sha256: string;
  revit_process: null | {
    process_id: number;
    executable_sha256: string;
    started_at_utc: string;
  };
  document: null | {
    project_fingerprint: string;
    document_session_id: string;
  };
  execution: {
    kind: "typed_tool_chain" | "dynamic_program";
    status: "completed" | "blocked" | "failed" | "outcome_unknown" | "source_only";
    execution_receipt_sha256: string | null;
    program_sha256: string | null;
    tool_call_receipt_sha256s: string[];
  };
  preview: {
    status: "completed" | "blocked" | "failed" | "not_requested" | "source_only";
    receipt_sha256: string | null;
  };
  apply: {
    status: "completed" | "blocked" | "failed" | "not_requested" | "outcome_unknown" | "source_only";
    authorization_sha256: string | null;
    receipt_sha256: string | null;
  };
  element_delta: {
    changed_ids: number[];
    created_ids: number[];
    deleted_ids: number[];
  };
  metrics: {
    elapsed_ms: number;
    turn_count: number;
    rpc_count: number;
  };
  cleanup: {
    required: boolean;
    status: "restored" | "discarded" | "not_required" | "failed" | "outcome_unknown" | "source_only";
    restoration_receipt_sha256: string | null;
  };
};

export type Epic0442ScorerVerdict = {
  schema_version: "epic0442_scorer_verdict/v1";
  verifier_id: string;
  verifier_version: string;
  verification_receipt_sha256: string;
  scorer_id: string;
  scorer_version: string;
  outcome: Epic0442Outcome;
  repair_count: number;
  reason_codes: string[];
};

export type Epic0442AuthenticatedResult = AuthorityBoundary & {
  schema_version: "epic0442_authenticated_result/v1";
  campaign_receipt_sha256: string;
  assignment_receipt_sha256: string;
  result_id: string;
  result_nonce: string;
  task_id: string;
  config_id: string;
  representation: Epic0442Representation;
  pair_order: 1 | 2;
  fixture_id: string;
  fixture_sha256: string;
  fixture_adapter_sha256: string;
  prompt_id: string;
  prompt_sha256: string;
  substrate: string;
  provider: string;
  model: string;
  action_policy: "preview_only" | "apply_cleanup";
  evidence: Epic0442ExecutionEvidence;
  verdict: Epic0442ScorerVerdict;
  issued_unix_seconds: number;
  receipt_hash: string;
  signature_base64url: string;
};

export interface Epic0442ReplayAuthority {
  reserve(namespace: "campaign" | "assignment" | "result", key: string): boolean;
}

export class InMemoryEpic0442ReplayAuthority implements Epic0442ReplayAuthority {
  readonly #seen = new Set<string>();
  reserve(namespace: "campaign" | "assignment" | "result", key: string): boolean {
    const scoped = `${namespace}\0${key}`;
    if (this.#seen.has(scoped)) return false;
    this.#seen.add(scoped);
    return true;
  }
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_IDS = 10_000;
const MAX_TOOL_RECEIPTS = 1_000;
const MAX_REASON_CODES = 64;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an exact plain object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const object = record(value, label); const actual = Object.keys(object).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
  return object;
}

function string(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function hash(value: unknown, label: string): string { return string(value, label, HASH); }
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is invalid.`);
  return value as number;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value as JsonValue), "utf8").digest("hex")}`;
}

function envelopeHash(value: Epic0442CampaignReceipt | Epic0442AssignmentReceipt): string { return hashJson(value); }

function authorityId(key: KeyLike): string {
  const candidate = key as Partial<KeyObject>;
  const publicKey = candidate.type === "public" ? key as KeyObject : createPublicKey(key);
  const der = publicKey.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function unsigned<T extends { receipt_hash: string; signature_base64url: string }>(value: T): Omit<T, "receipt_hash" | "signature_base64url"> {
  const { receipt_hash: _receiptHash, signature_base64url: _signature, ...payload } = value;
  return payload;
}

function signatureBytes(receiptHash: string): Buffer {
  return Buffer.from(canonicalJson({ domain: "epic0442-scorer-receipt/v1", receipt_hash: receiptHash }), "utf8");
}

function signed<T extends Record<string, unknown>>(payload: T, privateKey: KeyLike): T & { receipt_hash: string; signature_base64url: string } {
  const receiptHash = hashJson(payload);
  return { ...payload, receipt_hash: receiptHash, signature_base64url: sign(null, signatureBytes(receiptHash), privateKey).toString("base64url") };
}

function verifySignature(value: { authority_id: string; receipt_hash: string; signature_base64url: string }, publicKey: KeyLike, label: string): void {
  if (value.authority_id !== authorityId(publicKey)) throw new Error(`${label} authority does not match the trusted scorer key.`);
  const expectedHash = hashJson(unsigned(value));
  if (value.receipt_hash !== expectedHash) throw new Error(`${label} payload hash is invalid.`);
  let signature: Buffer;
  try { signature = Buffer.from(value.signature_base64url, "base64url"); } catch { throw new Error(`${label} signature is invalid.`); }
  if (!signature.length || !verify(null, signatureBytes(expectedHash), publicKey, signature)) throw new Error(`${label} signature is invalid.`);
}

const AUTHORITY_FIELDS = ["authority_id", "authority_scope", "authorizes_revit_execution", "authorizes_revit_apply"] as const;

function validateAuthority(object: Record<string, unknown>, label: string): void {
  hash(object.authority_id, `${label} authority_id`);
  if (object.authority_scope !== "benchmark_scoring_only" || object.authorizes_revit_execution !== false || object.authorizes_revit_apply !== false) {
    throw new Error(`${label} must be non-authorizing scorer evidence.`);
  }
}

function validateCampaignReceipt(value: unknown): asserts value is Epic0442CampaignReceipt {
  const object = exact(value, ["schema_version", ...AUTHORITY_FIELDS, "suite_id", "campaign_version", "source_campaign_schema_version",
    "source_campaign_sha256", "campaign_nonce", "issued_unix_seconds", "expires_unix_seconds", "receipt_hash", "signature_base64url"], "Campaign receipt");
  if (object.schema_version !== "epic0442_authenticated_campaign_receipt/v1" || object.source_campaign_schema_version !== "epic0441_campaign/v1") throw new Error("Campaign receipt schema is invalid.");
  validateAuthority(object, "Campaign receipt"); string(object.suite_id, "Campaign suite"); string(object.campaign_version, "Campaign version");
  hash(object.source_campaign_sha256, "Source campaign hash"); string(object.campaign_nonce, "Campaign nonce"); hash(object.receipt_hash, "Campaign receipt hash");
  string(object.signature_base64url, "Campaign signature", /^[A-Za-z0-9_-]{40,2048}$/);
  const issued = integer(object.issued_unix_seconds, "Campaign issued time", 0, 4_102_444_800);
  const expires = integer(object.expires_unix_seconds, "Campaign expiry", 1, 4_102_444_800);
  if (expires <= issued || expires - issued > 31_536_000) throw new Error("Campaign receipt lifetime is invalid.");
}

function validateAssignmentReceipt(value: unknown): asserts value is Epic0442AssignmentReceipt {
  const object = exact(value, ["schema_version", ...AUTHORITY_FIELDS, "campaign_receipt_sha256", "assignment_id", "assignment_nonce", "task_id",
    "config_id", "representation", "pair_order", "fixture_id", "fixture_sha256", "fixture_adapter_sha256", "prompt_id", "prompt_sha256",
    "substrate", "provider", "model", "action_policy", "issued_unix_seconds", "expires_unix_seconds", "receipt_hash", "signature_base64url"], "Assignment receipt");
  if (object.schema_version !== "epic0442_authenticated_assignment_receipt/v1") throw new Error("Assignment receipt schema is invalid.");
  validateAuthority(object, "Assignment receipt");
  for (const field of ["campaign_receipt_sha256", "fixture_sha256", "fixture_adapter_sha256", "prompt_sha256", "receipt_hash"] as const) hash(object[field], `Assignment ${field}`);
  for (const field of ["assignment_id", "assignment_nonce", "task_id", "config_id", "fixture_id", "prompt_id", "substrate", "provider", "model"] as const) string(object[field], `Assignment ${field}`);
  if (object.representation !== "typed_capability_chain" && object.representation !== "dynamic_program") throw new Error("Assignment representation is invalid.");
  if (object.pair_order !== 1 && object.pair_order !== 2) throw new Error("Assignment pair order is invalid.");
  if (object.action_policy !== "preview_only" && object.action_policy !== "apply_cleanup") throw new Error("Assignment action policy is invalid.");
  string(object.signature_base64url, "Assignment signature", /^[A-Za-z0-9_-]{40,2048}$/);
  const issued = integer(object.issued_unix_seconds, "Assignment issued time", 0, 4_102_444_800);
  const expires = integer(object.expires_unix_seconds, "Assignment expiry", 1, 4_102_444_800);
  if (expires <= issued || expires - issued > 86_400) throw new Error("Assignment receipt lifetime is invalid.");
}

function validateIdArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new Error(`${label} is invalid.`);
  let previous = -1;
  for (const candidate of value) {
    const id = integer(candidate, label, 0, 2_147_483_647);
    if (id <= previous) throw new Error(`${label} must be unique and ascending.`);
    previous = id;
  }
  return value as number[];
}

function validateEvidence(value: unknown, representation: Epic0442Representation): asserts value is Epic0442ExecutionEvidence {
  const object = exact(value, ["schema_version", "evidence_tier", "source_sha256", "runtime_sha256", "package_sha256", "revit_process", "document",
    "execution", "preview", "apply", "element_delta", "metrics", "cleanup"], "Execution evidence");
  if (object.schema_version !== "epic0442_execution_evidence/v1" || (object.evidence_tier !== "live" && object.evidence_tier !== "source_only")) throw new Error("Execution evidence schema or tier is invalid.");
  hash(object.source_sha256, "Evidence source hash"); hash(object.runtime_sha256, "Evidence runtime hash"); hash(object.package_sha256, "Evidence package hash");
  const process = object.revit_process === null ? null : exact(object.revit_process, ["process_id", "executable_sha256", "started_at_utc"], "Revit process evidence");
  if (process) { integer(process.process_id, "Revit process id", 1, 4_294_967_295); hash(process.executable_sha256, "Revit executable hash"); string(process.started_at_utc, "Revit start time", UTC); }
  const document = object.document === null ? null : exact(object.document, ["project_fingerprint", "document_session_id"], "Document evidence");
  if (document) { hash(document.project_fingerprint, "Project fingerprint"); string(document.document_session_id, "Document session id"); }
  const execution = exact(object.execution, ["kind", "status", "execution_receipt_sha256", "program_sha256", "tool_call_receipt_sha256s"], "Execution binding");
  const expectedKind = representation === "dynamic_program" ? "dynamic_program" : "typed_tool_chain";
  if (execution.kind !== expectedKind || !["completed", "blocked", "failed", "outcome_unknown", "source_only"].includes(String(execution.status))) throw new Error("Execution kind or status does not match its authenticated arm.");
  if (execution.execution_receipt_sha256 !== null) hash(execution.execution_receipt_sha256, "Execution receipt hash");
  if (representation === "dynamic_program") hash(execution.program_sha256, "Dynamic program hash");
  else if (execution.program_sha256 !== null) throw new Error("Typed execution must not claim a dynamic program hash.");
  if (!Array.isArray(execution.tool_call_receipt_sha256s) || execution.tool_call_receipt_sha256s.length > MAX_TOOL_RECEIPTS) throw new Error("Tool receipt list is invalid.");
  for (const item of execution.tool_call_receipt_sha256s) hash(item, "Tool call receipt hash");
  if (new Set(execution.tool_call_receipt_sha256s).size !== execution.tool_call_receipt_sha256s.length) throw new Error("Tool call receipt hashes must be unique.");
  const preview = exact(object.preview, ["status", "receipt_sha256"], "Preview binding");
  if (!["completed", "blocked", "failed", "not_requested", "source_only"].includes(String(preview.status))) throw new Error("Preview status is invalid.");
  if (preview.receipt_sha256 !== null) hash(preview.receipt_sha256, "Preview receipt hash");
  const apply = exact(object.apply, ["status", "authorization_sha256", "receipt_sha256"], "Apply binding");
  if (!["completed", "blocked", "failed", "not_requested", "outcome_unknown", "source_only"].includes(String(apply.status))) throw new Error("Apply status is invalid.");
  if (apply.authorization_sha256 !== null) hash(apply.authorization_sha256, "Apply authorization hash");
  if (apply.receipt_sha256 !== null) hash(apply.receipt_sha256, "Apply receipt hash");
  if (execution.status === "completed" && execution.execution_receipt_sha256 === null) throw new Error("Completed execution requires an authenticated execution receipt.");
  if (preview.status === "completed" && preview.receipt_sha256 === null) throw new Error("Completed preview requires an authenticated preview receipt.");
  if (apply.status === "completed" && (apply.authorization_sha256 === null || apply.receipt_sha256 === null)) throw new Error("Completed apply requires authenticated authorization and apply receipts.");
  const delta = exact(object.element_delta, ["changed_ids", "created_ids", "deleted_ids"], "Element delta");
  const allIds = [...validateIdArray(delta.changed_ids, "Changed ids"), ...validateIdArray(delta.created_ids, "Created ids"), ...validateIdArray(delta.deleted_ids, "Deleted ids")];
  if (new Set(allIds).size !== allIds.length) throw new Error("Changed, created, and deleted ids must be disjoint.");
  const metrics = exact(object.metrics, ["elapsed_ms", "turn_count", "rpc_count"], "Execution metrics");
  integer(metrics.elapsed_ms, "Elapsed milliseconds", 0, 86_400_000); integer(metrics.turn_count, "Turn count", 0, 10_000); integer(metrics.rpc_count, "RPC count", 0, 100_000);
  const cleanup = exact(object.cleanup, ["required", "status", "restoration_receipt_sha256"], "Cleanup binding");
  if (typeof cleanup.required !== "boolean" || !["restored", "discarded", "not_required", "failed", "outcome_unknown", "source_only"].includes(String(cleanup.status))) throw new Error("Cleanup binding is invalid.");
  if (cleanup.restoration_receipt_sha256 !== null) hash(cleanup.restoration_receipt_sha256, "Restoration receipt hash");
  if ((cleanup.status === "restored" || cleanup.status === "discarded") && cleanup.restoration_receipt_sha256 === null) throw new Error("Completed cleanup requires an authenticated restoration/discard receipt.");
  if (cleanup.status === "not_required" && (cleanup.required || cleanup.restoration_receipt_sha256 !== null)) throw new Error("Cleanup not_required binding is inconsistent.");
  if (cleanup.required === false && cleanup.status !== "not_required" && cleanup.status !== "source_only") throw new Error("Cleanup status is inconsistent with its requirement flag.");
  if (object.evidence_tier === "source_only") {
    if (process !== null || document !== null || execution.status !== "source_only" || preview.status !== "source_only" || apply.status !== "source_only"
      || allIds.length || cleanup.status !== "source_only") throw new Error("Source-only evidence cannot claim live execution truth.");
  } else if (!process || !document || execution.status === "source_only" || preview.status === "source_only" || apply.status === "source_only" || cleanup.status === "source_only") {
    throw new Error("Live evidence is missing a process, document, or live phase binding.");
  }
}

function validateVerdict(value: unknown, evidence: Epic0442ExecutionEvidence, actionPolicy: Epic0442AssignmentReceipt["action_policy"]): asserts value is Epic0442ScorerVerdict {
  const object = exact(value, ["schema_version", "verifier_id", "verifier_version", "verification_receipt_sha256", "scorer_id", "scorer_version", "outcome", "repair_count", "reason_codes"], "Scorer verdict");
  if (object.schema_version !== "epic0442_scorer_verdict/v1" || !(EPIC0442_OUTCOMES as readonly unknown[]).includes(object.outcome)) throw new Error("Scorer verdict schema or outcome is invalid.");
  for (const field of ["verifier_id", "verifier_version", "scorer_id", "scorer_version"] as const) string(object[field], `Verdict ${field}`);
  hash(object.verification_receipt_sha256, "Verification receipt hash");
  const repairCount = integer(object.repair_count, "Repair count", 0, 100);
  if (!Array.isArray(object.reason_codes) || object.reason_codes.length > MAX_REASON_CODES || object.reason_codes.some((item) => typeof item !== "string" || !ID.test(item))) throw new Error("Verdict reason codes are invalid.");
  if (new Set(object.reason_codes).size !== object.reason_codes.length) throw new Error("Verdict reason codes must be unique.");
  const outcome = object.outcome as Epic0442Outcome;
  const deltaCount = evidence.element_delta.changed_ids.length + evidence.element_delta.created_ids.length + evidence.element_delta.deleted_ids.length;
  if (outcome === "source_only" && evidence.evidence_tier !== "source_only") throw new Error("source_only outcome requires source-only evidence.");
  if (outcome !== "source_only" && evidence.evidence_tier !== "live") throw new Error("Live outcomes require live evidence.");
  if (outcome === "authenticated_live_success" && repairCount !== 0) throw new Error("Authenticated first-pass success cannot claim repairs.");
  if (outcome === "success_after_repair" && repairCount < 1) throw new Error("Success after repair requires at least one scorer-observed repair.");
  if (outcome === "authenticated_live_success" || outcome === "success_after_repair") {
    if (evidence.execution.status !== "completed" || evidence.preview.status !== "completed") throw new Error("Successful live outcomes require completed execution and preview evidence.");
    if (actionPolicy === "apply_cleanup" && evidence.apply.status !== "completed") throw new Error("Apply tasks require an authenticated completed apply receipt.");
    if (evidence.cleanup.required && evidence.cleanup.status !== "restored" && evidence.cleanup.status !== "discarded") throw new Error("Successful live outcomes require authenticated cleanup or restoration.");
  }
  if (outcome === "safe_blocker" && deltaCount !== 0) throw new Error("A safe blocker cannot carry changed, created, or deleted ids.");
  if (outcome === "safe_blocker" && evidence.execution.status !== "blocked" && evidence.preview.status !== "blocked" && evidence.apply.status !== "blocked") {
    throw new Error("A safe blocker requires an authenticated blocked phase.");
  }
  if (outcome === "outcome_unknown" && evidence.execution.status !== "outcome_unknown" && evidence.apply.status !== "outcome_unknown" && evidence.cleanup.status !== "outcome_unknown") {
    throw new Error("Outcome unknown requires an authenticated uncertain phase.");
  }
}

function validateResult(value: unknown): asserts value is Epic0442AuthenticatedResult {
  const object = exact(value, ["schema_version", ...AUTHORITY_FIELDS, "campaign_receipt_sha256", "assignment_receipt_sha256", "result_id", "result_nonce",
    "task_id", "config_id", "representation", "pair_order", "fixture_id", "fixture_sha256", "fixture_adapter_sha256", "prompt_id", "prompt_sha256",
    "substrate", "provider", "model", "action_policy", "evidence", "verdict", "issued_unix_seconds", "receipt_hash", "signature_base64url"], "Authenticated result");
  if (object.schema_version !== "epic0442_authenticated_result/v1") throw new Error("Authenticated result schema is invalid.");
  validateAuthority(object, "Authenticated result");
  for (const field of ["campaign_receipt_sha256", "assignment_receipt_sha256", "fixture_sha256", "fixture_adapter_sha256", "prompt_sha256", "receipt_hash"] as const) hash(object[field], `Result ${field}`);
  for (const field of ["result_id", "result_nonce", "task_id", "config_id", "fixture_id", "prompt_id", "substrate", "provider", "model"] as const) string(object[field], `Result ${field}`);
  if (object.representation !== "typed_capability_chain" && object.representation !== "dynamic_program") throw new Error("Result representation is invalid.");
  if (object.pair_order !== 1 && object.pair_order !== 2) throw new Error("Result pair order is invalid.");
  if (object.action_policy !== "preview_only" && object.action_policy !== "apply_cleanup") throw new Error("Result action policy is invalid.");
  validateEvidence(object.evidence, object.representation);
  validateVerdict(object.verdict, object.evidence, object.action_policy);
  integer(object.issued_unix_seconds, "Result issued time", 0, 4_102_444_800);
  string(object.signature_base64url, "Result signature", /^[A-Za-z0-9_-]{40,2048}$/);
}

export function epic0442SourceCampaignSha256(campaign: Epic0441Campaign): string {
  validateEpic0441Campaign(campaign);
  return hashJson(campaign);
}

export class Epic0442ScorerAuthority {
  readonly #mode: Epic0442RuntimeMode;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #authorityId: string;
  readonly #replay: Epic0442ReplayAuthority;
  readonly #now: () => number;

  constructor(options: { runtimeMode: Epic0442RuntimeMode; privateKey: KeyObject; replayAuthority: Epic0442ReplayAuthority; now?: () => number }) {
    if (options.privateKey.type !== "private") throw new Error("EPIC-0442 scorer authority requires a private signing key.");
    if (options.privateKey.asymmetricKeyType !== "ed25519") throw new Error("EPIC-0442 scorer authority requires an Ed25519 signing key.");
    this.#mode = options.runtimeMode; this.#privateKey = options.privateKey; this.#publicKey = createPublicKey(this.#privateKey);
    this.#authorityId = authorityId(this.#publicKey); this.#replay = options.replayAuthority; this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  publicKey(): KeyLike { return this.#publicKey; }

  #assertSignerEnabled(): void {
    if (this.#mode === "production") throw new Error("EPIC-0442 scorer signing is disabled in production mode.");
  }

  #authority(): AuthorityBoundary {
    return { authority_id: this.#authorityId, authority_scope: "benchmark_scoring_only", authorizes_revit_execution: false, authorizes_revit_apply: false };
  }

  issueCampaign(args: { campaign: Epic0441Campaign; campaignVersion: string; campaignNonce?: string; lifetimeSeconds?: number }): Epic0442CampaignReceipt {
    this.#assertSignerEnabled(); validateEpic0441Campaign(args.campaign); const issued = this.#now(); const nonce = args.campaignNonce ?? randomUUID();
    string(args.campaignVersion, "Campaign version"); string(nonce, "Campaign nonce");
    const campaignKey = `${args.campaign.suite_id}\0${args.campaignVersion}`;
    if (!this.#replay.reserve("campaign", `version\0${campaignKey}`)) throw new Error("Campaign version was already authenticated.");
    if (!this.#replay.reserve("campaign", `nonce\0${nonce}`)) throw new Error("Campaign receipt nonce was replayed.");
    const receipt = signed({ schema_version: "epic0442_authenticated_campaign_receipt/v1" as const, ...this.#authority(), suite_id: args.campaign.suite_id,
      campaign_version: args.campaignVersion, source_campaign_schema_version: args.campaign.schema_version,
      source_campaign_sha256: epic0442SourceCampaignSha256(args.campaign), campaign_nonce: nonce, issued_unix_seconds: issued,
      expires_unix_seconds: issued + (args.lifetimeSeconds ?? 86_400) }, this.#privateKey);
    validateCampaignReceipt(receipt); return receipt;
  }

  issueAssignment(args: {
    campaign: Epic0441Campaign;
    campaignReceipt: Epic0442CampaignReceipt;
    taskId: string; configId: string; representation: Epic0442Representation; pairOrder: 1 | 2;
    fixtureId: string; fixtureSha256: string; fixtureAdapterSha256: string; promptId: string; promptSha256: string;
    substrate: string; provider: string; model: string; actionPolicy: "preview_only" | "apply_cleanup";
    assignmentId?: string; assignmentNonce?: string; lifetimeSeconds?: number;
  }): Epic0442AssignmentReceipt {
    this.#assertSignerEnabled(); validateEpic0441Campaign(args.campaign); validateCampaignReceipt(args.campaignReceipt); verifySignature(args.campaignReceipt, this.#publicKey, "Campaign receipt");
    if (args.campaignReceipt.suite_id !== args.campaign.suite_id || args.campaignReceipt.source_campaign_sha256 !== epic0442SourceCampaignSha256(args.campaign)) {
      throw new Error("Assignment campaign does not match the authenticated frozen campaign.");
    }
    const task = args.campaign.tasks.find((candidate) => candidate.task_id === args.taskId);
    const config = args.campaign.execution_configs.find((candidate) => candidate.config_id === args.configId);
    if (!task || !config || config.representation !== args.representation) throw new Error("Assignment task/config arm is not in the authenticated frozen campaign.");
    if (task.wave !== "novel_post_freeze" && task.substrate !== args.substrate) throw new Error("Assignment substrate does not match the frozen campaign task.");
    const expectedPolicy = task.action_policy === "dry_run_only" ? "preview_only" : "apply_cleanup";
    if (args.actionPolicy !== expectedPolicy) throw new Error("Assignment action policy does not match the frozen campaign task.");
    const issued = this.#now(); if (issued >= args.campaignReceipt.expires_unix_seconds) throw new Error("Campaign receipt expired before assignment.");
    const campaignHash = envelopeHash(args.campaignReceipt); const armKey = `${campaignHash}\0${args.taskId}\0${args.configId}\0${args.representation}`;
    const assignmentId = args.assignmentId ?? randomUUID(); const assignmentNonce = args.assignmentNonce ?? randomUUID();
    if (!this.#replay.reserve("assignment", `arm\0${armKey}`)) throw new Error("Duplicate campaign task/arm assignment.");
    if (!this.#replay.reserve("assignment", `id\0${assignmentId}`)) throw new Error("Assignment id was replayed.");
    if (!this.#replay.reserve("assignment", `nonce\0${assignmentNonce}`)) throw new Error("Assignment nonce was replayed.");
    const receipt = signed({ schema_version: "epic0442_authenticated_assignment_receipt/v1" as const, ...this.#authority(), campaign_receipt_sha256: campaignHash,
      assignment_id: assignmentId, assignment_nonce: assignmentNonce, task_id: args.taskId, config_id: args.configId,
      representation: args.representation, pair_order: args.pairOrder, fixture_id: args.fixtureId, fixture_sha256: args.fixtureSha256,
      fixture_adapter_sha256: args.fixtureAdapterSha256, prompt_id: args.promptId, prompt_sha256: args.promptSha256, substrate: args.substrate,
      provider: args.provider, model: args.model, action_policy: args.actionPolicy, issued_unix_seconds: issued,
      expires_unix_seconds: Math.min(args.campaignReceipt.expires_unix_seconds, issued + (args.lifetimeSeconds ?? 3_600)) }, this.#privateKey);
    validateAssignmentReceipt(receipt); return receipt;
  }

  score(args: { campaignReceipt: Epic0442CampaignReceipt; assignmentReceipt: Epic0442AssignmentReceipt; evidence: Epic0442ExecutionEvidence;
    verdict: Epic0442ScorerVerdict; resultId?: string; resultNonce?: string }): Epic0442AuthenticatedResult {
    this.#assertSignerEnabled(); validateCampaignReceipt(args.campaignReceipt); validateAssignmentReceipt(args.assignmentReceipt);
    verifySignature(args.campaignReceipt, this.#publicKey, "Campaign receipt"); verifySignature(args.assignmentReceipt, this.#publicKey, "Assignment receipt");
    const campaignHash = envelopeHash(args.campaignReceipt);
    if (args.assignmentReceipt.campaign_receipt_sha256 !== campaignHash) throw new Error("Assignment does not belong to the authenticated campaign receipt.");
    const issued = this.#now(); if (issued >= args.assignmentReceipt.expires_unix_seconds) throw new Error("Assignment expired before scoring.");
    validateEvidence(args.evidence, args.assignmentReceipt.representation); validateVerdict(args.verdict, args.evidence, args.assignmentReceipt.action_policy);
    const assignmentHash = envelopeHash(args.assignmentReceipt);
    const resultId = args.resultId ?? randomUUID(); const resultNonce = args.resultNonce ?? randomUUID();
    if (!this.#replay.reserve("result", `assignment\0${assignmentHash}`)) throw new Error("Assignment scoring was replayed.");
    if (!this.#replay.reserve("result", `id\0${resultId}`)) throw new Error("Result id was replayed.");
    if (!this.#replay.reserve("result", `nonce\0${resultNonce}`)) throw new Error("Result nonce was replayed.");
    const result = signed({ schema_version: "epic0442_authenticated_result/v1" as const, ...this.#authority(), campaign_receipt_sha256: campaignHash,
      assignment_receipt_sha256: assignmentHash, result_id: resultId, result_nonce: resultNonce,
      task_id: args.assignmentReceipt.task_id, config_id: args.assignmentReceipt.config_id, representation: args.assignmentReceipt.representation,
      pair_order: args.assignmentReceipt.pair_order, fixture_id: args.assignmentReceipt.fixture_id, fixture_sha256: args.assignmentReceipt.fixture_sha256,
      fixture_adapter_sha256: args.assignmentReceipt.fixture_adapter_sha256, prompt_id: args.assignmentReceipt.prompt_id,
      prompt_sha256: args.assignmentReceipt.prompt_sha256, substrate: args.assignmentReceipt.substrate, provider: args.assignmentReceipt.provider,
      model: args.assignmentReceipt.model, action_policy: args.assignmentReceipt.action_policy, evidence: args.evidence, verdict: args.verdict,
      issued_unix_seconds: issued }, this.#privateKey);
    validateResult(result); return result;
  }
}

export function verifyEpic0442AuthenticatedChain(args: { publicKey: KeyLike; campaignReceipt: Epic0442CampaignReceipt;
  assignmentReceipts: readonly Epic0442AssignmentReceipt[]; results: readonly Epic0442AuthenticatedResult[];
  expectedCampaign?: Epic0441Campaign; expectedCampaignVersion?: string }): void {
  validateCampaignReceipt(args.campaignReceipt); verifySignature(args.campaignReceipt, args.publicKey, "Campaign receipt");
  if (args.expectedCampaign && args.campaignReceipt.source_campaign_sha256 !== epic0442SourceCampaignSha256(args.expectedCampaign)) throw new Error("Authenticated campaign hash does not match the expected frozen campaign.");
  if (args.expectedCampaignVersion && args.campaignReceipt.campaign_version !== args.expectedCampaignVersion) throw new Error("Authenticated campaign version does not match.");
  const campaignHash = envelopeHash(args.campaignReceipt); const assignments = new Map<string, Epic0442AssignmentReceipt>(); const arms = new Set<string>();
  const assignmentIds = new Set<string>(); const nonces = new Set<string>();
  for (const assignment of args.assignmentReceipts) {
    validateAssignmentReceipt(assignment); verifySignature(assignment, args.publicKey, "Assignment receipt");
    if (assignment.campaign_receipt_sha256 !== campaignHash) throw new Error("Assignment campaign chain hash is invalid.");
    const assignmentHash = envelopeHash(assignment); if (assignments.has(assignmentHash)) throw new Error("Duplicate assignment receipt."); assignments.set(assignmentHash, assignment);
    const arm = `${assignment.task_id}\0${assignment.config_id}\0${assignment.representation}`; if (arms.has(arm)) throw new Error("Duplicate authenticated task/arm."); arms.add(arm);
    if (assignmentIds.has(assignment.assignment_id)) throw new Error("Duplicate assignment id."); assignmentIds.add(assignment.assignment_id);
    if (nonces.has(assignment.assignment_nonce)) throw new Error("Duplicate assignment nonce."); nonces.add(assignment.assignment_nonce);
  }
  const resultAssignments = new Set<string>(); const resultIds = new Set<string>(); const resultNonces = new Set<string>();
  for (const result of args.results) {
    validateResult(result); verifySignature(result, args.publicKey, "Authenticated result");
    if (result.campaign_receipt_sha256 !== campaignHash) throw new Error("Result campaign chain hash is invalid.");
    const assignment = assignments.get(result.assignment_receipt_sha256); if (!assignment) throw new Error("Result has no authenticated assignment receipt.");
    if (resultAssignments.has(result.assignment_receipt_sha256)) throw new Error("Duplicate result for authenticated assignment."); resultAssignments.add(result.assignment_receipt_sha256);
    if (resultIds.has(result.result_id)) throw new Error("Duplicate result id."); resultIds.add(result.result_id);
    if (resultNonces.has(result.result_nonce)) throw new Error("Duplicate result nonce."); resultNonces.add(result.result_nonce);
    for (const field of ["task_id", "config_id", "representation", "pair_order", "fixture_id", "fixture_sha256", "fixture_adapter_sha256", "prompt_id", "prompt_sha256", "substrate", "provider", "model", "action_policy"] as const) {
      if (result[field] !== assignment[field]) throw new Error(`Result ${field} does not match its authenticated assignment.`);
    }
  }
  if (resultAssignments.size !== assignments.size) throw new Error("Every authenticated assignment must have exactly one authenticated result.");
}
