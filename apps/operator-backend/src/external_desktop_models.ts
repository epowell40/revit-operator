import { randomUUID } from "node:crypto";
import { trustedLocalExperimentHost } from "./assignments/local_advisory_policy.js";
import type { ReasoningEffort } from "./speed_config.js";

const providers = {
  "gemini-4-neon": "gemini",
  "gemini-4-carbon": "gemini",
  "claude-opus-5-5": "anthropic"
} as const;

export type ExternalDesktopProvider = typeof providers[keyof typeof providers];
const desktopTool = "operator_desktop_action";

export function externalDesktopProvider(model: string): ExternalDesktopProvider | undefined {
  return Object.hasOwn(providers, model) ? providers[model as keyof typeof providers] : undefined;
}

function keyFor(provider: ExternalDesktopProvider): string {
  return (provider === "gemini"
    ? process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ""
    : process.env.OPERATOR_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
}

export function availableExternalDesktopModels(): string[] {
  return process.env.OPERATOR_EXTERNAL_DESKTOP_MODELS === "1" && trustedLocalExperimentHost()
    ? Object.entries(providers).filter(([, provider]) => keyFor(provider)).map(([model]) => model)
    : [];
}

export function assertExternalDesktopModel(model: string, effort: ReasoningEffort, bound: boolean): void {
  if (!externalDesktopProvider(model)) return;
  if (!bound || !availableExternalDesktopModels().includes(model)) throw Error("Selected provider model is unavailable in this Operator runtime.");
  if (!["low", "medium", "high"].includes(effort)) throw Error("Selected provider model supports Low, Medium, and High effort in Operator.");
}

const desktopToolSchema = {
  type: "object", required: ["type"], additionalProperties: false,
  properties: {
    type: { enum: ["screenshot", "wait", "move", "click", "double_click", "scroll", "type", "keypress"] },
    x: { type: "integer" }, y: { type: "integer" }, button: { enum: ["left", "right", "middle"] },
    scrollX: { type: "integer" }, scrollY: { type: "integer" }, text: { type: "string" },
    keys: { type: "array", items: { type: "string" } }
  }
};

function functions(tools: any[]): any[] {
  return tools.map(tool => {
    if (tool?.type === "computer") return { name: desktopTool,
      description: "Perform one approved desktop GUI action and receive a current screenshot. Use coordinates from the latest screenshot. Use screenshot to inspect without input.",
      parameters: desktopToolSchema };
    if (tool?.type !== "function" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name)
        || tool.name === desktopTool || !tool.parameters) throw Error("external_model_unsupported_tool");
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
}

function needsAnthropicArgumentEnvelope(schema: Record<string, unknown>): boolean {
  return ["oneOf", "allOf", "anyOf"].some(key => Object.hasOwn(schema, key));
}

function anthropicTool({parameters, ...tool}: any) {
  if (!needsAnthropicArgumentEnvelope(parameters)) return { ...tool, input_schema: parameters };
  // Anthropic disallows combinators at the root of a tool schema. Keep the
  // original contract inside the envelope and validate the real arguments at dispatch.
  return {
    ...tool,
    description: `${tool.description ?? ""}\nPass the tool's inputs in the arguments object.`.trim(),
    input_schema: {
      type: "object", properties: { arguments: parameters },
      required: ["arguments"], additionalProperties: false
    }
  };
}

function embedded(value: unknown, accepted: string): { mime: string; base64: string } {
  const match = typeof value === "string" && new RegExp(`^data:(${accepted});base64,([A-Za-z0-9+/]+={0,2})$`).exec(value);
  if (!match || Buffer.from(match[2]!, "base64").toString("base64") !== match[2]) throw Error("external_model_embedded_media_required");
  return { mime: match[1]!, base64: match[2]! };
}

function inputPart(part: any, provider: ExternalDesktopProvider): any {
  if (["input_text", "output_text"].includes(part?.type) && typeof part.text === "string") return { ...(provider === "anthropic" ? { type: "text" } : {}), text: part.text };
  const image = ["input_image", "computer_screenshot"].includes(part?.type);
  if (!image && part?.type !== "input_file") throw Error("external_model_unsupported_input_part");
  const asset = embedded(image ? part.image_url : part.file_data, image ? "image/(?:png|jpeg|webp)" : "application/pdf");
  return provider === "gemini" ? { inlineData: { mimeType: asset.mime, data: asset.base64 } }
    : { type: image ? "image" : "document", source: { type: "base64", media_type: asset.mime, data: asset.base64 } };
}

function toolResult(item: any, name: string, provider: ExternalDesktopProvider): any {
  const parts: any[] = typeof item.output === "string" ? [{ type: "input_text", text: item.output }]
    : Array.isArray(item.output) ? item.output : [item.output];
  const content = parts.map(p => inputPart(p, provider));
  if (provider === "anthropic") return { type: "tool_result", tool_use_id: item.call_id, content };
  const text = content.filter(p => typeof p.text === "string").map(p => p.text).join("\n");
  const images = content.filter(p => p.inlineData);
  return { functionResponse: { name, response: { output: text || "See attached image." }, ...(images.length ? { parts: images } : {}) } };
}

/** Convert the exact host-bound input window. Signed provider blocks are
 * replayed verbatim. Tool results precede any user feedback in the same turn. */
export function externalDesktopPayload(provider: ExternalDesktopProvider, model: string, effort: ReasoningEffort,
  instructions: string, tools: any[], input: any[]): any {
  const declarations = functions(tools);
  const messages: { role: string; blocks: any[]; toolResults: any[] }[] = [];
  const pending = new Map<string, string>();
  const append = (role: string, blocks: any[], result = false) => {
    if (!blocks.length) return;
    if (messages.at(-1)?.role !== role) messages.push({ role, blocks: [], toolResults: [] });
    messages.at(-1)![result ? "toolResults" : "blocks"].push(...blocks);
  };
  for (const item of input) {
    if (item.type === "function_call_output" || item.type === "computer_call_output") {
      const name = pending.get(item.call_id);
      if (!name) throw Error("external_model_tool_result_without_call");
      pending.delete(item.call_id);
      append("user", [toolResult(item, name, provider)], true);
      continue;
    }
    if (pending.size && item.role === "user") {
      // Sidecar may interleave screenshot annotations between parallel tool outputs.
      // They become text after all the tool results in the same user message.
      const parts: any[] = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: item.content }];
      append("user", parts.map(p => inputPart(p, provider)));
      continue;
    }
    if (item.provider_part) {
      if (item.provider_transport !== provider) throw Error("external_model_foreign_history");
      append("assistant", [item.provider_part]);
      if (item.type === "function_call" || item.type === "computer_call")
        pending.set(item.call_id, item.type === "computer_call" ? desktopTool : item.name);
      continue;
    }
    if (!["user", "assistant"].includes(item.role)) throw Error("external_model_unsupported_history");
    const parts = typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content;
    if (!Array.isArray(parts)) throw Error("external_model_unsupported_input");
    append(item.role, parts.map(p => inputPart(p, provider)));
  }
  if (pending.size || !messages.length) throw Error("external_model_incomplete_history");
  // Provider limits are independent of the Assignment's existing call budget.
  const maxTokens = 24_576;
  if (provider === "gemini") return {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : m.role, parts: [...m.toolResults, ...m.blocks] })),
    tools: declarations.length ? [{ functionDeclarations: declarations.map(({ parameters, ...tool }) => ({ ...tool, parametersJsonSchema: parameters })) }] : undefined,
    generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: effort.toUpperCase() } }
  };
  return {
    model, system: instructions, messages: messages.map(m => ({ role: m.role, content: [...m.toolResults, ...m.blocks] })),
    tools: declarations.map(anthropicTool),
    max_tokens: maxTokens, thinking: { type: "adaptive", display: "omitted" }, output_config: { effort }
  };
}

