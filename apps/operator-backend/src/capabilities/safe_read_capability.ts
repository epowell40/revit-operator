import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestPrincipal } from "../request_context.js";
import { isHostedRuntime } from "../runtime_mode.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import {
  hostedAttestationConfigPresent,
  loadHostedSafeReadAttestation,
  SafeReadAttestationAuthorityError,
  type HostedAttestationSelection
} from "./safe_read_attestation_authority.js";
import { canonicalJson, sha256, type JsonValue } from "./tool_certification.js";

export const SAFE_READ_ROUTE_ID = "safe_read.sheet_count.v1";
export const SAFE_READ_EXECUTOR_ID = "revit-operator.safe-read-host.v1";
export const SAFE_READ_METHOD = "POST";
export const SAFE_READ_PATH = "/revit/certified/sheets/count";
export const SAFE_READ_BODY_SCHEMA = "revit-operator.safe-read.sheets-count.request.v1";
export const SAFE_READ_CANONICAL_BODY_JSON = `{"schema":"${SAFE_READ_BODY_SCHEMA}"}`;
export const SAFE_READ_PREAUTHORIZATION_SCHEMA = "revit-operator.safe-read-preauthorization-request.v1";
export const SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA = "revit-operator.safe-read-preauthorization-response.v1";
export const SAFE_READ_FINAL_AUTHORIZATION_SCHEMA = "revit-operator.safe-read-final-authorization-request.v1";
export const SAFE_READ_FINAL_RECEIPT_SCHEMA = "revit-operator.safe-read-final-authorization-receipt.v1";
export const SAFE_READ_RUNTIME_ATTESTATION_SCHEMA = "revit-operator.safe-read-runtime-attestation.v1";
export const SAFE_READ_PREAUTHORIZE_ENDPOINT = "/api/safe-read/direct/preauthorize";
export const SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT = "/api/safe-read/direct/authorize-execution";
export const SAFE_READ_CAPABILITY_VALID_FOR_MS = 30_000;
export const SAFE_READ_RECEIPT_VALID_FOR_MS = 2_000;
export const SAFE_READ_HTTP_MAX_BYTES = 64 * 1024;
export const SAFE_READ_COURIER_DISABLED = "SAFE_READ_COURIER_DISABLED";

