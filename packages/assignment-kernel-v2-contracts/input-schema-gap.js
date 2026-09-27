const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const text = (value, max = Infinity) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const invalid = (code, message) => ({ code, message });
const constraintKinds = new Set(["required", "json_type", "enum", "numeric_range", "string_length", "array_length",
  "property_set", "schema_depth", "schema_bounds", "schema_alternative"]);
const constraintKeys = new Set(["kind", "type", "allowed_values", "minimum", "maximum", "min_length", "max_length", "min_items", "max_items"]);

/** Optional correction diagnostics. This validates no dispatch/effect authority; callers must validate the independent result core. */
export function operationInputSchemaGapErrorV2(value, core) {
  const gap = record(value), result = record(core), identity = record(result?.request_identity);
  if (!result || result.status !== "failed_before_dispatch" || result.dispatch_state !== "not_dispatched"
      || result.persistent_effect !== "none" || result.observation_required !== false)
    return invalid("operation_input_schema_gap_effect_invalid", "An input-schema gap requires an independent no-effect pre-dispatch result.");
  if (!gap || !identity || gap.schema !== "revit-operator.operation-input-schema-gap/v2"
      || gap.gap_id !== `input-schema:${result.operation_id}` || gap.operation_id !== result.operation_id
      || gap.capability_id !== identity.capability_id || !text(gap.input_schema_id)
      || typeof gap.input_schema_digest !== "string" || !/^[a-f0-9]{64}$/.test(gap.input_schema_digest)
      || !["GET", "POST"].includes(gap.method) || gap.method !== identity.method || gap.path !== identity.path
      || gap.request_signature !== identity.request_signature || gap.dispatch !== false || gap.effect !== "none"
      || !Array.isArray(gap.issues) || !gap.issues.length || gap.issues.length > 64)
    return invalid("operation_input_schema_gap_invalid", "Input-schema identity and provenance must bind to the rejected operation.");
  for (const candidate of gap.issues) {
    const issue = record(candidate), constraint = record(issue?.expected_constraint);
    if (!issue || !text(issue.field_path, 512) || !text(issue.expected_type, 160) || !text(issue.actual_type, 160)
        || !["provider_corrected_arguments_required", "declared_deterministic_coercion"].includes(issue.safe_correction_eligibility)
        || !["provider_resubmit", "wrap_scalar_as_singleton_array"].includes(issue.correction_action) || !constraint)
      return invalid("operation_input_schema_issue_invalid", "Input-schema issues require bounded structured fields and correction eligibility.");
    let encoded;
    try { encoded = JSON.stringify(constraint); } catch { return invalid("operation_input_schema_constraint_invalid", "The constraint is not JSON data."); }
    if (!constraintKinds.has(constraint.kind) || !Object.keys(constraint).every(key => constraintKeys.has(key)) || encoded.length > 4096
        || (constraint.type !== undefined && !text(constraint.type, 160)))
      return invalid("operation_input_schema_constraint_invalid", "Input-schema expected constraint must use the bounded shared shape.");
    if (constraint.allowed_values !== undefined && (!Array.isArray(constraint.allowed_values) || constraint.allowed_values.length > 32
        || !constraint.allowed_values.every(value => value === null || typeof value === "boolean"
          || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 256))))
      return invalid("operation_input_schema_constraint_invalid", "Input-schema allowed values must be bounded JSON scalars.");
    for (const key of ["minimum", "maximum", "min_length", "max_length", "min_items", "max_items"])
      if (constraint[key] !== undefined && (typeof constraint[key] !== "number" || !Number.isFinite(constraint[key])))
        return invalid("operation_input_schema_constraint_invalid", "Input-schema numeric constraints must be finite.");
    if (issue.safe_correction_eligibility === "declared_deterministic_coercion"
      ? issue.correction_action !== "wrap_scalar_as_singleton_array" : issue.correction_action !== "provider_resubmit")
      return invalid("operation_input_schema_correction_invalid", "Correction action must match its declared eligibility.");
  }
  return null;
}