function normalizedOutput(provider: ExternalDesktopProvider, parts: any[], responseId: string, tools: any[]): any[] {
  const declarations = new Map(functions(tools).map(tool => [tool.name, tool.parameters]));
  const calls = new Set<string>();
  return parts.map((part, index) => {
    const continuation = { provider_transport: provider, provider_part: part };
    const call = provider === "gemini" ? part.functionCall : part.type === "tool_use" ? { id: part.id, name: part.name, args: part.input } : null;
    if (call) {
      const id = provider === "anthropic" ? call.id : `${responseId}:${index}`;
      if (!declarations.has(call.name) || typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)
          || calls.has(id) || !call.args || typeof call.args !== "object" || Array.isArray(call.args))
        throw Error("external_model_invalid_tool_call");
      let args = call.args;
      if (provider === "anthropic" && needsAnthropicArgumentEnvelope(declarations.get(call.name))) {
        if (!Object.hasOwn(args, "arguments") || Object.keys(args).length !== 1 || !args.arguments
            || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw Error("external_model_invalid_tool_call");
        args = args.arguments;
      }
      calls.add(id);
      return call.name === desktopTool
        ? { ...continuation, type: "computer_call", call_id: id, actions: [args] }
        : { ...continuation, type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(args) };
    }
    if (part.thought || ["thinking", "redacted_thinking"].includes(part.type)) {
      const opaque = part.signature ?? part.data ?? part.thoughtSignature;
      if (typeof opaque !== "string" || !opaque) throw Error("external_model_missing_thought_signature");
      return { ...continuation, type: "reasoning", encrypted_content: opaque };
    }
    if (typeof part.text === "string") return { ...continuation, type: "message", role: "assistant",
      content: [{ type: "output_text", text: part.text }] };
    throw Error("external_model_unsupported_output_part");
  });
}

