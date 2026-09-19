export interface ItemPageRange {
  path: string;
  start: number;
  count: number;
  fields?: readonly string[];
}

/** A byte-bounded view of retained rows. Column projection is explicitly
 * partial and never changes the retained source or its evidence authority. */
export function selectEvidenceItemPage(
  array: readonly unknown[],
  range: ItemPageRange,
  maxBytes: number,
  selectPath: (row: unknown, field: string, missing: symbol) => unknown
) {
  const page: unknown[] = [];
  let usedBytes = 2;
  const missing = Symbol("missing evidence column");
  for (let index = range.start; index < Math.min(array.length, range.start + range.count); index += 1) {
    const raw = array[index];
    const absent: string[] = [];
    const selected = range.fields
      ? { row_index: index,
          values: Object.fromEntries(range.fields.map(field => {
            const value = selectPath(raw, field, missing);
            if (value === missing) absent.push(field);
            return [field, value === missing ? null : value];
          })),
          missing_fields: absent }
      : raw;
    const size = Buffer.byteLength(JSON.stringify(selected), "utf8") + (page.length ? 1 : 0);
    if (usedBytes + size > maxBytes) {
      if (!page.length) throw new Error(`One evidence row exceeds ${maxBytes}-byte limit. Request fewer itemRange.fields or a larger authorized max_bytes.`);
      break;
    }
    page.push(selected);
    usedBytes += size;
  }
  const hasMore = range.start + page.length < array.length;
  const byteLimited = page.length < Math.min(range.count, Math.max(0, array.length - range.start));
  return {
    selection: page,
    complete: !range.fields && range.start === 0 && page.length >= array.length,
    pagination: {
      path: range.path, start: range.start, requested_count: range.count,
      returned_count: page.length, total_items: array.length,
      has_more: hasMore, next_start: hasMore ? range.start + page.length : null,
      byte_limited: byteLimited,
      requested_rows_complete: !byteLimited,
      source_rows_exhausted: !hasMore,
      ...(range.fields ? { fields: [...range.fields], row_projection: "selected_fields" as const } : {})
    }
  };
}
