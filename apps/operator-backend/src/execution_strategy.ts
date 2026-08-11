export const EXECUTION_STRATEGY_EVIDENCE_V1 = "revit-operator.execution-strategy-evidence.v1" as const;

export const EXECUTION_SUBSTRATES = [
  "typed_capability",
  "typed_capability_composition",
  "dynamic_revit_program"
] as const;

export type ExecutionSubstrate = typeof EXECUTION_SUBSTRATES[number];

export type ExecutionStrategyEvidence = {
  schema: typeof EXECUTION_STRATEGY_EVIDENCE_V1;
  selected_substrate: ExecutionSubstrate;
  reason: string;
};

export type RecordedExecutionStrategyEvidence = ExecutionStrategyEvidence & {
  recorded_at_utc: string;
  authority: "telemetry_only";
  authorization_granted: false;
};

/**
 * Provider-neutral strategy contract. The model chooses a representation;
 * deterministic admission and authorization remain separate host decisions.
 */
export const GENERAL_AGENT_EXECUTION_STRATEGY_LINES = [
  "Execution representation (model choice; never authorization):",
  "- Choose one representation for executable Revit work: one certified typed capability, a composition of a few certified typed capabilities, or a bounded task-specific Dynamic Revit program.",
  "- Prefer one typed capability when an exact primitive already expresses a simple predictable operation. Prefer a few-tool composition when a small deterministic sequence remains clearer and cheaper than code.",
  "- Prefer a Dynamic Revit program when custom loops or branching, many similar operations, geometry/graph algorithms, novel work, or company/project/user-specific rules make code the more natural representation.",
  "- Do not route by prompt keywords or regexes. Reason from the task, live evidence, available substrates, expected effects, and verification needs; either representation may be correct.",
  "- Record the selected_substrate and one concise reason using revit-operator.execution-strategy-evidence.v1 before execution. That evidence is bounded telemetry only: it grants no capability, admission, approval, or authorization.",
  "- Dynamic program discovery is an affordance, not permission. Generate/compile/preview/apply only through a currently available dynamic admission path; otherwise remain fail-closed and use an admitted alternative or report the exact gate."
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeExecutionStrategyEvidence(value: unknown): ExecutionStrategyEvidence | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("execution_strategy must be an object or null");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["reason", "schema", "selected_substrate"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("execution_strategy contains unexpected or missing fields");
  }
  if (value.schema !== EXECUTION_STRATEGY_EVIDENCE_V1) {
    throw new Error(`execution_strategy.schema must be ${EXECUTION_STRATEGY_EVIDENCE_V1}`);
  }
  if (typeof value.selected_substrate !== "string" || !(EXECUTION_SUBSTRATES as readonly string[]).includes(value.selected_substrate)) {
    throw new Error("execution_strategy.selected_substrate is invalid");
  }
  if (typeof value.reason !== "string") throw new Error("execution_strategy.reason must be a string");
  const reason = value.reason.trim();
  if (reason.length < 1 || reason.length > 320) {
    throw new Error("execution_strategy.reason must contain 1-320 characters");
  }
  return {
    schema: EXECUTION_STRATEGY_EVIDENCE_V1,
    selected_substrate: value.selected_substrate as ExecutionSubstrate,
    reason
  };
}

export function recordExecutionStrategyEvidence(
  value: unknown,
  record: (evidence: RecordedExecutionStrategyEvidence) => void,
  now: () => Date = () => new Date()
): RecordedExecutionStrategyEvidence | null {
  const normalized = normalizeExecutionStrategyEvidence(value);
  if (!normalized) return null;
  const evidence: RecordedExecutionStrategyEvidence = {
    ...normalized,
    recorded_at_utc: now().toISOString(),
    authority: "telemetry_only",
    authorization_granted: false
  };
  record(evidence);
  return evidence;
}
