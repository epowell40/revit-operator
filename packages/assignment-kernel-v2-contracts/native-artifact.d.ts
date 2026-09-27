export const NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA: "revit-operator.native-artifact-receipt.v1";
export interface NativeArtifactReceiptV1 {
  readonly schema: typeof NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA;
  readonly method: "POST";
  readonly path: "/revit/export-pdf" | "/revit/print" | "/revit/export-elements-xlsx" | "/revit/save-as";
  readonly print_settings_restored?: boolean;
  readonly print_settings_untouched?: boolean;
  readonly not_started_reason?: "interactive_printer_destination" | "printer_capability_unavailable" | "printer_unavailable" | "no_printer_configured" | "save_preflight_failed";
  readonly save_io_not_started?: boolean;
  readonly save_document?: {
    readonly native_save_returned: boolean;
    readonly same_document: boolean;
    readonly document_session_changed: boolean;
    readonly before: { readonly session_id: string; readonly project_fingerprint: string; readonly path: string };
    readonly after: { readonly session_id: string; readonly project_fingerprint: string; readonly path: string } | null;
    readonly document_path_changed: boolean;
    readonly project_binding_changed: boolean;
  };
  readonly phase: "preview" | "apply";
  readonly status: "not_started" | "complete" | "unverified";
  readonly expected_output_paths: readonly string[];
  readonly expected_export_calls: number;
  readonly export_calls: readonly boolean[];
  readonly outputs: readonly { readonly path: string; readonly size_bytes: number; readonly sha256: string; readonly fresh_output: boolean; readonly stable_read?: boolean }[];
}
export function nativeArtifactReceiptEffectV1(value: unknown, method: unknown, path: unknown, requestedEffect: unknown): "none" | "applied" | null;
export function nativeArtifactResultEffectV2(value: unknown): "none" | "applied" | null;
export function nativeDocumentCheckpointResultV2(value: unknown): boolean;
