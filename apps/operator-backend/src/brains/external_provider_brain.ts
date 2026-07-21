import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ActionCall,
  type ChatRequest,
  type ChatResponse,
  type ToolResult
} from "../contracts.js";
import { collectInlineImagesFromToolResults } from "../attachments/inline_images.js";
import { compactIncomingToolResult } from "../tool_result_compaction.js";
import { getHistory, getPinnedGoal } from "../session_store.js";
import { resolveExistingFileUnderWorkspace } from "../workspace.js";
import type { StreamCallbacks } from "./codex_brain.js";
import { getOperatorAgentBaseInstructions } from "./codex_brain.js";

type ExternalProvider = "gemini" | "anthropic";
type FetchLike = typeof fetch;

export type ExternalProviderDependencies = {
  fetchImpl?: FetchLike;
};

type ProviderImage = {
  mime: string;
  dataBase64: string;
};

type ProviderDecision = {
  assistant_message?: unknown;
  actions?: unknown;
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assistant_message", "actions"],
  properties: {
    assistant_message: {
      type: "string",
      description: "Concise user-facing progress, result, or exact blocker."
    },
    actions: {
      type: "array",
      description: "The next smallest executable Revit action or tightly coupled action group.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action_id", "method", "path", "body_json"],
        properties: {
          action_id: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"] },
          path: { type: "string" },
          body_json: {
            type: ["string", "null"],
            description: "JSON-encoded request body, or null when the request has no body."
          }
        }
      }
    }
  }
} as const;

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…(truncated)`;
}

function safeJson(value: unknown, maxChars: number): string {
  try {
    return clip(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return "(not serializable)";
  }
}

function maxPromptChars(): number {
  const raw = Number.parseInt(process.env.OPERATOR_EXTERNAL_AGENT_MAX_PROMPT_CHARS ?? "80000", 10);
  return Number.isFinite(raw) ? Math.max(12_000, Math.min(240_000, raw)) : 80_000;
}

function maxHistoryMessages(): number {
  const raw = Number.parseInt(process.env.OPERATOR_EXTERNAL_AGENT_MAX_HISTORY_MESSAGES ?? "24", 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(80, raw)) : 24;
}

function maxOutputTokens(provider: ExternalProvider): number {
  const name =
    provider === "gemini"
      ? "OPERATOR_GEMINI_AGENT_MAX_OUTPUT_TOKENS"
      : "OPERATOR_ANTHROPIC_MAX_OUTPUT_TOKENS";
  const fallback = provider === "anthropic" ? 8192 : 4096;
  const raw = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
  return Number.isFinite(raw) ? Math.max(512, Math.min(32_000, raw)) : fallback;
}

function timeoutMs(provider: ExternalProvider): number {
  const name =
    provider === "gemini"
      ? "OPERATOR_GEMINI_AGENT_TIMEOUT_MS"
      : "OPERATOR_ANTHROPIC_TIMEOUT_MS";
  const fallback =
    provider === "gemini"
      ? process.env.OPERATOR_GEMINI_TIMEOUT_MS
      : undefined;
  const raw = Number.parseInt(process.env[name] ?? fallback ?? "180000", 10);
  return Number.isFinite(raw) ? Math.max(10_000, Math.min(10 * 60_000, raw)) : 180_000;
}

export function resolveGeminiAgentApiKey(): string {
  return (process.env.OPERATOR_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
}

export function resolveAnthropicApiKey(): string {
  return (process.env.OPERATOR_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
}

export function resolveGeminiAgentModel(): string {
  return (
    process.env.OPERATOR_GEMINI_AGENT_MODEL ||
    process.env.OPERATOR_GEMINI_MODEL ||
    "gemini-3.5-flash"
  ).trim();
}

export function resolveAnthropicModel(): string {
  return (process.env.OPERATOR_ANTHROPIC_MODEL || "claude-opus-4-8").trim();
}

function resolveGeminiAgentModels(): string[] {
  const values = [
    resolveGeminiAgentModel(),
    ...(process.env.OPERATOR_GEMINI_AGENT_MODEL_FALLBACKS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  ];
  return [...new Set(values.filter(Boolean))];
}

function compactToolResults(toolResults: ToolResult[] | undefined): ToolResult[] {
  if (!Array.isArray(toolResults)) return [];
  return toolResults.slice(-20).map(result => compactIncomingToolResult(result));
}

function buildPrompt(req: ChatRequest, provider: ExternalProvider): string {
  const lines: string[] = [
    getOperatorAgentBaseInstructions(),
    "",
    `You are running as the Operator ${provider} brain. You do not call MCP directly in this process.`,
    "Instead, return the next bridge calls in the actions array. The host executes them and returns tool_results on the next turn.",
    "Use /revit/search-tools, /revit/tool-doc, and /revit/tool-examples when an exact contract is unknown.",
    "Prefer bounded predicate queries over unfiltered collection reads. A tool result marked _compacted, result_clipped, truncated, or containing a truncation marker is incomplete: never infer absence from it; immediately take the next smallest bounded read-only query that can resolve the target.",
    "For Revit writes: observe first, emit only the next smallest reversible action or tightly coupled action group, dry-run it, then apply and verify on later turns.",
    "Never demand one perfect all-or-nothing MEP graph. Preserve accepted prior work and repair location, size, type, connectivity, or annotation mismatches incrementally.",
    "Before creating replacement geometry, inventory the bounded target region and retain useful source-grounded elements. Prefer one staged move, rotate, MEP size/elevation edit, or exact connector repair; persist affected_element_ids and verify them before creating duplicates.",
    "A successful write remains provisional until complete native ID readback, focused visual evidence, and a reversible save-as checkpoint all succeed. Advance only after that checkpoint is recorded.",
    "If the host reports a blocked staged operation, propose one /revit/existing-conditions-mep-draft-workflow action containing exactly one smaller replacement operation with the same action_key, the same inputFingerprintSha256, a new repair:* stageKey, and repairReason. The host registers and sequences it without replaying accepted work.",
    "For pipe and duct creation, prefer explicit endpoints, size, system/type, level/elevation, verify, and dry-run fields.",
    "For movement, use an exact model-space XYZ vector. For orthogonal joins, prefer route/branch workflows that create and verify fittings.",
    "If calibrated source-to-model registration is absent, do not convert image pixels into model writes. Request the smallest alignment/inventory action needed to establish it.",
    "When Current Revit/server context contains workbench_source_preflight_complete=true, the attached source has already been analyzed by the backend. Never call /revit/tool-search, /revit/search-tools, tool docs, examples, or any Revit endpoint to look for a source-analysis tool. Read workbench_results and the supplied source images, then take only the next smallest native verification action needed for registration.",
    "When workbench_structured_image_analysis_complete=true, structured Gemini source-image analysis is also complete. Preserve those source observations as provisional evidence and verify them against bounded native room/view/element reads before any write.",
    "Return JSON matching the supplied schema. body_json must itself be valid JSON text when present.",
    ""
  ];

  const pinnedGoal = getPinnedGoal(req.session_id);
  if (pinnedGoal) {
    lines.push("Pinned user goal:", pinnedGoal, "");
  }

  const historyLimit = maxHistoryMessages();
  const history = historyLimit > 0 ? getHistory(req.session_id).slice(-historyLimit) : [];
  if (history.length > 0) {
    lines.push("Recent conversation:");
    for (const message of history) {
      lines.push(`${message.role.toUpperCase()}: ${clip(message.text, 5000)}`);
    }
    lines.push("");
  }

  if ((req.user_text ?? "").trim()) {
    lines.push("Current user request:", (req.user_text ?? "").trim(), "");
  }

  const serverContext =
    req.context && typeof req.context === "object" && !Array.isArray(req.context)
      ? ((req.context as Record<string, unknown>).__server as Record<string, unknown> | undefined)
      : undefined;
  if (serverContext?.workbench_source_preflight_complete === true) {
    const sourcePreflightSummary = serverContext.workbench_source_preflight_summary;
    lines.push(
      "Backend source-preflight status:",
      "- workbench_source_preflight_complete=true",
      `- workbench_structured_image_analysis_complete=${serverContext.workbench_structured_image_analysis_complete === true}`,
      "- Do not search for source-analysis tooling. Continue with one bounded native registration-verification action.",
      ""
    );
    if (sourcePreflightSummary && typeof sourcePreflightSummary === "object") {
      lines.push(
        "Verified source/native preflight summary:",
        safeJson(sourcePreflightSummary, 16_000),
        "If native_sheet.placed_view_id is present, do not list or rediscover sheets/views. Use that exact view id for the next bounded room, frame, or visible-inventory verification.",
        ""
      );
    }
  }

  if (req.context !== undefined) {
    lines.push("Current Revit/server context:", safeJson(req.context, 20_000), "");
  }

  const toolResults = compactToolResults(req.tool_results);
  if (toolResults.length > 0) {
    lines.push("Latest tool results:", safeJson(toolResults, 32_000), "");
  }

  if (Array.isArray(req.user_attachments) && req.user_attachments.length > 0) {
    lines.push(
      "User attachment metadata:",
      safeJson(
        req.user_attachments.map(attachment => ({
          id: attachment.id,
          relative_path: attachment.relative_path,
          filename: attachment.filename,
          mime: attachment.mime,
          bytes: attachment.bytes,
          sha256: attachment.sha256
        })),
        8000
      ),
      ""
    );
  }

  return clip(lines.join("\n"), maxPromptChars());
}

function dataUrlToProviderImage(value: string): ProviderImage | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value.trim());
  if (!match) return null;
  const mime = match[1]!.toLowerCase() === "image/jpg" ? "image/jpeg" : match[1]!.toLowerCase();
  const dataBase64 = match[2]!.replace(/\s+/g, "");
  if (!dataBase64) return null;
  return { mime, dataBase64 };
}

function readWorkspaceUserImage(relativePath: string, mimeHint?: string): ProviderImage | null {
  try {
    const full = resolveExistingFileUnderWorkspace(relativePath);
    const stat = fs.statSync(full);
    const maxBytes = Math.max(
      256 * 1024,
      Number.parseInt(process.env.OPERATOR_PROMPT_MAX_IMAGE_BYTES ?? `${4 * 1024 * 1024}`, 10) ||
        4 * 1024 * 1024
    );
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    const ext = path.extname(full).toLowerCase();
    const mime =
      (mimeHint || "").trim().toLowerCase() ||
      (ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
    if (!/^image\/(?:png|jpeg|jpg|webp|gif)$/i.test(mime)) return null;
    return {
      mime: mime === "image/jpg" ? "image/jpeg" : mime,
      dataBase64: fs.readFileSync(full).toString("base64")
    };
  } catch {
    return null;
  }
}

function collectProviderImages(req: ChatRequest): ProviderImage[] {
  const maxImagesRaw = Number.parseInt(process.env.OPERATOR_EXTERNAL_AGENT_MAX_IMAGES ?? "6", 10);
  const maxImages = Number.isFinite(maxImagesRaw) ? Math.max(0, Math.min(12, maxImagesRaw)) : 6;
  if (maxImages === 0) return [];

  const maxBytes = Math.max(
    256 * 1024,
    Number.parseInt(process.env.OPERATOR_PROMPT_MAX_IMAGE_BYTES ?? `${4 * 1024 * 1024}`, 10) ||
      4 * 1024 * 1024
  );
  const images = collectInlineImagesFromToolResults(req.tool_results, {
    maxImages,
    maxBytes
  })
    .map(dataUrlToProviderImage)
    .filter((image): image is ProviderImage => !!image);

  for (const attachment of req.user_attachments ?? []) {
    if (images.length >= maxImages) break;
    const relativePath = (attachment.relative_path || "").trim();
    if (!relativePath) continue;
    const image = readWorkspaceUserImage(relativePath, attachment.mime);
    if (image) images.push(image);
  }

  const serverContext =
    req.context && typeof req.context === "object"
      ? (req.context as { __server?: { workbench_inline_image_paths?: unknown } }).__server
      : undefined;
  const workbenchPaths = Array.isArray(serverContext?.workbench_inline_image_paths)
    ? serverContext.workbench_inline_image_paths
    : [];
  for (const candidate of workbenchPaths) {
    if (images.length >= maxImages) break;
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const image = readWorkspaceUserImage(candidate.trim());
    if (image) images.push(image);
  }

  return images.slice(0, maxImages);
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseProviderDecision(text: string): ProviderDecision {
  const json = extractFirstJsonObject(text.trim()) ?? text.trim();
  const parsed = JSON.parse(json) as ProviderDecision;
  if (!parsed || typeof parsed !== "object") throw new Error("Provider returned a non-object response.");
  return parsed;
}

function normalizeProviderDecision(raw: ProviderDecision): ChatResponse {
  const actions: ActionCall[] = [];
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  for (const entry of rawActions.slice(0, 12)) {
    if (!entry || typeof entry !== "object") continue;
    const action = entry as Record<string, unknown>;
    const method = String(action.method ?? "").trim().toUpperCase();
    const requestPath = String(action.path ?? "").trim();
    if ((method !== "GET" && method !== "POST") || !requestPath.startsWith("/")) continue;
    const actionId = String(action.action_id ?? "").trim() || `external:${randomUUID()}`;
    const bodyJson = action.body_json;
    let body: unknown;
    if (typeof bodyJson === "string" && bodyJson.trim()) {
      body = JSON.parse(bodyJson);
    }
    actions.push({
      action_id: actionId,
      method,
      path: requestPath,
      ...(body !== undefined ? { body } : {})
    });
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      typeof raw.assistant_message === "string" ? raw.assistant_message.trim() : "",
    actions
  };
}

function providerError(provider: ExternalProvider, message: string): ChatResponse {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: `${provider === "gemini" ? "Gemini" : "Anthropic"} brain error: ${message}`,
    actions: []
  };
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  durationMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(
  req: ChatRequest,
  dependencies: ExternalProviderDependencies
): Promise<ChatResponse> {
  const key = resolveGeminiAgentApiKey();
  if (!key) {
    return providerError(
      "gemini",
      "API key missing. Set OPERATOR_GEMINI_API_KEY or GEMINI_API_KEY in a machine-local environment."
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const baseUrl = (
    process.env.OPERATOR_GEMINI_AGENT_BASE_URL ||
    process.env.OPERATOR_GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta"
  )
    .trim()
    .replace(/\/+$/, "");
  const prompt = buildPrompt(req, "gemini");
  const images = collectProviderImages(req);
  const models = resolveGeminiAgentModels();
  let lastError = "No Gemini model was configured.";

  for (const model of models) {
    const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const image of images) {
      parts.push({
        inlineData: {
          mimeType: image.mime,
          data: image.dataBase64
        }
      });
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": key
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: maxOutputTokens("gemini"),
              responseMimeType: "application/json",
              responseJsonSchema: RESPONSE_SCHEMA
            }
          })
        },
        timeoutMs("gemini")
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    const responseText = await response.text();
    if (!response.ok) {
      lastError = `HTTP ${response.status}: ${clip(responseText.replace(/\s+/g, " ").trim(), 1000)}`;
      continue;
    }

    try {
      const payload = JSON.parse(responseText) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (payload.candidates ?? [])
        .flatMap(candidate => candidate.content?.parts ?? [])
        .map(part => (typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      if (!text) throw new Error("Gemini returned no text decision.");
      return normalizeProviderDecision(parseProviderDecision(text));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return providerError("gemini", lastError);
}

async function callAnthropic(
  req: ChatRequest,
  dependencies: ExternalProviderDependencies
): Promise<ChatResponse> {
  const key = resolveAnthropicApiKey();
  if (!key) {
    return providerError(
      "anthropic",
      "API key missing. Set OPERATOR_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY in operator-backend/.env.local and restart."
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const baseUrl = (process.env.OPERATOR_ANTHROPIC_BASE_URL || "https://api.anthropic.com")
    .trim()
    .replace(/\/+$/, "");
  const prompt = buildPrompt(req, "anthropic");
  const images = collectProviderImages(req);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mime,
        data: image.dataBase64
      }
    });
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: resolveAnthropicModel(),
          max_tokens: maxOutputTokens("anthropic"),
          thinking: { type: "adaptive" },
          output_config: {
            effort: (process.env.OPERATOR_ANTHROPIC_EFFORT || "xhigh").trim(),
            format: {
              type: "json_schema",
              schema: RESPONSE_SCHEMA
            }
          },
          messages: [{ role: "user", content }]
        })
      },
      timeoutMs("anthropic")
    );

    const responseText = await response.text();
    if (!response.ok) {
      return providerError(
        "anthropic",
        `HTTP ${response.status}: ${clip(responseText.replace(/\s+/g, " ").trim(), 1000)}`
      );
    }

    const payload = JSON.parse(responseText) as {
      stop_reason?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (payload.content ?? [])
      .filter(block => block.type === "text" && typeof block.text === "string")
      .map(block => block.text!)
      .join("\n");
    if (!text) {
      return providerError(
        "anthropic",
        `No text decision returned${payload.stop_reason ? ` (stop_reason=${payload.stop_reason})` : ""}.`
      );
    }
    return normalizeProviderDecision(parseProviderDecision(text));
  } catch (error) {
    return providerError("anthropic", error instanceof Error ? error.message : String(error));
  }
}

export async function decideGemini(
  req: ChatRequest,
  dependencies: ExternalProviderDependencies = {}
): Promise<ChatResponse> {
  return callGemini(req, dependencies);
}

export async function decideAnthropic(
  req: ChatRequest,
  dependencies: ExternalProviderDependencies = {}
): Promise<ChatResponse> {
  return callAnthropic(req, dependencies);
}

async function emitStreamingResult(
  decision: Promise<ChatResponse>,
  callbacks: StreamCallbacks
): Promise<ChatResponse> {
  const response = await decision;
  const text = response.assistant_message || "";
  callbacks.onDelta?.(text);
  callbacks.onDone?.(text);
  return response;
}

export async function decideGeminiStreaming(
  req: ChatRequest,
  callbacks: StreamCallbacks,
  dependencies: ExternalProviderDependencies = {}
): Promise<ChatResponse> {
  return emitStreamingResult(decideGemini(req, dependencies), callbacks);
}

export async function decideAnthropicStreaming(
  req: ChatRequest,
  callbacks: StreamCallbacks,
  dependencies: ExternalProviderDependencies = {}
): Promise<ChatResponse> {
  return emitStreamingResult(decideAnthropic(req, dependencies), callbacks);
}
