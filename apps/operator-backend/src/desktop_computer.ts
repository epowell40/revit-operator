import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import type { ModelCallReceipt } from "./contracts.js";
import { createOpenAiModelCallReceipt } from "./model_call_telemetry.js";
import {
  isReasoningEffort,
  isSafeModelId,
  normalizeModelId,
  normalizeReasoningEffort,
  type ReasoningEffort
} from "./speed_config.js";
import {
  getSidecarAgentProfileState,
  type SidecarAgentProfileState
} from "./capabilities/sidecar_agent_profile.js";
import { assertBoundedModelEvidencePayload, type ModelEvidencePayloadUsage } from "./evidence/model_context_budget.js";
import { appendEvidenceTelemetry } from "./evidence/evidence_store.js";

export type DesktopComputerRelayRequest = {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  instructions?: string;
  tools?: unknown[];
  input: unknown;
  previous_response_id?: string;
  evidence_scope?: { session_id: string; assignment_id?: string | null };
};

type DesktopComputerRelayResponse = {
  id: string;
  output_text: string;
  output: unknown[];
  model?: string;
  model_call_receipt: ModelCallReceipt;
};

class DesktopComputerProviderError extends Error {
  readonly modelCallReceipt: ModelCallReceipt;

  constructor(modelCallReceipt: ModelCallReceipt, cause: unknown) {
    super("Desktop computer provider request failed.", { cause });
    this.name = "DesktopComputerProviderError";
    this.modelCallReceipt = modelCallReceipt;
  }
}

export function getDesktopComputerProviderErrorReceipt(error: unknown): ModelCallReceipt | null {
  return error instanceof DesktopComputerProviderError ? error.modelCallReceipt : null;
}

function resolveDesktopComputerModel(): string {
  return normalizeModelId(process.env.OPERATOR_DESKTOP_COMPUTER_MODEL, "gpt-5.6-terra");
}

function resolveDesktopComputerReasoningEffort(): ReasoningEffort {
  return normalizeReasoningEffort(process.env.OPERATOR_DESKTOP_COMPUTER_REASONING_EFFORT, "medium");
}

export function getDesktopComputerConfig(): {
  available: boolean;
  provider: "backend";
  model: string;
  reasoning_effort: string;
  sidecar_agent_profile: SidecarAgentProfileState;
} {
  return {
    available: !!resolveOpenAiApiKey(),
    provider: "backend",
    model: resolveDesktopComputerModel(),
    reasoning_effort: resolveDesktopComputerReasoningEffort(),
    sidecar_agent_profile: getSidecarAgentProfileState()
  };
}

function normalizeRelayRequest(value: unknown): DesktopComputerRelayRequest {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const input = body.input;
  if (input == null) {
    throw new Error("input is required.");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !isSafeModelId(model)) {
    throw new Error("model must be a bounded provider model identifier.");
  }
  const reasoningEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort.trim().toLowerCase()
    : "";
  if (reasoningEffort && !isReasoningEffort(reasoningEffort)) {
    throw new Error("reasoning_effort must be none, low, medium, high, xhigh, or max.");
  }
  const rawEvidenceScope = body.evidence_scope && typeof body.evidence_scope === "object" && !Array.isArray(body.evidence_scope)
    ? body.evidence_scope as Record<string, unknown>
    : null;
  const sessionId = typeof rawEvidenceScope?.session_id === "string" ? rawEvidenceScope.session_id.trim() : "";
  const assignmentId = typeof rawEvidenceScope?.assignment_id === "string" ? rawEvidenceScope.assignment_id.trim() : "";
  if (rawEvidenceScope && (!/^[A-Za-z0-9._:-]{1,240}$/.test(sessionId)
      || (assignmentId && !/^[A-Za-z0-9._:-]{1,240}$/.test(assignmentId)))) {
    throw new Error("evidence_scope must contain bounded session and optional Assignment identifiers.");
  }

  return {
    model: model || undefined,
    reasoning_effort: reasoningEffort ? reasoningEffort as ReasoningEffort : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    input,
    evidence_scope: rawEvidenceScope ? { session_id: sessionId, assignment_id: assignmentId || null } : undefined,
    previous_response_id:
      typeof body.previous_response_id === "string" ? body.previous_response_id.trim() || undefined : undefined
  };
}

function recordDesktopEvidenceUsage(
  usage: ModelEvidencePayloadUsage,
  scope: DesktopComputerRelayRequest["evidence_scope"],
  receipt: ModelCallReceipt
): void {
  if (!scope || usage.projection_count === 0) return;
  appendEvidenceTelemetry({
    session_id: scope.session_id,
    assignment_id: scope.assignment_id ?? null,
    model_call_id: receipt.call_id,
    source: "desktop_computer_model_context",
    raw_evidence_bytes_produced: 0,
    unique_evidence_bytes_stored: 0,
    projected_bytes_sent: usage.projected_bytes,
    duplicate_bytes_avoided: Math.max(0, usage.referenced_raw_bytes - usage.projected_bytes),
    evidence_items_expanded: 0,
    budget_events: 0,
    estimated_model_tokens_avoided: Math.floor(Math.max(0, usage.referenced_raw_bytes - usage.projected_bytes) / 4)
  });
}

function extractOutputText(response: any): string {
  const direct = typeof response?.output_text === "string" ? response.output_text : "";
  if (direct.trim()) return direct;

  const parts: string[] = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (!contentItem || contentItem.type !== "output_text" || typeof contentItem.text !== "string") continue;
      if (contentItem.text) parts.push(contentItem.text);
    }
  }

  return parts.join("");
}

function simplifyRelayResponse(response: any, modelCallReceipt: ModelCallReceipt): DesktopComputerRelayResponse {
  return {
    id: typeof response?.id === "string" ? response.id : "",
    output_text: extractOutputText(response),
    output: Array.isArray(response?.output) ? response.output : [],
    model: typeof response?.model === "string" ? response.model : undefined,
    model_call_receipt: modelCallReceipt
  };
}

export async function relayDesktopComputerResponse(rawBody: unknown): Promise<DesktopComputerRelayResponse> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.");
  }

  const body = normalizeRelayRequest(rawBody);
  const evidenceUsage = assertBoundedModelEvidencePayload(body.input);
  const client = createOpenAiClient(apiKey);
  const model = body.model || resolveDesktopComputerModel();
  const reasoningEffort = body.reasoning_effort || resolveDesktopComputerReasoningEffort();
  const startedAtUtc = new Date().toISOString();
  const startedMs = Date.now();
  let response: unknown;
  try {
    response = await client.responses.create({
      model,
      reasoning: { effort: reasoningEffort },
      instructions: body.instructions,
      tools: body.tools,
      input: body.input,
      previous_response_id: body.previous_response_id
    } as any);
  } catch (error) {
    const receipt = createOpenAiModelCallReceipt({
      route: "desktop_computer",
      requested_model: model,
      reasoning_effort: reasoningEffort,
      started_at_utc: startedAtUtc,
      duration_ms: Date.now() - startedMs,
      error
    });
    recordDesktopEvidenceUsage(evidenceUsage, body.evidence_scope, receipt);
    throw new DesktopComputerProviderError(receipt, error);
  }
  const receipt = createOpenAiModelCallReceipt({
    route: "desktop_computer",
    requested_model: model,
    reasoning_effort: reasoningEffort,
    started_at_utc: startedAtUtc,
    duration_ms: Date.now() - startedMs,
    response
  });
  recordDesktopEvidenceUsage(evidenceUsage, body.evidence_scope, receipt);
  return simplifyRelayResponse(response, receipt);
}
