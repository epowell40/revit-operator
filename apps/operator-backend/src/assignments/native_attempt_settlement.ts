import type { AssignmentEffectAuthority, AssignmentRequestedEffect } from "./control_plane.js";
import { canonicalRevitActionPath } from "../action_path_mutability.js";

export const NATIVE_ATTEMPT_SETTLEMENT_SCHEMA = "revit-operator.native-attempt-settlement.v1" as const;

export type NativeAttemptSettlement = {
  schema: typeof NATIVE_ATTEMPT_SETTLEMENT_SCHEMA;
  assignment_id: string | null;
  attempt_id: string | null;
  run_id: string | null;
  generation: number | null;
  requested_effect: AssignmentRequestedEffect;
  method: string;
  path: string;
  action_signature: string | null;
  target_fingerprint: string | null;
  request_dispatched: boolean;
  effect_state: "none" | "unknown" | "applied";
  effect_reason: string;
  effect_authority: AssignmentEffectAuthority;
  affected_target_identities: string[];
  receipt_refs: string[];
  evidence_refs: string[];
  settled_at_utc: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap(item => text(item) ? [text(item)!] : []))].slice(0, 200)
    : [];
}

function findSettlement(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const source = value.trim();
    if (!source.startsWith("{") && !source.startsWith("[")) return null;
    try { return findSettlement(JSON.parse(source), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findSettlement(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const row = record(value);
  if (!row) return null;
  const direct = record(row.canonical_attempt_settlement);
  if (direct?.schema === NATIVE_ATTEMPT_SETTLEMENT_SCHEMA) return direct;
  if (row.schema === NATIVE_ATTEMPT_SETTLEMENT_SCHEMA) return row;
  for (const child of Object.values(row)) {
    const found = findSettlement(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseNativeAttemptSettlement(value: unknown): NativeAttemptSettlement | null {
  const row = findSettlement(value);
  if (!row) return null;
  const requestedEffect = row.requested_effect;
  const effectState = row.effect_state;
  const authority = row.effect_authority;
  const allowedAuthorities: AssignmentEffectAuthority[] = [
    "native_host", "native_transaction", "native_receipt", "native_rollback", "target_readback",
    "schema_validator", "write_grant", "admission_policy", "transport_pre_dispatch", "dispatch_transport"
  ];
  if (!(["read", "preview", "apply"] as unknown[]).includes(requestedEffect)
      || !(["none", "unknown", "applied"] as unknown[]).includes(effectState)
      || !allowedAuthorities.includes(authority as AssignmentEffectAuthority)
      || typeof row.request_dispatched !== "boolean") return null;
  if (effectState === "applied" && !["native_transaction", "native_receipt", "target_readback"].includes(String(authority))) return null;
  if (effectState === "unknown" && row.request_dispatched !== true) return null;
  if (effectState === "applied" && row.request_dispatched !== true) return null;
  const generation = typeof row.generation === "number" && Number.isSafeInteger(row.generation) && row.generation >= 0
    ? row.generation : null;
  return {
    schema: NATIVE_ATTEMPT_SETTLEMENT_SCHEMA,
    assignment_id: text(row.assignment_id), attempt_id: text(row.attempt_id), run_id: text(row.run_id), generation,
    requested_effect: requestedEffect as AssignmentRequestedEffect,
    method: text(row.method)?.toUpperCase() ?? "", path: text(row.path) ?? "",
    action_signature: text(row.action_signature), target_fingerprint: text(row.target_fingerprint),
    request_dispatched: row.request_dispatched,
    effect_state: effectState as NativeAttemptSettlement["effect_state"],
    effect_reason: text(row.effect_reason) ?? `native_effect_${effectState}`,
    effect_authority: authority as AssignmentEffectAuthority,
    affected_target_identities: texts(row.affected_target_identities),
    receipt_refs: texts(row.receipt_refs), evidence_refs: texts(row.evidence_refs),
    settled_at_utc: text(row.settled_at_utc)
  };
}

export function nativeSettlementMatchesAttempt(input: {
  settlement: NativeAttemptSettlement;
  assignment_id: string;
  attempt_id: string;
  run_id: string;
  generation: number;
  requested_effect: AssignmentRequestedEffect;
  method: string;
  path: string;
  action_signature: string;
  target_fingerprint: string;
}): boolean {
  const settlement = input.settlement;
  return (!settlement.assignment_id || settlement.assignment_id === input.assignment_id)
    && (!settlement.attempt_id || settlement.attempt_id === input.attempt_id)
    && (!settlement.run_id || settlement.run_id === input.run_id)
    && (settlement.generation === null || settlement.generation === input.generation)
    && settlement.requested_effect === input.requested_effect
    && (!settlement.method || settlement.method === input.method.toUpperCase())
    && (!settlement.path || canonicalRevitActionPath(settlement.path) === canonicalRevitActionPath(input.path))
    && (!settlement.action_signature || settlement.action_signature === input.action_signature)
    && (!settlement.target_fingerprint || settlement.target_fingerprint === input.target_fingerprint);
}
