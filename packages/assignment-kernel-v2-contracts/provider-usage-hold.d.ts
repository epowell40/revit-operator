export const PROVIDER_USAGE_HOLD_V1_SCHEMA: "revit-operator.provider-usage-hold/v1";
export interface ProviderUsageWorkerIdentityV1 {
  provider: "openai_codex";
  configured_billing_mode: "chatgpt" | "api_key" | "unknown";
  requested_model: string | null;
  requested_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  reported_model: string | null;
  reported_model_source: "raw_response" | "rerouted" | null;
}
export interface ProviderUsageHoldV1 {
  schema: typeof PROVIDER_USAGE_HOLD_V1_SCHEMA;
  hold_id: string;
  binding: { assignment_id: string; session_id: string; run_id: string; generation: number; principal_id: string; document_fingerprint?: string };
  attempt_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  code: "usageLimitExceeded";
  recorded_at: string;
  resume_budget: { max_reasoning_turns: number; max_provider_calls: number; max_operations: number; max_equivalent_operations: number;
    max_no_progress_epochs: number; max_reconciliation_attempts: number; max_wall_clock_ms: number; max_total_tokens: number };
  worker_identity?: ProviderUsageWorkerIdentityV1;
}
export function validProviderUsageWorkerIdentityV1(value: unknown): value is ProviderUsageWorkerIdentityV1;
export function parseProviderUsageHoldV1(value: unknown, expectedBinding?: ProviderUsageHoldV1["binding"]): ProviderUsageHoldV1;
