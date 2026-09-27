export interface OperationInputSchemaIssueV2 {
  field_path: string;
  expected_type: string;
  actual_type: string;
  safe_correction_eligibility: "provider_corrected_arguments_required" | "declared_deterministic_coercion";
  correction_action: "provider_resubmit" | "wrap_scalar_as_singleton_array";
  expected_constraint: Readonly<{
    kind: "required" | "json_type" | "enum" | "numeric_range" | "string_length" | "array_length" | "property_set" | "schema_depth" | "schema_bounds" | "schema_alternative";
    type?: string;
    allowed_values?: readonly (string | number | boolean | null)[];
    minimum?: number;
    maximum?: number;
    min_length?: number;
    max_length?: number;
    min_items?: number;
    max_items?: number;
  }>;
}
export function operationInputSchemaGapErrorV2(value: unknown, result: unknown): Readonly<{ code: string; message: string }> | null;
