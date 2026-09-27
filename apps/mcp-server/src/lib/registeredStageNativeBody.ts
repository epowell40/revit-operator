/**
 * The registered PDF workflow carries host-only provenance alongside the
 * native stage request. Keep that full envelope for exact host authorization,
 * but send only the published native Params shape to Revit.
 */
export function registeredStageNativeBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const rootKeys = [
    "inputFingerprintSha256", "stageKey", "priorActionOutputs", "operations",
    "dryRun", "verify", "maximumCreatedElements", "targetViewId",
    "applyTargetViewPhase", "requireAllCreatedElementsVisibleInTargetView"
  ];
  const operationKeys = [
    "action_key", "path", "depends_on", "apply_body", "deferred_body",
    "expected_created_min", "expected_created_max"
  ];
  const priorOutputKeys = [
    "action_key", "created_element_ids", "affected_element_ids",
    "route_segment_element_ids", "route_start_element_ids", "route_end_element_ids",
    "split_main_start_element_ids", "split_main_end_element_ids"
  ];
  const pick = (row: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const native = pick(source, rootKeys);
  if (Array.isArray(source.operations)) {
    native.operations = source.operations.map(item =>
      item && typeof item === "object" && !Array.isArray(item)
        ? pick(item as Record<string, unknown>, operationKeys)
        : item
    );
  }
  if (Array.isArray(source.priorActionOutputs)) {
    native.priorActionOutputs = source.priorActionOutputs.map(item =>
      item && typeof item === "object" && !Array.isArray(item)
        ? pick(item as Record<string, unknown>, priorOutputKeys)
        : item
    );
  }
  return native;
}
