import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DYNAMIC_PROGRAM_ADMISSION_SCHEMA = "dynamic_program_admission/v1" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REVIT_VERSIONS = new Set(["2023", "2024", "2025"]);

export type DynamicProgramAdmissionV1 = {
  schema: typeof DYNAMIC_PROGRAM_ADMISSION_SCHEMA;
  admission_id: string;
  normalized_source_hash: string;
  compiled_artifact_hash: string;
  compiler_runtime_hash: string;
  sdk_version: string;
  sdk_manifest_hash: string;
  sdk_artifact_hash: string;
  worker_executable_hash: string;
  worker_runtime_package_hash: string;
  sandbox_profile_version: string;
  sandbox_profile_hash: string;
  authenticated_worker_identity_hash: string;
  target_revit_version: "2023" | "2024" | "2025";
  host_adapter_manifest_hash: string;
  document_fingerprint: string;
  document_session_id: string;
  document_revision: number;
  project_context_identity_hash: string;
  capability_envelope_hash: string;
  operation_family_envelope_hash: string;
  effect_budget_hash: string;
  file_capability_set_hash: string;
  operation_graph_hash: string;
  preview_receipt_hash: string;
  policy_identity_hash: string;
  runtime_identity_hash: string;
  request_family_seal_hash: string;
  final_authorization_hash: string;
  principal_id_hash: string;
  principal_session_hash: string;
  correlation_id: string;
  replay_nonce_hash: string;
  issued_unix_seconds: number;
  expires_unix_seconds: number;
  admission_signature: string;
};

type UnsignedDynamicProgramAdmissionV1 = Omit<DynamicProgramAdmissionV1, "admission_signature">;
export type TrustedDynamicAdmissionFactsV1 = Omit<UnsignedDynamicProgramAdmissionV1, "schema">;

export type DynamicAdmissionReplayAuthority = {
  consume(replayKey: string, expiresUnixSeconds: number, nowUnixSeconds: number): boolean;
};

const ORDER: readonly (keyof UnsignedDynamicProgramAdmissionV1)[] = [
  "schema", "admission_id", "normalized_source_hash", "compiled_artifact_hash", "compiler_runtime_hash",
  "sdk_version", "sdk_manifest_hash", "sdk_artifact_hash", "worker_executable_hash", "worker_runtime_package_hash",
  "sandbox_profile_version", "sandbox_profile_hash", "authenticated_worker_identity_hash", "target_revit_version",
  "host_adapter_manifest_hash", "document_fingerprint", "document_session_id", "document_revision",
  "project_context_identity_hash", "capability_envelope_hash", "operation_family_envelope_hash", "effect_budget_hash",
  "file_capability_set_hash", "operation_graph_hash", "preview_receipt_hash", "policy_identity_hash", "runtime_identity_hash",
  "request_family_seal_hash", "final_authorization_hash", "principal_id_hash", "principal_session_hash", "correlation_id",
  "replay_nonce_hash", "issued_unix_seconds", "expires_unix_seconds"
];

const EXACT_KEYS = [...ORDER, "admission_signature"].sort();

export class DynamicProgramAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DynamicProgramAdmissionError";
  }
}

function denied(code: string, message: string): never {
  throw new DynamicProgramAdmissionError(code, message);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    denied("DYNAMIC_ADMISSION_SHAPE_DENIED", "Dynamic program admission must be a plain object.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || value !== value.normalize("NFC")) {
    denied("DYNAMIC_ADMISSION_FIELD_DENIED", `${field} is not a bounded canonical string.`);
  }
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) denied("DYNAMIC_ADMISSION_HASH_DENIED", `${field} is not a canonical SHA-256 identity.`);
  return value as string;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) denied("DYNAMIC_ADMISSION_FIELD_DENIED", `${field} must be a safe integer.`);
  return value as number;
}

function fixedEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalPart(value: string | number): string {
  return `+${Buffer.from(String(value), "utf8").toString("base64")}\n`;
}

export function canonicalDynamicProgramAdmission(admission: UnsignedDynamicProgramAdmissionV1): string {
  return ORDER.map(field => canonicalPart(admission[field] as string | number)).join("");
}

