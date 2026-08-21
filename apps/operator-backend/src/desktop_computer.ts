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

export type DesktopComputerRelayRequest = {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  instructions?: string;
  tools?: unknown[];
  input: unknown;
  previous_response_id?: string;
};

type DesktopComputerRelayResponse = {
  id: string;
  output_text: string;
  output: unknown[];
  model?: string;
  model_call_receipt: ModelCallReceipt;
};

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

  return {
    model: model || undefined,
    reasoning_effort: reasoningEffort ? reasoningEffort as ReasoningEffort : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    input,
    previous_response_id:
      typeof body.previous_response_id === "string" ? body.previous_response_id.trim() || undefined : undefined
  };
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
  const client = createOpenAiClient(apiKey);
  const model = body.model || resolveDesktopComputerModel();
  const reasoningEffort = body.reasoning_effort || resolveDesktopComputerReasoningEffort();
  const startedAtUtc = new Date().toISOString();
  const startedMs = Date.now();
  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoningEffort },
    instructions: body.instructions,
    tools: body.tools,
    input: body.input,
    previous_response_id: body.previous_response_id
  } as any);

  return simplifyRelayResponse(response, createOpenAiModelCallReceipt({
    route: "desktop_computer",
    requested_model: model,
    reasoning_effort: reasoningEffort,
    started_at_utc: startedAtUtc,
    duration_ms: Date.now() - startedMs,
    response
  }));
}
