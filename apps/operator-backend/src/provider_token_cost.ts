/** Standard text-token list-price equivalents, not invoices, service-tier
 * confirmation or permission to spend. Keep this snapshot reproducible. */
export const PROVIDER_TOKEN_PRICING_SNAPSHOT = {
  schema: "revit-operator.openai-pricing-snapshot.v1",
  effective_date: "2026-10-09",
  model_rate_dates: { "gpt-6.1-sol": "2026-10-09", default: "2026-09-24" },
  currency: "USD",
  unit_tokens: 1_000_000,
  long_context_input_threshold_tokens: 272_000,
  rates: {
    "gpt-5.6-sol": { input: 4, cached_input: 0.4, cache_write_input: 5, output: 20 },
    "gpt-5.6-luna": { input: 0.2, cached_input: 0.02, cache_write_input: 0.25, output: 1.2 },
    "gpt-6-astra": { input: 10, cached_input: 1, cache_write_input: 12.5, output: 50 },
    "gpt-6-sol": { input: 2, cached_input: 0.2, cache_write_input: 2.5, output: 10 },
    "gpt-6.1-sol": { input: 2, cached_input: 0.1, cache_write_input: 2.5, output: 10 }
  },
  sources: {
    "gpt-5.6-sol": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "gpt-5.6-luna": "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    "gpt-6-astra": "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "gpt-6-sol": "https://developers.openai.com/api/docs/models/gpt-6-sol",
    "gpt-6.1-sol": "https://developers.openai.com/api/docs/models/gpt-6.1-sol"
  }
} as const;

export interface ProviderTokenCategories {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Both cache categories are included in input, never additional input. A
 * missing category cannot be inferred from total tokens or priced as zero. */
export function ordinaryInputTokens(tokens: ProviderTokenCategories): number | null {
  const input = tokens.input_tokens, cached = tokens.cached_input_tokens, write = tokens.cache_write_input_tokens;
  return validTokenCount(input) && validTokenCount(cached) && validTokenCount(write) && cached + write <= input
    ? input - cached - write : null;
}

/** Price each provider request separately: the long-context multiplier applies
 * to that request's full input and output, not the assignment's accumulated input. */
export function standardProviderTextTokenCostUsd(model: string, tokens: ProviderTokenCategories): number | null {
  if (!Object.hasOwn(PROVIDER_TOKEN_PRICING_SNAPSHOT.rates, model)) return null;
  const rates = PROVIDER_TOKEN_PRICING_SNAPSHOT.rates[model as keyof typeof PROVIDER_TOKEN_PRICING_SNAPSHOT.rates];
  const ordinary = ordinaryInputTokens(tokens);
  if (!rates || ordinary === null || !validTokenCount(tokens.output_tokens)) return null;
  const input = tokens.input_tokens as number, cached = tokens.cached_input_tokens as number, write = tokens.cache_write_input_tokens as number;
  const long = input > PROVIDER_TOKEN_PRICING_SNAPSHOT.long_context_input_threshold_tokens;
  return ((ordinary * rates.input + cached * rates.cached_input + write * rates.cache_write_input) * (long ? 2 : 1)
    + tokens.output_tokens * rates.output * (long ? 1.5 : 1)) / PROVIDER_TOKEN_PRICING_SNAPSHOT.unit_tokens;
}
