import { randomUUID } from "node:crypto";
import type { ModelCallReceipt, ModelCallTokenUsage } from "./contracts.js";
import { normalizeModelId, type ReasoningEffort, type SpeedRouteKind } from "./speed_config.js";

export type ModelCallRoute = SpeedRouteKind | "desktop_computer";

type TelemetryPayload = Record<string, unknown>;

export type OpenAiUsageTelemetrySink = {
  append_event: (event_type: string, payload: TelemetryPayload) => void;
  append_notification: (event_type: string, message: string, payload: TelemetryPayload) => void;
};

export type OpenAiModelCallReceiptInput = {
  route: ModelCallRoute;
  requested_model: string;
  reasoning_effort: ReasoningEffort;
  started_at_utc: string;
  duration_ms: number;
  response?: unknown;
  error?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function boundedProviderValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

export function extractOpenAiTokenUsage(usageValue: unknown): ModelCallTokenUsage {
  const usage = asRecord(usageValue);
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return {
    input_tokens: nonNegativeInteger(usage.input_tokens),
    cached_input_tokens: nonNegativeInteger(inputDetails.cached_tokens),
    output_tokens: nonNegativeInteger(usage.output_tokens),
    reasoning_output_tokens: nonNegativeInteger(outputDetails.reasoning_tokens),
    total_tokens: nonNegativeInteger(usage.total_tokens)
  };
}

export function openAiUsageNotificationsEnabled(): boolean {
  const value = (process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function providerErrorCode(error: unknown): string | null {
  const record = asRecord(error);
  const explicit = boundedProviderValue(record.code);
  if (explicit) return explicit;
  const status = nonNegativeInteger(record.status);
  if (status !== null) return `http_${status}`;
  return error instanceof Error ? boundedProviderValue(error.name) : null;
}

export function createOpenAiModelCallReceipt(args: OpenAiModelCallReceiptInput): ModelCallReceipt {
  const response = asRecord(args.response);
  const providerCallId = boundedProviderValue(response.id);
  const requestedModel = normalizeModelId(args.requested_model, "unknown");
  const actualModel = normalizeModelId(response.model, requestedModel);
  const responseStatus = boundedProviderValue(response.status);
  return {
    schema: "revit-operator.model-call-receipt.v1",
    call_id: providerCallId ?? randomUUID(),
    provider: "openai",
    route: args.route,
    requested_model: requestedModel,
    model: actualModel,
    reasoning_effort: args.reasoning_effort,
    started_at_utc: args.started_at_utc,
    duration_ms: Math.max(0, Math.trunc(Number.isFinite(args.duration_ms) ? args.duration_ms : 0)),
    success: args.error === undefined && (responseStatus === null || responseStatus === "completed"),
    response_status: responseStatus,
    error_code: args.error === undefined ? null : providerErrorCode(args.error),
    tokens: extractOpenAiTokenUsage(response.usage)
  };
}

export function recordOpenAiModelCallReceipt(args: {
  receipts: ModelCallReceipt[];
  receipt_input: OpenAiModelCallReceiptInput;
  append_receipt: (receipt: ModelCallReceipt) => void;
}): ModelCallReceipt {
  const receipt = createOpenAiModelCallReceipt(args.receipt_input);
  args.receipts.push(receipt);
  try {
    args.append_receipt(receipt);
  } catch {
    // Receipt propagation through the caller remains authoritative for this turn.
  }
  return receipt;
}

export function recordOpenAiUsageTelemetry(args: OpenAiUsageTelemetrySink & {
  receipt: ModelCallReceipt;
  route: SpeedRouteKind;
  route_reason: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  prompt_build_ms: number;
  model_latency_ms: number;
  input_chars: number;
  usage_notifications_enabled: boolean;
}): void {
  try {
    const { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens } = args.receipt.tokens;
    const usagePayload = {
      model: args.model,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      total_tokens
    };
    if (args.usage_notifications_enabled) {
      args.append_notification(
        "openai.usage",
        `OpenAI usage: model=${args.model}${input_tokens !== null ? `, in=${input_tokens}` : ""}${output_tokens !== null ? `, out=${output_tokens}` : ""}${total_tokens !== null ? `, total=${total_tokens}` : ""}`,
        { ...usagePayload }
      );
      args.append_event("openai.usage", { ...usagePayload });
    }
    args.append_event("speed.timing", {
      route: args.route,
      reason: args.route_reason,
      model: args.model,
      reasoning_effort: args.reasoning_effort,
      call_id: args.receipt.call_id,
      success: args.receipt.success,
      prompt_build_ms: args.prompt_build_ms,
      model_latency_ms: args.model_latency_ms,
      input_chars: args.input_chars,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      total_tokens
    });
  } catch {
    // Telemetry failures must not mask a completed provider response.
  }
}
