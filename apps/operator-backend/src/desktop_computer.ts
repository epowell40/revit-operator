import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";

export type DesktopComputerRelayRequest = {
  model?: string;
  reasoning_effort?: string;
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
};

function resolveDesktopComputerModel(): string {
  return (process.env.OPERATOR_DESKTOP_COMPUTER_MODEL || "gpt-5.6-terra").trim();
}

function resolveDesktopComputerReasoningEffort(): string {
  return (process.env.OPERATOR_DESKTOP_COMPUTER_REASONING_EFFORT || "medium")
    .trim()
    .toLowerCase();
}

export function getDesktopComputerConfig(): {
  available: boolean;
  provider: "backend";
  model: string;
  reasoning_effort: string;
} {
  return {
    available: !!resolveOpenAiApiKey(),
    provider: "backend",
    model: resolveDesktopComputerModel(),
    reasoning_effort: resolveDesktopComputerReasoningEffort()
  };
}

function normalizeRelayRequest(value: unknown): DesktopComputerRelayRequest {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const input = body.input;
  if (input == null) {
    throw new Error("input is required.");
  }

  return {
    model: typeof body.model === "string" ? body.model.trim() || undefined : undefined,
    reasoning_effort:
      typeof body.reasoning_effort === "string" ? body.reasoning_effort.trim().toLowerCase() || undefined : undefined,
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

function simplifyRelayResponse(response: any): DesktopComputerRelayResponse {
  return {
    id: typeof response?.id === "string" ? response.id : "",
    output_text: extractOutputText(response),
    output: Array.isArray(response?.output) ? response.output : [],
    model: typeof response?.model === "string" ? response.model : undefined
  };
}

export async function relayDesktopComputerResponse(rawBody: unknown): Promise<DesktopComputerRelayResponse> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.");
  }

  const body = normalizeRelayRequest(rawBody);
  const client = createOpenAiClient(apiKey);
  const response = await client.responses.create({
    model: body.model || resolveDesktopComputerModel(),
    reasoning: { effort: body.reasoning_effort || resolveDesktopComputerReasoningEffort() },
    instructions: body.instructions,
    tools: body.tools,
    input: body.input,
    previous_response_id: body.previous_response_id
  } as any);

  return simplifyRelayResponse(response);
}
