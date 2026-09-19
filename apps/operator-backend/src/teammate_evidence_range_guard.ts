type EvidenceRangeCall = Readonly<{ effect: string; raw_body: unknown }>;

export type SuccessfulEvidenceItemRange = Readonly<{
  evidence_id: string;
  path: string;
  start: number;
  end: number;
  total_items: number;
  reaches_source_end: boolean;
  fields: readonly string[] | null;
}>;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function itemRangeRequest(call: EvidenceRangeCall): Readonly<{
  evidence_id: string; path: string; start: number; count: number; fields: readonly string[] | null;
}> | null {
  if (call.effect !== "evidence_read") return null;
  const body = objectValue(call.raw_body);
  const itemRange = objectValue(body.itemRange ?? body.item_range);
  const evidenceId = boundedString(body.evidenceId ?? body.evidence_id, 300);
  const path = boundedString(itemRange.path, 500);
  const start = Number(itemRange.start);
  const count = Number(itemRange.count);
  if (!evidenceId || !path || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1) return null;
  const fields = Array.isArray(itemRange.fields)
    ? [...new Set(itemRange.fields.map(value => boundedString(value, 512)).filter(Boolean))].sort()
    : null;
  return { evidence_id: evidenceId, path, start, count, fields };
}

function fieldsCover(prior: readonly string[] | null, requested: readonly string[] | null): boolean {
  if (prior === null) return true;
  if (requested === null) return false;
  const available = new Set(prior);
  return requested.every(field => available.has(field));
}

export function isRedundantEvidenceItemRange(ranges: readonly SuccessfulEvidenceItemRange[], call: EvidenceRangeCall): boolean {
  const requested = itemRangeRequest(call);
  if (!requested) return false;
  return ranges.some(prior => {
    if (prior.evidence_id !== requested.evidence_id || prior.path !== requested.path
        || !fieldsCover(prior.fields, requested.fields) || requested.start < prior.start) return false;
    const requestedEnd = requested.start + requested.count;
    const effectiveEnd = prior.reaches_source_end ? Math.min(requestedEnd, prior.total_items) : requestedEnd;
    return effectiveEnd <= prior.end;
  });
}

function retrievalResult(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try { return retrievalResult(JSON.parse(trimmed), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = retrievalResult(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.schema === "revit-operator.evidence-retrieval.v1" && row.pagination && typeof row.pagination === "object") return row;
  for (const child of Object.values(row)) {
    const found = retrievalResult(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function recordSuccessfulEvidenceItemRange(
  ranges: SuccessfulEvidenceItemRange[], call: EvidenceRangeCall, result: unknown
): void {
  const requested = itemRangeRequest(call);
  const retrieval = retrievalResult(result);
  const pagination = objectValue(retrieval?.pagination);
  if (!requested || !retrieval || boundedString(pagination.path, 500) !== requested.path) return;
  const start = Number(pagination.start);
  const returned = Number(pagination.returned_count);
  const total = Number(pagination.total_items);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(returned) || returned < 0
      || !Number.isSafeInteger(total) || total < 0 || start !== requested.start) return;
  ranges.push({ evidence_id: requested.evidence_id, path: requested.path, start, end: start + returned, total_items: total,
    reaches_source_end: pagination.has_more === false, fields: requested.fields });
  if (ranges.length > 128) ranges.splice(0, ranges.length - 128);
}
