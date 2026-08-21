import { randomUUID } from "node:crypto";
import type { ModelCallReceipt, ModelCallTokenUsage } from "./contracts.js";
import { normalizeModelId, type ReasoningEffort, type SpeedRouteKind } from "./speed_config.js";

export type ModelCallRoute = SpeedRouteKind | "desktop_computer";

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

function providerErrorCode(error: unknown): string | null {
  const record = asRecord(error);
  const explicit = boundedProviderValue(record.code);
  if (explicit) return explicit;
  const status = nonNegativeInteger(record.status);
  if (status !== null) return `http_${status}`;
  return error instanceof Error ? boundedProviderValue(error.name) : null;
}

export function createOpenAiModelCallReceipt(args: {
  route: ModelCallRoute;
  requested_model: string;
  reasoning_effort: ReasoningEffort;
  started_at_utc: string;
  duration_ms: number;
  response?: unknown;
  error?: unknown;
}): ModelCallReceipt {
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
