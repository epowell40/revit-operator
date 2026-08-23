export const OPERATOR_BACKEND_CONTRACT_VERSION = "operator.backend.v1";

import type { EvidenceProjectionV1, EvidenceRefV1 } from "./evidence/evidence_ref.js";

export type HttpMethod = "GET" | "POST";

export type ActionCall = {
  action_id: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
  /** Backend-planned effect; callers and tool results cannot downgrade it. */
  request_effect?: "read" | "preview" | "apply";
  assignment_id?: string;
  attempt_id?: string;
  assignment_run_id?: string;
  assignment_generation?: number;
  action_signature?: string;
  target_fingerprint?: string;
};

export type ToolAttachment =
  | {
      kind: "image";
      mime: string;
      filename?: string;
      /**
       * base64 (no data: prefix)
       */
      data_base64?: string;
      /**
       * Optional: local path in RevitOperator sandbox (for user display)
       */
      local_path?: string;
    };

export type ToolResult = {
  action_id: string;
  method: HttpMethod;
  path: string;
  request_effect?: "read" | "preview" | "apply";
  status: "done" | "failed";
  /** A failed call may have reached Revit without a settled execution receipt. */
  retryable?: boolean;
  outcome_unknown?: boolean;
  /** True only after the native request has left the sidecar. */
  request_dispatched?: boolean;
  /** A result requiring reconciliation is never eligible for read degradation. */
  reconciliation_required?: boolean;
  result_json?: unknown;
  error?: string;
  result_summary?: string;
  failure_kind?: string;
  failure_code?: string;
  failure_hint?: string;
  duration_ms?: number;
  attachments?: ToolAttachment[];
  /** Immutable raw evidence identities. Model context consumes projections, not raw payloads. */
  evidence_refs?: EvidenceRefV1[];
  evidence_projections?: EvidenceProjectionV1[];
};

export type UserAttachment = {
  id: string;
  relative_path?: string;
  filename?: string;
  bytes?: number;
  sha256?: string;
  mime?: string;
  created_at?: string;
  external_path?: string;
};

export type ChatRequest = {
  version: typeof OPERATOR_BACKEND_CONTRACT_VERSION;
  session_id: string;
  message_id: string;
  /**
   * User text for the turn. For multi-turn tool loops, this may be an empty string
   * on continuation steps where tool_results are provided.
   */
  user_text?: string;
  context?: unknown;
  tool_results?: ToolResult[];
  user_attachments?: UserAttachment[];
};

export type ModelCallTokenUsage = {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens?: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
};

export type ModelCallReceipt = {
  schema: "revit-operator.model-call-receipt.v1";
  call_id: string;
  provider: "openai";
  route: "classic" | "planner" | "executor" | "codex_agent" | "desktop_computer";
  requested_model: string;
  model: string;
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  started_at_utc: string;
  /** Provider-only duration when the provider exposes it; null otherwise. */
  duration_ms: number | null;
  success: boolean;
  response_status: string | null;
  error_code: string | null;
  tokens: ModelCallTokenUsage;
  usage_source?: "responses_api_response" | "responses_api_raw_completion";
  turn_id?: string;
};

