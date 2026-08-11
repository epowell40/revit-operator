import path from "node:path";
import { benchmarkDataRoot, readJsonFile } from "./files.js";

export const GENERAL_REVIT_CAPABILITY_SCHEMA = "revit-operator.general-revit-capability-acceptance/v1" as const;
export const GENERAL_REVIT_RESULT_TIERS = [
  "not_run", "accepted", "planned", "previewed", "completed", "verified", "refused", "failed"
] as const;

export type GeneralRevitResultTier = (typeof GENERAL_REVIT_RESULT_TIERS)[number];
export type GeneralRevitExpectedEffect = "read" | "preview" | "apply";

export type GeneralRevitCapabilityCase = {
  case_id: string;
  source: "user_basic" | "user_extended" | "redline_corpus";
  operation_family: string;
  prompt: string;
  probe_prompt: string;
  capability_paths: string[];
  dispatch_any_of: string[];
  expected_effect: GeneralRevitExpectedEffect;
  epic0441_task_refs: string[];
};

export type GeneralRevitCapabilityCorpus = {
  schema_version: typeof GENERAL_REVIT_CAPABILITY_SCHEMA;
  suite_id: string;
  purpose: string;
  truth_policy: {
    tiers: GeneralRevitResultTier[];
    non_refusal_is_not_completion: true;
    assistant_self_report_is_not_verification: true;
    live_completion_requires_successful_dispatch: true;
    live_verification_requires_readback_or_artifact_evidence: true;
    clarification_for_missing_target_is_accepted: true;
    capability_subset_refusal_is_failure: true;
  };
  required_operation_families: string[];
  cases: GeneralRevitCapabilityCase[];
};

type ActionLike = {
  path?: unknown;
  request_effect?: unknown;
  request_dispatched?: unknown;
  status?: unknown;
};

export type GeneralRevitAttempt = {
  ok?: unknown;
  assistant_message?: unknown;
  error?: unknown;
  effect_state?: unknown;
  outcome_unknown?: unknown;
  reconciliation_required?: unknown;
  actions?: unknown;
  rounds?: unknown;
  [key: string]: unknown;
};

export type GeneralRevitEvaluation = {
  case_id: string;
  tier: GeneralRevitResultTier;
  non_refusal: boolean;
  completed: boolean;
  verified: boolean;
  expected_path_observed: boolean;
  observed_paths: string[];
  dispatched: boolean;
  apply_dispatched: boolean;
  outcome_unknown: boolean;
  refusal_reason: string | null;
  summary: string;
};

export type GeneralRevitSummary = {
  total: number;
  by_tier: Record<GeneralRevitResultTier, number>;
  non_refusal_count: number;
  completed_count: number;
  verified_count: number;
  refusal_count: number;
  failure_count: number;
  non_refusal_rate: number;
  completion_rate: number;
  verification_rate: number;
};

