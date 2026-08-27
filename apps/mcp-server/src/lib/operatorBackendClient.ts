import {
  buildOperatorBackendAuthHeaders,
  redactOperatorBackendAuthText,
  resolveOperatorBackendAuth,
  type OperatorBackendAuthMode,
  type OperatorBackendAuthV1
} from "./operatorBackendAuth.js";

export const SEMANTIC_MEP_ROUTE_PLAN_PATH = "/tools/mep/semantic-route-plan";
export const EVIDENCE_RETRIEVE_PATH = "/evidence/retrieve";
export const READ_COMPLETION_CLAIM_PATH = "/api/assignments/read-completion-claims";
export const ASSIGNMENT_CLARIFICATION_PATH = "/api/assignments/clarifications";
export const NOOP_COMPLETION_CLAIM_PATH = "/api/assignments/noop-completion-claims";
export const ASSIGNMENT_V2_CRITERIA_PATH = "/api/assignments/v2/criteria/evaluate";
export const ASSIGNMENT_V2_CLARIFICATION_PATH = "/api/assignments/v2/clarifications";
export const ASSIGNMENT_V2_INPUT_PATH = "/api/assignments/v2/inputs";
export const ASSIGNMENT_V2_CHILD_OPERATION_PATH = "/api/assignments/v2/operations/children";
export const ASSIGNMENT_V2_OPERATION_DISPATCH_PATH = "/api/assignments/v2/operations/dispatch";
export const ASSIGNMENT_V2_OPERATION_RESULT_PATH = "/api/assignments/v2/operations/results";

export type SemanticMepRoutePlanInput = {
  userText: string;
  viewId?: number;
  roomNumber?: string;
  levelName?: string;
  toolResults?: unknown[];
};

export type OperatorBackendClientOptions = {
  baseUrl?: string;
  token?: string;
  authMode?: OperatorBackendAuthMode;
  auth?: OperatorBackendAuthV1;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function configuredBaseUrl(): string {
  return (process.env.OPERATOR_API_BASE_URL || "http://127.0.0.1:7007").trim().replace(/\/+$/, "");
}

export function createOperatorBackendClient(options: OperatorBackendClientOptions = {}) {
  const baseUrl = (options.baseUrl || configuredBaseUrl()).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("OPERATOR_API_BASE_URL must be an http(s) URL.");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(path: string, body: unknown, label: string): Promise<unknown> {
    const targetUrl = `${baseUrl}${path}`;
    const auth = resolveOperatorBackendAuth({
      auth: options.auth,
      authMode: options.authMode,
      token: options.token,
      baseUrl,
      env: options.env
    });
    const response = await fetchImpl(targetUrl, {
      method: "POST",
      headers: buildOperatorBackendAuthHeaders(auth, targetUrl),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      let details = "";
      try { details = redactOperatorBackendAuthText(await response.text(), auth); } catch {}
      throw new Error(`${label} responded with status ${response.status}${details ? `: ${details}` : ""}`);
    }
    return await response.json();
  }

  return {
    async requestAssignmentClarification(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_CLARIFICATION_PATH, input, "Operator Assignment clarification");
    },
    async submitNoopCompletionClaim(input: unknown): Promise<unknown> {
      return await post(NOOP_COMPLETION_CLAIM_PATH, input, "Operator no-op completion claim");
    },
    async submitReadCompletionClaim(input: unknown): Promise<unknown> {
      return await post(READ_COMPLETION_CLAIM_PATH, input, "Operator read-completion claim");
    },
    async evaluateAssignmentCriteriaV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_CRITERIA_PATH, input, "Operator V2 criterion evaluation");
    },
    async requestAssignmentInputV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_CLARIFICATION_PATH, input, "Operator V2 clarification");
    },
    async supplyAssignmentInputV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_INPUT_PATH, input, "Operator V2 input response");
    },
    async openAssignmentChildOperationV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_CHILD_OPERATION_PATH, input, "Operator V2 child operation admission");
    },
    async markAssignmentOperationDispatchV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_OPERATION_DISPATCH_PATH, input, "Operator V2 operation dispatch");
    },
    async settleAssignmentOperationV2(input: unknown): Promise<unknown> {
      return await post(ASSIGNMENT_V2_OPERATION_RESULT_PATH, input, "Operator V2 operation settlement");
    },
    async retrieveEvidence(input: unknown): Promise<unknown> {
      return await post(EVIDENCE_RETRIEVE_PATH, input, "Operator evidence retrieval");
    },
    async planSemanticMepRoute(input: SemanticMepRoutePlanInput): Promise<unknown> {
      return await post(SEMANTIC_MEP_ROUTE_PLAN_PATH, {
          user_text: input.userText,
          ...(input.viewId === undefined ? {} : { view_id: input.viewId }),
          ...(input.roomNumber === undefined ? {} : { room_number: input.roomNumber }),
          ...(input.levelName === undefined ? {} : { level_name: input.levelName }),
          ...(input.toolResults === undefined ? {} : { tool_results: input.toolResults })
        }, "Operator backend");
    }
  };
}
