import {
  appendExistingConditionsRepairLedgerEntry,
  hashExistingConditionsLedgerValue,
  normalizeExistingConditionsLedgerSha256,
  readExistingConditionsRepairLedger,
  type ExistingConditionsRepairLedgerEntry
} from "./repair_ledger_store.js";

export type ExistingConditionsSourceDispositionReasonV1 =
  | "source_supported"
  | "no_cross_group_junction"
  | "no_label_within_gate"
  | "registered_cross_page_no_target"
  | "ambiguous_source_topology";

export type ExistingConditionsSourceDispositionV1 = {
  schema_version: 1;
  package_fingerprint_sha256: string;
  source_receipt_sha256: string;
  source_receipt_schema: string;
  source_frame_id: string;
  registration_context_id: string;
  target_key: string;
  disposition: "accepted_source_observation" | "abstained";
  reason_code: ExistingConditionsSourceDispositionReasonV1;
  evidence_group_ids: string[];
  next_repair: string;
  native_write_allowed: false;
};

export type ExistingConditionsSourceDispositionStateV1 = {
  disposition: ExistingConditionsSourceDispositionV1;
  sequence: number;
  event_key: string;
  entry_sha256: string;
  status: "accepted" | "follow_up";
  updated_at_ms: number;
};

function text(value: unknown, field: string, maximum = 240): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`existing_conditions_source_disposition_${field}_required`);
  if (normalized.length > maximum) {
    throw new Error(`existing_conditions_source_disposition_${field}_too_long`);
  }
  return normalized;
}

function normalizeEvidenceGroupIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("existing_conditions_source_disposition_evidence_group_ids_invalid");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = text(item, "evidence_group_id", 96);
    if (!/^[a-z][a-z0-9_]{0,48}_[0-9a-f]{16,64}$/i.test(id)) {
      throw new Error("existing_conditions_source_disposition_evidence_group_id_not_opaque");
    }
    const key = id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(id);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export function validateExistingConditionsSourceDispositionV1(
  value: ExistingConditionsSourceDispositionV1
): ExistingConditionsSourceDispositionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1) {
    throw new Error("existing_conditions_source_disposition_schema_invalid");
  }
  if (value.native_write_allowed !== false) {
    throw new Error("existing_conditions_source_disposition_must_deny_native_write");
  }
  const packageFingerprint = normalizeExistingConditionsLedgerSha256(
    value.package_fingerprint_sha256,
    "source_disposition_package_fingerprint"
  );
  const sourceReceiptSha256 = normalizeExistingConditionsLedgerSha256(
    value.source_receipt_sha256,
    "source_disposition_source_receipt"
  );
  const sourceReceiptSchema = text(value.source_receipt_schema, "source_receipt_schema");
  const sourceFrameId = text(value.source_frame_id, "source_frame_id");
  const registrationContextId = text(value.registration_context_id, "registration_context_id");
  const targetKey = text(value.target_key, "target_key");
  const nextRepair = text(value.next_repair, "next_repair", 600);
  const dispositions = new Set(["accepted_source_observation", "abstained"]);
  if (!dispositions.has(value.disposition)) {
    throw new Error("existing_conditions_source_disposition_value_invalid");
  }
  const reasons = new Set<ExistingConditionsSourceDispositionReasonV1>([
    "source_supported",
    "no_cross_group_junction",
    "no_label_within_gate",
    "registered_cross_page_no_target",
    "ambiguous_source_topology"
  ]);
  if (!reasons.has(value.reason_code)) {
    throw new Error("existing_conditions_source_disposition_reason_invalid");
  }
  if (
    (value.disposition === "accepted_source_observation") !==
    (value.reason_code === "source_supported")
  ) {
    throw new Error("existing_conditions_source_disposition_reason_mismatch");
  }
  const evidenceGroupIds = normalizeEvidenceGroupIds(value.evidence_group_ids);
  const normalized: ExistingConditionsSourceDispositionV1 = {
    schema_version: 1,
    package_fingerprint_sha256: packageFingerprint,
    source_receipt_sha256: sourceReceiptSha256,
    source_receipt_schema: sourceReceiptSchema,
    source_frame_id: sourceFrameId,
    registration_context_id: registrationContextId,
    target_key: targetKey,
    disposition: value.disposition,
    reason_code: value.reason_code,
    evidence_group_ids: evidenceGroupIds,
    next_repair: nextRepair,
    native_write_allowed: false
  };
  if (/\b(?:Element|ViewRegion)\d+\b/i.test(JSON.stringify(normalized))) {
    throw new Error("existing_conditions_source_disposition_raw_source_id_forbidden");
  }
  return normalized;
}

export function recordExistingConditionsSourceDispositionV1(args: {
  sessionId: string;
  disposition: ExistingConditionsSourceDispositionV1;
}): ExistingConditionsRepairLedgerEntry {
  const disposition = validateExistingConditionsSourceDispositionV1(args.disposition);
  const streamSha256 = hashExistingConditionsLedgerValue({
    schema: "operator.existing_conditions.source_disposition_stream.v1",
    package_fingerprint_sha256: disposition.package_fingerprint_sha256,
    source_receipt_sha256: disposition.source_receipt_sha256,
    registration_context_id: disposition.registration_context_id,
    target_key: disposition.target_key
  });
  return appendExistingConditionsRepairLedgerEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: disposition.package_fingerprint_sha256,
    workflowSha256: streamSha256,
    event: "source_disposition_recorded",
    status: disposition.disposition === "accepted_source_observation" ? "accepted" : "follow_up",
    acceptedProgress: true,
    payload: { source_disposition: disposition },
    nextRepair: disposition.next_repair
  });
}

export function latestExistingConditionsSourceDispositionV1(
  sessionId: string,
  targetKey?: string
): ExistingConditionsSourceDispositionStateV1 | null {
  const normalizedTarget = String(targetKey ?? "").trim().toLowerCase();
  const entry = readExistingConditionsRepairLedger(sessionId)
    .filter(candidate => {
      if (candidate.event !== "source_disposition_recorded") return false;
      const value = candidate.payload.source_disposition as ExistingConditionsSourceDispositionV1;
      return !normalizedTarget || String(value?.target_key ?? "").trim().toLowerCase() === normalizedTarget;
    })
    .at(-1);
  if (!entry) return null;
  const disposition = validateExistingConditionsSourceDispositionV1(
    entry.payload.source_disposition as ExistingConditionsSourceDispositionV1
  );
  return {
    disposition,
    sequence: entry.sequence,
    event_key: entry.event_key,
    entry_sha256: entry.entry_sha256,
    status: disposition.disposition === "accepted_source_observation" ? "accepted" : "follow_up",
    updated_at_ms: Date.parse(entry.ts) || Date.now()
  };
}
