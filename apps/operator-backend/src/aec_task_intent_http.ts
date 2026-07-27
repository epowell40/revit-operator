import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "./contracts.js";
import { interpretAecTaskIntent, type AecTaskIntentInterpreter } from "./aec_task_intent_interpreter.js";
import { resolveAecWorkflow } from "./deterministic/aec_workflow_registry.js";
import { issueAecTaskIntentToken } from "./aec_task_intent_cache.js";
import { deterministicNamedObjectTopologyTask } from "./aec_semantic_task_interpreter.js";
import { planAecQueryTask } from "./deterministic/aec_query_plan.js";
import { MEP_SERVICE_ACCESSORY_WORKFLOW_ID, parseMepServiceAccessoryTask } from "./deterministic/mep_service_accessory_runtime.js";
import { parseDirectScheduleCellUpdate, parseGroupedScheduleBulkClarification, parseScheduleCellUpdateFromConversation } from "./schedule_cell_update_intent.js";

export type AecTaskIntentHttpResult = {
  status: number;
  body: {
    ok: boolean;
    handled?: boolean;
    workflow_id?: string | null;
    intent_token?: string | null;
    intent?: unknown;
    error?: string;
  };
};

function safeId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : fallback;
}

export async function resolveAecTaskIntentHttp(body: unknown, interpreter?: AecTaskIntentInterpreter): Promise<AecTaskIntentHttpResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { ok: false, error: "Invalid JSON body" } };
  const parsed = body as Record<string, unknown>;
  const userText = typeof parsed.user_text === "string" ? parsed.user_text : typeof parsed.userText === "string" ? parsed.userText : typeof parsed.request === "string" ? parsed.request : "";
  if (!userText.trim()) return { status: 400, body: { ok: false, error: "user_text is required" } };
  const scheduleCellUpdate = parseScheduleCellUpdateFromConversation(userText, parsed.conversation) ?? parseDirectScheduleCellUpdate(userText);
  if (scheduleCellUpdate) {
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        workflow_id: "schedule.cell_update",
        intent_token: null,
        intent: scheduleCellUpdate
      }
    };
  }
  const groupedScheduleBulk = parseGroupedScheduleBulkClarification(userText);
  if (groupedScheduleBulk) {
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        workflow_id: "schedule.grouped_bulk_clarification",
        intent_token: null,
        intent: {
          schema: "revit-operator.schedule-grouped-bulk-clarification.v1",
          ...groupedScheduleBulk,
          evidence: { user_text: userText }
        }
      }
    };
  }
  const serviceAccessoryTask = parseMepServiceAccessoryTask(userText);
  if (serviceAccessoryTask) {
    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        workflow_id: MEP_SERVICE_ACCESSORY_WORKFLOW_ID,
        intent_token: null,
        intent: serviceAccessoryTask
      }
    };
  }
  const topologyTask = deterministicNamedObjectTopologyTask(userText);
  if (topologyTask) {
    const topologyPlan = planAecQueryTask(topologyTask);
    if (topologyPlan.status === "ready" && topologyPlan.workflow_id === "query.document_elements") {
      return {
        status: 200,
        body: {
          ok: true,
          handled: true,
          workflow_id: topologyPlan.workflow_id,
          intent_token: null,
          intent: topologyTask
        }
      };
    }
  }
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: safeId(parsed.session_id ?? parsed.sessionId, `semantic-preflight-${randomUUID()}`),
    message_id: safeId(parsed.message_id ?? parsed.messageId, `semantic-preflight-${randomUUID()}`),
    user_text: userText
  };
  const intent = await interpretAecTaskIntent(request, interpreter);
  const resolution = intent ? resolveAecWorkflow(intent) : null;
  const intentToken = resolution ? issueAecTaskIntentToken(resolution.intent) : null;
  return {
    status: 200,
    body: {
      ok: true,
      handled: !!resolution,
      workflow_id: resolution?.workflow_id ?? null,
      intent_token: intentToken,
      intent
    }
  };
}
