export const NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA: "revit-operator.native-artifact-receipt.v1";
export interface NativeArtifactReceiptV1 {
  readonly schema: typeof NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA;
  readonly method: "POST";
  readonly path: "/revit/export-pdf" | "/revit/print" | "/revit/export-elements-xlsx";
  readonly print_settings_restored?: boolean;
  readonly print_settings_untouched?: boolean;
  readonly not_started_reason?: "interactive_printer_destination" | "printer_capability_unavailable" | "printer_unavailable" | "no_printer_configured";
  readonly phase: "preview" | "apply";
  readonly status: "not_started" | "complete" | "unverified";
  readonly expected_output_paths: readonly string[];
  readonly expected_export_calls: number;
  readonly export_calls: readonly boolean[];
  readonly outputs: readonly { readonly path: string; readonly size_bytes: number; readonly sha256: string; readonly fresh_output: boolean }[];
}
export function nativeArtifactReceiptEffectV1(value: unknown, method: unknown, path: unknown, requestedEffect: unknown): "none" | "applied" | null;
export function nativeArtifactResultEffectV2(value: unknown): "none" | "applied" | null;
