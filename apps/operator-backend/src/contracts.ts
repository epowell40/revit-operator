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
};
