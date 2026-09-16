import type { GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";
import { sha256Value } from "./protocol_v2_hash.js";

type RecordValue = Record<string, unknown>;
export type GeneralRevitAcceptanceCriteria = {
  delivery_criteria: string[];
  collateral_criteria: string[];
  intentional_missing_information: string[];
};
export function validateGeneralRevitAcceptanceReviewCase(testCase: GeneralRevitCapabilityCase): void {
  if (!testCase.acceptance_review) return;
  for (const key of ["delivery_criteria", "collateral_criteria", "intentional_missing_information"] as const) {
    const entries = testCase.acceptance_review[key];
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || !entry.trim())
      || (key !== "intentional_missing_information" && entries.length === 0)) {
      throw new Error(`Case ${testCase.case_id} has invalid independent review criteria: ${key}.`);
    }
  }
  if (testCase.fixture_precondition?.clear_selection !== true) throw new Error(`Reviewed case ${testCase.case_id} must declare a fresh selection state.`);
}
export type AcceptanceReviewCheck = {
  criterion: string;
  status: "pending" | "pass" | "fail" | "unverifiable";
  evidence_refs: string[];
  explanation: string;
};
export type AcceptanceReviewCase = {
  case_id: string;
  source_case_sha256: string;
  raw_trace_sha256: string;
  prompt: string;
  runtime_evaluation: unknown;
  intentional_missing_information: string[];
  outcome: "pending" | "delivered" | "verified_noop" | "clarification" | "fixture_blocked" | "failed" | "unverified";
  delivery: AcceptanceReviewCheck[];
  collateral: AcceptanceReviewCheck[];
  explanation: string;
  evidence_refs: string[];
};
export type AcceptanceReviewPacket = {
  schema: "revit-operator.general-revit-independent-review/v1";
  run_id: string;
  source_run_sha256: string;
  criteria_sha256: string;
  review_instructions: string[];
  cases: AcceptanceReviewCase[];
};

export function buildGeneralRevitAcceptanceReviewPacket(
  runId: string, selectedCases: GeneralRevitCapabilityCase[], traces: RecordValue[]
): AcceptanceReviewPacket | null {
  if (!selectedCases.some(entry => entry.acceptance_review)) return null;
  const byId = new Map(traces.map(trace => [String(trace.case_id), trace]));
  if (byId.size !== traces.length || selectedCases.length !== traces.length
    || new Set(selectedCases.map(entry => entry.case_id)).size !== selectedCases.length) {
    throw new Error("Independent review requires exactly one retained trace per selected case.");
  }
  const checks = (criteria: string[]): AcceptanceReviewCheck[] => criteria.map(criterion => ({
    criterion, status: "pending", evidence_refs: [], explanation: ""
  }));
  const cases = selectedCases.map(entry => {
    const trace = byId.get(entry.case_id);
    if (!entry.acceptance_review || !trace) throw new Error(`Independent review is missing criteria or trace for ${entry.case_id}.`);
    return {
      case_id: entry.case_id, source_case_sha256: sha256Value(entry), raw_trace_sha256: sha256Value(trace),
      prompt: entry.prompt, runtime_evaluation: trace.verification_results ?? null,
      intentional_missing_information: entry.acceptance_review.intentional_missing_information,
      outcome: "pending" as const, delivery: checks(entry.acceptance_review.delivery_criteria),
      collateral: checks(entry.acceptance_review.collateral_criteria), explanation: "", evidence_refs: []
    };
  });
  return {
    schema: "revit-operator.general-revit-independent-review/v1", run_id: runId,
    source_run_sha256: sha256Value({ run_id: runId, traces }),
    criteria_sha256: sha256Value(selectedCases.map(entry => ({ case_id: entry.case_id, acceptance_review: entry.acceptance_review }))),
    review_instructions: [
      "Review independently of the candidate's completion claim. The runtime score is provisional until every case is adjudicated.",
      "Cite retained native pre/postcondition records, rendered artifacts or observed UI evidence for each passing delivery and collateral criterion. Assistant prose and a generic completed flag are insufficient.",
      "Evidence references must resolve within the retained run evidence or its explicitly hashed companion artifacts. Record the file and JSON pointer, page or image identity.",
      "Clarification and fixture blockers are separate outcomes and never count as delivered work. Do not invent missing information or retroactively supply follow-ups to the baseline.",
      "A verified no-op requires complete target-bound proof that the requested state already held. A relevant read alone is insufficient.",
      "Use unverified when evidence is insufficient; do not infer collateral safety from the absence of a reported error. Preserve failed baselines and record repairs as separate runs."
    ], cases
  };
}