export type ChatResponse = {
  version: typeof OPERATOR_BACKEND_CONTRACT_VERSION;
  assistant_message: string;
  actions: ActionCall[];
  /** Provider-call metadata only. Never contains prompts or model output. */
  model_call_receipts?: ModelCallReceipt[];
  execution_strategy_evidence?: {
    schema: "revit-operator.execution-strategy-evidence.v1";
    selected_substrate: "typed_capability" | "typed_capability_composition" | "dynamic_revit_program";
    reason: string;
    recorded_at_utc: string;
    authority: "telemetry_only";
    authorization_granted: false;
  };
  dynamic_program_execution_receipt?: {
    schema: "revit-operator.provider-dynamic-program-execution-receipt.v1";
    status: "completed" | "failed" | "blocked";
    apply_requested: boolean;
    supervisor_exit_code: number | null;
    evidence_path: string | null;
    evidence_sha256: string | null;
    authority: "trusted_supervisor_receipt";
    provider_prose_authorized: false;
    request_dispatched: boolean;
    outcome_unknown: boolean;
    failure: string | null;
    supervisor_executable_sha256?: string | null;
    supervisor_package_sha256?: string | null;
    worker_runtime_package_sha256?: string | null;
    evidence_binding_sha256?: string | null;
    target_revit_year?: "2023" | "2024" | "2025" | "2026" | null;
  };
  certified_capability_limitations?: Array<{
    code: "CERTIFIED_ACTION_DENIED";
    action_ids: string[];
    actions: ActionCall[];
    message: string;
  }>;
  ok?: false;
  request_dispatched?: false;
  outcome_unknown?: false;
  reconciliation_required?: false;
  certified_capability_state?: {
    schema: "revit-operator.certified-sidecar-capability-state.v1";
    policy_hash: string;
    method: "GET";
    path: "/revit/context";
    request_hash: string;
    effect_hash: string;
    channel: "typed_mcp";
    alias: "revit_get_context";
    evidence_id: "certified-context";
  };
  certified_read_disposition?: {
    schema: "revit-operator.certified-read-disposition.v1";
    terminal: true;
    status: "degraded";
    session_id: string;
    message_id: string;
    policy_hash: string;
    document_executor_signature: string;
    action_ids: string[];
    evidence_ids: string[];
    answer_status: "grounded_evidence_summary";
    answer_evidence_ids: string[];
    correction_count: 1;
  };
  teammate_loop_receipt?: {
    schema: "revit-operator.teammate-loop-receipt.v1";
    turn_kind: "conversation" | "inspection" | "navigation" | "mutation";
    context_state: "not_required" | "live" | "missing" | "invalid";
    stage: "answer" | "clarify" | "ground" | "discover" | "preview" | "apply" | "verify" | "report" | "blocked";
    preview_action_ids: string[];
    preview_receipts?: Array<{
      action_id: string;
      path: string;
      status: "success";
      evidence_sha256: string;
    }>;
    apply_action_id: string | null;
    verification_action_ids: string[];
    apply_attempts: number;
    verified: boolean;
    verification_mode: "none" | "explicit_apply_receipt" | "target_bound_readback" | "trusted_dynamic_program_receipt";
    verification_action_id: string | null;
    verification_evidence_sha256: string | null;
    blocked_reason: string | null;
  };
  aec_query_receipt?: {
    schema: "revit-operator.aec-query-receipt.v1";
    terminal: true;
    status: "found" | "not_found" | "ambiguous" | "complete" | "failed";
    workflow_id: string;
    bounded: true;
    broadened: false;
  };
  schedule_update_receipt?: {
    schema: "revit-operator.schedule-update-receipt.v1";
    terminal: true;
    status: "complete" | "blocked" | "failed";
    bounded: true;
    verified: boolean;
  };
  requirements_receipt?: {
    schema: "revit-operator.requirements-receipt.v1";
    generated_at: string;
    status: "resolved" | "conflict" | "overflow";
    query: string;
    scope_refs: Array<{ kind: "office" | "engineer" | "project" | "client"; id: string }>;
    applied: Array<{
      requirement_id: string;
      revision: number;
      scope: { kind: "office" | "engineer" | "project" | "client"; id: string };
      key: string;
      text: string;
      reason: "highest_precedence" | "duplicate" | "lower_precedence" | "superseded";
    }>;
    suppressed: Array<{
      requirement_id: string;
      revision: number;
      scope: { kind: "office" | "engineer" | "project" | "client"; id: string };
      key: string;
      text: string;
      reason: "highest_precedence" | "duplicate" | "lower_precedence" | "superseded";
    }>;
    conflicts: Array<{
      key: string;
      precedence: number;
      requirements: Array<{
        requirement_id: string;
        revision: number;
        scope: { kind: "office" | "engineer" | "project" | "client"; id: string };
        text: string;
      }>;
    }>;
    overflow: { applied_count: number; suppressed_count: number; conflict_count: number; max_results: number } | null;
    receipt_sha256: string;
  };
};
