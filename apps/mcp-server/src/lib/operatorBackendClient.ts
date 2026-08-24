import { getOrCreateOperatorToken } from "./workspace.js";

export const SEMANTIC_MEP_ROUTE_PLAN_PATH = "/tools/mep/semantic-route-plan";
export const EVIDENCE_RETRIEVE_PATH = "/evidence/retrieve";
export const READ_COMPLETION_CLAIM_PATH = "/api/assignments/read-completion-claims";

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
  fetchImpl?: typeof fetch;
};

function configuredBaseUrl(): string {
  return (process.env.OPERATOR_API_BASE_URL || "http://127.0.0.1:7007").trim().replace(/\/+$/, "");
}

export function createOperatorBackendClient(options: OperatorBackendClientOptions = {}) {
  const baseUrl = (options.baseUrl || configuredBaseUrl()).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("OPERATOR_API_BASE_URL must be an http(s) URL.");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async submitReadCompletionClaim(input: unknown): Promise<unknown> {
      const token = options.token ?? getOrCreateOperatorToken();
      const response = await fetchImpl(`${baseUrl}${READ_COMPLETION_CLAIM_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Operator-Token": token } : {})
        },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        let details = "";
        try { details = await response.text(); } catch {}
        throw new Error(`Operator read-completion claim responded with status ${response.status}${details ? `: ${details}` : ""}`);
      }
      return await response.json();
    },
    async retrieveEvidence(input: unknown): Promise<unknown> {
      const token = options.token ?? getOrCreateOperatorToken();
      const response = await fetchImpl(`${baseUrl}${EVIDENCE_RETRIEVE_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Operator-Token": token } : {})
        },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        let details = "";
        try { details = await response.text(); } catch {}
        throw new Error(`Operator evidence retrieval responded with status ${response.status}${details ? `: ${details}` : ""}`);
      }
      return await response.json();
    },
    async planSemanticMepRoute(input: SemanticMepRoutePlanInput): Promise<unknown> {
      const token = options.token ?? getOrCreateOperatorToken();
      const response = await fetchImpl(`${baseUrl}${SEMANTIC_MEP_ROUTE_PLAN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Operator-Token": token } : {})
        },
        body: JSON.stringify({
          user_text: input.userText,
          ...(input.viewId === undefined ? {} : { view_id: input.viewId }),
          ...(input.roomNumber === undefined ? {} : { room_number: input.roomNumber }),
          ...(input.levelName === undefined ? {} : { level_name: input.levelName }),
          ...(input.toolResults === undefined ? {} : { tool_results: input.toolResults })
        })
      });

      if (!response.ok) {
        let details = "";
        try { details = await response.text(); } catch { /* ignore */ }
        throw new Error(`Operator backend responded with status ${response.status}${details ? `: ${details}` : ""}`);
      }
      return await response.json();
    }
  };
}