const HASH = /^sha256:[0-9a-f]{64}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/;
const CAPABILITY_ID = /^src1_[A-Za-z0-9_-]{43}$/;
const RECEIPT_ID = /^srr1_[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ATTESTATION_FILENAME = "safe_read_runtime_attestation.v1.json";

const PREAUTH_KEYS = [
  "schema", "route_id", "host_instance_id", "executor_id", "runtime_attestation_sha256",
  "runtime_tuple", "document", "client_session_id", "request_id", "attempt_id", "capability_nonce_sha256"
] as const;
const FINAL_KEYS = [
  "schema", "route_id", "host_instance_id", "executor_id", "runtime_attestation_sha256",
  "runtime_tuple", "document", "client_session_id", "request_id", "attempt_id", "capability_id", "capability_nonce"
] as const;
const RUNTIME_KEYS = ["host_content_sha256", "host_mvid", "revit_api_content_sha256", "revit_api_mvid", "revit_version"] as const;
const DOCUMENT_KEYS = ["project_fingerprint", "document_session_id"] as const;
const ATTESTATION_KEYS = [
  "schema", "state", "issued_at_utc", "expires_at_utc", "route_id", "route_contract_sha256",
  "policy_sha256", "proof_sha256", "executor_id", "runtime_tuple"
] as const;

const SAFE_READ_CANONICAL_BODY = JSON.parse(SAFE_READ_CANONICAL_BODY_JSON) as JsonValue;
export const SAFE_READ_BODY_SHA256 = sha256(SAFE_READ_CANONICAL_BODY);
export const SAFE_READ_REQUEST_HASH = sha256({
  method: SAFE_READ_METHOD,
  path: SAFE_READ_PATH,
  body: SAFE_READ_CANONICAL_BODY
});
export const SAFE_READ_EFFECT_HASH = sha256({ effect: "read", resource: "sheets.count", mutates: false });
export const SAFE_READ_ROUTE_CONTRACT_SHA256 = sha256({
  route_id: SAFE_READ_ROUTE_ID,
  method: SAFE_READ_METHOD,
  path: SAFE_READ_PATH,
  canonical_body_json: SAFE_READ_CANONICAL_BODY_JSON,
  request_hash: SAFE_READ_REQUEST_HASH,
  effect_hash: SAFE_READ_EFFECT_HASH
});
export const SAFE_READ_POLICY_SHA256 = sha256({
  policy: "safe-read.direct-only.v1",
  courier: "disabled",
  capability: "single-use"
});

export const SAFE_READ_GOLDEN_CONTRACT = Object.freeze({
  route_id: SAFE_READ_ROUTE_ID,
  executor_id: SAFE_READ_EXECUTOR_ID,
  method: SAFE_READ_METHOD,
  path: SAFE_READ_PATH,
  body_schema: SAFE_READ_BODY_SCHEMA,
  canonical_body_json: SAFE_READ_CANONICAL_BODY_JSON,
  body_sha256: SAFE_READ_BODY_SHA256,
  request_hash: SAFE_READ_REQUEST_HASH,
  effect_hash: SAFE_READ_EFFECT_HASH,
  route_contract_sha256: SAFE_READ_ROUTE_CONTRACT_SHA256,
  policy_sha256: SAFE_READ_POLICY_SHA256,
  capability_id_pattern: "src1_ + 32-byte base64url (48 chars)",
  receipt_id_pattern: "srr1_ + 32-byte base64url (48 chars)",
  preauthorize_endpoint: SAFE_READ_PREAUTHORIZE_ENDPOINT,
  authorize_execution_endpoint: SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT,
  nonce_transport: "host-generated; sha256 in preauthorization body; raw nonce in final body only",
  receipt_hmac_domain: "safe-read-final-receipt-v1"
});

export type SafeReadRuntimeTuple = {
  host_content_sha256: string;
  host_mvid: string;
  revit_api_content_sha256: string;
  revit_api_mvid: string;
  revit_version: string;
};

export type SafeReadDocumentBinding = {
  project_fingerprint: string;
  document_session_id: string;
};

export type SafeReadPreauthorizationRequest = {
  schema: typeof SAFE_READ_PREAUTHORIZATION_SCHEMA;
  route_id: typeof SAFE_READ_ROUTE_ID;
  host_instance_id: string;
  executor_id: string;
  runtime_attestation_sha256: string;
  runtime_tuple: SafeReadRuntimeTuple;
  document: SafeReadDocumentBinding;
  client_session_id: string;
  request_id: string;
  attempt_id: string;
  capability_nonce_sha256: string;
};

export type SafeReadFinalAuthorizationRequest = Omit<SafeReadPreauthorizationRequest, "schema" | "capability_nonce_sha256"> & {
  schema: typeof SAFE_READ_FINAL_AUTHORIZATION_SCHEMA;
  capability_id: string;
  capability_nonce: string;
};

export type SafeReadPreauthorizationResponse = {
  schema: typeof SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA;
  capability_id: string;
  bindings_hash: string;
  issued_at_utc: string;
  expires_at_utc: string;
};

export type SafeReadPreauthorizationEnvelope = {
  ok: true;
  authorization: SafeReadPreauthorizationResponse;
};

export type SafeReadFinalAuthorizationReceipt = {
  schema: typeof SAFE_READ_FINAL_RECEIPT_SCHEMA;
  route_id: typeof SAFE_READ_ROUTE_ID;
  host_instance_id: string;
  executor_id: string;
  runtime_attestation_sha256: string;
  runtime_tuple: SafeReadRuntimeTuple;
  document: SafeReadDocumentBinding;
  client_session_id: string;
  request_id: string;
  attempt_id: string;
  capability_id: string;
  bindings_hash: string;
  receipt_id: string;
  issued_at_utc: string;
  expires_at_utc: string;
  hmac_sha256: string;
};

export type SafeReadFinalAuthorizationEnvelope = {
  ok: true;
  receipt: SafeReadFinalAuthorizationReceipt;
};

export type SafeReadFailureBody = {
  ok: false;
  code: string;
  error: string;
  retryable: boolean;
  request_dispatched: false;
  outcome_unknown: boolean;
};

export class SafeReadCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 500 | 503,
    readonly retryable: boolean,
    readonly outcomeUnknown = false
  ) {
    super(message);
    this.name = "SafeReadCapabilityError";
  }

  body(): SafeReadFailureBody {
    return {
      ok: false,
      code: this.code,
      error: this.message,
      retryable: this.retryable,
      request_dispatched: false,
      outcome_unknown: this.outcomeUnknown
    };
  }
}

type SqliteStatement = {
  run: (...args: unknown[]) => { changes: number | bigint };
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  all: (...args: unknown[]) => Record<string, unknown>[];
};
type SqliteDb = {
  pragma: (value: string) => unknown;
  exec: (value: string) => unknown;
  prepare: (value: string) => SqliteStatement;
  close: () => void;
};

type SafeReadServiceOptions = {
  databasePath: string;
  manifestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  /** Test-only fault injection at the outcome-unknown boundary. */
  afterConsume?: () => void;
};

type RuntimeAttestation = {
  schema: typeof SAFE_READ_RUNTIME_ATTESTATION_SCHEMA;
  state: "active" | "revoked";
  issued_at_utc: string;
  expires_at_utc: string;
  route_id: typeof SAFE_READ_ROUTE_ID;
  route_contract_sha256: string;
  policy_sha256: string;
  proof_sha256: string;
  executor_id: string;
  runtime_tuple: SafeReadRuntimeTuple;
};

type CapabilityRow = {
  principal_scope: string;
  capability_id_hash: string;
  nonce_sha256: string;
  bindings_json: string;
  bindings_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
  state: "preauthorized" | "consumed";
};

type LoadedAttestation = {
  manifest: RuntimeAttestation;
  sha256: string;
  hosted?: HostedAttestationSelection;
};

