export type ToolSearchCandidateV3 = Readonly<{
  method?: unknown;
  path?: unknown;
  risk?: unknown;
  group?: unknown;
  title?: unknown;
  description?: unknown;
  example?: unknown;
  required_fields?: readonly unknown[];
  optional_fields?: readonly unknown[];
}>;

export const TOOL_SEARCH_RANKING_VERSION_V3 = "operator.tool_search_ranking.v3" as const;

export function isToolSearchRankingVersionV3(value: unknown): boolean {
  return String(value ?? "").trim() === TOOL_SEARCH_RANKING_VERSION_V3;
}

const SEMANTIC_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  inventory: "quantify",
  inventories: "quantify",
  quantification: "quantify",
  count: "quantify",
  counted: "quantify",
  counting: "quantify",
  counts: "quantify",
  grouped: "group",
  grouping: "group",
  groups: "group",
  listed: "list",
  listing: "list",
  categories: "category",
  elements: "element",
  families: "family",
  terminals: "terminal",
  types: "type",
  notes: "note",
  tags: "tag",
  ducts: "duct",
  pipes: "pipe",
  views: "view",
  sheets: "sheet",
  schedules: "schedule",
  parameters: "parameter",
  ids: "id",
  connections: "connection",
  updates: "update",
  updated: "update",
  updating: "update",
  edit: "update",
  edits: "update",
  edited: "update",
  editing: "update",
  replace: "update",
  replaces: "update",
  replaced: "update",
  replacing: "update",
  change: "update",
  changes: "update",
  changed: "update",
  changing: "update",
  duplication: "duplicate",
  duplicates: "duplicate",
  duplicated: "duplicate",
  deleting: "delete",
  deleted: "delete",
  removes: "delete",
  removed: "delete",
  removing: "delete",
  screenshots: "capture",
  screenshot: "capture"
});

const STOP_TOKENS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "into", "is", "it", "of", "on", "or", "please", "that", "the", "this",
  "to", "with", "without", "existing", "current", "revit"
]);

// Only task verbs belong here. Control flags such as apply, preview, dry, and
// run describe execution mode and must never outweigh the requested domain
// action.
const TASK_ACTION_TOKENS = new Set([
  "capture", "close", "copy", "create", "delete", "export", "find", "import",
  "inspect", "list", "load", "move", "open", "print", "purge", "quantify",
  "rename", "repair", "resize", "resolve", "save", "set", "sync", "tag",
  "update", "verify"
]);

function normalizeToken(value: string): string {
  const token = value.normalize("NFKC").toLowerCase();
  return SEMANTIC_TOKENS[token] ?? token;
}

function tokenSequence(value: unknown): readonly string[] {
  const separated = String(value ?? "")
    .normalize("NFKC")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .toLowerCase();
  return separated
    .split(/[^\p{L}\p{N}]+/gu)
    .map(normalizeToken)
    .filter(token => token.length >= 2 && !STOP_TOKENS.has(token));
}

export function toolSearchTokensV3(value: unknown): readonly string[] {
  return [...new Set(tokenSequence(value))];
}

function longestContiguousMatch(left: readonly string[], right: readonly string[]): number {
  let longest = 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1] + 1;
        if (current[rightIndex] > longest) longest = current[rightIndex];
      }
    }
    previous = current;
  }
  return longest;
}

function bestFieldWeight(token: string, fields: readonly Readonly<{ tokens: ReadonlySet<string>; weight: number }>[]): number {
  let best = 0;
  for (const field of fields) {
    if (field.weight > best && field.tokens.has(token)) best = field.weight;
  }
  return best;
}

export function scoreToolSearchCandidateV3(candidate: ToolSearchCandidateV3, queryValue: unknown): number {
  const querySequence = tokenSequence(queryValue);
  const queryTokens = [...new Set(querySequence)];
  if (queryTokens.length === 0) return 0;

  const pathSequence = tokenSequence(candidate.path);
  const titleSequence = tokenSequence(candidate.title);
  const pathTokens = new Set(pathSequence);
  const titleTokens = new Set(titleSequence);
  const fields: readonly Readonly<{ tokens: ReadonlySet<string>; weight: number }>[] = [
    { tokens: pathTokens, weight: 72 },
    { tokens: titleTokens, weight: 64 },
    { tokens: new Set(tokenSequence(candidate.group)), weight: 24 },
    { tokens: new Set(tokenSequence(candidate.description)), weight: 14 },
    { tokens: new Set(tokenSequence(candidate.example)), weight: 12 },
    { tokens: new Set(tokenSequence(candidate.method)), weight: 4 }
  ];

  let score = 0;
  let pathTitleCoverage = 0;
  for (const token of queryTokens) {
    score += bestFieldWeight(token, fields);
    if (pathTokens.has(token) || titleTokens.has(token)) {
      pathTitleCoverage += 1;
      if (TASK_ACTION_TOKENS.has(token)) score += 260;
    }
  }
  score += pathTitleCoverage * pathTitleCoverage * 24;

  const orderedMatch = Math.max(
    longestContiguousMatch(querySequence, pathSequence.filter(token => token !== "revit")),
    longestContiguousMatch(querySequence, titleSequence)
  );
  if (orderedMatch >= 2) score += orderedMatch * orderedMatch * 48;
  return score;
}

export function compareToolSearchCandidatesV3(
  left: Readonly<{ tool: ToolSearchCandidateV3; score: number }>,
  right: Readonly<{ tool: ToolSearchCandidateV3; score: number }>
): number {
  if (left.score !== right.score) return right.score - left.score;
  const riskRank = (value: unknown): number => {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "low") return 0;
    if (normalized === "medium") return 1;
    if (normalized === "high") return 2;
    return 3;
  };
  const leftRisk = riskRank(left.tool.risk);
  const rightRisk = riskRank(right.tool.risk);
  if (leftRisk !== rightRisk) return leftRisk - rightRisk;
  const leftPath = String(left.tool.path ?? "");
  const rightPath = String(right.tool.path ?? "");
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}
