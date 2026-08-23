import type { EvidenceProjectionV1, EvidenceTelemetryEventV1 } from "./evidence_ref.js";
import { appendEvidenceTelemetry } from "./evidence_store.js";

export const MODEL_EVIDENCE_ENVELOPE_SCHEMA = "revit-operator.model-evidence-envelope.v1" as const;

export type EvidenceContextBudget = { item_bytes: number; request_bytes: number };

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function getEvidenceContextBudget(): EvidenceContextBudget {
  const item_bytes = envInt("OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES", 8_192, 1_024, 65_536);
  const request_bytes = envInt("OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES", 32_768, item_bytes, 262_144);
  return { item_bytes, request_bytes };
}

export function assembleBoundedEvidenceContext(input: {
  projections: EvidenceProjectionV1[];
  session_id: string;
  assignment_id?: string | null;
  model_call_id?: string | null;
  source?: string;
  budget?: EvidenceContextBudget;
}): { projections: EvidenceProjectionV1[]; bytes: number; omitted: number } {
  const budget = input.budget ?? getEvidenceContextBudget();
  const selected: EvidenceProjectionV1[] = [];
  let bytes = 2;
  let omitted = 0;
  for (const projection of input.projections) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(projection), "utf8") + (selected.length > 0 ? 1 : 0);
    if (encodedBytes > budget.item_bytes || bytes + encodedBytes > budget.request_bytes) { omitted++; continue; }
    selected.push(projection);
    bytes += encodedBytes;
  }
  const rawBytes = input.projections.reduce((sum, item) => sum + item.byte_count, 0);
  appendEvidenceTelemetry({
    session_id: input.session_id,
    assignment_id: input.assignment_id ?? null,
    model_call_id: input.model_call_id ?? null,
    source: input.source ?? "model_context",
    raw_evidence_bytes_produced: 0,
    unique_evidence_bytes_stored: 0,
    projected_bytes_sent: bytes,
    duplicate_bytes_avoided: Math.max(0, rawBytes - bytes),
    evidence_items_expanded: 0,
    budget_events: omitted > 0 ? 1 : 0,
    estimated_model_tokens_avoided: Math.floor(Math.max(0, rawBytes - bytes) / 4)
  } satisfies Omit<EvidenceTelemetryEventV1, "schema" | "recorded_at_utc">);
  return { projections: selected, bytes, omitted };
}

export function assertBoundedModelEvidencePayload(input: unknown, budget = getEvidenceContextBudget()): void {
  let totalEvidenceBytes = 0;
  const queue: unknown[] = [input];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const row = value as Record<string, unknown>;
    if (row.type === "function_call_output" && typeof row.output === "string") {
      const bytes = Buffer.byteLength(row.output, "utf8");
      let projectionEnvelope: { schema?: unknown; evidence_projections?: unknown } | null = null;
      try { projectionEnvelope = JSON.parse(row.output); } catch {}
      const projections = projectionEnvelope?.schema === MODEL_EVIDENCE_ENVELOPE_SCHEMA && Array.isArray(projectionEnvelope.evidence_projections)
        ? projectionEnvelope.evidence_projections
        : [];
      const isEvidenceProjection = projections.length > 0 && projections.every(projection => {
        if (!projection || typeof projection !== "object" || (projection as any).schema !== "revit-operator.evidence-projection.v1") return false;
        return Buffer.byteLength(JSON.stringify(projection), "utf8") <= budget.item_bytes;
      });
      if (bytes > budget.item_bytes && !isEvidenceProjection) {
        throw new Error(`Raw function_call_output exceeds the ${budget.item_bytes}-byte evidence item budget; store it and send an EvidenceRef projection.`);
      }
      if (isEvidenceProjection) totalEvidenceBytes += bytes;
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") queue.push(child);
  }
  if (totalEvidenceBytes > budget.request_bytes) throw new Error(`Projected evidence exceeds the ${budget.request_bytes}-byte model-request budget.`);
}

export function modelEvidenceEnvelope(projections: EvidenceProjectionV1[], omitted = 0): {
  schema: typeof MODEL_EVIDENCE_ENVELOPE_SCHEMA;
  evidence_projections: EvidenceProjectionV1[];
  omitted: number;
  retrieval: string;
} {
  return {
    schema: MODEL_EVIDENCE_ENVELOPE_SCHEMA,
    evidence_projections: projections,
    omitted,
    retrieval: "Use a named evidence_id with a focused field/item/text/target selector when more authoritative evidence is required."
  };
}
