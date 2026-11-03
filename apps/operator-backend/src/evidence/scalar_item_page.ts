import { parseEvidenceRetrievalSelectorV1, type EvidenceScalarFilterV1 } from "@revitoperator/assignment-kernel-v2-contracts";
import type { ItemPageRange } from "./item_page.js";

/** Pure selection over existing scoped evidence bytes. Never native collection proof. */
export function selectScalarEvidenceItemPage(array: readonly unknown[], input: ItemPageRange, maxBytes: number,
  selectPath: (row: unknown, field: string, missing: symbol) => unknown) {
  const parsed = parseEvidenceRetrievalSelectorV1({ item_range: input });
  if (parsed.kind !== "item_range" || !parsed.item_range.fields) throw new Error("Scalar selection requires fields");
  const range = parsed.item_range;
  if (array.length > 5000) throw new Error("Scalar selection source exceeds 5000 retained rows; narrow the original evidence scope");
  const missing = Symbol("missing scalar evidence field");
  const comparable = (v: unknown) => v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v);
  let nonComparableRows = 0;
  const rows = array.map((raw, row_index) => ({ raw, row_index })).filter(row => {
    let unavailable = false, matches = true;
    for (const filter of range.filters ?? []) {
      const value = selectPath(row.raw, filter.field, missing);
      if (value === missing || !comparable(value) || filter.value !== null && (value === null || typeof value !== typeof filter.value)) {
        unavailable = true; matches = false; continue;
      }
      const a = value as number, b = filter.value as number;
      const comparison = filter.op === "eq" ? value === filter.value : filter.op === "ne" ? value !== filter.value
        : filter.op === "lt" ? a < b : filter.op === "lte" ? a <= b : filter.op === "gt" ? a > b : a >= b;
      if (!comparison) matches = false;
    }
    if (unavailable) nonComparableRows++;
    return matches;
  });
  let unavailableOrderRows = 0;
  if (range.orderBy) {
    const order = range.orderBy, keys = new Map<number, number | null>();
    for (const row of rows) { const value = selectPath(row.raw, order.field, missing);
      const key = typeof value === "number" && Number.isFinite(value) ? value : null;
      if (key === null) unavailableOrderRows++; keys.set(row.row_index, key); }
    rows.sort((a, b) => { const x = keys.get(a.row_index)!, y = keys.get(b.row_index)!;
      if (x === null || y === null) return x === y ? a.row_index - b.row_index : x === null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : 0) * (order.direction === "asc" ? 1 : -1) || a.row_index - b.row_index; });
  }
  const selection: Array<{row_index:number;values:Record<string,unknown>;missing_fields:string[]}> = [];
  let used = 2;
  for (const row of rows.slice(range.start, range.start + range.count)) {
    const absent: string[] = [], values = Object.fromEntries(range.fields!.map(field => {
      const value = selectPath(row.raw, field, missing); if (value === missing) absent.push(field);
      return [field, value === missing ? null : value]; }));
    const item = { row_index: row.row_index, values, missing_fields: absent }, size = Buffer.byteLength(JSON.stringify(item)) + (selection.length ? 1 : 0);
    if (used + size > maxBytes) { if (!selection.length) throw new Error(`One evidence row exceeds ${maxBytes}-byte limit. Request fewer itemRange.fields or a larger authorized max_bytes.`); break; }
    selection.push(item); used += size;
  }
  const hasMore = range.start + selection.length < rows.length;
  const byteLimited = selection.length < Math.min(range.count, Math.max(0, rows.length - range.start));
  return { selection, complete: false, pagination: {
    path: range.path, start: range.start, requested_count: range.count, returned_count: selection.length, total_items: array.length,
    has_more: hasMore, next_start: hasMore ? range.start + selection.length : null, byte_limited: byteLimited, requested_rows_complete: !byteLimited,
    source_rows_exhausted: false, fields: [...range.fields!], row_projection: "selected_fields" as const,
    selection_query: { cursor_basis: "selected_rank" as const, source_total_items: array.length, matched_total_items: rows.length,
      scanned_retained_rows: array.length, retained_scan_complete: true, non_comparable_filter_rows: nonComparableRows,
      unavailable_numeric_order_rows: unavailableOrderRows, selected_rows_exhausted: !hasMore,
      ...(range.filters ? { filters: range.filters } : {}), ...(range.orderBy ? { orderBy: range.orderBy } : {}) }
  } };
}
