import type { BenchmarkPricingConfig, NormalizedTokenUsage } from "./types.js";

export function estimateTokensFromText(text: string): number {
  const normalized = (text ?? "").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function readNumericCandidate(...values: unknown[]): number | null {
  for (const value of values) {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return null;
}

export function normalizeUsageFromResponse(rawResponse: unknown, inputText: string, outputText: string): NormalizedTokenUsage {
  const raw = rawResponse && typeof rawResponse === "object" ? (rawResponse as Record<string, unknown>) : {};
  const usage = raw.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : {};

  const inputTokens =
    readNumericCandidate(usage.input_tokens, usage.input_text_tokens, usage.prompt_tokens) ??
    estimateTokensFromText(inputText);
  const outputTokens =
    readNumericCandidate(usage.output_tokens, usage.output_text_tokens, usage.completion_tokens) ??
    estimateTokensFromText(outputText);
  const totalTokens = readNumericCandidate(usage.total_tokens) ?? inputTokens + outputTokens;
  const apiVisible =
    readNumericCandidate(usage.input_tokens, usage.input_text_tokens, usage.prompt_tokens) !== null &&
    readNumericCandidate(usage.output_tokens, usage.output_text_tokens, usage.completion_tokens) !== null;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    source: apiVisible ? "api" : "estimated"
  };
}

export function calculateCallCostUsd(
  model: string,
  usage: NormalizedTokenUsage,
  pricing: BenchmarkPricingConfig
): number {
  const rates = pricing.models[model];
  if (!rates) return 0;
  const inputCost = (usage.input_tokens / 1_000_000) * rates.input_per_1m_tokens_usd;
  const outputCost = (usage.output_tokens / 1_000_000) * rates.output_per_1m_tokens_usd;
  return inputCost + outputCost + (rates.tool_call_fee_usd ?? 0);
}
