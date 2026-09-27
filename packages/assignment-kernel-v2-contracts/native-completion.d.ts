export type NativeCompletionDispatchV1 = Readonly<{
  schema: "revit-operator.native-completion-dispatch/v1";
  identity: { binding: Record<string, unknown>; operation_id: string; request_identity: Record<string, unknown> };
  native: {
    request_id: string; request_nonce_sha256: string; server_epoch: string;
    method: "POST"; path: string; body_present: true; source_body_sha256: string;
    channel: "generic_call" | "typed_mcp"; alias: string; transport_receipt_sha256: string;
    expected_document_fingerprint: string;
  };
}>;
export type NativeCompletionReconciliationV1 = Readonly<{
  schema: "revit-operator.native-completion-reconciliation/v1";
  original_result_id: string;
  dispatch: NativeCompletionDispatchV1;
  record_sha256: string;
  evidence_id: string;
  receipt: Record<string, unknown>;
  proof: Record<string, unknown>;
}>;
export function nativeCompletionReconciliationEffectV1(value: unknown, operation: unknown): "none" | "applied" | null;