// This validates review completeness and provenance, not the meaning of evidence.
// The independent reviewer must inspect every cited record/artifact; a generated
// packet is deliberately incapable of yielding a delivered score by itself.
export function summarizeGeneralRevitAcceptanceReview(original: AcceptanceReviewPacket, reviewed: AcceptanceReviewPacket) {
  if (original.schema !== reviewed.schema || original.run_id !== reviewed.run_id
    || original.source_run_sha256 !== reviewed.source_run_sha256 || original.criteria_sha256 !== reviewed.criteria_sha256
    || reviewed.cases.length !== original.cases.length) throw new Error("Independent review source identity drifted.");
  const byId = new Map(reviewed.cases.map(entry => [entry.case_id, entry]));
  if (byId.size !== reviewed.cases.length) throw new Error("Independent review contains duplicate cases.");
  for (const expected of original.cases) {
    const actual = byId.get(expected.case_id);
    if (!actual || actual.source_case_sha256 !== expected.source_case_sha256 || actual.raw_trace_sha256 !== expected.raw_trace_sha256
      || actual.prompt !== expected.prompt) throw new Error(`Independent review changed case identity: ${expected.case_id}.`);
    for (const kind of ["delivery", "collateral"] as const) {
      if (sha256Value(actual[kind].map(check => check.criterion)) !== sha256Value(expected[kind].map(check => check.criterion))) {
        throw new Error(`Independent review changed ${kind} criteria: ${expected.case_id}.`);
      }
      for (const check of actual[kind]) {
        if (!["pending", "pass", "fail", "unverifiable"].includes(check.status)) throw new Error("Unknown review check status.");
        if (check.status === "pass" && (!check.explanation.trim() || !check.evidence_refs.length || check.evidence_refs.some(ref => !ref.trim()))) {
          throw new Error(`Passing review criterion has no evidence: ${expected.case_id}.`);
        }
      }
    }
    if (!["pending", "delivered", "verified_noop", "clarification", "fixture_blocked", "failed", "unverified"].includes(actual.outcome)) {
      throw new Error("Unknown independent review outcome.");
    }
    if (actual.outcome !== "pending" && (!actual.explanation.trim() || !actual.evidence_refs.length)) throw new Error("Adjudicated outcome requires an explanation and evidence.");
    if (["delivered", "verified_noop"].includes(actual.outcome)
      && [...actual.delivery, ...actual.collateral].some(check => check.status !== "pass")) {
      throw new Error(`Delivered or no-op outcome has incomplete or failed criteria: ${expected.case_id}.`);
    }
  }
  const count = (outcome: AcceptanceReviewCase["outcome"]) => reviewed.cases.filter(entry => entry.outcome === outcome).length;
  const pending = count("pending");
  return {
    total: reviewed.cases.length, adjudicated: reviewed.cases.length - pending,
    qualification_status: pending ? "pending_independent_review" : "independently_reviewed",
    delivered: count("delivered"), verified_noop: count("verified_noop"), clarification: count("clarification"),
    fixture_blocked: count("fixture_blocked"), failed: count("failed"), unverified: count("unverified"), pending,
    delivery_rate: pending || !reviewed.cases.length ? null : count("delivered") / reviewed.cases.length
  };
}
