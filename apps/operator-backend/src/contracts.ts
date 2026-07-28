export const OPERATOR_BACKEND_CONTRACT_VERSION = "operator.backend.v1";

export type HttpMethod = "GET" | "POST";

export type ActionCall = {
  action_id: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
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
  result_json?: unknown;
  error?: string;
  result_summary?: string;
  failure_kind?: string;
  failure_code?: string;
  failure_hint?: string;
  duration_ms?: number;
  attachments?: ToolAttachment[];
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

export type ChatResponse = {
  version: typeof OPERATOR_BACKEND_CONTRACT_VERSION;
  assistant_message: string;
  actions: ActionCall[];
  teammate_loop_receipt?: {
    schema: "revit-operator.teammate-loop-receipt.v1";
    turn_kind: "conversation" | "inspection" | "navigation" | "mutation";
    context_state: "not_required" | "live" | "missing" | "invalid";
    stage: "answer" | "clarify" | "ground" | "discover" | "preview" | "apply" | "verify" | "report" | "blocked";
    preview_action_ids: string[];
    apply_action_id: string | null;
    verification_action_ids: string[];
    apply_attempts: number;
    verified: boolean;
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
