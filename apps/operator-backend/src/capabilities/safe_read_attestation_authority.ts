import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
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
  public_key_sha256: string;
};

type SignerRingReference = {
  epoch: string;
  sequence: number;
  sha256: string;
};

export type HostedSignerIdentity = {
  keyId: string;
  state: "active" | "revoked";
  publicKeySha256: string;
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
  signerRingEpoch: string;
  signerRingSequence: number;
  signerRingSha256: string;
  signerIdentities: HostedSignerIdentity[];
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

function parseStrictJsonText(text: string, label: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} must not contain a UTF-8 BOM.`);
  const scanner = new StrictJsonScanner(text, label);
  scanner.scan();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} is not valid JSON.`);
  }
}

function parseStrictJsonBytes(raw: Buffer, label: string): unknown {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} must not contain a UTF-8 BOM.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} is not valid UTF-8.`);
  }
  return parseStrictJsonText(text, label);
}

class StrictJsonScanner {
  private index = 0;
  constructor(private readonly text: string, private readonly label: string) {}

  scan(): void {
    this.whitespace();
    this.value("$");
    this.whitespace();
    if (this.index !== this.text.length) this.invalid("contains trailing data");
  }

  private value(location: string): void {
    const character = this.text[this.index];
    if (character === "{") return this.object(location);
    if (character === "[") return this.array(location);
    if (character === '"') { this.string(); return; }
    if (character === "t") return this.literal("true");
    if (character === "f") return this.literal("false");
    if (character === "n") return this.literal("null");
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) return this.number();
    this.invalid(`contains an invalid value at ${location}`);
  }

  private object(location: string): void {
    this.index++;
    this.whitespace();
    if (this.text[this.index] === "}") { this.index++; return; }
    const keys = new Set<string>();
    while (true) {
      if (this.text[this.index] !== '"') this.invalid(`contains a non-string object key at ${location}`);
      const key = this.string();
      if (keys.has(key)) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${this.label} repeats JSON property ${JSON.stringify(key)} at ${location}.`);
      keys.add(key);
      this.whitespace();
      if (this.text[this.index++] !== ":") this.invalid(`is missing ':' after ${location}.${key}`);
      this.whitespace();
      this.value(`${location}.${key}`);
      this.whitespace();
      const separator = this.text[this.index++];
      if (separator === "}") return;
      if (separator !== ",") this.invalid(`contains an invalid object separator at ${location}`);
      this.whitespace();
    }
  }

  private array(location: string): void {
    this.index++;
    this.whitespace();
    if (this.text[this.index] === "]") { this.index++; return; }
    let item = 0;
    while (true) {
      this.value(`${location}[${item++}]`);
      this.whitespace();
      const separator = this.text[this.index++];
      if (separator === "]") return;
      if (separator !== ",") this.invalid(`contains an invalid array separator at ${location}`);
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.index++;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index++;
        const source = this.text.slice(start, this.index);
        try { return JSON.parse(source) as string; }
        catch { this.invalid("contains an invalid JSON string"); }
      }
      if (code < 0x20) this.invalid("contains an unescaped control character");
      if (code === 0x5c) {
        this.index++;
        const escape = this.text[this.index];
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.invalid("contains an invalid Unicode escape");
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.invalid("contains an invalid escape");
      }
      this.index++;
    }
    this.invalid("contains an unterminated JSON string");
  }

  private number(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.index));
    if (!match) this.invalid("contains an invalid JSON number");
    this.index += match[0].length;
  }

  private literal(expected: string): void {
    if (this.text.slice(this.index, this.index + expected.length) !== expected) this.invalid("contains an invalid JSON literal");
    this.index += expected.length;
  }

  private whitespace(): void {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index]!)) this.index++;
  }

  private invalid(detail: string): never {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${this.label} ${detail}.`);
  }
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  // Node's Windows path-stat reports dev=0 while descriptor-stat reports the
  // volume serial. The stable file index (`ino`) is shared by both APIs.
  return left.ino !== 0 && left.ino === right.ino
    && (process.platform === "win32" || left.dev === right.dev);
}

function sameSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function canonicalPinnedPath(value: string, label: string): string {
  if (value !== value.trim() || !path.isAbsolute(value)) {
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} path must be an absolute canonical path.`, true);
  }
  const resolved = path.resolve(value);
  if (!pathsEqual(resolved, value)) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} path is not canonical.`);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch { reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} is unavailable.`, true); }
    if (stat.isSymbolicLink()) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} path must not contain links or reparse points.`);
  }
  let real: string;
  let parent: string;
  try {
    real = fs.realpathSync.native(resolved);
    parent = fs.realpathSync.native(path.dirname(resolved));
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} is unavailable.`, true);
  }
  if (!pathsEqual(real, resolved) || !pathsEqual(path.dirname(real), parent)) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} path escapes its canonical parent.`);
  }
  return resolved;
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
  const resolved = canonicalPinnedPath(pathValue, label);
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlocking = fs.constants.O_NONBLOCK ?? 0;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow | nonBlocking);
  } catch {
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} is unavailable.`, true);
  }
  try {
    const before = fs.fstatSync(descriptor);
    const pathBefore = fs.lstatSync(resolved);
    if (!before.isFile() || !pathBefore.isFile() || !sameIdentity(before, pathBefore)) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} must be one stable regular file.`);
    if (before.size < 1 || before.size > maxBytes) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} exceeds its bounded file size.`);
    const raw = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < raw.length) {
      const count = fs.readSync(descriptor, raw, offset, raw.length - offset, offset);
      if (count < 1) reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} changed during its bounded read.`);
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, raw.length) !== 0) {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} grew during its bounded read.`);
    }
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(resolved);
    if (!sameSnapshot(before, after) || !pathAfter.isFile() || !sameIdentity(after, pathAfter) || pathAfter.size !== after.size) {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `${label} changed identity during its bounded read.`);
    }
    const actual = rawSha256(raw);
    if (!equal(actual, pinValue)) reject("SAFE_READ_ATTESTATION_SET_PIN_MISMATCH", `${label} does not match its deployment pin.`);
    return { raw, parsed: parseStrictJsonBytes(raw, label), sha256: actual };
  } catch (error) {
    if (error instanceof SafeReadAttestationAuthorityError) throw error;
    reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} could not be read safely.`, true);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* primary result remains authoritative */ }
    }
  }
  reject("SAFE_READ_ATTESTATION_SET_UNAVAILABLE", `${label} could not be read safely.`, true);
}

function parseTuple(value: unknown, location: string): RuntimeTuple {
  const tuple = object(value, location);
  exactKeys(tuple, ["host_content_sha256", "host_mvid", "revit_api_content_sha256", "revit_api_mvid", "revit_version"], location);
  for (const field of ["host_content_sha256", "revit_api_content_sha256"] as const) hash(tuple[field], `${location}.${field}`);
  for (const field of ["host_mvid", "revit_api_mvid", "revit_version"] as const) token(tuple[field], `${location}.${field}`);
  return tuple as RuntimeTuple;
}

function parseSignerRing(value: unknown, sha256: string): { reference: SignerRingReference; signers: Map<string, Signer> } {
  const ring = object(value, "trusted signer ring");
  exactKeys(ring, ["schema", "epoch", "sequence", "signers"], "trusted signer ring");
  const epoch = token(ring.epoch, "trusted signer ring epoch");
  if (ring.schema !== SAFE_READ_ATTESTATION_SIGNER_RING_SCHEMA || !Number.isSafeInteger(ring.sequence) || (ring.sequence as number) < 1
      || !Array.isArray(ring.signers) || ring.signers.length < 1 || ring.signers.length > MAX_ENTRIES) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Trusted signer ring schema or size is invalid.");
  }
  const result = new Map<string, Signer>();
  const publicKeys = new Map<string, string>();
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
    const publicKeySha256 = rawSha256(publicKey);
    const existingKeyId = publicKeys.get(publicKeySha256);
    if (existingKeyId) {
      reject("SAFE_READ_ATTESTATION_SET_INVALID", `signers[${index}] reuses public-key material from ${existingKeyId}.`);
    }
    publicKeys.set(publicKeySha256, keyId);
    result.set(keyId, {
      key_id: keyId,
      algorithm: "ed25519",
      state: signer.state,
      public_key_spki_base64: signer.public_key_spki_base64 as string,
      public_key_sha256: publicKeySha256
    });
    previous = keyId;
  }
  return { reference: { epoch, sequence: ring.sequence as number, sha256 }, signers: result };
}

function parseSet(value: unknown): {
  sequence: number;
  signerRing: SignerRingReference;
  entries: AttestationEntry[];
  signatures: AttestationSignature[];
  payload: Record<string, unknown>;
} {
  const set = object(value, "attestation set");
  exactKeys(set, ["schema", "sequence", "issued_at_utc", "signer_ring", "entries", "signatures"], "attestation set");
  if (set.schema !== SAFE_READ_ATTESTATION_SET_SCHEMA || !Number.isSafeInteger(set.sequence) || (set.sequence as number) < 1) {
    reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation set schema or sequence is invalid.");
  }
  canonicalUtc(set.issued_at_utc, "attestation set issued_at_utc");
  const signerRing = object(set.signer_ring, "attestation set signer_ring");
  exactKeys(signerRing, ["epoch", "sequence", "sha256"], "attestation set signer_ring");
  const signerRingReference: SignerRingReference = {
    epoch: token(signerRing.epoch, "attestation set signer_ring.epoch"),
    sequence: Number.isSafeInteger(signerRing.sequence) && (signerRing.sequence as number) >= 1
      ? signerRing.sequence as number
      : reject("SAFE_READ_ATTESTATION_SET_INVALID", "Attestation set signer-ring sequence is invalid."),
    sha256: hash(signerRing.sha256, "attestation set signer_ring.sha256")
  };
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
      parsedAttestation = parseStrictJsonText(entry.attestation_json, `entries[${index}].attestation_json`);
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
    signerRing: signerRingReference,
    entries,
    signatures,
    payload: {
      schema: set.schema,
      sequence: set.sequence,
      issued_at_utc: set.issued_at_utc,
      signer_ring: set.signer_ring,
      entries: set.entries
    }
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
  const ring = parseSignerRing(ringFile.parsed, ringFile.sha256);
  const set = parseSet(setFile.parsed);
  if (set.signerRing.epoch !== ring.reference.epoch || set.signerRing.sequence !== ring.reference.sequence
      || !equal(set.signerRing.sha256, ring.reference.sha256)) {
    reject("SAFE_READ_ATTESTATION_SIGNER_RING_MISMATCH", "Attestation set does not bind the exact pinned signer ring.");
  }
  const signedBytes = Buffer.from(canonicalJson(set.payload as JsonValue), "utf8");
  for (const signature of set.signatures) {
    const signer = ring.signers.get(signature.key_id);
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
    setSha256: setFile.sha256,
    signerRingEpoch: ring.reference.epoch,
    signerRingSequence: ring.reference.sequence,
    signerRingSha256: ring.reference.sha256,
    signerIdentities: [...ring.signers.values()].map(signer => ({
      keyId: signer.key_id,
      state: signer.state,
      publicKeySha256: signer.public_key_sha256
    }))
  };
}
