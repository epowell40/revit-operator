import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";

export const DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA = "dynamic_program_reuse_record/v1" as const;
const DYNAMIC_PROGRAM_REUSE_LEDGER_SCHEMA = "dynamic_program_reuse_ledger_entry/v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 1024;

export type DynamicProgramReuseRecordV1 = {
  schema: typeof DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA;
  record_id: string;
  normalized_source: string;
  normalized_source_hash: string;
  semantic_task_description: string;
  required_sdk_capabilities: string[];
  applicability: { company_hash: string | null; project_hash: string | null; user_hash: string | null };
  input_schema_hash: string;
  program_hash: string;
  preview_evidence_hash: string;
  apply_evidence_hash: string | null;
  verification_outcome: "preview_verified" | "apply_verified";
  failure_history_hash: string;
  runtime_version: string;
  sdk_version: string;
  authoring_model_identity_hash: string;
  recorded_at_utc: string;
};

export type DynamicProgramReuseBindings = {
  company_hash: string | null;
  project_hash: string | null;
  user_hash: string | null;
  input_schema_hash: string;
  runtime_version: string;
  sdk_version: string;
  model_identity_hash: string;
  available_sdk_capabilities: readonly string[];
};

export type DynamicProgramReuseCandidate = {
  record: Readonly<DynamicProgramReuseRecordV1>;
  use_as: "example_or_starting_template";
  requires_current_compilation: true;
  requires_current_admission: true;
  historical_success_bypasses_authorization: false;
};

type LedgerEntry = {
  schema: typeof DYNAMIC_PROGRAM_REUSE_LEDGER_SCHEMA;
  record: DynamicProgramReuseRecordV1;
  previous_entry_hash: string | null;
  entry_hash: string;
  writer_key_id: string;
  signature: string;
};

export type DynamicProgramReuseStoreOptions = {
  authentication_key: Buffer;
  writer_key_id: string;
  verify_evidence: (hash: string, kind: "preview" | "apply") => boolean;
  is_revoked?: (recordId: string) => boolean;
};

export class DynamicProgramReuseStore {
  constructor(private readonly filePath: string, private readonly options: DynamicProgramReuseStoreOptions) {
    if (!Buffer.isBuffer(options.authentication_key) || options.authentication_key.length < 32 || !SHA256.test(options.writer_key_id)
      || typeof options.verify_evidence !== "function") throw new Error("Dynamic reuse store requires trusted authentication and evidence authorities.");
  }

  append(record: DynamicProgramReuseRecordV1): void {
    this.assertSafePath();
    validateRecord(record, this.options.verify_evidence);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let lock: number;
    try { lock = fs.openSync(lockPath, "wx"); } catch { throw new Error("Dynamic reuse ledger is locked by another writer or requires operator recovery."); }
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, "utf8"); fs.fsyncSync(lock);
      const existing = this.readLedger();
      if (existing.length >= MAX_RECORDS) throw new Error("Dynamic reuse ledger record limit is exceeded.");
      if (existing.some(value => value.record.record_id === record.record_id)) throw new Error("Dynamic reuse record id is duplicate or equivocated.");
      const previous = existing.at(-1)?.entry_hash ?? null;
      const unsigned = { schema: DYNAMIC_PROGRAM_REUSE_LEDGER_SCHEMA, record, previous_entry_hash: previous, writer_key_id: this.options.writer_key_id } as const;
      const entryHash = sha256(canonicalJson(unsigned));
      const entry: LedgerEntry = { ...unsigned, entry_hash: entryHash, signature: this.sign(entryHash) };
      const currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      const appendBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
      if (currentBytes + appendBytes > MAX_LEDGER_BYTES) throw new Error("Dynamic reuse ledger byte limit would be exceeded.");
      atomicAppendJsonlLine(this.filePath, entry);
    } finally {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch { /* A retained lock fails later writers closed. */ }
    }
  }

  readAll(): Readonly<DynamicProgramReuseRecordV1>[] {
    return this.readLedger().map(value => Object.freeze({ ...value.record }));
  }

  candidate(recordId: string, bindings: DynamicProgramReuseBindings): DynamicProgramReuseCandidate | null {
    validateBindings(bindings);
    const record = this.readAll().find(value => value.record_id === recordId);
    if (!record || this.options.is_revoked?.(record.record_id)) return null;
    const available = new Set(bindings.available_sdk_capabilities);
    if (record.applicability.company_hash !== bindings.company_hash || record.applicability.project_hash !== bindings.project_hash
      || record.applicability.user_hash !== bindings.user_hash || record.input_schema_hash !== bindings.input_schema_hash
      || record.runtime_version !== bindings.runtime_version || record.sdk_version !== bindings.sdk_version
      || record.authoring_model_identity_hash !== bindings.model_identity_hash
      || record.required_sdk_capabilities.some(value => !available.has(value))) return null;
    return {
      record,
      use_as: "example_or_starting_template",
      requires_current_compilation: true,
      requires_current_admission: true,
      historical_success_bypasses_authorization: false
    };
  }

  private readLedger(): LedgerEntry[] {
    this.assertSafePath();
    if (!fs.existsSync(this.filePath)) return [];
    const stat = fs.statSync(this.filePath);
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error("Dynamic reuse ledger is not a bounded regular file.");
    const content = fs.readFileSync(this.filePath, "utf8");
    if (content.length > 0 && !content.endsWith("\n")) throw new Error("Dynamic reuse ledger is truncated and quarantined from use.");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_RECORDS) throw new Error("Dynamic reuse ledger record limit is exceeded.");
    const entries: LedgerEntry[] = [];
    const ids = new Set<string>();
    let previous: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      let parsed: LedgerEntry;
      try { parsed = JSON.parse(lines[index]!) as LedgerEntry; } catch { throw new Error(`Dynamic reuse ledger entry ${index + 1} is malformed and quarantined from use.`); }
      try {
        if (!parsed || parsed.schema !== DYNAMIC_PROGRAM_REUSE_LEDGER_SCHEMA || parsed.writer_key_id !== this.options.writer_key_id
          || parsed.previous_entry_hash !== previous || !SHA256.test(parsed.entry_hash) || !HMAC_SHA256.test(parsed.signature)) throw new Error("ledger shape or chain is invalid");
        validateRecord(parsed.record, this.options.verify_evidence);
        if (ids.has(parsed.record.record_id)) throw new Error("record id is duplicate or equivocated");
        const unsigned = { schema: parsed.schema, record: parsed.record, previous_entry_hash: parsed.previous_entry_hash, writer_key_id: parsed.writer_key_id };
        const expectedHash = sha256(canonicalJson(unsigned));
        if (parsed.entry_hash !== expectedHash || !secureEqual(parsed.signature, this.sign(expectedHash))) throw new Error("ledger authentication is invalid");
      } catch (error) { throw new Error(`Dynamic reuse ledger entry ${index + 1} is invalid: ${(error as Error).message}`); }
      ids.add(parsed.record.record_id); previous = parsed.entry_hash; entries.push(parsed);
    }
    return entries;
  }

  private sign(entryHash: string): string {
    return `hmac-sha256:${createHmac("sha256", this.options.authentication_key).update(entryHash, "utf8").digest("hex")}`;
  }

  private assertSafePath(): void {
    for (const candidate of [path.dirname(this.filePath), this.filePath]) {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("Dynamic reuse ledger path contains a reparse or symbolic link.");
    }
  }
}

