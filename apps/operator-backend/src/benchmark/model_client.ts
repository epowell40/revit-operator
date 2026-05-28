import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { normalizeUsageFromResponse } from "./cost.js";
import type { BenchmarkModelClient, BenchmarkModelRequest, BenchmarkModelResponse } from "./types.js";

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

export class OpenAiResponsesBenchmarkClient implements BenchmarkModelClient {
  async createResponse(request: BenchmarkModelRequest): Promise<BenchmarkModelResponse> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) {
      throw new Error("OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.");
    }

    const client = createOpenAiClient(apiKey);
    const response = await client.responses.create({
      model: request.model,
      ...(request.reasoning !== "none" ? { reasoning: { effort: request.reasoning } } : {}),
      instructions: request.system_prompt,
      input: request.user_prompt,
      metadata: request.metadata
    } as any);

    const outputText = extractOutputText(response);
    return {
      model: request.model,
      output_text: outputText,
      raw_response: response,
      usage: normalizeUsageFromResponse(response, `${request.system_prompt}\n${request.user_prompt}`, outputText),
      response_id: typeof (response as any)?.id === "string" ? (response as any).id : null
    };
  }
}
