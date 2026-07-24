export type ExistingConditionsDeleteRequest = {
  ids: number[];
  apply: boolean;
  confirm?: string;
};

export function buildExistingConditionsDeleteRequest(
  ids: number[],
  apply: boolean
): ExistingConditionsDeleteRequest {
  const normalizedIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (normalizedIds.length === 0) throw new Error("existing_conditions_redaction_delete_ids_required");
  return {
    ids: normalizedIds,
    apply,
    ...(apply ? { confirm: `DELETE ${normalizedIds.length} ELEMENTS` } : {})
  };
}

export function verifyExistingConditionsDeletedElementReadback(
  value: unknown,
  requestedIds: number[]
): number[] {
  const requested = [...new Set(requestedIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  if (requested.length === 0) throw new Error("existing_conditions_redaction_readback_ids_required");
  if (!Array.isArray(value)) throw new Error("existing_conditions_redaction_readback_must_be_an_array");
  const rows = value.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : {});
  const readbackIds = rows
    .map((entry) => Number(entry.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (readbackIds.length !== rows.length || new Set(readbackIds).size !== readbackIds.length) {
    throw new Error("existing_conditions_redaction_readback_ids_invalid_or_duplicate");
  }
  if (JSON.stringify(readbackIds) !== JSON.stringify(requested)) {
    throw new Error("existing_conditions_redaction_readback_ids_do_not_match_requested_scope");
  }
  const foundIds = rows
    .filter((entry) => entry.found !== false)
    .map((entry) => Number(entry.id))
    .sort((a, b) => a - b);
  if (foundIds.length > 0) {
    throw new Error(`existing_conditions_redaction_requested_ids_still_found:${foundIds.join(",")}`);
  }
  return requested;
}