function providerUsage(p: ExternalDesktopProvider, data: any) {
  if (p === "gemini") {
    const u = data.usageMetadata;
    if (!u || !Number.isSafeInteger(u.promptTokenCount) || !Number.isSafeInteger(u.totalTokenCount)) return undefined;
    const thoughts = u.thoughtsTokenCount ?? 0;
    return { input_tokens: u.promptTokenCount, output_tokens: (u.candidatesTokenCount ?? 0) + thoughts,
      total_tokens: u.totalTokenCount, input_tokens_details: { cached_tokens: u.cachedContentTokenCount ?? 0 },
      output_tokens_details: { reasoning_tokens: thoughts } };
  }
  const u = data.usage;
  if (!u || !Number.isSafeInteger(u.input_tokens) || !Number.isSafeInteger(u.output_tokens)) return undefined;
  const cached = u.cache_read_input_tokens ?? 0, written = u.cache_creation_input_tokens ?? 0;
  const input = u.input_tokens + cached + written;
  return { input_tokens: input, output_tokens: u.output_tokens, total_tokens: input + u.output_tokens,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written } };
}

export class ExternalDesktopResponseError extends Error {
  constructor(readonly status: number, readonly code: string, readonly observed?: unknown) { super(code); }
}

export async function requestExternalDesktopModel(provider: ExternalDesktopProvider, model: string, effort: ReasoningEffort,
  instructions: string, tools: any[], input: unknown) {
  if (!Array.isArray(input)) throw Error("external_model_exact_input_window_required");
  const key = keyFor(provider);
  if (!key) throw Error("external_model_credential_unavailable");
  const endpoint = provider === "gemini"
    ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` : "https://api.anthropic.com/v1/messages";
  const headers: Record<string, string> = provider === "gemini"
    ? { "x-goog-api-key": key } : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers },
    redirect: "error", signal: AbortSignal.timeout(240_000),
    body: JSON.stringify(externalDesktopPayload(provider, model, effort, instructions, tools, input)) });
  if (!response.ok) throw new ExternalDesktopResponseError(response.status, `http_${response.status}`);
  const data = await response.json() as any;
  const candidate = data.candidates?.[0];
  const actual = provider === "gemini" ? data.modelVersion : data.model;
  const id = (provider === "gemini" ? data.responseId : data.id) ?? `external-${randomUUID()}`;
  const usage = providerUsage(provider, data);
  const observed = { id, model: actual, usage, status: "incomplete" };
  const finish = provider === "gemini" ? candidate?.finishReason : data.stop_reason;
  const parts = provider === "gemini" ? candidate?.content?.parts : data.content;
  if (actual !== model && !String(actual ?? "").startsWith(`${model}-`)) throw new ExternalDesktopResponseError(200, "external_model_identity_mismatch", observed);
  if (!usage || !(provider === "gemini" ? finish === "STOP" : ["tool_use", "end_turn"].includes(finish)) || !parts?.length)
    throw new ExternalDesktopResponseError(200, "external_model_incomplete_response", observed);
  try { return { ...observed, status: "completed", output: normalizedOutput(provider, parts, id, tools) }; }
  catch { throw new ExternalDesktopResponseError(200, "external_model_unusable_response", observed); }
}
