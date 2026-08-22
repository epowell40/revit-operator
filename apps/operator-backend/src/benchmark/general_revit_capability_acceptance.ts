import path from "node:path";
import { benchmarkDataRoot, readJsonFile } from "./files.js";
import { benchmarkSemanticCapabilityId, canonicalBenchmarkRevitPath } from "./durable_tool_evidence.js";

export const GENERAL_REVIT_CAPABILITY_SCHEMA = "revit-operator.general-revit-capability-acceptance/v1" as const;
export const GENERAL_REVIT_RESULT_TIERS = [
  "not_run", "accepted", "planned", "previewed", "completed", "verified", "refused", "failed"
] as const;

export type GeneralRevitResultTier = (typeof GENERAL_REVIT_RESULT_TIERS)[number];
export type GeneralRevitExpectedEffect = "read" | "preview" | "apply";
export type GeneralRevitVerificationBasis =
  | "none"
  | "fixture_semantic_oracle"
  | "target_bound_model_state"
  | "rollback_verified_preview"
  | "model_state_readback"
  | "artifact_evidence"
  | "structured_preview_receipt"
  | "durable_server_validation"
  | "generic_structured_receipt";

export type GeneralRevitCapabilityCase = {
  case_id: string;
  source: "user_basic" | "user_extended" | "redline_corpus" | "long_horizon" | "document_production" | "code_execution";
  operation_family: string;
  prompt: string;
  probe_prompt: string;
  capability_paths: string[];
  dispatch_any_of: string[];
  expected_effect: GeneralRevitExpectedEffect;
  production_expected_effect?: GeneralRevitExpectedEffect;
  probe_expected_effect?: Exclude<GeneralRevitExpectedEffect, "apply">;
  allow_verified_noop?: boolean;
  require_target_bound_preview_verification?: boolean;
  epic0441_task_refs: string[];
  prompt_specificity?: "terse" | "ordinary" | "detailed" | "ambiguous_actionable" | "research_required";
  corpus_task_type?: string;
  grounding_demand?: "low" | "medium" | "high";
  research_demand?: "none" | "optional" | "required";
  answer_assertions?: {
    must_match: string[];
    must_not_match?: string[];
    evidence?: {
      required_successful_paths?: string[];
      required_successful_tools?: string[];
      required_semantic_capability_ids?: string[];
      required_semantic_facts?: Array<{
        capability_id: string;
        key: string;
        equals: string | number | boolean;
      }>;
    };
  };
  fixture_blocker_assertions?: {
    must_match: string[];
    must_not_match?: string[];
    evidence?: {
      required_successful_paths?: string[];
      required_semantic_capability_ids?: string[];
      minimum_unique_connector_element_ids?: number;
      maximum_failed_connector_rows?: number;
      required_open_hvac_connector_count?: number;
      maximum_open_physical_connector_owner_count?: number;
      require_compact_connector_filter?: boolean;
      require_untruncated_connector_scan?: boolean;
    };
  };
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
  corpus_evidence: {
    taxonomy_path: string;
    actionable_comment_total: number;
    top_task_type_comment_total: number;
    task_types: Array<{
      rank: number;
      task_type_id: string;
      corpus_count: number;
      coverage_kind: "direct" | "proxy" | "gap";
      case_ids: string[];
    }>;
  };
  required_operation_families: string[];
  cases: GeneralRevitCapabilityCase[];
};

export type GeneralRevitCorpusCoverage = {
  taxonomy_path: string;
  actionable_comment_total: number;
  top_task_type_comment_total: number;
  mapped_comment_total: number;
  directly_covered_comment_total: number;
  mapped_top_task_type_rate: number;
  direct_top_task_type_rate: number;
  mapped_actionable_comment_rate: number;
  direct_actionable_comment_rate: number;
  covered_task_type_count: number;
  top_task_type_count: number;
  case_count: number;
  prompt_specificity: Record<string, number>;
  task_types: GeneralRevitCapabilityCorpus["corpus_evidence"]["task_types"];
};

