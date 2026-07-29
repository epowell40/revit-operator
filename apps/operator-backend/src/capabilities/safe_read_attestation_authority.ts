import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isHostedRuntime } from "../runtime_mode.js";
import { canonicalJson, type JsonValue } from "./tool_certification.js";

export const SAFE_READ_ATTESTATION_SET_SCHEMA = "revit-operator.safe-read-runtime-attestation-set.v1";
export const SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA = "revit-operator.safe-read-attestation-trusted-signers.v1";
export const SAFE_READ_ATTESTATION_AUTHORITY_ID = "safe-read.hosted-attestation-set.v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENTRIES = 16;

type RuntimeTuple = {
  host_content_sha256: string;
  host_mvid: string;
  revit_api_content_sha256: string;
  revit_api_mvid: string;
  revit_version: string;
};

type Signer = {
  key_id: string;
  algorithm: "ed25519";
  state: "active" | "revoked";
  public_key_spki_base64: string;
};

type AttestationEntry = {
  runtime_attestation_sha256: string;
  runtime_tuple: RuntimeTuple;
  attestationJson: string;
  attestation: unknown;
};

type AttestationSignature = {
  key_id: string;
  algorithm: "ed25519";
  signature_base64url: string;
};

export type HostedAttestationSelection = {
  attestation: unknown;
  attestationSha256: string;
  authorityId: typeof SAFE_READ_ATTESTATION_AUTHORITY_ID;
  setSequence: number;
  setSha256: string;
};

export class SafeReadAttestationAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "SafeReadAttestationAuthorityError";
  }
}

function reject(code: string, message: string, retryable = false): never {
  throw new SafeReadAttestationAuthorityError(code, message, retryable);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], location: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} fields do not match its schema.`);
  }
}

function hash(value: unknown, location: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} must be a lowercase sha256 value.`);
  }
  return value;
}

