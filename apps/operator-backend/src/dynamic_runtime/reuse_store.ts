import fs from "node:fs";
import path from "node:path";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";

export const DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA = "dynamic_program_reuse_record/v1" as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

export type DynamicProgramReuseCandidate = {
  record: Readonly<DynamicProgramReuseRecordV1>;
  use_as: "example_or_starting_template";
  requires_current_compilation: true;
  requires_current_admission: true;
  historical_success_bypasses_authorization: false;
};

export class DynamicProgramReuseStore {
  constructor(private readonly filePath: string) {}

  append(record: DynamicProgramReuseRecordV1): void {
    validateRecord(record);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicAppendJsonlLine(this.filePath, record);
  }

  readAll(): Readonly<DynamicProgramReuseRecordV1>[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
      const parsed = JSON.parse(line) as DynamicProgramReuseRecordV1;
      try { validateRecord(parsed); } catch (error) { throw new Error(`Dynamic reuse record ${index + 1} is invalid: ${(error as Error).message}`); }
      return Object.freeze(parsed);
    });
  }

  candidate(recordId: string): DynamicProgramReuseCandidate | null {
    const record = [...this.readAll()].reverse().find(value => value.record_id === recordId);
    if (!record) return null;
    return {
      record,
      use_as: "example_or_starting_template",
      requires_current_compilation: true,
      requires_current_admission: true,
      historical_success_bypasses_authorization: false
    };
  }
}

function validateRecord(record: DynamicProgramReuseRecordV1): void {
  if (!record || record.schema !== DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA || !text(record.record_id, 160)
    || !text(record.normalized_source, 512_000) || !text(record.semantic_task_description, 2000)
    || !text(record.runtime_version, 128) || !text(record.sdk_version, 128)
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
  if (record.verification_outcome === "apply_verified" && !record.apply_evidence_hash) throw new Error("applied reuse record requires apply evidence");
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/\u0000/.test(value);
}