function fail(
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 410 | 500 | 503,
  retryable = false,
  outcomeUnknown = false
): never {
  throw new SafeReadCapabilityError(code, message, status, retryable, outcomeUnknown);
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("SAFE_READ_REQUEST_MALFORMED", `${location} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
}

function exactOrderedKeys(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail("SAFE_READ_REQUEST_MALFORMED", `${location} fields must exactly match canonical schema order.`, 400);
  }
}

function exactGuid(value: unknown, location: string): string {
  if (typeof value !== "string" || !GUID.test(value)) {
    fail("SAFE_READ_REQUEST_MALFORMED", `${location} must be a lowercase canonical GUID.`, 400);
  }
  return value;
}

function exactToken(value: unknown, location: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    fail("SAFE_READ_REQUEST_MALFORMED", `${location} must be a bounded canonical protocol token.`, 400);
  }
  return value;
}

function exactHash(value: unknown, location: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail("SAFE_READ_REQUEST_MALFORMED", `${location} must be a lowercase sha256 value.`, 400);
  }
  return value;
}

function runtimeTuple(value: unknown): SafeReadRuntimeTuple {
  const tuple = asObject(value, "runtime_tuple");
  exactOrderedKeys(tuple, RUNTIME_KEYS, "runtime_tuple");
  return {
    host_content_sha256: exactHash(tuple.host_content_sha256, "runtime_tuple.host_content_sha256"),
    host_mvid: exactGuid(tuple.host_mvid, "runtime_tuple.host_mvid"),
    revit_api_content_sha256: exactHash(tuple.revit_api_content_sha256, "runtime_tuple.revit_api_content_sha256"),
    revit_api_mvid: exactGuid(tuple.revit_api_mvid, "runtime_tuple.revit_api_mvid"),
    revit_version: exactToken(tuple.revit_version, "runtime_tuple.revit_version")
  };
}

function documentBinding(value: unknown): SafeReadDocumentBinding {
  const document = asObject(value, "document");
  exactOrderedKeys(document, DOCUMENT_KEYS, "document");
  return {
    project_fingerprint: exactHash(document.project_fingerprint, "document.project_fingerprint"),
    document_session_id: exactGuid(document.document_session_id, "document.document_session_id")
  };
}

export function parseSafeReadPreauthorizationRequest(value: unknown): SafeReadPreauthorizationRequest {
  const request = asObject(value, "SafeRead preauthorization request");
  exactOrderedKeys(request, PREAUTH_KEYS, "SafeRead preauthorization request");
  if (request.schema !== SAFE_READ_PREAUTHORIZATION_SCHEMA || request.route_id !== SAFE_READ_ROUTE_ID) {
    fail("SAFE_READ_REQUEST_MALFORMED", "SafeRead preauthorization schema or route is unsupported.", 400);
  }
  return {
    schema: SAFE_READ_PREAUTHORIZATION_SCHEMA,
    route_id: SAFE_READ_ROUTE_ID,
    host_instance_id: exactGuid(request.host_instance_id, "host_instance_id"),
    executor_id: request.executor_id === SAFE_READ_EXECUTOR_ID
      ? SAFE_READ_EXECUTOR_ID
      : fail("SAFE_READ_REQUEST_MALFORMED", "executor_id is unsupported.", 400),
    runtime_attestation_sha256: exactHash(request.runtime_attestation_sha256, "runtime_attestation_sha256"),
    runtime_tuple: runtimeTuple(request.runtime_tuple),
    document: documentBinding(request.document),
    client_session_id: exactGuid(request.client_session_id, "client_session_id"),
    request_id: exactGuid(request.request_id, "request_id"),
    attempt_id: exactGuid(request.attempt_id, "attempt_id"),
    capability_nonce_sha256: exactHash(request.capability_nonce_sha256, "capability_nonce_sha256")
  };
}

export function parseSafeReadFinalAuthorizationRequest(value: unknown): SafeReadFinalAuthorizationRequest {
  const request = asObject(value, "SafeRead final authorization request");
  exactOrderedKeys(request, FINAL_KEYS, "SafeRead final authorization request");
  if (request.schema !== SAFE_READ_FINAL_AUTHORIZATION_SCHEMA || request.route_id !== SAFE_READ_ROUTE_ID) {
    fail("SAFE_READ_REQUEST_MALFORMED", "SafeRead final authorization schema or route is unsupported.", 400);
  }
  if (typeof request.capability_id !== "string" || !CAPABILITY_ID.test(request.capability_id)) {
    fail("SAFE_READ_REQUEST_MALFORMED", "capability_id is malformed.", 400);
  }
  if (typeof request.capability_nonce !== "string" || !NONCE.test(request.capability_nonce)) {
    fail("SAFE_READ_REQUEST_MALFORMED", "capability_nonce must be exactly 256 bits in canonical base64url form.", 400);
  }
  return {
    schema: SAFE_READ_FINAL_AUTHORIZATION_SCHEMA,
    route_id: SAFE_READ_ROUTE_ID,
    host_instance_id: exactGuid(request.host_instance_id, "host_instance_id"),
    executor_id: request.executor_id === SAFE_READ_EXECUTOR_ID
      ? SAFE_READ_EXECUTOR_ID
      : fail("SAFE_READ_REQUEST_MALFORMED", "executor_id is unsupported.", 400),
    runtime_attestation_sha256: exactHash(request.runtime_attestation_sha256, "runtime_attestation_sha256"),
    runtime_tuple: runtimeTuple(request.runtime_tuple),
    document: documentBinding(request.document),
    client_session_id: exactGuid(request.client_session_id, "client_session_id"),
    request_id: exactGuid(request.request_id, "request_id"),
    attempt_id: exactGuid(request.attempt_id, "attempt_id"),
    capability_id: request.capability_id,
    capability_nonce: request.capability_nonce
  };
}

export function safeReadRuntimeAttestationPath(): string {
  const candidates = [
    path.resolve(MODULE_DIR, "../../config", ATTESTATION_FILENAME),
    path.resolve(MODULE_DIR, "../../../config", ATTESTATION_FILENAME)
  ];
  return candidates.find(candidate => fs.existsSync(candidate))
    ?? candidates.find(candidate => fs.existsSync(path.dirname(candidate)))
    ?? candidates[0]!;
}

function parseUtc(value: unknown, location: string): { source: string; ms: number } {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    fail("SAFE_READ_ATTESTATION_INVALID", `${location} must be canonical UTC.`, 503);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    fail("SAFE_READ_ATTESTATION_INVALID", `${location} is invalid.`, 503);
  }
  return { source: value, ms };
}

function parseAttestation(value: unknown): RuntimeAttestation {
  try {
    const manifest = asObject(value, "SafeRead runtime attestation");
    exactOrderedKeys(manifest, ATTESTATION_KEYS, "SafeRead runtime attestation");
    if (manifest.schema !== SAFE_READ_RUNTIME_ATTESTATION_SCHEMA) throw new Error("schema");
    if (manifest.state !== "active" && manifest.state !== "revoked") throw new Error("state");
    const issued = parseUtc(manifest.issued_at_utc, "issued_at_utc");
    const expires = parseUtc(manifest.expires_at_utc, "expires_at_utc");
    if (expires.ms <= issued.ms) throw new Error("time range");
    return {
      schema: SAFE_READ_RUNTIME_ATTESTATION_SCHEMA,
      state: manifest.state,
      issued_at_utc: issued.source,
      expires_at_utc: expires.source,
      route_id: manifest.route_id === SAFE_READ_ROUTE_ID
        ? SAFE_READ_ROUTE_ID
        : fail("SAFE_READ_ATTESTATION_INVALID", "Runtime attestation route_id is unsupported.", 503),
      route_contract_sha256: exactHash(manifest.route_contract_sha256, "route_contract_sha256"),
      policy_sha256: exactHash(manifest.policy_sha256, "policy_sha256"),
      proof_sha256: exactHash(manifest.proof_sha256, "proof_sha256"),
      executor_id: manifest.executor_id === SAFE_READ_EXECUTOR_ID
        ? SAFE_READ_EXECUTOR_ID
        : fail("SAFE_READ_ATTESTATION_INVALID", "Runtime attestation executor_id is unsupported.", 503),
      runtime_tuple: runtimeTuple(manifest.runtime_tuple)
    };
  } catch (error) {
    if (error instanceof SafeReadCapabilityError && error.code.startsWith("SAFE_READ_ATTESTATION_")) throw error;
    fail("SAFE_READ_ATTESTATION_INVALID", "SafeRead runtime attestation is malformed.", 503);
  }
}

function rawSha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bindingPayload(request: SafeReadPreauthorizationRequest, attestation: RuntimeAttestation): Record<string, unknown> {
  return {
    route_id: SAFE_READ_ROUTE_ID,
    method: SAFE_READ_METHOD,
    path: SAFE_READ_PATH,
    canonical_body_json: SAFE_READ_CANONICAL_BODY_JSON,
    request_hash: SAFE_READ_REQUEST_HASH,
    effect_hash: SAFE_READ_EFFECT_HASH,
    route_contract_sha256: attestation.route_contract_sha256,
    policy_sha256: attestation.policy_sha256,
    proof_sha256: attestation.proof_sha256,
    host_instance_id: request.host_instance_id,
    executor_id: request.executor_id,
    runtime_attestation_sha256: request.runtime_attestation_sha256,
    runtime_tuple: request.runtime_tuple,
    document: request.document,
    client_session_id: request.client_session_id,
    request_id: request.request_id,
    attempt_id: request.attempt_id
  };
}

function publicBindings(request: SafeReadFinalAuthorizationRequest): Omit<SafeReadFinalAuthorizationReceipt,
  "schema" | "capability_id" | "bindings_hash" | "receipt_id" | "issued_at_utc" | "expires_at_utc" | "hmac_sha256"> {
  return {
    route_id: request.route_id,
    host_instance_id: request.host_instance_id,
    executor_id: request.executor_id,
    runtime_attestation_sha256: request.runtime_attestation_sha256,
    runtime_tuple: request.runtime_tuple,
    document: request.document,
    client_session_id: request.client_session_id,
    request_id: request.request_id,
    attempt_id: request.attempt_id
  };
}

function capabilityIdHash(value: string): string {
  return rawSha256(`safe-read-capability-v1\0${value}`);
}

export function computeSafeReadReceiptHmac(
  nonce: Buffer,
  payload: Omit<SafeReadFinalAuthorizationReceipt, "hmac_sha256">
): string {
  const key = createHmac("sha256", nonce).update("safe-read-final-receipt-v1", "utf8").digest();
  return `sha256:${createHmac("sha256", key).update(canonicalJson(payload as unknown as JsonValue), "utf8").digest("hex")}`;
}

function assertAttestationMatches(attestation: RuntimeAttestation, request: SafeReadPreauthorizationRequest): void {
  const matches = attestation.route_id === request.route_id
    && attestation.route_contract_sha256 === SAFE_READ_ROUTE_CONTRACT_SHA256
    && attestation.policy_sha256 === SAFE_READ_POLICY_SHA256
    && attestation.executor_id === request.executor_id
    && canonicalJson(attestation.runtime_tuple as unknown as JsonValue) === canonicalJson(request.runtime_tuple as unknown as JsonValue);
  if (!matches) fail("SAFE_READ_ATTESTATION_BINDING_MISMATCH", "Runtime attestation does not bind this route, policy, executor, and runtime.", 403);
}

function rowFrom(value: Record<string, unknown> | undefined): CapabilityRow | null {
  if (!value) return null;
  return value as unknown as CapabilityRow;
}

export class SafeReadCapabilityService {
  private readonly db: SqliteDb;
  private readonly manifestPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly afterConsume?: () => void;

  constructor(options: SafeReadServiceOptions) {
    this.manifestPath = path.resolve(options.manifestPath ?? safeReadRuntimeAttestationPath());
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.random = options.randomBytes ?? randomBytes;
    this.afterConsume = options.afterConsume;
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
    const require = createRequire(import.meta.url);
    const Database = (require("better-sqlite3") as { default?: new (name: string) => SqliteDb } | (new (name: string) => SqliteDb));
    const Constructor = typeof Database === "function" ? Database : Database.default!;
    this.db = new Constructor(path.resolve(options.databasePath));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS safe_read_capabilities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_scope TEXT NOT NULL,
        client_session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        capability_id_hash TEXT NOT NULL UNIQUE,
        nonce_sha256 TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        bindings_hash TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('preauthorized','consumed')),
        consumed_at_ms INTEGER,
        UNIQUE(principal_scope, client_session_id, request_id, attempt_id)
      );
      CREATE INDEX IF NOT EXISTS idx_safe_read_expiry ON safe_read_capabilities(state, expires_at_ms);
      CREATE TABLE IF NOT EXISTS safe_read_attestation_high_water (
        authority_id TEXT PRIMARY KEY,
        set_sequence INTEGER NOT NULL,
        set_sha256 TEXT NOT NULL,
        signer_ring_epoch TEXT NOT NULL,
        signer_ring_sequence INTEGER NOT NULL,
        signer_ring_sha256 TEXT NOT NULL,
        accepted_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS safe_read_attestation_revoked_signers (
        authority_id TEXT NOT NULL,
        signer_ring_epoch TEXT NOT NULL,
        key_id TEXT NOT NULL,
        public_key_sha256 TEXT NOT NULL,
        revoked_at_ring_sequence INTEGER NOT NULL,
        PRIMARY KEY(authority_id, signer_ring_epoch, key_id)
      );
    `);
    const highWaterColumns = new Set(this.db.prepare("PRAGMA table_info(safe_read_attestation_high_water)")
      .all().map(column => String(column.name)));
    if (!highWaterColumns.has("signer_ring_epoch")) this.db.exec("ALTER TABLE safe_read_attestation_high_water ADD COLUMN signer_ring_epoch TEXT");
    if (!highWaterColumns.has("signer_ring_sequence")) this.db.exec("ALTER TABLE safe_read_attestation_high_water ADD COLUMN signer_ring_sequence INTEGER");
    if (!highWaterColumns.has("signer_ring_sha256")) this.db.exec("ALTER TABLE safe_read_attestation_high_water ADD COLUMN signer_ring_sha256 TEXT");
  }

  close(): void {
    this.db.close();
  }

  private loadAttestation(request: Pick<SafeReadPreauthorizationRequest, "runtime_attestation_sha256" | "runtime_tuple">): LoadedAttestation {
    let hostedMode: boolean;
    try {
      hostedMode = isHostedRuntime(this.env);
    } catch {
      fail("SAFE_READ_ATTESTATION_CONFIG_MIXED", "SafeRead runtime mode configuration is invalid.", 503);
    }
    if (hostedMode) {
      let hosted: HostedAttestationSelection;
      try {
        hosted = loadHostedSafeReadAttestation(this.env, request.runtime_attestation_sha256, request.runtime_tuple);
      } catch (error) {
        if (error instanceof SafeReadAttestationAuthorityError) {
          fail(error.code, error.message, error.code === "SAFE_READ_ATTESTATION_SELECTION_FAILED" ? 403 : 503, error.retryable);
        }
        fail("SAFE_READ_ATTESTATION_SET_INVALID", "SafeRead hosted attestation authority failed closed.", 503);
      }
      const manifest = parseAttestation(hosted.attestation);
      this.assertAttestationCurrent(manifest);
      return { manifest, sha256: hosted.attestationSha256, hosted };
    }
    if (hostedAttestationConfigPresent(this.env)) {
      fail("SAFE_READ_ATTESTATION_CONFIG_MIXED", "Attestation-set configuration is allowed only in effective hosted mode.", 503);
    }
    const pin = String(this.env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256 ?? "");
    if (!HASH.test(pin)) {
      fail("SAFE_READ_ATTESTATION_UNAVAILABLE", "SafeRead runtime attestation pin is not configured.", 503, true);
    }
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.manifestPath);
    } catch {
      fail("SAFE_READ_ATTESTATION_UNAVAILABLE", "SafeRead runtime attestation is unavailable.", 503, true);
    }
    const actual = rawSha256(raw);
    if (!equalSecret(pin, actual)) {
      fail("SAFE_READ_ATTESTATION_PIN_MISMATCH", "SafeRead runtime attestation does not match its deployment pin.", 503);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      fail("SAFE_READ_ATTESTATION_INVALID", "SafeRead runtime attestation is malformed.", 503);
    }
    const manifest = parseAttestation(parsed);
    this.assertAttestationCurrent(manifest);
    return { manifest, sha256: actual };
  }

  private assertAttestationCurrent(manifest: RuntimeAttestation): void {
    const now = this.now().getTime();
    if (manifest.state === "revoked") fail("SAFE_READ_ATTESTATION_REVOKED", "SafeRead runtime attestation is revoked.", 403);
    if (Date.parse(manifest.issued_at_utc) > now || Date.parse(manifest.expires_at_utc) <= now) {
      fail("SAFE_READ_ATTESTATION_STALE", "SafeRead runtime attestation is not currently valid.", 403);
    }
  }

  private acceptHostedHighWater(attested: LoadedAttestation, now: number): void {
    if (!attested.hosted) return;
    const {
      authorityId,
      setSequence,
      setSha256,
      signerRingEpoch,
      signerRingSequence,
      signerRingSha256,
      signerIdentities
    } = attested.hosted;
    const current = this.db.prepare(`
      SELECT set_sequence, set_sha256, signer_ring_epoch, signer_ring_sequence, signer_ring_sha256
      FROM safe_read_attestation_high_water WHERE authority_id=?
    `).get(authorityId) as {
      set_sequence: number;
      set_sha256: string;
      signer_ring_epoch: string | null;
      signer_ring_sequence: number | null;
      signer_ring_sha256: string | null;
    } | undefined;
    if (current && setSequence < current.set_sequence) {
      fail("SAFE_READ_ATTESTATION_SET_ROLLBACK", "Hosted attestation set sequence is below the durable high-water mark.", 503);
    }
    if (current && setSequence === current.set_sequence && !equalSecret(setSha256, current.set_sha256)) {
      fail("SAFE_READ_ATTESTATION_SET_EQUIVOCATION", "Hosted attestation set reuses a sequence with different content.", 503);
    }
    const hasRingHighWater = current?.signer_ring_epoch != null
      && current.signer_ring_sequence != null
      && current.signer_ring_sha256 != null;
    if (current && hasRingHighWater && signerRingEpoch !== current.signer_ring_epoch) {
      fail("SAFE_READ_ATTESTATION_SIGNER_RING_EPOCH_MISMATCH", "Hosted signer-ring epoch differs from the durable authority epoch.", 503);
    }
    if (current && hasRingHighWater && signerRingSequence < current.signer_ring_sequence!) {
      fail("SAFE_READ_ATTESTATION_SIGNER_RING_ROLLBACK", "Hosted signer-ring sequence is below the durable high-water mark.", 503);
    }
    if (current && hasRingHighWater && signerRingSequence === current.signer_ring_sequence
        && !equalSecret(signerRingSha256, current.signer_ring_sha256!)) {
      fail("SAFE_READ_ATTESTATION_SIGNER_RING_EQUIVOCATION", "Hosted signer ring reuses a sequence with different content.", 503);
    }
    const revoked = this.db.prepare(`
      SELECT key_id, public_key_sha256
      FROM safe_read_attestation_revoked_signers
      WHERE authority_id=? AND signer_ring_epoch=?
    `).all(authorityId, signerRingEpoch) as Array<{ key_id: string; public_key_sha256: string }>;
    const revokedById = new Map(revoked.map(identity => [identity.key_id, identity.public_key_sha256]));
    const revokedByMaterial = new Set(revoked.map(identity => identity.public_key_sha256));
    for (const identity of signerIdentities) {
      const priorMaterial = revokedById.get(identity.keyId);
      if (priorMaterial && !equalSecret(priorMaterial, identity.publicKeySha256)) {
        fail("SAFE_READ_ATTESTATION_SIGNER_IDENTITY_REUSE", "Hosted signer key identifier was rebound after revocation.", 503);
      }
      if (identity.state === "active" && (priorMaterial || revokedByMaterial.has(identity.publicKeySha256))) {
        fail("SAFE_READ_ATTESTATION_SIGNER_REACTIVATION", "A durably revoked hosted signer was reactivated.", 503);
      }
    }
    const rememberRevocation = this.db.prepare(`
      INSERT OR IGNORE INTO safe_read_attestation_revoked_signers(
        authority_id, signer_ring_epoch, key_id, public_key_sha256, revoked_at_ring_sequence
      ) VALUES(?,?,?,?,?)
    `);
    for (const identity of signerIdentities) {
      if (identity.state === "revoked") {
        rememberRevocation.run(authorityId, signerRingEpoch, identity.keyId, identity.publicKeySha256, signerRingSequence);
      }
    }
    if (!current) {
      this.db.prepare(`
        INSERT INTO safe_read_attestation_high_water(
          authority_id, set_sequence, set_sha256, signer_ring_epoch, signer_ring_sequence, signer_ring_sha256, accepted_at_ms
        ) VALUES(?,?,?,?,?,?,?)
      `).run(authorityId, setSequence, setSha256, signerRingEpoch, signerRingSequence, signerRingSha256, now);
    } else if (!hasRingHighWater || setSequence > current.set_sequence || signerRingSequence > current.signer_ring_sequence!) {
      this.db.prepare(`
        UPDATE safe_read_attestation_high_water
        SET set_sequence=?, set_sha256=?, signer_ring_epoch=?, signer_ring_sequence=?, signer_ring_sha256=?, accepted_at_ms=?
        WHERE authority_id=?
      `).run(setSequence, setSha256, signerRingEpoch, signerRingSequence, signerRingSha256, now, authorityId);
    }
  }

  preauthorize(principalScope: string, value: unknown): SafeReadPreauthorizationResponse {
    const scope = exactHash(principalScope, "principal scope");
    const request = parseSafeReadPreauthorizationRequest(value);
    const attested = this.loadAttestation(request);
    if (!equalSecret(request.runtime_attestation_sha256, attested.sha256)) {
      fail("SAFE_READ_ATTESTATION_PIN_MISMATCH", "Request does not bind the deployment-pinned runtime attestation.", 403);
    }
    assertAttestationMatches(attested.manifest, request);
    const now = this.now().getTime();
    const expires = now + SAFE_READ_CAPABILITY_VALID_FOR_MS;
    const capabilityId = `src1_${this.random(32).toString("base64url")}`;
    const bindings = bindingPayload(request, attested.manifest);
    const bindingsJson = canonicalJson(bindings as unknown as JsonValue);
    const bindingsHash = rawSha256(bindingsJson);
    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      this.acceptHostedHighWater(attested, now);
      this.db.prepare(`
        INSERT INTO safe_read_capabilities(
          principal_scope, client_session_id, request_id, attempt_id, capability_id_hash,
          nonce_sha256, bindings_json, bindings_hash, issued_at_ms, expires_at_ms, state
        ) VALUES(?,?,?,?,?,?,?,?,?,?, 'preauthorized')
      `).run(
        scope, request.client_session_id, request.request_id, request.attempt_id, capabilityIdHash(capabilityId),
        request.capability_nonce_sha256, bindingsJson, bindingsHash, now, expires
      );
      this.db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      }
      if (error instanceof SafeReadCapabilityError) throw error;
      if (String(error).includes("UNIQUE constraint failed")) {
        fail("SAFE_READ_ATTEMPT_ALREADY_EXISTS", "This principal, session, request, and attempt already has a capability.", 409);
      }
      fail("SAFE_READ_STORE_UNAVAILABLE", "SafeRead capability store is unavailable.", 503, true);
    }
    return {
      schema: SAFE_READ_PREAUTHORIZATION_RESPONSE_SCHEMA,
      capability_id: capabilityId,
      bindings_hash: bindingsHash,
      issued_at_utc: new Date(now).toISOString(),
      expires_at_utc: new Date(expires).toISOString()
    };
  }

  authorizeExecution(principalScope: string, value: unknown): SafeReadFinalAuthorizationReceipt {
    const scope = exactHash(principalScope, "principal scope");
    const request = parseSafeReadFinalAuthorizationRequest(value);
    const nonceBytes = Buffer.from(request.capability_nonce, "base64url");
    try {
      return this.authorizeExecutionWithNonce(scope, request, nonceBytes);
    } finally {
      nonceBytes.fill(0);
    }
  }

  private authorizeExecutionWithNonce(
    scope: string,
    request: SafeReadFinalAuthorizationRequest,
    nonceBytes: Buffer
  ): SafeReadFinalAuthorizationReceipt {
    const idHash = capabilityIdHash(request.capability_id);
    const initial = rowFrom(this.db.prepare(`
      SELECT principal_scope, capability_id_hash, nonce_sha256, bindings_json, bindings_hash,
             issued_at_ms, expires_at_ms, state
      FROM safe_read_capabilities WHERE capability_id_hash=?
    `).get(idHash));
    if (!initial || initial.principal_scope !== scope) {
      fail("SAFE_READ_CAPABILITY_NOT_FOUND", "SafeRead capability was not found for this principal.", 404);
    }
    const nonceHash = rawSha256(nonceBytes);
    if (!equalSecret(initial.nonce_sha256, nonceHash)) {
      fail("SAFE_READ_CAPABILITY_POSSESSION_FAILED", "SafeRead capability possession proof is invalid.", 403);
    }
    try {
      JSON.parse(initial.bindings_json) as Record<string, unknown>;
    } catch {
      fail("SAFE_READ_STORE_UNAVAILABLE", "Stored SafeRead bindings are invalid.", 503, true);
    }
    const expectedRequest = {
      schema: SAFE_READ_PREAUTHORIZATION_SCHEMA,
      ...publicBindings(request),
      capability_nonce_sha256: nonceHash
    } as SafeReadPreauthorizationRequest;
    const attested = this.loadAttestation(expectedRequest);
    if (!equalSecret(request.runtime_attestation_sha256, attested.sha256)) {
      fail("SAFE_READ_ATTESTATION_PIN_MISMATCH", "Capability does not bind the current deployment-pinned runtime attestation.", 403);
    }
    assertAttestationMatches(attested.manifest, expectedRequest);
    const expectedBindings = canonicalJson(bindingPayload(expectedRequest, attested.manifest) as unknown as JsonValue);
    if (!equalSecret(initial.bindings_json, expectedBindings) || !equalSecret(initial.bindings_hash, rawSha256(expectedBindings))) {
      fail("SAFE_READ_CAPABILITY_BINDING_MISMATCH", "SafeRead capability does not bind this immutable execution tuple.", 403);
    }

    const now = this.now().getTime();
    if (initial.expires_at_ms <= now) fail("SAFE_READ_CAPABILITY_EXPIRED", "SafeRead capability has expired.", 410);
    if (initial.state !== "preauthorized") fail("SAFE_READ_CAPABILITY_REPLAYED", "SafeRead capability was already consumed.", 409);

    let casApplied = false;
    let commitConfirmed = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      // Re-read pins, signer authorization, set contents, and the exact selected tuple
      // while the capability CAS transaction is held. This is intentionally separate
      // from the earlier preflight verification.
      const casAttested = this.loadAttestation(expectedRequest);
      if (!equalSecret(request.runtime_attestation_sha256, casAttested.sha256)) {
        fail("SAFE_READ_ATTESTATION_PIN_MISMATCH", "Capability does not bind the final deployment-pinned runtime attestation.", 403);
      }
      assertAttestationMatches(casAttested.manifest, expectedRequest);
      const casExpectedBindings = canonicalJson(bindingPayload(expectedRequest, casAttested.manifest) as unknown as JsonValue);
      if (!equalSecret(initial.bindings_json, casExpectedBindings) || !equalSecret(initial.bindings_hash, rawSha256(casExpectedBindings))) {
        fail("SAFE_READ_CAPABILITY_BINDING_MISMATCH", "SafeRead capability does not bind the final immutable execution tuple.", 403);
      }
      this.acceptHostedHighWater(casAttested, this.now().getTime());
      const current = rowFrom(this.db.prepare(`
        SELECT principal_scope, capability_id_hash, nonce_sha256, bindings_json, bindings_hash,
               issued_at_ms, expires_at_ms, state
        FROM safe_read_capabilities WHERE capability_id_hash=?
      `).get(idHash));
      const casNow = this.now().getTime();
      if (!current || current.principal_scope !== scope) {
        this.db.exec("ROLLBACK");
        fail("SAFE_READ_CAPABILITY_NOT_FOUND", "SafeRead capability was not found for this principal.", 404);
      }
      if (current.expires_at_ms <= casNow) {
        this.db.exec("ROLLBACK");
        fail("SAFE_READ_CAPABILITY_EXPIRED", "SafeRead capability has expired.", 410);
      }
      if (current.state !== "preauthorized") {
        this.db.exec("ROLLBACK");
        fail("SAFE_READ_CAPABILITY_REPLAYED", "SafeRead capability was already consumed.", 409);
      }
      const result = this.db.prepare(`
        UPDATE safe_read_capabilities SET state='consumed', consumed_at_ms=?
        WHERE capability_id_hash=? AND principal_scope=? AND state='preauthorized' AND expires_at_ms>?
      `).run(casNow, idHash, scope, casNow);
      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        fail("SAFE_READ_CAPABILITY_REPLAYED", "SafeRead capability was not consumable.", 409);
      }
      casApplied = true;
      this.db.exec("COMMIT");
      commitConfirmed = true;
    } catch (error) {
      if (!commitConfirmed) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      }
      if (error instanceof SafeReadCapabilityError) throw error;
      fail("SAFE_READ_STORE_UNAVAILABLE", "SafeRead capability consumption failed.", 503, !casApplied, casApplied);
    }

    try {
      this.afterConsume?.();
      const issuedAt = this.now().getTime();
      const payload: Omit<SafeReadFinalAuthorizationReceipt, "hmac_sha256"> = {
        schema: SAFE_READ_FINAL_RECEIPT_SCHEMA,
        ...publicBindings(request),
        capability_id: request.capability_id,
        bindings_hash: initial.bindings_hash,
        receipt_id: `srr1_${this.random(32).toString("base64url")}`,
        issued_at_utc: new Date(issuedAt).toISOString(),
        expires_at_utc: new Date(issuedAt + SAFE_READ_RECEIPT_VALID_FOR_MS).toISOString()
      };
      return { ...payload, hmac_sha256: computeSafeReadReceiptHmac(nonceBytes, payload) };
    } catch {
      fail(
        "SAFE_READ_POST_AUTHORIZATION_FAILURE",
        "SafeRead capability was consumed but the final receipt could not be completed.",
        500,
        false,
        true
      );
    }
  }
}