function token(value: unknown, location: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} must be a bounded token.`);
  }
  return value;
}

function canonicalUtc(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} must be canonical UTC.`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} must be canonical UTC.`);
  }
  return value;
}

function decodeBase64(value: unknown, location: string, url: boolean): Buffer {
  if (typeof value !== "string" || !value || (url && !BASE64URL.test(value))) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} is not canonical base64${url ? "url" : ""}.`);
  }
  const decoded = Buffer.from(value, url ? "base64url" : "base64");
  if (!decoded.length || decoded.toString(url ? "base64url" : "base64") !== value) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${location} is not canonical base64${url ? "url" : ""}.`);
  }
  return decoded;
}

function rawSha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readPinned(
  pathValue: string | undefined,
  pinValue: string | undefined,
  label: string,
  maxBytes: number
): { raw: Buffer; parsed: unknown; sha256: string } {
  if (!pathValue?.trim() || !pinValue || !HASH.test(pinValue)) {
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} path and hash pin must both be configured.`, true);
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.resolve(pathValue));
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} is unavailable.`, true);
  }
  if (raw.length < 1 || raw.length > maxBytes) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} exceeds its bounded file size.`);
  }
  const actual = rawSha256(raw);
  if (!equal(actual, pinValue)) reject("SAFE_READ_ATTESTATION_SET_PIN_MISMATCH", `${label} does not match its deployment pin.`);
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")), sha256: actual };
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} is not valid JSON.`);
  }
}

function parseTuple(value: unknown, location: string): RuntimeTuple {
  const tuple = object(value, location);
  exactKeys(tuple, ["host_content_sha256", "host_mvid", "revit_api_content_sha256", "revit_api_mvid", "revit_version"], location);
  for (const field of ["host_content_sha256", "revit_api_content_sha256"] as const) hash(tuple[field], `${location}.${field}`);
  for (const field of ["host_mvid", "revit_api_mvid", "revit_version"] as const) token(tuple[field], `${location}.${field}`);
  return tuple as RuntimeTuple;
}

function parseSignerRing(value: unknown): Map<string, Signer> {
  const ring = object(value, "trusted signer ring");
  exactKeys(ring, ["schema", "signers"], "trusted signer ring");
  if (ring.schema !== SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA || !Array.isArray(ring.signers) || ring.signers.length < 1 || ring.signers.length > MAX_ENTRIES) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Trusted signer ring schema or size is invalid.");
  }
  const result = new Map<string, Signer>();
  let previous = "";
  for (const [index, value] of ring.signers.entries()) {
    const signer = object(value, `signers[${index}]`);
    exactKeys(signer, ["key_id", "algorithm", "state", "public_key_spki_base64"], `signers[${index}]`);
    const keyId = token(signer.key_id, `signers[${index}].key_id`);
    if (keyId <= previous || signer.algorithm !== "ed25519" || (signer.state !== "active" && signer.state !== "revoked")) {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", "Trusted signers must be uniquely sorted Ed25519 entries with a valid state.");
    }
    const publicKey = decodeBase64(signer.public_key_spki_base64, `signers[${index}].public_key_spki_base64`, false);
    try {
      const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `signers[${index}] does not contain an Ed25519 SPKI key.`);
    }
    result.set(keyId, { key_id: keyId, algorithm: "ed25519", state: signer.state, public_key_spki_base64: signer.public_key_spki_base64 as string });
    previous = keyId;
  }
  return result;
}

function parseSet(value: unknown): { sequence: number; entries: AttestationEntry[]; signatures: AttestationSignature[]; payload: Record<string, unknown> } {
  const set = object(value, "attestation set");
  exactKeys(set, ["schema", "sequence", "issued_at_utc", "entries", "signatures"], "attestation set");
  if (set.schema !== SAFE_READ_ATTESTATION_SET_SCHEMA || !Number.isSafeInteger(set.sequence) || (set.sequence as number) < 1) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation set schema or sequence is invalid.");
  }
  canonicalUtc(set.issued_at_utc, "attestation set issued_at_utc");
  if (!Array.isArray(set.entries) || set.entries.length < 1 || set.entries.length > MAX_ENTRIES) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation set must contain 1-16 entries.");
  }
  const entries: AttestationEntry[] = [];
  let previousHash = "";
  for (const [index, value] of set.entries.entries()) {
    const entry = object(value, `entries[${index}]`);
    exactKeys(entry, ["runtime_attestation_sha256", "runtime_tuple", "attestation_json"], `entries[${index}]`);
    const attestationHash = hash(entry.runtime_attestation_sha256, `entries[${index}].runtime_attestation_sha256`);
    if (attestationHash <= previousHash) reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation entries must be uniquely sorted by hash.");
    if (typeof entry.attestation_json !== "string" || !entry.attestation_json || Buffer.byteLength(entry.attestation_json, "utf8") > 64 * 1024) {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `entries[${index}].attestation_json must be a bounded non-empty UTF-8 JSON string.`);
    }
    const computed = rawSha256(Buffer.from(entry.attestation_json, "utf8"));
    if (!equal(attestationHash, computed)) reject("SAFE_READ_ATTESTATION_SET_INVALID", `entries[${index}] attestation hash is invalid.`);
    let parsedAttestation: unknown;
    try {
      parsedAttestation = JSON.parse(entry.attestation_json.replace(/^\uFEFF/, ""));
    } catch {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `entries[${index}].attestation_json is not valid JSON.`);
    }
    entries.push({
      runtime_attestation_sha256: attestationHash,
      runtime_tuple: parseTuple(entry.runtime_tuple, `entries[${index}].runtime_tuple`),
      attestationJson: entry.attestation_json,
      attestation: parsedAttestation
    });
    previousHash = attestationHash;
  }
  if (!Array.isArray(set.signatures) || set.signatures.length < 1 || set.signatures.length > MAX_ENTRIES) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation set must contain 1-16 signatures.");
  }
  const signatures: AttestationSignature[] = [];
  let previousKey = "";
  for (const [index, value] of set.signatures.entries()) {
    const signature = object(value, `signatures[${index}]`);
    exactKeys(signature, ["key_id", "algorithm", "signature_base64url"], `signatures[${index}]`);
    const keyId = token(signature.key_id, `signatures[${index}].key_id`);
    if (keyId <= previousKey || signature.algorithm !== "ed25519") reject("SAFE_READ_ATTESTATION_SET_INVALID", "Signatures must be uniquely sorted Ed25519 entries.");
    decodeBase64(signature.signature_base64url, `signatures[${index}].signature_base64url`, true);
    signatures.push({ key_id: keyId, algorithm: "ed25519", signature_base64url: signature.signature_base64url as string });
    previousKey = keyId;
  }
  return {
    sequence: set.sequence as number,
    entries,
    signatures,
    payload: { schema: set.schema, sequence: set.sequence, issued_at_utc: set.issued_at_utc, entries: set.entries }
  };
}

export function hostedAttestationConfigPresent(env: NodeJS.ProcessEnv): boolean {
  return [
    env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH,
    env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256,
    env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_PATH,
    env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256
  ].some(value => Boolean(value?.trim()));
}

export function loadHostedSafeReadAttestation(
  env: NodeJS.ProcessEnv,
  requestedAttestationSha256: string,
  requestedRuntimeTuple: RuntimeTuple
): HostedAttestationSelection {
  if (!isHostedRuntime(env)) reject("SAFE_READ_ATTESTATION_CONFIG_MIXED", "Attestation-set configuration is allowed only in effective hosted mode.");
  if (env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256?.trim()) {
    reject("SAFE_READ_ATTESTATION_CONFIG_MIXED", "Hosted mode cannot combine single-manifest and attestation-set configuration.");
  }
  const ringFile = readPinned(
    env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_PATH,
    env.OPERATOR_SAFE_READ_ATTESTATION_TRUSTED_SIGNERS_SHA256,
    "SafeRead trusted signer ring",
    64 * 1024
  );
  const setFile = readPinned(
    env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_PATH,
    env.OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SET_SHA256,
    "SafeRead runtime attestation set",
    2 * 1024 * 1024
  );
  const signers = parseSignerRing(ringFile.parsed);
  const set = parseSet(setFile.parsed);
  const signedBytes = Buffer.from(canonicalJson(set.payload as JsonValue), "utf8");
  for (const signature of set.signatures) {
    const signer = signers.get(signature.key_id);
    if (!signer || signer.state !== "active") reject("SAFE_READ_ATTESTATION_SIGNATURE_INVALID", `Signature key ${signature.key_id} is unknown or revoked.`);
    const key = createPublicKey({ key: Buffer.from(signer.public_key_spki_base64, "base64"), format: "der", type: "spki" });
    if (!verify(null, signedBytes, key, Buffer.from(signature.signature_base64url, "base64url"))) {
      reject("SAFE_READ_ATTESTATION_SIGNATURE_INVALID", `Signature from ${signature.key_id} is invalid.`);
    }
  }
  const tupleJson = canonicalJson(requestedRuntimeTuple as unknown as JsonValue);
  const matches = set.entries.filter(entry => equal(entry.runtime_attestation_sha256, requestedAttestationSha256)
    && canonicalJson(entry.runtime_tuple as unknown as JsonValue) === tupleJson);
  if (matches.length !== 1) reject("SAFE_READ_ATTESTATION_SELECTION_FAILED", "No unique signed attestation matches the exact hash and runtime tuple.");
  return {
    attestation: matches[0]!.attestation,
    attestationSha256: matches[0]!.runtime_attestation_sha256,
    authorityId: SAFE_READ_ATTESTATION_AUTHORITY_ID,
    setSequence: set.sequence,
    setSha256: setFile.sha256
  };
}
