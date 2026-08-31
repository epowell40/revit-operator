export type ToolSearchCandidateV2 = Readonly<{
  method?: unknown;
  path?: unknown;
  group?: unknown;
  title?: unknown;
  description?: unknown;
  example?: unknown;
  required_fields?: readonly unknown[];
  optional_fields?: readonly unknown[];
}>;

const SEMANTIC_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  inventory: "quantify",
  inventories: "quantify",
  counting: "count",
  counts: "count",
  grouped: "group",
  grouping: "group",
  groups: "group",
  listed: "list",
  listing: "list",
  categories: "category",
  elements: "element",
  families: "family",
  terminals: "terminal",
  types: "type"
});

function normalizeToken(value: string): string {
  const token = value.normalize("NFKC").toLowerCase();
  return SEMANTIC_TOKENS[token] ?? token;
}

export function toolSearchTokensV2(value: unknown): readonly string[] {
  return [...new Set(String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .map(normalizeToken)
    .filter(token => token.length >= 2))];
}

function fieldScore(value: unknown, query: string, queryTokens: readonly string[], exactScore: number, tokenScore: number): number {
  const field = String(value ?? "").trim();
  if (!field) return 0;
  const normalizedField = field.normalize("NFKC").toLowerCase();
  const fieldTokens = new Set(toolSearchTokensV2(field));
  const phraseScore = normalizedField.includes(query) ? exactScore : 0;
  const matched = queryTokens.filter(token => fieldTokens.has(token)).length;
  return phraseScore + (matched * tokenScore);
}

export function scoreToolSearchCandidateV2(candidate: ToolSearchCandidateV2, queryValue: unknown): number {
  const query = String(queryValue ?? "").trim().normalize("NFKC").toLowerCase();
  const queryTokens = toolSearchTokensV2(query);
  if (!query || queryTokens.length === 0) return 0;
  const fields: readonly unknown[] = [
    candidate.path, candidate.title, candidate.group, candidate.description, candidate.example,
    candidate.method, candidate.required_fields?.join(" "), candidate.optional_fields?.join(" ")
  ];
  const candidateTokens = new Set(fields.flatMap(field => [...toolSearchTokensV2(field)]));
  const coverage = queryTokens.filter(token => candidateTokens.has(token)).length;
  const aggregateIntent = queryTokens.includes("quantify") || queryTokens.includes("count");
  const candidateAggregates = candidateTokens.has("quantify") || candidateTokens.has("count");
  const aggregationBonus = aggregateIntent && candidateAggregates
    ? 100 + (queryTokens.includes("group") && candidateTokens.has("group") ? 140 : 0)
    : 0;
  return fieldScore(candidate.path, query, queryTokens, 140, 28)
    + fieldScore(candidate.title, query, queryTokens, 120, 30)
    + fieldScore(candidate.group, query, queryTokens, 80, 24)
    + fieldScore(candidate.description, query, queryTokens, 55, 12)
    + fieldScore(candidate.example, query, queryTokens, 45, 10)
    + fieldScore(candidate.method, query, queryTokens, 25, 8)
    + fieldScore(candidate.required_fields?.join(" "), query, queryTokens, 0, 6)
    + fieldScore(candidate.optional_fields?.join(" "), query, queryTokens, 0, 3)
    + (coverage * 20)
    + aggregationBonus;
}

export function compareToolSearchCandidatesV2(
  left: Readonly<{ tool: ToolSearchCandidateV2; score: number }>,
  right: Readonly<{ tool: ToolSearchCandidateV2; score: number }>
): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftPath = String(left.tool.path ?? "");
  const rightPath = String(right.tool.path ?? "");
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}