type ActionLike = {
  path?: unknown;
  request_effect?: unknown;
  request_dispatched?: unknown;
  status?: unknown;
  receipt?: unknown;
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
  answer_assertion_available: boolean;
  answer_assertion_passed: boolean | null;
  answer_assertion_failures: string[];
  fixture_blocker_assertion_available: boolean;
  fixture_blocker_assertion_passed: boolean | null;
  fixture_blocker_assertion_failures: string[];
  fixture_blocker_accepted: boolean;
  verification_basis: GeneralRevitVerificationBasis;
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

export function generalRevitExecutionCase(
  testCase: GeneralRevitCapabilityCase,
  applyRequested: boolean
): GeneralRevitCapabilityCase {
  if (applyRequested) {
    if (testCase.production_expected_effect) {
      return testCase.production_expected_effect === testCase.expected_effect
        ? testCase
        : { ...testCase, expected_effect: testCase.production_expected_effect };
    }
    // The corpus historically stored preview as the safe-probe expectation for
    // many mutation prompts. An explicitly authorized apply run must grade the
    // production prompt as an apply unless the task is intrinsically read-only.
    return testCase.expected_effect === "read" || testCase.expected_effect === "apply"
      ? testCase
      : { ...testCase, expected_effect: "apply" };
  }
  if (testCase.expected_effect === "read") return testCase;
  return { ...testCase, expected_effect: testCase.probe_expected_effect ?? "preview" };
}

export function generalRevitPromptSpecificity(testCase: GeneralRevitCapabilityCase): string {
  if (testCase.prompt_specificity) return testCase.prompt_specificity;
  if (testCase.operation_family === "research_and_compliance") return "research_required";
  const words = testCase.prompt.trim().split(/\s+/).length;
  if (words <= 16) return "terse";
  if (words <= 32) return "ordinary";
  return "detailed";
}

export function generalRevitGroundingDemand(testCase: GeneralRevitCapabilityCase): "low" | "medium" | "high" {
  if (testCase.grounding_demand) return testCase.grounding_demand;
  if (["project_query", "native_fallback"].includes(testCase.operation_family)) return "low";
  if (["tag", "text_edit", "add", "delete", "move", "rotate", "type_change", "size_transition", "route", "reroute_offset", "family_edit", "visual_verification"].includes(testCase.operation_family)) return "high";
  return "medium";
}

export function generalRevitResearchDemand(testCase: GeneralRevitCapabilityCase): "none" | "optional" | "required" {
  if (testCase.research_demand) return testCase.research_demand;
  if (testCase.operation_family === "research_and_compliance") return "required";
  if (["native_fallback", "family_edit", "print_export"].includes(testCase.operation_family)) return "optional";
  return "none";
}

export function summarizeGeneralRevitCorpusCoverage(corpus: GeneralRevitCapabilityCorpus): GeneralRevitCorpusCoverage {
  const mapped = corpus.corpus_evidence.task_types.filter((entry) => entry.coverage_kind !== "gap" && entry.case_ids.length > 0);
  const direct = mapped.filter((entry) => entry.coverage_kind === "direct");
  const specificity: Record<string, number> = {};
  for (const entry of corpus.cases) {
    const bucket = generalRevitPromptSpecificity(entry);
    specificity[bucket] = (specificity[bucket] || 0) + 1;
  }
  const mappedCommentTotal = mapped.reduce((sum, entry) => sum + entry.corpus_count, 0);
  const directCommentTotal = direct.reduce((sum, entry) => sum + entry.corpus_count, 0);
  return {
    taxonomy_path: corpus.corpus_evidence.taxonomy_path,
    actionable_comment_total: corpus.corpus_evidence.actionable_comment_total,
    top_task_type_comment_total: corpus.corpus_evidence.top_task_type_comment_total,
    mapped_comment_total: mappedCommentTotal,
    directly_covered_comment_total: directCommentTotal,
    mapped_top_task_type_rate: mappedCommentTotal / corpus.corpus_evidence.top_task_type_comment_total,
    direct_top_task_type_rate: directCommentTotal / corpus.corpus_evidence.top_task_type_comment_total,
    mapped_actionable_comment_rate: mappedCommentTotal / corpus.corpus_evidence.actionable_comment_total,
    direct_actionable_comment_rate: directCommentTotal / corpus.corpus_evidence.actionable_comment_total,
    covered_task_type_count: mapped.length,
    top_task_type_count: corpus.corpus_evidence.task_types.length,
    case_count: corpus.cases.length,
    prompt_specificity: Object.fromEntries(Object.entries(specificity).sort(([left], [right]) => left.localeCompare(right))),
    task_types: corpus.corpus_evidence.task_types
  };
}

const CAPABILITY_REFUSAL_PATTERNS: RegExp[] = [
  /\b(?:i\s+)?(?:can(?:not|'t)|am unable to|do not|don't)\s+(?:provide|produce|perform|execute|make|change|edit|create|duplicate|print|access|query|inspect|use)\b/i,
  /\b(?:only|merely)\s+(?:exposes?|supports?|allows?)\s+(?:document|view|context|read[- ]only)/i,
  /\b(?:tools?|capabilit(?:y|ies)|write access|project[- ]wide quer(?:y|ies))\s+(?:is|are)\s+not (?:available|exposed|supported|enabled)/i,
  /\bnot available in (?:this|the) (?:profile|mode|runtime)\b/i,
  /\bnot exposed in (?:this|the) (?:profile|mode|runtime)\b/i,
  /\bcertified(?:[- ]only)? (?:profile|mode|runtime)\b/i,
  /\bcertified read[- ]only (?:surface|profile|mode|runtime)\b/i,
  /\b(?:surface|profile|mode|runtime) (?:does not|doesn't) expose\b/i,
  /\bno (?:tool|capability|access|permission)s? to\b/i,
  /\bread[- ]only profile\b/i
];

const MISSING_TARGET_PATTERNS: RegExp[] = [
  /\b(?:which|what) (?:element|equipment|sheet|view|schedule|family|type|printer)\b/i,
  /\bselect (?:an?|the)\b/i,
  /\bneed (?:an?|the|a little more) (?:exact )?(?:target|name|selection|sheet|view|schedule|family|printer|information|detail)/i,
  /\bplease (?:identify|select|name|specify|choose|confirm)\b/i,
  /\b(?:no|nothing is) selected\b/i,
  /\bmultiple matches\b/i,
  /\b(?:(?:requested|intended|exact|the) )?target (?:is|remains|appears) ambiguous\b/i,
  /\b(?:active|current) sheet (?:is|appears to be|may be|is likely) (?:the )?wrong\b/i,
  /\blikely (?:the )?wrong sheet is active\b/i,
  /\btarget [^.\n]{0,40}selection (?:is|are) (?:needed|required) to continue\b/i
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
  if (corpus.cases.length !== 100) throw new Error("General Revit corpus must contain exactly one hundred representative tasks.");
  const ids = new Set<string>();
  const families = new Set<string>();
  for (const testCase of corpus.cases) {
    if (!/^[a-z][a-z0-9_]{4,79}$/.test(testCase.case_id)) throw new Error(`Invalid case id ${testCase.case_id}.`);
    if (ids.has(testCase.case_id)) throw new Error(`Duplicate case id ${testCase.case_id}.`);
    ids.add(testCase.case_id);
    families.add(testCase.operation_family);
    if (testCase.prompt.trim().length < 12 || testCase.probe_prompt.trim().length < 30) throw new Error(`Case ${testCase.case_id} has no meaningful user or probe prompt.`);
    if (testCase.probe_expected_effect && !["read", "preview"].includes(testCase.probe_expected_effect)) throw new Error(`Case ${testCase.case_id} has an invalid safe-probe effect.`);
    if (testCase.allow_verified_noop && (testCase.expected_effect !== "apply" || !testCase.answer_assertions)) {
      throw new Error(`Case ${testCase.case_id} may allow a verified no-op only for an apply case with fixture answer assertions.`);
    }
    if (testCase.require_target_bound_preview_verification && testCase.probe_expected_effect !== "preview") {
      throw new Error(`Case ${testCase.case_id} may require target-bound preview verification only for a preview probe.`);
    }
    if (!/\b(?:do not|don't)\b/i.test(testCase.probe_prompt)) throw new Error(`Probe ${testCase.case_id} must explicitly remain non-mutating.`);
    if (testCase.capability_paths.length === 0 || testCase.dispatch_any_of.length === 0) throw new Error(`Case ${testCase.case_id} has no concrete execution lane.`);
    for (const candidate of [...testCase.capability_paths, ...testCase.dispatch_any_of]) {
      if (!/^\/revit\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(candidate)) throw new Error(`Case ${testCase.case_id} has invalid Revit path ${candidate}.`);
    }
    if (testCase.fixture_blocker_assertions && (testCase.expected_effect !== "apply" || !testCase.answer_assertions)) {
      throw new Error(`Case ${testCase.case_id} may accept a fixture blocker only for an apply case with a separate completion oracle.`);
    }
    for (const [label, assertions] of [
      ["answer", testCase.answer_assertions],
      ["fixture blocker", testCase.fixture_blocker_assertions]
    ] as const) {
      if (!assertions) continue;
      if (!Array.isArray(assertions.must_match) || assertions.must_match.length === 0) {
        throw new Error(`Case ${testCase.case_id} ${label} assertions require at least one must_match pattern.`);
      }
      for (const pattern of [...assertions.must_match, ...(assertions.must_not_match || [])]) {
        try { new RegExp(pattern, "i"); } catch { throw new Error(`Case ${testCase.case_id} has an invalid ${label} assertion regex.`); }
      }
      for (const capabilityId of assertions.evidence?.required_semantic_capability_ids || []) {
        if (!/^revit\.[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(capabilityId)) throw new Error(`Case ${testCase.case_id} has an invalid semantic capability id.`);
      }
      if (label === "answer") {
        for (const fact of assertions.evidence?.required_semantic_facts || []) {
          if (!/^revit\.[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(fact.capability_id) || !/^[A-Za-z][A-Za-z0-9]*$/.test(fact.key)) {
            throw new Error(`Case ${testCase.case_id} has an invalid semantic fact requirement.`);
          }
        }
      }
    }
  }
  for (const required of corpus.required_operation_families) {
    if (!families.has(required)) throw new Error(`Missing required operation family ${required}.`);
  }
  const evidence = corpus.corpus_evidence;
  if (!evidence || evidence.actionable_comment_total <= 0 || evidence.top_task_type_comment_total <= 0) {
    throw new Error("General Revit corpus evidence is missing aggregate redline counts.");
  }
  const evidenceCount = evidence.task_types.reduce((sum, entry) => sum + entry.corpus_count, 0);
  if (evidenceCount !== evidence.top_task_type_comment_total) throw new Error("General Revit top task-type evidence total is inconsistent.");
  if (evidence.task_types.length !== 15) throw new Error("General Revit corpus evidence must retain the frozen top fifteen task types.");
  for (const entry of evidence.task_types) {
    if (!entry.task_type_id || entry.corpus_count <= 0) throw new Error("General Revit corpus evidence has an invalid task type.");
    if (entry.coverage_kind === "gap" && entry.case_ids.length > 0) throw new Error(`${entry.task_type_id}: a gap cannot claim mapped cases.`);
    if (entry.coverage_kind !== "gap" && entry.case_ids.length === 0) throw new Error(`${entry.task_type_id}: mapped coverage has no cases.`);
    for (const caseId of entry.case_ids) {
      if (!ids.has(caseId)) throw new Error(`${entry.task_type_id}: unknown mapped case ${caseId}.`);
    }
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

function durableSpecificRevitPaths(attempt: GeneralRevitAttempt): string[] {
  const paths = new Set<string>();
  const nonSubstantive = /(?:call_tool|discover_capabilities|search_tools|record_execution_strategy|ping|get_context|tool_registry|tool_doc|tool_examples|write_grant)/i;
  for (const assignment of durableAssignments(attempt)) {
    const evidence = assignment.evidence && typeof assignment.evidence === "object" && !Array.isArray(assignment.evidence)
      ? (assignment.evidence as { entries?: unknown }).entries : [];
    for (const entry of Array.isArray(evidence) ? evidence : []) {
      const summary = entry && typeof entry === "object" ? String((entry as { summary?: unknown }).summary || "") : "";
      const match = summary.match(/^Live tool (?:[a-z0-9_-]+:)?(revit_[a-z0-9_]+) completed\.?$/i);
      if (!match || nonSubstantive.test(match[1])) continue;
      const path = canonicalBenchmarkRevitPath(`/revit/${match[1].slice("revit_".length).replaceAll("_", "-")}`);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

type DurableLifecycleEntry = {
  goalId: string;
  completed: boolean;
  blocked: boolean;
  verified: boolean;
  requestedEffect: GeneralRevitExpectedEffect | null;
  completionMode: string;
};

type DurableLifecycle = { completed: boolean; blocked: boolean; verified: boolean; requestedEffects: GeneralRevitExpectedEffect[]; completionModes: string[]; assignments: DurableLifecycleEntry[] };

function durableLifecycle(attempt: GeneralRevitAttempt): DurableLifecycle {
  let completed = false;
  let blocked = false;
  let verified = false;
  const requestedEffects = new Set<GeneralRevitExpectedEffect>();
  const completionModes = new Set<string>();
  const assignments: DurableLifecycleEntry[] = [];
  for (const assignment of durableAssignments(attempt)) {
    const lifecycle = assignment.lifecycle && typeof assignment.lifecycle === "object" && !Array.isArray(assignment.lifecycle)
      ? assignment.lifecycle as { phase?: unknown; source_status?: unknown } : {};
    const phase = String(lifecycle.phase || lifecycle.source_status || "").trim().toLowerCase();
    const assignmentCompleted = ["complete", "completed", "verified"].includes(phase);
    const assignmentBlocked = ["blocked", "failed", "outcome_unknown"].includes(phase);
    completed ||= assignmentCompleted;
    blocked ||= assignmentBlocked;
    const verification = assignment.verification && typeof assignment.verification === "object" && !Array.isArray(assignment.verification)
      ? assignment.verification as { state?: unknown; criteria?: unknown } : {};
    const state = String(verification.state || "").trim().toLowerCase();
    const criteria = Array.isArray(verification.criteria) ? verification.criteria : [];
    const assignmentVerified = ["pass", "passed", "verified", "complete", "completed"].includes(state)
      || (criteria.length > 0 && criteria.every((criterion) => {
        const status = criterion && typeof criterion === "object" ? String((criterion as { status?: unknown }).status || "").toLowerCase() : "";
        return ["pass", "passed", "verified"].includes(status);
      }));
    verified ||= assignmentVerified;
    const execution = assignment.execution && typeof assignment.execution === "object" && !Array.isArray(assignment.execution)
      ? assignment.execution as { requested_effect?: unknown; completion_mode?: unknown } : {};
    const requestedEffect = String(execution.requested_effect || "").trim().toLowerCase();
    if (requestedEffect === "read" || requestedEffect === "preview" || requestedEffect === "apply") requestedEffects.add(requestedEffect);
    const completionMode = String(execution.completion_mode || "").trim().toLowerCase();
    if (completionMode) completionModes.add(completionMode);
    assignments.push({
      goalId: String(assignment.source_record_id || "").trim(),
      completed: assignmentCompleted,
      blocked: assignmentBlocked,
      verified: assignmentVerified,
      requestedEffect: requestedEffect === "read" || requestedEffect === "preview" || requestedEffect === "apply" ? requestedEffect : null,
      completionMode
    });
  }
  return { completed, blocked, verified, requestedEffects: [...requestedEffects], completionModes: [...completionModes], assignments };
}

function durableResultSummary(attempt: GeneralRevitAttempt): string {
  const summaries: string[] = [];
  for (const assignment of durableAssignments(attempt)) {
    const plan = assignment.plan && typeof assignment.plan === "object" && !Array.isArray(assignment.plan)
      ? assignment.plan as { steps?: unknown } : {};
    for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const summary = String((step as { result_summary?: unknown }).result_summary || "").trim();
      if (summary) summaries.push(summary);
    }
  }
  return [...new Set(summaries)].join("\n").trim();
}

function teammateLoopTruth(attempt: GeneralRevitAttempt): { mutationAttempted: boolean; blocked: boolean; verified: boolean } {
  const value = attempt.teammate_loop_receipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mutationAttempted: false, blocked: false, verified: false };
  }
  const receipt = value as {
    turn_kind?: unknown; stage?: unknown; blocked_reason?: unknown; apply_attempts?: unknown; verified?: unknown;
    apply_action_id?: unknown; verification_action_ids?: unknown; verification_mode?: unknown;
    verification_action_id?: unknown; verification_evidence_sha256?: unknown;
  };
  const mutationAttempted = receipt.turn_kind === "mutation" && Number(receipt.apply_attempts) > 0;
  const blocked = receipt.stage === "blocked"
    || (typeof receipt.blocked_reason === "string" && receipt.blocked_reason.trim().length > 0)
    || (mutationAttempted && receipt.verified !== true);
  const mode = String(receipt.verification_mode || "");
  const actionId = String(receipt.verification_action_id || "");
  const evidenceHash = String(receipt.verification_evidence_sha256 || "");
  const actionIds = Array.isArray(receipt.verification_action_ids) ? receipt.verification_action_ids.map(String) : [];
  const auditBound = /^sha256:[a-f0-9]{64}$/.test(evidenceHash) && (
    (mode === "explicit_apply_receipt" && actionId !== "" && actionId === String(receipt.apply_action_id || ""))
    || (mode === "target_bound_readback" && actionId !== "" && actionIds.includes(actionId))
    || (mode === "trusted_dynamic_program_receipt" && actionId === "dynamic_program")
  );
  const verifiedRollbackPreview = receipt.turn_kind === "inspection"
    && Number(receipt.apply_attempts) === 0
    && mode === "target_bound_readback"
    && hasCertifiedTeammatePreviewReceipt(attempt);
  return { mutationAttempted, blocked, verified: (mutationAttempted || verifiedRollbackPreview) && receipt.verified === true && auditBound && !blocked };
}

type CertifiedTeammatePreviewReceipt = { action_id: string; path: string };

function certifiedTeammatePreviewReceipts(attempt: GeneralRevitAttempt): CertifiedTeammatePreviewReceipt[] {
  const value = attempt.teammate_loop_receipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const receipt = value as {
    schema?: unknown; turn_kind?: unknown; context_state?: unknown; stage?: unknown;
    preview_action_ids?: unknown; preview_receipts?: unknown; apply_attempts?: unknown; blocked_reason?: unknown;
  };
  if (receipt.schema !== "revit-operator.teammate-loop-receipt.v1"
      || receipt.turn_kind === "conversation"
      || receipt.context_state !== "live"
      || receipt.stage === "blocked"
      || Number(receipt.apply_attempts) !== 0
      || (receipt.blocked_reason !== null && receipt.blocked_reason !== undefined
        && (typeof receipt.blocked_reason !== "string" || receipt.blocked_reason.trim().length > 0))) return [];
  if (!Array.isArray(receipt.preview_action_ids) || !Array.isArray(receipt.preview_receipts)) return [];
  const actionIds = new Set(receipt.preview_action_ids
    .filter((actionId): actionId is string => typeof actionId === "string" && actionId.trim().length > 0)
    .map((actionId) => actionId.trim()));
  if (actionIds.size === 0 || actionIds.size !== receipt.preview_action_ids.length) return [];
  const rows: CertifiedTeammatePreviewReceipt[] = [];
  for (const value of receipt.preview_receipts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as { action_id?: unknown; path?: unknown; status?: unknown; evidence_sha256?: unknown };
    const actionId = String(row.action_id || "").trim();
    const path = String(row.path || "").trim();
    const evidenceHash = String(row.evidence_sha256 || "").trim();
    if (!actionIds.has(actionId) || row.status !== "success"
        || !/^(?:\/revit\/[a-z0-9/-]+|revit_[a-z0-9_]+)$/.test(path)
        || !/^sha256:[a-f0-9]{64}$/.test(evidenceHash)) continue;
    rows.push({ action_id: actionId, path });
  }
  const certifiedActionIds = new Set(rows.map((row) => row.action_id));
  return certifiedActionIds.size === actionIds.size && [...actionIds].every((actionId) => certifiedActionIds.has(actionId))
    ? rows
    : [];
}

function hasCertifiedTeammatePreviewReceipt(attempt: GeneralRevitAttempt): boolean {
  return certifiedTeammatePreviewReceipts(attempt).length > 0;
}

function certifiedTeammatePreviewPaths(attempt: GeneralRevitAttempt): string[] {
  return [...new Set(certifiedTeammatePreviewReceipts(attempt).map((row) => row.path))];
}

function combinedMessage(attempt: GeneralRevitAttempt): string {
  const assistantMessage = typeof attempt.assistant_message === "string" && attempt.assistant_message.trim()
    ? attempt.assistant_message
    : durableResultSummary(attempt);
  return [assistantMessage, attempt.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function assistantReportsIncompleteMutation(attempt: GeneralRevitAttempt): boolean {
  if (!teammateLoopTruth(attempt).mutationAttempted) return false;
  const text = combinedMessage(attempt);
  return /\[teammate_loop_blocked\]|\bassignment is blocked\b|\bcannot claim (?:the )?(?:revit )?change is complete\b|\brequest(?:ed)?(?: [^.\n]{0,80})? (?:is|was) not (?:yet )?complete\b|\bnot yet complete\b/i.test(text);
}

function assistantReportsTaskBlocked(attempt: GeneralRevitAttempt): boolean {
  const text = combinedMessage(attempt);
  return /(?:^|\n)\s*(?:#{1,6}\s*)?blocked\b/i.test(text)
    || /\bno qualifying [^.\n]{0,120} (?:exists|was found|could be found)\b/i.test(text)
    || /\b(?:could not|was unable to) (?:produce|complete|execute|preview|apply)\b/i.test(text);
}

export function capabilityRefusalReason(attempt: GeneralRevitAttempt, expectedPathObserved = false): string | null {
  if (expectedPathObserved) return null;
  const text = combinedMessage(attempt);
  if (!text || MISSING_TARGET_PATTERNS.some((pattern) => pattern.test(text))) return null;
  const match = CAPABILITY_REFUSAL_PATTERNS.find((pattern) => pattern.test(text));
  return match ? text.slice(0, 500) : null;
}

function isMissingTargetClarification(attempt: GeneralRevitAttempt): boolean {
  const text = combinedMessage(attempt);
  return !!text && MISSING_TARGET_PATTERNS.some((pattern) => pattern.test(text));
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

function assistantReportsVerifiedNoop(attempt: GeneralRevitAttempt): boolean {
  const text = combinedMessage(attempt);
  return /\bno (?:rename|change|edit|update|modification|action|write)s? (?:was|were|is|are)?\s*(?:required|needed|necessary)\b/i.test(text)
    || /\bno changes? (?:was|were|is|are)?\s*(?:required|needed|necessary)\b/i.test(text)
    || /\bverified no[ -]?op\b/i.test(text)
    || /\balready (?:conforms?|compliant|matches?|satisf(?:y|ies|ied)|correct|present|up[ -]to[ -]date)\b/i.test(text);
}

function markdownTableMismatchFacts(answerText: string): string[] {
  const rows = answerText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|") && line.endsWith("|"));
  const cells = rows.map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
  const headerIndex = cells.findIndex((row) => row.some((cell) => /^sheet(?: number)?$/i.test(cell))
    && row.some((cell) => /^drawn by$/i.test(cell))
    && row.some((cell) => /^checked by$/i.test(cell)));
  if (headerIndex < 0) return [];

  const header = cells[headerIndex];
  const sheetIndex = header.findIndex((cell) => /^sheet(?: number)?$/i.test(cell));
  const drawnByIndex = header.findIndex((cell) => /^drawn by$/i.test(cell));
  const checkedByIndex = header.findIndex((cell) => /^checked by$/i.test(cell));
  const namedExpected = /expected\b[^\n]*\bDrawn By\s*=\s*([A-Za-z0-9_-]+)\s*\/\s*Checked By\s*=\s*([A-Za-z0-9_-]+)/i.exec(answerText);
  const positionalExpected = /(?:expected|required)\s+([A-Za-z0-9_-]+)\s*\/\s*([A-Za-z0-9_-]+)(?:\s+combination)?/i.exec(answerText);
  const comparisonExpected = /(?:differ(?:s|ing)?\s+from|against)\s+([A-Za-z0-9_-]+)\s*\/\s*([A-Za-z0-9_-]+)/i.exec(answerText);
  const expected = namedExpected || positionalExpected || comparisonExpected;
  if (!expected) return [];
  const separator = (cell: string) => /^:?-{3,}:?$/.test(cell);
  const data = cells.slice(headerIndex + 1)
    .filter((row) => row.length > Math.max(sheetIndex, drawnByIndex, checkedByIndex))
    .filter((row) => !row.every(separator))
    .filter((row) => row[sheetIndex] && row[drawnByIndex] && row[checkedByIndex]);
  if (data.length === 0) return [];

  const expectedDrawnBy = expected[1].toLowerCase();
  const expectedCheckedBy = expected[2].toLowerCase();
  let sheetMismatches = 0;
  let fieldMismatches = 0;
  for (const row of data) {
    const drawnByMismatch = row[drawnByIndex].toLowerCase() !== expectedDrawnBy;
    const checkedByMismatch = row[checkedByIndex].toLowerCase() !== expectedCheckedBy;
    if (drawnByMismatch || checkedByMismatch) sheetMismatches += 1;
    if (drawnByMismatch) fieldMismatches += 1;
    if (checkedByMismatch) fieldMismatches += 1;
  }
  return [
    `Derived table rows audited: ${data.length}`,
    `Derived sheets with one or more mismatches: ${sheetMismatches}`,
    `Derived individual field mismatches: ${fieldMismatches}`
  ];
}

function semanticAssertionText(answerText: string): string {
  const presentationNeutral = answerText
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "");
  const derivedFacts = markdownTableMismatchFacts(presentationNeutral);
  return derivedFacts.length > 0 ? `${presentationNeutral}\n${derivedFacts.join("\n")}` : presentationNeutral;
}

function assertionPatternMatches(pattern: string, answerText: string): boolean {
  const expression = new RegExp(pattern, "i");
  if (expression.test(answerText)) return true;
  // Fixture oracles grade model facts, not Markdown style. Models commonly wrap
  // identifiers, counts, and labels in emphasis or inline-code delimiters; those
  // delimiters must not turn a correct value into a benchmark failure.
  return expression.test(semanticAssertionText(answerText));
}

type TrustedSemanticFact = { capability_id: string; key: string; value: string | number | boolean };

function durableEvidenceRecord(attempt: GeneralRevitAttempt): Record<string, unknown> {
  return attempt.durable_tool_evidence && typeof attempt.durable_tool_evidence === "object" && !Array.isArray(attempt.durable_tool_evidence)
    ? attempt.durable_tool_evidence as Record<string, unknown>
    : {};
}

function successfulEvidencePaths(evidence: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(evidence.successful_paths)
    ? evidence.successful_paths.map((value) => canonicalBenchmarkRevitPath(String(value))).filter(Boolean)
    : []);
}

type ValidatedActionReceipt = { path: string; effect: GeneralRevitExpectedEffect; capabilityId: string; row: Record<string, unknown> };

function validatedActionReceipts(evidence: Record<string, unknown>): ValidatedActionReceipt[] {
  const rows = (Array.isArray(evidence.result_receipts) ? evidence.result_receipts : [])
    .map((value) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
  return rows.flatMap((row, index) => {
    if (!row) return [];
    const path = canonicalBenchmarkRevitPath(String(row.path || ""));
    const capabilityId = benchmarkSemanticCapabilityId(path);
    const effect = String(row.request_effect || "").trim().toLowerCase();
    const valid = row.status === "completed" && row.envelope_succeeded === true && row.parsed_ok !== false
      && row.parsed_outcome_unknown !== true && row.parsed_reconciliation_required !== true
      && !(typeof row.parsed_error === "string" && row.parsed_error.trim())
      && !!capabilityId && row.semantic_capability_id === capabilityId
      && (effect === "read" || effect === "preview" || effect === "apply")
      && !!String(row.goal_id || "") && !!String(row.action_id || "")
      && /^[a-f0-9]{64}$/.test(String(row.result_sha256 || ""));
    if (!valid) return [];
    const laterSamePath = rows.slice(index + 1).some((later) => later && canonicalBenchmarkRevitPath(String(later.path || "")) === path);
    return laterSamePath ? [] : [{ path, effect: effect as GeneralRevitExpectedEffect, capabilityId, row }];
  });
}

function durableReceiptBoundToLifecycle(
  durable: DurableLifecycle,
  receipts: ValidatedActionReceipt[],
  expectedPaths: Set<string>,
  expectedEffect: GeneralRevitExpectedEffect,
  options: { requireVerified?: boolean; completionMode?: string; requireReceiptEffect?: boolean } = {}
): boolean {
  const requireReceiptEffect = options.requireReceiptEffect !== false;
  return receipts.some((receipt) => expectedPaths.has(receipt.path)
    && (!requireReceiptEffect || receipt.effect === expectedEffect)
    && durable.assignments.some((assignment) =>
      assignment.goalId.length > 0
      && assignment.goalId === String(receipt.row.goal_id || "").trim()
      && assignment.completed
      && !assignment.blocked
      && (!options.requireVerified || assignment.verified)
      && assignment.requestedEffect === expectedEffect
      && (!options.completionMode || assignment.completionMode === options.completionMode)));
}

function successfulSemanticCapabilityIds(evidence: Record<string, unknown>): Set<string> {
  return new Set(validatedActionReceipts(evidence).map((receipt) => receipt.capabilityId));
}

function trustedSemanticFacts(evidence: Record<string, unknown>): TrustedSemanticFact[] {
  const candidates: TrustedSemanticFact[] = [];
  const redundantFields: Readonly<Record<string, string>> = {
    count: "parsed_count",
    requestedCount: "parsed_requested_count",
    scannedElementCount: "parsed_scanned_element_count",
    failedElementCount: "parsed_failed_element_count",
    openPhysicalConnectorCount: "parsed_open_physical_connector_count",
    connectorScanTruncatedElementCount: "parsed_connector_scan_truncated_element_count",
    truncated: "parsed_truncated"
  };
  for (const { row, capabilityId } of validatedActionReceipts(evidence)) {
    const parsedFacts = row.parsed_semantic_facts;
    if (!parsedFacts || typeof parsedFacts !== "object" || Array.isArray(parsedFacts)) continue;
    for (const [key, factValue] of Object.entries(parsedFacts as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)
        || (typeof factValue !== "string" && typeof factValue !== "number" && typeof factValue !== "boolean")) continue;
      const redundantField = redundantFields[key];
      if (redundantField && row[redundantField] !== factValue) continue;
      candidates.push({ capability_id: capabilityId, key, value: factValue });
    }
  }
  return candidates.filter((candidate) => !candidates.some((other) => other.capability_id === candidate.capability_id
    && other.key === candidate.key && other.value !== candidate.value));
}
function fixtureBlockerEvidenceFailures(
  testCase: GeneralRevitCapabilityCase,
  attempt: GeneralRevitAttempt
): string[] {
  const requirements = testCase.fixture_blocker_assertions?.evidence;
  if (!requirements) return [];
  const evidence = durableEvidenceRecord(attempt);
  const successfulPaths = successfulEvidencePaths(evidence);
  const semanticCapabilityIds = successfulSemanticCapabilityIds(evidence);
  const connectorInventory = evidence.connector_inventory && typeof evidence.connector_inventory === "object"
    ? evidence.connector_inventory as Record<string, unknown>
    : {};
  const failures: string[] = [];
  for (const path of requirements.required_successful_paths || []) {
    if (!successfulPaths.has(canonicalBenchmarkRevitPath(path))) failures.push(`evidence_missing_successful_path:${path}`);
  }
  for (const capabilityId of requirements.required_semantic_capability_ids || []) {
    if (!semanticCapabilityIds.has(capabilityId)) failures.push(`evidence_missing_semantic_capability:${capabilityId}`);
  }
  const uniqueElementIds = Number(connectorInventory.unique_element_ids);
  if (requirements.minimum_unique_connector_element_ids !== undefined
    && (!Number.isFinite(uniqueElementIds) || uniqueElementIds < requirements.minimum_unique_connector_element_ids)) {
    failures.push(`evidence_connector_unique_ids:${Number.isFinite(uniqueElementIds) ? uniqueElementIds : "missing"}<${requirements.minimum_unique_connector_element_ids}`);
  }
  const failedRows = Number(connectorInventory.failed_rows);
  if (requirements.maximum_failed_connector_rows !== undefined
    && (!Number.isFinite(failedRows) || failedRows > requirements.maximum_failed_connector_rows)) {
    failures.push(`evidence_connector_failed_rows:${Number.isFinite(failedRows) ? failedRows : "missing"}>${requirements.maximum_failed_connector_rows}`);
  }
  const openHvacConnectors = Number(connectorInventory.open_hvac_connectors);
  if (requirements.required_open_hvac_connector_count !== undefined
    && (!Number.isFinite(openHvacConnectors) || openHvacConnectors !== requirements.required_open_hvac_connector_count)) {
    failures.push(`evidence_open_hvac_connectors:${Number.isFinite(openHvacConnectors) ? openHvacConnectors : "missing"}!=${requirements.required_open_hvac_connector_count}`);
  }
  const openPhysicalConnectorOwnerCount = Number(connectorInventory.open_physical_connector_owner_count);
  if (requirements.maximum_open_physical_connector_owner_count !== undefined
    && (!Number.isFinite(openPhysicalConnectorOwnerCount)
      || openPhysicalConnectorOwnerCount > requirements.maximum_open_physical_connector_owner_count)) {
    failures.push(`evidence_open_physical_connector_owners:${Number.isFinite(openPhysicalConnectorOwnerCount) ? openPhysicalConnectorOwnerCount : "missing"}>${requirements.maximum_open_physical_connector_owner_count}`);
  }
  if (requirements.require_compact_connector_filter === true && connectorInventory.compact_filter_used !== true) {
    failures.push("evidence_compact_connector_filter:missing");
  }
  if (requirements.require_untruncated_connector_scan === true && connectorInventory.scan_truncated !== false) {
    failures.push(`evidence_connector_scan_truncated:${connectorInventory.scan_truncated === true ? "true" : "missing"}`);
  }
  return failures;
}

function answerEvidenceFailures(
  testCase: GeneralRevitCapabilityCase,
  attempt: GeneralRevitAttempt
): string[] {
  const requirements = testCase.answer_assertions?.evidence;
  if (!requirements) return [];
  const evidence = durableEvidenceRecord(attempt);
  const successfulPaths = successfulEvidencePaths(evidence);
  const semanticCapabilityIds = successfulSemanticCapabilityIds(evidence);
  const semanticFacts = trustedSemanticFacts(evidence);
  const successfulTools = new Set(Array.isArray(evidence.successful_tools)
    ? evidence.successful_tools.map((value) => String(value))
    : []);
  return [
    ...(requirements.required_successful_paths || [])
      .filter((path) => !successfulPaths.has(canonicalBenchmarkRevitPath(path)))
      .map((path) => `evidence_missing_successful_path:${path}`),
    ...(requirements.required_successful_tools || [])
      .filter((tool) => !successfulTools.has(tool))
      .map((tool) => `evidence_missing_successful_tool:${tool}`),
    ...(requirements.required_semantic_capability_ids || [])
      .filter((capabilityId) => !semanticCapabilityIds.has(capabilityId))
      .map((capabilityId) => `evidence_missing_semantic_capability:${capabilityId}`),
    ...(requirements.required_semantic_facts || [])
      .filter((required) => !semanticFacts.some((fact) => fact.capability_id === required.capability_id
        && fact.key === required.key && fact.value === required.equals))
      .map((required) => `evidence_semantic_fact_mismatch:${required.capability_id}:${required.key}:${JSON.stringify(required.equals)}`)
  ];
}

function verificationChecksPass(value: unknown): boolean {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length === 0) return false;
  return rows.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    const named = typeof row.name === "string" && row.name.trim().length > 0;
    const grounded = Object.prototype.hasOwnProperty.call(row, "expected")
      || Object.prototype.hasOwnProperty.call(row, "actual")
      || (Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0);
    return row.ok === true && named && grounded;
  });
}

function hasModelStateReadbackEvidence(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return hasModelStateReadbackEvidence(JSON.parse(text), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((entry) => hasModelStateReadbackEvidence(entry, depth + 1));
  if (typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["readback", "read_back"].includes(key) && nonEmptyEvidenceValue(child)) return true;
    if (["verification_result", "verification_results"].includes(key) && verificationChecksPass(child)) return true;
    if (hasModelStateReadbackEvidence(child, depth + 1)) return true;
  }
  return false;
}

function nestedEvidenceMatches(
  value: unknown,
  predicate: (key: string, child: unknown) => boolean,
  depth = 0
): boolean {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return nestedEvidenceMatches(JSON.parse(text), predicate, depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((entry) => nestedEvidenceMatches(entry, predicate, depth + 1));
  if (typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (predicate(key, child) || nestedEvidenceMatches(child, predicate, depth + 1)) return true;
  }
  return false;
}

function hasCommittedVerifiedDynamicApplyReceipt(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || depth > 10) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return hasCommittedVerifiedDynamicApplyReceipt(JSON.parse(text), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((entry) => hasCommittedVerifiedDynamicApplyReceipt(entry, depth + 1));
  if (typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.schema === "dynamic-revit-apply-receipt/v1" && row.outcome === "committed_verified") {
    const changedIds = Array.isArray(row.changed_element_ids) ? row.changed_element_ids : [];
    const operations = Array.isArray(row.operation_results) ? row.operation_results : [];
    return changedIds.length > 0 && operations.length > 0 && operations.every((operation) => {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) return false;
      const result = operation as Record<string, unknown>;
      return typeof result.target === "string" && result.target.trim().length > 0
        && Object.prototype.hasOwnProperty.call(result, "before")
        && Object.prototype.hasOwnProperty.call(result, "after")
        && result.before !== result.after;
    });
  }
  return Object.values(row).some((child) => hasCommittedVerifiedDynamicApplyReceipt(child, depth + 1));
}

function dynamicRuntimeEffectMatches(row: ActionLike, expectedEffect: GeneralRevitExpectedEffect): boolean {
  const path = String(row.path || "").trim();
  if (!/^\/revit\/dynamic-runtime(?:\/(?:preview|apply))?$/.test(path)) return false;
  const effect = String(row.request_effect || "").trim();
  return effect === expectedEffect || (expectedEffect === "read" && effect === "preview");
}

function successfulDynamicRuntimeAlternative(row: ActionLike, expectedEffect: GeneralRevitExpectedEffect): boolean {
  if (!dynamicRuntimeEffectMatches(row, expectedEffect) || row.status === "failed" || row.request_dispatched === false) return false;
  if (expectedEffect === "apply") return hasCommittedVerifiedDynamicApplyReceipt(row.receipt);
  return row.request_dispatched === true;
}

function nonEmptyEvidenceValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function verificationBasis(
  testCase: GeneralRevitCapabilityCase,
  attempt: GeneralRevitAttempt,
  completed: boolean,
  answerAssertionPassed: boolean | null,
  teammate: { mutationAttempted: boolean; blocked: boolean; verified: boolean },
  durable: { completed: boolean; blocked: boolean; verified: boolean; requestedEffects: GeneralRevitExpectedEffect[] }
): GeneralRevitVerificationBasis {
  if (!completed) return "none";
  if (testCase.answer_assertions && answerAssertionPassed === true) return "fixture_semantic_oracle";
  if (teammate.verified) return "target_bound_model_state";
  if (nestedEvidenceMatches(attempt, (key, child) =>
    (["rollback_truth", "rollback_verified"].includes(key) && child === true)
    || (key === "rollback_status" && `${child}`.toLowerCase() === "rolledback")
    || (key === "rollback_verified_element_ids" && Array.isArray(child) && child.length > 0))) {
    return "rollback_verified_preview";
  }
  if (testCase.expected_effect !== "apply" && hasCertifiedTeammatePreviewReceipt(attempt)) {
    return "structured_preview_receipt";
  }
  if (hasCommittedVerifiedDynamicApplyReceipt(attempt)) return "model_state_readback";
  if (hasModelStateReadbackEvidence(attempt)) return "model_state_readback";
  if (nestedEvidenceMatches(attempt, (key, child) =>
    ["artifact", "artifacts", "artifact_id", "artifact_ids", "artifact_path", "artifact_paths"].includes(key)
      && nonEmptyEvidenceValue(child))) return "artifact_evidence";
  if (durable.verified) return "durable_server_validation";
  return hasStructuredVerificationEvidence(attempt) ? "generic_structured_receipt" : "none";
}

export function evaluateGeneralRevitCapabilityAttempt(
  testCase: GeneralRevitCapabilityCase,
  attempt: GeneralRevitAttempt | null | undefined
): GeneralRevitEvaluation {
  // Natural-language assertions in this corpus were authored for read and
  // rollback-preview probes. They are useful semantic oracles for those
  // non-mutating modes, but they must not veto an authorized mutation whose
  // structured receipt and readback prove the requested model-state change.
  // Apply truth is therefore determined from tool/lifecycle evidence, not from
  // whether the assistant repeated legacy preview wording.
  if (!attempt) {
    return {
      case_id: testCase.case_id, tier: "not_run", non_refusal: false, completed: false, verified: false,
      expected_path_observed: false, observed_paths: [], dispatched: false, apply_dispatched: false,
      outcome_unknown: false, refusal_reason: null,
      answer_assertion_available: testCase.expected_effect !== "apply" && !!testCase.answer_assertions,
      answer_assertion_passed: null, answer_assertion_failures: [],
      fixture_blocker_assertion_available: !!testCase.fixture_blocker_assertions,
      fixture_blocker_assertion_passed: null, fixture_blocker_assertion_failures: [], fixture_blocker_accepted: false,
      verification_basis: "none", summary: "Case was not run."
    };
  }
  const rows = actionRows(attempt);
  const durableEvidence = durableEvidenceRecord(attempt);
  const durableReceipts = validatedActionReceipts(durableEvidence);
  const durablePaths = new Set([
    ...successfulEvidencePaths(durableEvidence),
    ...durableSpecificRevitPaths(attempt)
  ]);
  const teammatePreviewPaths = certifiedTeammatePreviewPaths(attempt).map(canonicalBenchmarkRevitPath);
  const expectedPaths = new Set(testCase.dispatch_any_of.map(canonicalBenchmarkRevitPath));
  const rowMatchesExpectedPathAndEffect = (row: ActionLike, effect: GeneralRevitExpectedEffect) =>
    expectedPaths.has(canonicalBenchmarkRevitPath(String(row.path || "")))
    && row.request_effect === effect && row.request_dispatched === true && row.status !== "failed";
  const composablePreviewLaneObserved = testCase.expected_effect !== "apply"
    && teammatePreviewPaths.includes("/revit/transaction-plan");
  const observedPaths = [...new Set([
    ...rows.map((row) => canonicalBenchmarkRevitPath(String(row.path || ""))).filter(Boolean),
    ...durablePaths,
    ...teammatePreviewPaths
  ])];
  const expectedPathObserved = composablePreviewLaneObserved
    || observedPaths.some((candidate) => expectedPaths.has(candidate))
    || rows.some((row) => dynamicRuntimeEffectMatches(row, testCase.expected_effect));
  const substantiveFailedAction = rows.some((row, index) => {
    const failedPath = String(row.path || "");
    if (row.status !== "failed" || !/^\/revit\/(?!health$|context$|ping$)/.test(failedPath)) return false;
    const failedEffect = String(row.request_effect || "").trim();
    return !rows.slice(index + 1).some((later) => {
      if (later.status !== "success" || later.request_dispatched === false) return false;
      const laterPath = String(later.path || "");
      if (laterPath === failedPath) return true;
      // Discovery is intentionally exploratory: an invalid read query is
      // recovered when a later live read supplies the evidence used for the
      // conclusion. A read must never recover a failed preview or mutation.
      return failedEffect === "read" && String(later.request_effect || "").trim() === "read";
    });
  });
  const successfulExpectedPathObserved = [...durablePaths].some((candidate) => expectedPaths.has(candidate))
    || composablePreviewLaneObserved
    || teammatePreviewPaths.some((candidate) => expectedPaths.has(candidate))
    || rows.some((row) => rowMatchesExpectedPathAndEffect(row, testCase.expected_effect))
    || rows.some((row) => successfulDynamicRuntimeAlternative(row, testCase.expected_effect));
  const teammate = teammateLoopTruth(attempt);
  const applyDispatched = rows.some((row) => rowMatchesExpectedPathAndEffect(row, "apply"))
    || rows.some((row) => successfulDynamicRuntimeAlternative(row, "apply"))
    || (teammate.mutationAttempted && [...durablePaths].some((candidate) => expectedPaths.has(candidate)));
  const dispatched = applyDispatched || rows.some((row) => row.request_dispatched === true)
    || durablePaths.size > 0;
  const answerAssertionsApplicable = !!testCase.answer_assertions
    && (testCase.expected_effect !== "apply" || !applyDispatched);
  const outcomeUnknown = attempt.outcome_unknown === true || attempt.reconciliation_required === true;
  const durable = durableLifecycle(attempt);
  const durableEffectReceiptCompleted = durableReceiptBoundToLifecycle(
    durable, durableReceipts, expectedPaths, testCase.expected_effect
  );
  const durableVerifiedEffectReceiptCompleted = durableReceiptBoundToLifecycle(
    durable, durableReceipts, expectedPaths, testCase.expected_effect, { requireVerified: true }
  );
  const recoveredCanonicalTimeout = attempt.ok === false
    && /^Computer run exceeded \d+ms\.$/i.test(String(attempt.error || "").trim())
    && durableVerifiedEffectReceiptCompleted
    && durableResultSummary(attempt).length > 0;
  const attemptSucceeded = attempt.ok !== false || recoveredCanonicalTimeout;
  const assistantIncomplete = assistantReportsIncompleteMutation(attempt);
  const assistantBlocked = assistantReportsTaskBlocked(attempt);
  const missingTargetClarification = isMissingTargetClarification(attempt);
  const refusalReason = capabilityRefusalReason(attempt, successfulExpectedPathObserved);
  const answerText = typeof attempt.assistant_message === "string" && attempt.assistant_message.trim()
    ? attempt.assistant_message
    : durableResultSummary(attempt);
  const answerEvidenceAssertionFailures = answerAssertionsApplicable ? answerEvidenceFailures(testCase, attempt) : [];
  const answerEvidenceRequirements = answerAssertionsApplicable ? testCase.answer_assertions?.evidence : undefined;
  const answerEvidenceIsAuthoritative = (
    (answerEvidenceRequirements?.required_semantic_facts?.length ?? 0) > 0
    || (testCase.expected_effect !== "read" && (answerEvidenceRequirements?.required_successful_paths?.length ?? 0) > 0)
  )
    && answerEvidenceAssertionFailures.length === 0;
  const answerAssertionFailures = answerAssertionsApplicable && testCase.answer_assertions
    ? [
        ...(answerEvidenceIsAuthoritative ? [] : testCase.answer_assertions.must_match
          .filter((pattern) => !assertionPatternMatches(pattern, answerText))
          .map((pattern) => `missing:${pattern}`)),
        ...(testCase.answer_assertions.must_not_match || [])
          .filter((pattern) => assertionPatternMatches(pattern, answerText))
          .map((pattern) => `forbidden:${pattern}`),
        ...answerEvidenceAssertionFailures
      ]
    : [];
  const answerAssertionPassed = answerAssertionsApplicable ? answerAssertionFailures.length === 0 : null;
  const fixtureBlockerAssertionFailures = testCase.fixture_blocker_assertions
    ? [
        ...testCase.fixture_blocker_assertions.must_match
          .filter((pattern) => !assertionPatternMatches(pattern, answerText))
          .map((pattern) => `missing:${pattern}`),
        ...(testCase.fixture_blocker_assertions.must_not_match || [])
          .filter((pattern) => assertionPatternMatches(pattern, answerText))
          .map((pattern) => `forbidden:${pattern}`),
        ...fixtureBlockerEvidenceFailures(testCase, attempt)
      ]
    : [];
  const fixtureBlockerAssertionPassed = testCase.fixture_blocker_assertions
    ? fixtureBlockerAssertionFailures.length === 0
    : null;
  const verifiedNoop = testCase.expected_effect === "apply" && testCase.allow_verified_noop === true
    && answerAssertionPassed === true && successfulExpectedPathObserved && !applyDispatched
    && assistantReportsVerifiedNoop(attempt) && !assistantBlocked && !assistantIncomplete
    && durableReceiptBoundToLifecycle(
      durable, durableReceipts, expectedPaths, "apply",
      { requireVerified: true, completionMode: "verified_noop", requireReceiptEffect: false }
    );
  const directPreviewDispatched = rows.some((row) => rowMatchesExpectedPathAndEffect(row, "preview"))
    || rows.some((row) => successfulDynamicRuntimeAlternative(row, "preview"));
  // A certified preview is a stronger non-mutating observation than a plain
  // read and may satisfy either safe effect. It must never satisfy apply.
  const teammatePreviewDispatched = testCase.expected_effect !== "apply"
    && (composablePreviewLaneObserved || teammatePreviewPaths.some((candidate) => expectedPaths.has(candidate)));
  const fixtureInspectionObserved = durablePaths.size > 0 || rows.some((row) => row.request_effect === "read"
    && row.request_dispatched === true && row.status !== "failed"
    && /^\/revit\//.test(canonicalBenchmarkRevitPath(String(row.path || ""))));
  const fixtureBlockerAccepted = fixtureBlockerAssertionPassed === true
    && attemptSucceeded && fixtureInspectionObserved && dispatched
    && !applyDispatched && !directPreviewDispatched && !teammatePreviewDispatched
    && (assistantBlocked || durable.blocked || teammate.blocked)
    && !outcomeUnknown && !substantiveFailedAction && !teammate.mutationAttempted
    && !refusalReason;
  const durableEffectCompleted = durableEffectReceiptCompleted;
  const requestedEffectSatisfied = testCase.expected_effect === "apply"
    ? applyDispatched || verifiedNoop
    : testCase.expected_effect === "preview"
      ? directPreviewDispatched || teammatePreviewDispatched || durableEffectCompleted
      : successfulExpectedPathObserved;
  const requiredEffectMissing = testCase.expected_effect !== "read" && dispatched && !requestedEffectSatisfied;
  const targetBoundPreviewVerificationMissing = testCase.require_target_bound_preview_verification === true && !teammate.verified;
  const authoritativeTeammateEffect = teammate.verified && (
    testCase.expected_effect === "apply"
      ? teammate.mutationAttempted && applyDispatched
      : teammatePreviewDispatched
  );
  const authoritativeEffectRecovery = durableVerifiedEffectReceiptCompleted || authoritativeTeammateEffect;
  // Exploratory failures remain visible in telemetry, but they cannot negate a
  // later action-bound, target-bound verification receipt for the requested
  // effect. The receipt and expected-lane checks above prevent an unrelated
  // successful route from masking a failed task.
  const effectiveSubstantiveFailedAction = substantiveFailedAction && !authoritativeEffectRecovery;
  const effectiveDurableBlocked = durable.blocked && !authoritativeEffectRecovery;
  const effectiveTeammateBlocked = teammate.blocked && !authoritativeEffectRecovery;
  const effectiveAssistantIncomplete = assistantIncomplete && !authoritativeEffectRecovery;
  const effectiveAssistantBlocked = assistantBlocked && !authoritativeEffectRecovery;
  const effectiveMissingTargetClarification = missingTargetClarification && !authoritativeEffectRecovery;
  const completed = attemptSucceeded && successfulExpectedPathObserved && requestedEffectSatisfied && answerAssertionPassed !== false && !effectiveSubstantiveFailedAction && !outcomeUnknown && !effectiveDurableBlocked && !effectiveTeammateBlocked && !effectiveAssistantIncomplete && !effectiveAssistantBlocked && !effectiveMissingTargetClarification
    && !targetBoundPreviewVerificationMissing && (dispatched || durableEffectCompleted);
  const basis = verificationBasis(testCase, attempt, completed, answerAssertionPassed, teammate, durable);
  const verified = completed && !["none", "durable_server_validation", "generic_structured_receipt"].includes(basis);
  let tier: GeneralRevitResultTier;
  if (refusalReason) tier = "refused";
  else if (effectiveMissingTargetClarification && attemptSucceeded && !effectiveSubstantiveFailedAction && !outcomeUnknown && !teammate.mutationAttempted && !applyDispatched) tier = "accepted";
  else if (fixtureBlockerAccepted) tier = "accepted";
  else if (!attemptSucceeded || effectiveSubstantiveFailedAction || outcomeUnknown || effectiveDurableBlocked || effectiveTeammateBlocked || effectiveAssistantIncomplete || effectiveAssistantBlocked || requiredEffectMissing || targetBoundPreviewVerificationMissing || answerAssertionPassed === false) tier = "failed";
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
    answer_assertion_available: answerAssertionsApplicable,
    answer_assertion_passed: answerAssertionPassed,
    answer_assertion_failures: answerAssertionFailures,
    fixture_blocker_assertion_available: !!testCase.fixture_blocker_assertions,
    fixture_blocker_assertion_passed: fixtureBlockerAssertionPassed,
    fixture_blocker_assertion_failures: fixtureBlockerAssertionFailures,
    fixture_blocker_accepted: fixtureBlockerAccepted,
    verification_basis: basis,
    summary: tier === "refused" ? "Agent refused an in-scope Revit capability."
      : tier === "failed" ? answerAssertionPassed === false
        ? "Tool-backed execution completed, but the fixture-grounded answer assertions failed."
        : targetBoundPreviewVerificationMissing
        ? "Rollback preview lacks target-bound post-rollback model-state verification."
        : requiredEffectMissing
        ? testCase.expected_effect === "apply"
          ? "Mutation case did not dispatch a verified apply operation."
          : `Case did not produce the requested ${testCase.expected_effect} effect.`
        : "Attempt failed or has an uncertain outcome."
        : fixtureBlockerAccepted ? "Fixture-grounded inspection proved that this sample lacks a semantically compatible target; the agent correctly stopped without previewing or applying an invalid substitution."
        : verifiedNoop ? "Fixture-grounded readback verified that the requested state was already satisfied; no write was necessary."
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
