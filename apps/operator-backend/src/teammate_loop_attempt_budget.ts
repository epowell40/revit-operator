export type TeammateLoopAttemptBudget = {
  total: number;
  discovery: number;
  by_signature: Map<string, number>;
  successful_discovery: Set<string>;
};

const MAX_TOTAL_REVIT_CALL_ATTEMPTS = 64;
const MAX_DISCOVERY_CALL_ATTEMPTS = 16;
const MAX_FAILED_DISCOVERY_ATTEMPTS_PER_SIGNATURE = 2;

const DISCOVERY_PATHS = new Set([
  "/revit/ping", "/revit/context", "/revit/write-grant-status", "/revit/tool-registry", "/revit/tool-search",
  "/revit/search-tools", "/revit/tool-doc", "/revit/tool-examples", "/revit/native-api-search", "/revit/native-api-catalog"
]);
const DISCOVERY_TOOLS = new Set([
  "operator_discover_capabilities", "operator_plan_semantic_mep_route", "operator_record_execution_strategy",
  "revit_ping", "revit_get_context", "revit_write_grant_status", "revit_search_tools", "revit_tool_registry",
  "revit_tool_doc", "revit_tool_examples"
]);

export function newTeammateLoopAttemptBudget(): TeammateLoopAttemptBudget {
  return { total: 0, discovery: 0, by_signature: new Map(), successful_discovery: new Set() };
}

export function isTeammateDiscoveryPath(path: string): boolean { return DISCOVERY_PATHS.has(path); }
export function isTeammateDiscoveryTool(tool: string): boolean { return DISCOVERY_TOOLS.has(tool); }

export function gateTeammateLoopAttempt(budget: TeammateLoopAttemptBudget, effect: string, signature: string): string | null {
  if (budget.total >= MAX_TOTAL_REVIT_CALL_ATTEMPTS) return "total_revit_call_attempt_budget_exhausted";
  if (effect !== "discovery") return null;
  if (budget.successful_discovery.has(signature)) return "successful_discovery_already_available";
  if (budget.discovery >= MAX_DISCOVERY_CALL_ATTEMPTS) return "discovery_call_attempt_budget_exhausted";
  if ((budget.by_signature.get(signature) ?? 0) >= MAX_FAILED_DISCOVERY_ATTEMPTS_PER_SIGNATURE) return "discovery_retry_budget_exhausted";
  return null;
}

export function registerTeammateLoopAttempt(budget: TeammateLoopAttemptBudget, effect: string, signature: string): void {
  budget.total += 1;
  budget.by_signature.set(signature, (budget.by_signature.get(signature) ?? 0) + 1);
  if (effect === "discovery") budget.discovery += 1;
}

export function recordSuccessfulTeammateDiscovery(budget: TeammateLoopAttemptBudget, signature: string): void {
  budget.successful_discovery.add(signature);
}
