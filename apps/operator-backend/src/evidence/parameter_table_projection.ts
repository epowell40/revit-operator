type Row = Record<string, unknown>;
function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

/** Presentation only. Native bytes and their evidence identity remain unchanged. */
export function projectParameterTable(payload: unknown, maxBytes: number): Row | null {
  const source = record(payload);
  if (!source || !["elementIds", "categories"].includes(String(source.selector))
      || source.hostModelOnly !== true || !Array.isArray(source.items)
      || source.items.length > 20_000 || source.returnedCount !== source.items.length
      || !Number.isSafeInteger(source.totalMatched) || !Number.isSafeInteger(source.offset)
      || typeof source.hasMore !== "boolean") return null;
  const { items, ...nativeQuery } = source;
  const definitions: Row[] = [], indices = new Map<string, number>();
  const rows: Row[] = [];
  const identities = new Set<number>();
  for (const item of items) {
    const row = record(item);
    if (!row || !Number.isSafeInteger(row.id) || (row.id as number) <= 0
        || typeof row.uniqueId !== "string" || !row.uniqueId || identities.has(row.id as number)
        || !record(row.parameters) || !Array.isArray(row.parameterDetails)
        || row.parameterDetails.length > 128) return null;
    identities.add(row.id as number);
    const { parameterDetails, parameters, ...identity } = row;
    const values: unknown[][] = [];
    for (const detail of parameterDetails) {
      const valueRow = record(detail);
      if (!valueRow || typeof valueRow.name !== "string" || !valueRow.name
          || typeof valueRow.storageType !== "string" || typeof valueRow.isReadOnly !== "boolean") return null;
      const { value, valueString, ...metadata } = valueRow;
      const key = JSON.stringify(metadata);
      let index = indices.get(key);
      if (index === undefined) { index = definitions.length; indices.set(key, index); definitions.push(metadata); }
      // Presence flags distinguish absent values from null and empty strings.
      values.push([index, Object.hasOwn(valueRow, "value"), value ?? null,
        Object.hasOwn(valueRow, "valueString"), valueString ?? null]);
    }
    rows.push({ identity, parameters, values });
  }
  const make = (count: number): Row => ({
    schema: "revit-operator.parameter-table-presentation/v1",
    native_query: nativeQuery,
    parameter_metadata: definitions,
    value_columns: ["metadata_index", "value_present", "value", "value_string_present", "value_string"],
    rows: rows.slice(0, count),
    coverage: { native_returned_rows: rows.length, presented_rows: count,
      page_rows_complete: count === rows.length, query_has_more: source.hasMore,
      omitted_page_rows: rows.length - count },
    ...(count === rows.length ? {} : { remaining_rows: {
      tool: "operator_retrieve_evidence", selector: "itemRange", path: "payload.items",
      start: count, count: rows.length - count,
      guidance: "Retrieve remaining retained rows; do not repeat native reads solely to recover omitted values."
    } })
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const complete = make(rows.length);
  if (bytes(complete) <= maxBytes) return complete;
  let low = 0, high = Math.max(0, rows.length - 1);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(make(mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  const result = make(low);
  return bytes(result) <= maxBytes && (low > 0 || rows.length === 0) ? result : null;
}
