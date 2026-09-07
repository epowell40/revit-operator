import { summarizeGeneralRevitAcceptanceReview, type AcceptanceReviewPacket } from "./general_revit_acceptance_review.js";
import { sha256Value } from "./protocol_v2_hash.js";
import type { BenchmarkRawReportV2 } from "./protocol_v2_types.js";

export type BenchmarkIndependentReviewV2 = { original: AcceptanceReviewPacket; reviewed: AcceptanceReviewPacket };
export type BenchmarkQualificationV2 = {
  independent_review_status: "not_recorded" | "pending_independent_review" | "independently_reviewed";
  runtime_score_is_provisional: boolean;
  delivery_and_collateral_accepted: boolean;
  release_readiness: "not_assessed";
  review_sha256: string | null;
};

/** Runtime pass and absence of detected blocking failures never establish release qualification. */
export function benchmarkQualificationV2(report: Pick<BenchmarkRawReportV2, "envelope" | "cases" | "independent_review">): BenchmarkQualificationV2 {
  const evidence = report.independent_review;
  if (!evidence) return { independent_review_status: "not_recorded", runtime_score_is_provisional: true,
    delivery_and_collateral_accepted: false, release_readiness: "not_assessed", review_sha256: null };
  const { original, reviewed } = evidence;
  const summary = summarizeGeneralRevitAcceptanceReview(original, reviewed);
  if (original.run_id !== report.envelope.identity.run_id || original.cases.length !== report.cases.length) {
    throw new Error("Independent review does not bind this raw report run/case set.");
  }
  for (const result of report.cases) {
    const expected = original.cases.find(entry => entry.case_id === result.case_id);
    if (!expected || expected.source_case_sha256 !== result.case_sha256 || expected.raw_trace_sha256 !== result.raw_trace_sha256) {
      throw new Error(`Independent review does not bind raw case evidence: ${result.case_id}.`);
    }
  }
  const complete = summary.pending === 0;
  return { independent_review_status: complete ? "independently_reviewed" : "pending_independent_review",
    runtime_score_is_provisional: !complete,
    delivery_and_collateral_accepted: complete && reviewed.cases.every(entry => ["delivered", "verified_noop"].includes(entry.outcome)
      && entry.delivery.length > 0 && entry.collateral.length > 0
      && [...entry.delivery, ...entry.collateral].every(check => check.status === "pass")),
    release_readiness: "not_assessed", review_sha256: sha256Value(evidence) };
}

/** Validate an independently completed packet using the existing review owner; create a new immutable report. */
export function attachBenchmarkIndependentReviewV2(report: BenchmarkRawReportV2, evidence: BenchmarkIndependentReviewV2): BenchmarkRawReportV2 {
  const { report_sha256: _hash, ...source } = report;
  if (sha256Value(source) !== _hash) throw new Error("Cannot attach review to a changed raw report.");
  const withEvidence = { ...source, independent_review: structuredClone(evidence) };
  const unsigned = { ...withEvidence, qualification: benchmarkQualificationV2(withEvidence) };
  return { ...unsigned, report_sha256: sha256Value(unsigned) };
}