export function safeReadPrincipalScope(mode: "shared_token" | "principal_jwt", principal?: RequestPrincipal): string {
  if (mode === "principal_jwt") {
    if (!principal) fail("SAFE_READ_AUTHENTICATION_REQUIRED", "SafeRead requires an authenticated principal.", 403);
    return rawSha256(canonicalJson({
      tenant_id: principal.tenant_id || principal.license_id,
      user_id: principal.user_id,
      subject: principal.sub
    }));
  }
  return rawSha256("safe-read-principal-scope-v1\0shared-token");
}

const services = new Map<string, SafeReadCapabilityService>();

export function getSafeReadCapabilityService(): SafeReadCapabilityService {
  const databasePath = path.join(ensureWorkspaceLayout().db, "safe-read-capabilities.sqlite");
  let service = services.get(databasePath);
  if (!service) {
    service = new SafeReadCapabilityService({ databasePath });
    services.set(databasePath, service);
  }
  return service;
}

export function safeReadCourierDisabledFailure(): SafeReadFailureBody {
  return new SafeReadCapabilityError(
    SAFE_READ_COURIER_DISABLED,
    "SafeRead capabilities are direct-only; courier jobs and transport are disabled.",
    403,
    false
  ).body();
}

export function safeReadPreauthorizationEnvelope(
  authorization: SafeReadPreauthorizationResponse
): SafeReadPreauthorizationEnvelope {
  return { ok: true, authorization };
}

export function safeReadFinalAuthorizationEnvelope(
  receipt: SafeReadFinalAuthorizationReceipt
): SafeReadFinalAuthorizationEnvelope {
  return { ok: true, receipt };
}

export function safeReadDirectEndpointEnvelope(
  service: SafeReadCapabilityService,
  pathname: string,
  principalScope: string,
  body: unknown
): SafeReadPreauthorizationEnvelope | SafeReadFinalAuthorizationEnvelope {
  if (pathname === SAFE_READ_PREAUTHORIZE_ENDPOINT) {
    return safeReadPreauthorizationEnvelope(service.preauthorize(principalScope, body));
  }
  if (pathname === SAFE_READ_AUTHORIZE_EXECUTION_ENDPOINT) {
    return safeReadFinalAuthorizationEnvelope(service.authorizeExecution(principalScope, body));
  }
  fail("SAFE_READ_REQUEST_MALFORMED", "SafeRead direct endpoint is unsupported.", 404);
}

export function isSafeReadCapabilityId(value: unknown): value is string {
  return typeof value === "string" && CAPABILITY_ID.test(value);
}

export function isSafeReadReceiptId(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_ID.test(value);
}
