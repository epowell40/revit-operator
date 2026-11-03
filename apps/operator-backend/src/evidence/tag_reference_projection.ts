type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const own = (value: Row, keys: string[]): Row => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Selected native facts for task planning, never a replacement for source evidence or verification authority. */
export function projectTagReferences(payload: unknown, maxBytes: number): Row | null {
  const source = record(payload);
  const input = source?.result;
  if (!Array.isArray(input) || input.length < 1 || input.length > 200 || !Number.isSafeInteger(maxBytes) || maxBytes < 64) return null;
  let recognized = false;
  const identities = new Set<number>();
  const normalized: Array<{ tag: number; type: Row | null; view: unknown; state: Row; refs: Array<[number | null, Row]> }> = [];
  for (const value of input) {
    const row = record(value);
    if (!row || !id(row.id) || identities.has(row.id) || typeof row.found !== "boolean") return null;
    identities.add(row.id);
    if (row.found === false) {
      normalized.push({ tag: row.id, type: null, view: null, state: own(row, ["found", "error"]), refs: [] });
      continue;
    }
    const tag = record(row.tagReferences);
    if (!tag || tag.schema !== "operator.tag_references.v1" || typeof tag.applicable !== "boolean") return null;
    recognized = true;
    const type = own(row, ["typeId", "familyName", "typeName"]);
    if (tag.applicable === false) {
      normalized.push({ tag: row.id, type, view: null, state: { found: true, ...own(tag, ["applicable", "complete", "reason"]) }, refs: [] });
      continue;
    }
    const owner = record(tag.ownerView);
    if (tag.ownerView != null && (!owner || !id(owner.elementId) || typeof owner.name !== "string")) return null;
    if (!Array.isArray(tag.items) || tag.items.length > 64
        || !["complete", "orphaned", "enumerationFailed", "truncated"].every(key => typeof tag[key] === "boolean")
        || !["totalReferences", "returned", "unresolvedReferences"].every(key => count(tag[key]))
        || tag.returned !== tag.items.length || (tag.totalReferences as number) < tag.items.length
        || (tag.unresolvedReferences as number) > tag.items.length
        || tag.truncated !== ((tag.totalReferences as number) > tag.items.length)
        || tag.complete !== (tag.items.length > 0 && tag.returned === tag.totalReferences
          && tag.unresolvedReferences === 0 && !tag.orphaned && !tag.enumerationFailed)) return null;
    const references: Array<[number | null, Row]> = [];
    let unresolved = 0;
    for (const value of tag.items) {
      const reference = record(value);
      if (!reference || typeof reference.resolved !== "boolean" || !["host", "linked"].includes(String(reference.documentScope))) return null;
      if (!reference.resolved) unresolved++;
      const nativeId = id(reference.elementId) ? reference.elementId : null;
      const linked = reference.documentScope === "linked";
      if (reference.resolved && (!nativeId || !Object.hasOwn(reference, "identityKey"))) return null;
      if (linked && !id(reference.linkInstanceId)) return null;
      if (!linked && reference.linkInstanceId != null) return null;
      // Fold a key only when it exactly agrees with its native namespace and ID.
      // Equal numeric IDs in different links must remain different identities.
      if (Object.hasOwn(reference, "identityKey") && reference.identityKey !==
          (linked ? `link:${reference.linkInstanceId}:${nativeId}` : `host:${nativeId}`)) return null;
      references.push([nativeId, own(reference, ["documentScope", "linkInstanceId", "resolved", "phase",
        "hostViewPhaseComparable", "hostViewPhaseLimitation", "reason"])]);
    }
    if (unresolved !== tag.unresolvedReferences) return null;
    const { schema: _schema, items: _items, ownerView: _view, ...nativeState } = tag;
    normalized.push({ tag: row.id, type, view: tag.ownerView ?? null, state: { found: true, ...nativeState }, refs: references });
  }
  if (!recognized) return null;

  const make = (size: number): Row => {
    const tagTypes: unknown[] = [], ownerViews: unknown[] = [], referenceStates: unknown[] = [], referenceFacts: unknown[] = [], ownerPhases: unknown[] = [];
    const indices = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
    const tables = [tagTypes, ownerViews, referenceStates, referenceFacts, ownerPhases];
    const intern = (table: number, value: unknown): number | null => {
      if (value === null) return null;
      const key = JSON.stringify(value), known = indices[table]!.get(key);
      if (known !== undefined) return known;
      const index = tables[table]!.length; indices[table]!.set(key, index); tables[table]!.push(value); return index;
    };
    const rows = normalized.slice(0, size).map(row => {
      const view = record(row.view), phase = view ? own(view, ["phaseId", "phaseName"]) : {};
      const viewIndex = view ? intern(1, [view.elementId ?? null, view.name ?? null,
        Object.keys(phase).length ? intern(4, phase) : null,
        (Object.hasOwn(view, "elementId") ? 1 : 0) + (Object.hasOwn(view, "name") ? 2 : 0)]) : null;
      return [row.tag, intern(0, row.type), viewIndex, intern(2, row.state), row.refs.map(([elementId, facts]) => [elementId, intern(3, facts)])];
    });
    return {
      schema: "revit-operator.tag-reference-presentation/v1",
      row_columns: ["tag_id", "tag_type_index", "owner_view_index", "reference_state_index", "references"],
      owner_view_columns: ["elementId", "name", "owner_phase_index", "present_mask_id1_name2"],
      reference_columns: ["element_id", "reference_facts_index"],
      tag_types: tagTypes, owner_views: ownerViews, owner_phases: ownerPhases, reference_states: referenceStates, reference_facts: referenceFacts, rows,
      coverage: { native_returned_rows: input.length, presented_rows: size, returned_rows_complete: size === input.length,
        source_rows_exhausted: size === input.length, omitted_rows: input.length - size, whole_project_coverage_proven: false },
      source_fields_omitted: ["other element-summary columns and owner-view uniqueId", "referenced element descriptive/type metadata and uniqueId"],
      guidance: "Selected native facts, not edit permission or a full source copy. Array position is source_row. Indices address dictionaries; views use owner_phases. Reference identity is host:<element_id> or link:<linkInstanceId>:<element_id> (native key checked). Unknown/orphan/truncated/linked phase limits remain unproved. New/Existing describes equipment, not tag age. Retrieve extra columns only as needed by source_row and itemRange fields; targetSubset requires reviewed identities.",
      source_retrieval: { tool: "operator_retrieve_evidence", selector: "itemRange", path: "payload.result",
        fields: ["id", "uniqueId", "typeId", "familyName", "typeName", "tagReferences.ownerView", "tagReferences.items"],
        ...(size === input.length ? {} : { next_start: size, remaining_rows: input.length - size }) }
    };
  };
  const all = make(input.length);
  if (bytes(all) <= maxBytes) return all;
  let low = 0, high = input.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(make(mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  const partial = make(low);
  return low > 0 && bytes(partial) <= maxBytes ? partial : null;
}