export function signDynamicProgramAdmission(admission: UnsignedDynamicProgramAdmissionV1, trustedKey: Buffer): string {
  if (!Buffer.isBuffer(trustedKey) || trustedKey.length < 32) denied("DYNAMIC_ADMISSION_AUTHORITY_DENIED", "Dynamic admission authority key must be at least 256 bits.");
  return `hmac-sha256:${createHmac("sha256", trustedKey).update(canonicalDynamicProgramAdmission(admission), "utf8").digest("hex")}`;
}

export function issueDynamicProgramAdmission(facts: TrustedDynamicAdmissionFactsV1, trustedKey: Buffer): DynamicProgramAdmissionV1 {
  const unsigned = { schema: DYNAMIC_PROGRAM_ADMISSION_SCHEMA, ...facts } satisfies UnsignedDynamicProgramAdmissionV1;
  return { ...unsigned, admission_signature: signDynamicProgramAdmission(unsigned, trustedKey) };
}

export function dynamicAdmissionReplayKey(admission: DynamicProgramAdmissionV1): string {
  return `sha256:${createHash("sha256").update(`${admission.admission_id}\n${admission.replay_nonce_hash}\n${admission.final_authorization_hash}`, "utf8").digest("hex")}`;
}

export function validateAndConsumeDynamicProgramAdmission(args: {
  admission: unknown;
  trusted_facts: TrustedDynamicAdmissionFactsV1;
  trusted_key: Buffer;
  replay_authority: DynamicAdmissionReplayAuthority;
  now_unix_seconds?: number;
}): Readonly<DynamicProgramAdmissionV1> {
  const record = plainObject(args.admission);
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== EXACT_KEYS.length || actualKeys.some((value, index) => value !== EXACT_KEYS[index])) {
    denied("DYNAMIC_ADMISSION_SHAPE_DENIED", "Dynamic program admission has missing or unknown fields.");
  }
  if (record.schema !== DYNAMIC_PROGRAM_ADMISSION_SCHEMA) denied("DYNAMIC_ADMISSION_SCHEMA_DENIED", "Dynamic program admission schema is unsupported.");
  const admission = record as DynamicProgramAdmissionV1;
  text(admission.admission_id, "admission_id", 160); text(admission.correlation_id, "correlation_id", 160);
  text(admission.sdk_version, "sdk_version", 128); text(admission.sandbox_profile_version, "sandbox_profile_version", 128);
  text(admission.document_session_id, "document_session_id", 256);
  if (!REVIT_VERSIONS.has(admission.target_revit_version)) denied("DYNAMIC_ADMISSION_VERSION_DENIED", "Target Revit version is outside the supported manifest set.");
  const hashFields = ORDER.filter(field => String(field).endsWith("_hash") || field === "document_fingerprint");
  for (const field of hashFields) hash(admission[field], String(field));
  const revision = integer(admission.document_revision, "document_revision");
  const issued = integer(admission.issued_unix_seconds, "issued_unix_seconds");
  const expires = integer(admission.expires_unix_seconds, "expires_unix_seconds");
  const now = args.now_unix_seconds ?? Math.floor(Date.now() / 1000);
  if (revision < 0 || issued > now + 5 || expires <= now || expires > now + 300 || expires <= issued) {
    denied("DYNAMIC_ADMISSION_EXPIRED", "Dynamic program admission lifetime or document revision is invalid.");
  }

  const trusted = { schema: DYNAMIC_PROGRAM_ADMISSION_SCHEMA, ...args.trusted_facts } as UnsignedDynamicProgramAdmissionV1;
  for (const field of ORDER) {
    if (field === "schema") continue;
    const observed = String(admission[field]); const expected = String(trusted[field]);
    if (!fixedEqual(observed, expected)) denied("DYNAMIC_ADMISSION_BINDING_DENIED", `Dynamic program admission ${String(field)} does not match trusted current state.`);
  }
  const expectedSignature = signDynamicProgramAdmission(trusted, args.trusted_key);
  if (!fixedEqual(expectedSignature, text(admission.admission_signature, "admission_signature", 128))) {
    denied("DYNAMIC_ADMISSION_SIGNATURE_DENIED", "Dynamic program admission signature is invalid.");
  }
  const replayKey = dynamicAdmissionReplayKey(admission);
  if (!args.replay_authority.consume(replayKey, expires, now)) {
    denied("DYNAMIC_ADMISSION_REPLAY_DENIED", "Dynamic program admission was replayed.");
  }
  return Object.freeze({ ...admission });
}