const CAPABILITY_REFUSAL_PATTERNS: RegExp[] = [
  /\b(?:i\s+)?(?:can(?:not|'t)|am unable to|do not|don't)\s+(?:provide|perform|execute|make|change|edit|create|duplicate|print|access|query|inspect|use)\b/i,
  /\b(?:only|merely)\s+(?:exposes?|supports?|allows?)\s+(?:document|view|context|read[- ]only)/i,
  /\b(?:tools?|capabilit(?:y|ies)|write access|project[- ]wide quer(?:y|ies))\s+(?:is|are)\s+not (?:available|exposed|supported|enabled)/i,
  /\bnot available in (?:this|the) (?:profile|mode|runtime)\b/i,
  /\bcertified(?:[- ]only)? (?:profile|mode|runtime)\b/i,
  /\bno (?:tool|capability|access|permission)s? to\b/i,
  /\bread[- ]only profile\b/i
];

const MISSING_TARGET_PATTERNS: RegExp[] = [
  /\b(?:which|what) (?:element|equipment|sheet|view|schedule|family|type|printer)\b/i,
  /\bselect (?:an?|the)\b/i,
  /\bneed (?:an?|the|a little more) (?:exact )?(?:target|name|selection|sheet|view|schedule|family|printer|information|detail)/i,
  /\bplease (?:identify|select|name|specify|choose|confirm)\b/i,
  /\b(?:no|nothing is) selected\b/i,
  /\bmultiple matches\b/i
];

const STRUCTURED_EVIDENCE_KEYS = new Set([
  "artifact", "artifacts", "artifact_id", "artifact_ids", "artifact_path", "artifact_paths",
  "receipt", "receipts", "receipt_id", "receipt_ids", "result_hash", "readback", "read_back",
  "verification_result", "verification_results", "affected_element_ids"
]);

export function loadGeneralRevitCapabilityCorpus(): GeneralRevitCapabilityCorpus {
  const corpus = readJsonFile<GeneralRevitCapabilityCorpus>(
    path.join(benchmarkDataRoot(), "general-agent", "revit-capability-acceptance.v1.json")
  );
  validateGeneralRevitCapabilityCorpus(corpus);
  return corpus;
}

export function validateGeneralRevitCapabilityCorpus(corpus: GeneralRevitCapabilityCorpus): void {
  if (corpus.schema_version !== GENERAL_REVIT_CAPABILITY_SCHEMA) throw new Error("Unexpected General Revit capability corpus schema.");
  if (!corpus.suite_id.trim() || corpus.purpose.trim().length < 40) throw new Error("General Revit corpus identity is underspecified.");
  if (JSON.stringify(corpus.truth_policy.tiers) !== JSON.stringify(GENERAL_REVIT_RESULT_TIERS)) {
    throw new Error("General Revit result tiers changed without a schema revision.");
  }
  for (const [key, value] of Object.entries(corpus.truth_policy)) {
    if (key !== "tiers" && value !== true) throw new Error(`Truth policy ${key} must remain enabled.`);
  }
  if (corpus.cases.length < 20) throw new Error("General Revit corpus must cover at least twenty representative tasks.");
  const ids = new Set<string>();
  const families = new Set<string>();
  for (const testCase of corpus.cases) {
    if (!/^[a-z][a-z0-9_]{4,79}$/.test(testCase.case_id)) throw new Error(`Invalid case id ${testCase.case_id}.`);
    if (ids.has(testCase.case_id)) throw new Error(`Duplicate case id ${testCase.case_id}.`);
    ids.add(testCase.case_id);
    families.add(testCase.operation_family);
    if (testCase.prompt.trim().length < 30 || testCase.probe_prompt.trim().length < 40) throw new Error(`Case ${testCase.case_id} is underspecified.`);
    if (!/\b(?:do not|don't)\b/i.test(testCase.probe_prompt)) throw new Error(`Probe ${testCase.case_id} must explicitly remain non-mutating.`);
    if (testCase.capability_paths.length === 0 || testCase.dispatch_any_of.length === 0) throw new Error(`Case ${testCase.case_id} has no concrete execution lane.`);
    for (const candidate of [...testCase.capability_paths, ...testCase.dispatch_any_of]) {
      if (!/^\/revit\/[a-z0-9-]+$/.test(candidate)) throw new Error(`Case ${testCase.case_id} has invalid Revit path ${candidate}.`);
    }
  }
  for (const required of corpus.required_operation_families) {
    if (!families.has(required)) throw new Error(`Missing required operation family ${required}.`);
  }
}

function actionRows(attempt: GeneralRevitAttempt): ActionLike[] {
  const rows: ActionLike[] = [];
  if (Array.isArray(attempt.actions)) rows.push(...attempt.actions.filter((row): row is ActionLike => !!row && typeof row === "object"));
  if (!Array.isArray(attempt.rounds)) return rows;
  for (const round of attempt.rounds) {
    if (!round || typeof round !== "object") continue;
    const actions = (round as { actions?: unknown }).actions;
    if (Array.isArray(actions)) rows.push(...actions.filter((row): row is ActionLike => !!row && typeof row === "object"));
  }
  return rows;
}

function durableAssignments(attempt: GeneralRevitAttempt): Record<string, unknown>[] {
  const projection = attempt.assignment_projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return [];
  const assignments = (projection as { assignments?: unknown }).assignments;
  return Array.isArray(assignments)
    ? assignments.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function durableRevitToolNames(attempt: GeneralRevitAttempt): string[] {
  const names: string[] = [];
  const nonSubstantive = /(?:discover_capabilities|search_tools|record_execution_strategy|ping|get_context|tool_registry|tool_doc|tool_examples|write_grant)/i;
  for (const assignment of durableAssignments(attempt)) {
    const evidence = assignment.evidence && typeof assignment.evidence === "object" && !Array.isArray(assignment.evidence)
      ? (assignment.evidence as { entries?: unknown }).entries : [];
    for (const entry of Array.isArray(evidence) ? evidence : []) {
      const summary = entry && typeof entry === "object" ? String((entry as { summary?: unknown }).summary || "") : "";
      const match = summary.match(/^Live tool ([a-z0-9_:-]+) completed\.?$/i);
      if (match && /(?:^|:)revit_|^revit_/i.test(match[1]) && !nonSubstantive.test(match[1])) names.push(match[1]);
    }
  }
  return [...new Set(names)];
}

function durableLifecycle(attempt: GeneralRevitAttempt): { completed: boolean; blocked: boolean; verified: boolean } {
  let completed = false;
  let blocked = false;
  let verified = false;
  for (const assignment of durableAssignments(attempt)) {
    const lifecycle = assignment.lifecycle && typeof assignment.lifecycle === "object" && !Array.isArray(assignment.lifecycle)
      ? assignment.lifecycle as { phase?: unknown; source_status?: unknown } : {};
    const phase = String(lifecycle.phase || lifecycle.source_status || "").trim().toLowerCase();
    completed ||= ["complete", "completed", "verified"].includes(phase);
    blocked ||= ["blocked", "failed", "outcome_unknown"].includes(phase);
    const verification = assignment.verification && typeof assignment.verification === "object" && !Array.isArray(assignment.verification)
      ? assignment.verification as { state?: unknown; criteria?: unknown } : {};
    const state = String(verification.state || "").trim().toLowerCase();
    const criteria = Array.isArray(verification.criteria) ? verification.criteria : [];
    verified ||= ["pass", "passed", "verified", "complete", "completed"].includes(state)
      || (criteria.length > 0 && criteria.every((criterion) => {
        const status = criterion && typeof criterion === "object" ? String((criterion as { status?: unknown }).status || "").toLowerCase() : "";
        return ["pass", "passed", "verified"].includes(status);
      }));
  }
  return { completed, blocked, verified };
}

function teammateLoopTruth(attempt: GeneralRevitAttempt): { mutationAttempted: boolean; blocked: boolean; verified: boolean } {
  const value = attempt.teammate_loop_receipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mutationAttempted: false, blocked: false, verified: false };
  }
  const receipt = value as { turn_kind?: unknown; stage?: unknown; blocked_reason?: unknown; apply_attempts?: unknown; verified?: unknown };
  const mutationAttempted = receipt.turn_kind === "mutation" && Number(receipt.apply_attempts) > 0;
  const blocked = receipt.stage === "blocked"
    || (typeof receipt.blocked_reason === "string" && receipt.blocked_reason.trim().length > 0)
    || (mutationAttempted && receipt.verified !== true);
  return { mutationAttempted, blocked, verified: mutationAttempted && receipt.verified === true && !blocked };
}

function combinedMessage(attempt: GeneralRevitAttempt): string {
  return [attempt.assistant_message, attempt.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function assistantReportsIncompleteMutation(attempt: GeneralRevitAttempt): boolean {
  if (!teammateLoopTruth(attempt).mutationAttempted) return false;
  const text = combinedMessage(attempt);
  return /\[teammate_loop_blocked\]|\bassignment is blocked\b|\bcannot claim (?:the )?(?:revit )?change is complete\b|\brequest(?:ed)?(?: [^.\n]{0,80})? (?:is|was) not (?:yet )?complete\b|\bnot yet complete\b/i.test(text);
}

export function capabilityRefusalReason(attempt: GeneralRevitAttempt, expectedPathObserved = false): string | null {
  if (expectedPathObserved) return null;
  const text = combinedMessage(attempt);
  if (!text || MISSING_TARGET_PATTERNS.some((pattern) => pattern.test(text))) return null;
  const match = CAPABILITY_REFUSAL_PATTERNS.find((pattern) => pattern.test(text));
  return match ? text.slice(0, 500) : null;
}

function hasStructuredVerificationEvidence(value: unknown, depth = 0): boolean {
  if (!value || depth > 6) return false;
  if (Array.isArray(value)) return value.some((entry) => hasStructuredVerificationEvidence(entry, depth + 1));
  if (typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (STRUCTURED_EVIDENCE_KEYS.has(key) && child !== null && child !== false && child !== "" && (!Array.isArray(child) || child.length > 0)) return true;
    if (hasStructuredVerificationEvidence(child, depth + 1)) return true;
  }
  return false;
}

export function evaluateGeneralRevitCapabilityAttempt(
  testCase: GeneralRevitCapabilityCase,
  attempt: GeneralRevitAttempt | null | undefined
): GeneralRevitEvaluation {
  if (!attempt) {
    return {
      case_id: testCase.case_id, tier: "not_run", non_refusal: false, completed: false, verified: false,
      expected_path_observed: false, observed_paths: [], dispatched: false, apply_dispatched: false,
      outcome_unknown: false, refusal_reason: null, summary: "Case was not run."
    };
  }
  const rows = actionRows(attempt);
  const durableTools = durableRevitToolNames(attempt);
  const observedPaths = [...new Set([
    ...rows.map((row) => String(row.path || "").trim()).filter(Boolean),
    ...durableTools.map((tool) => `mcp:${tool}`)
  ])];
  const expectedPathObserved = observedPaths.some((candidate) => testCase.dispatch_any_of.includes(candidate)) || durableTools.length > 0;
  const teammate = teammateLoopTruth(attempt);
  const applyDispatched = teammate.mutationAttempted || attempt.effect_state === "apply_dispatched"
    || rows.some((row) => row.request_effect === "apply" && row.request_dispatched === true);
  const dispatched = applyDispatched || attempt.effect_state === "read_only_dispatched"
    || rows.some((row) => row.request_dispatched === true) || durableTools.length > 0;
  const outcomeUnknown = attempt.outcome_unknown === true || attempt.reconciliation_required === true;
  const durable = durableLifecycle(attempt);
  const assistantIncomplete = assistantReportsIncompleteMutation(attempt);
  const refusalReason = capabilityRefusalReason(attempt, expectedPathObserved);
  const completed = attempt.ok !== false && expectedPathObserved && !outcomeUnknown && !durable.blocked && !teammate.blocked && !assistantIncomplete
    && (dispatched || durable.completed);
  const verified = completed && (teammate.verified || hasStructuredVerificationEvidence(attempt) || durable.verified);
  let tier: GeneralRevitResultTier;
  if (refusalReason) tier = "refused";
  else if (attempt.ok === false || outcomeUnknown || durable.blocked || teammate.blocked || assistantIncomplete) tier = "failed";
  else if (verified) tier = "verified";
  else if (completed && testCase.expected_effect === "preview") tier = "previewed";
  else if (completed) tier = "completed";
  else if (expectedPathObserved) tier = "planned";
  else tier = "accepted";
  const nonRefusal = tier !== "refused";
  return {
    case_id: testCase.case_id,
    tier,
    non_refusal: nonRefusal,
    completed,
    verified,
    expected_path_observed: expectedPathObserved,
    observed_paths: observedPaths,
    dispatched,
    apply_dispatched: applyDispatched,
    outcome_unknown: outcomeUnknown,
    refusal_reason: refusalReason,
    summary: tier === "refused" ? "Agent refused an in-scope Revit capability."
      : tier === "failed" ? "Attempt failed or has an uncertain outcome."
        : tier === "verified" ? "Expected Revit lane completed with structured verification evidence."
          : tier === "previewed" ? "Expected non-mutating Revit preview lane completed."
            : tier === "completed" ? "Expected Revit lane completed; independent verification was not present."
              : tier === "planned" ? "Agent selected a concrete Revit lane but did not dispatch it."
                : "Agent did not refuse, but no expected Revit lane completed."
  };
}

export function summarizeGeneralRevitCapabilityReport(results: readonly GeneralRevitEvaluation[]): GeneralRevitSummary {
  const byTier = Object.fromEntries(GENERAL_REVIT_RESULT_TIERS.map((tier) => [tier, 0])) as Record<GeneralRevitResultTier, number>;
  for (const result of results) byTier[result.tier] += 1;
  const total = results.length;
  const nonRefusalCount = results.filter((result) => result.non_refusal).length;
  const completedCount = results.filter((result) => result.completed).length;
  const verifiedCount = results.filter((result) => result.verified).length;
  return {
    total,
    by_tier: byTier,
    non_refusal_count: nonRefusalCount,
    completed_count: completedCount,
    verified_count: verifiedCount,
    refusal_count: byTier.refused,
    failure_count: byTier.failed,
    non_refusal_rate: total === 0 ? 0 : nonRefusalCount / total,
    completion_rate: total === 0 ? 0 : completedCount / total,
    verification_rate: total === 0 ? 0 : verifiedCount / total
  };
}