function validateRecord(record: DynamicProgramReuseRecordV1, verifyEvidence: DynamicProgramReuseStoreOptions["verify_evidence"]): void {
  if (!record || record.schema !== DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA || !text(record.record_id, 160)
    || !text(record.normalized_source, 128_000) || !text(record.semantic_task_description, 2000)
    || !text(record.runtime_version, 128) || !text(record.sdk_version, 128) || !record.applicability
    || !Array.isArray(record.required_sdk_capabilities) || record.required_sdk_capabilities.length > 128
    || new Set(record.required_sdk_capabilities).size !== record.required_sdk_capabilities.length
    || record.required_sdk_capabilities.some(value => !text(value, 160))
    || !["preview_verified", "apply_verified"].includes(record.verification_outcome)
    || !Number.isFinite(Date.parse(record.recorded_at_utc))) throw new Error("record shape is invalid");
  for (const value of [record.normalized_source_hash, record.input_schema_hash, record.program_hash, record.preview_evidence_hash,
    record.failure_history_hash, record.authoring_model_identity_hash, record.applicability.company_hash,
    record.applicability.project_hash, record.applicability.user_hash, record.apply_evidence_hash]) {
    if (value !== null && !SHA256.test(value)) throw new Error("record hash is invalid");
  }
  if (record.normalized_source_hash !== sha256(record.normalized_source)) throw new Error("normalized source hash is invalid");
  if (!verifyEvidence(record.preview_evidence_hash, "preview")) throw new Error("preview evidence is unavailable or unauthenticated");
  if (record.verification_outcome === "apply_verified" && (!record.apply_evidence_hash || !verifyEvidence(record.apply_evidence_hash, "apply"))) {
    throw new Error("applied reuse record requires authenticated apply evidence");
  }
  if (record.verification_outcome === "preview_verified" && record.apply_evidence_hash !== null) throw new Error("preview-only reuse record cannot claim apply evidence");
}

function validateBindings(bindings: DynamicProgramReuseBindings): void {
  if (!bindings || !text(bindings.runtime_version, 128) || !text(bindings.sdk_version, 128)
    || !Array.isArray(bindings.available_sdk_capabilities) || new Set(bindings.available_sdk_capabilities).size !== bindings.available_sdk_capabilities.length) {
    throw new Error("Dynamic reuse applicability bindings are invalid.");
  }
  for (const value of [bindings.company_hash, bindings.project_hash, bindings.user_hash, bindings.input_schema_hash, bindings.model_identity_hash]) {
    if (value !== null && !SHA256.test(value)) throw new Error("Dynamic reuse applicability hash is invalid.");
  }
}

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/\u0000/.test(value);
}
