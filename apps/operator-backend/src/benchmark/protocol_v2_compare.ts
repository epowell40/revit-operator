import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";
import { sha256Value } from "./protocol_v2_hash.js";
import { readBenchmarkRawReportV2 } from "./protocol_v2_report.js";

type ComparisonDeltaV2 = {
  case_id: string;
  baseline_delivery_verdict: string;
  candidate_delivery_verdict: string;
  baseline_effect_state: string;
  candidate_effect_state: string;
  baseline_first_failure: string | null;
  candidate_first_failure: string | null;
  completion_time_delta_ms: number | null;
};

export type BenchmarkExactRerunComparisonV2 = {
  schema: "revit-operator.benchmark-exact-rerun-comparison/v2";
  baseline: { run_id: string; report_sha256: string; public_revision: string; private_revision: string };
  candidate: { run_id: string; report_sha256: string; public_revision: string; private_revision: string };
  immutable_case_contract_match: true;
  envelope_changes: string[];
  case_deltas: ComparisonDeltaV2[];
  comparison_sha256: string;
};

function requireSame(label: string, baseline: unknown, candidate: unknown): void {
  if (sha256Value(baseline) !== sha256Value(candidate)) {
    throw new Error(`Exact rerun comparison rejected ${label} drift.`);
  }
}

export function compareBenchmarkExactRerunsV2(baselinePath: string, candidatePath: string): BenchmarkExactRerunComparisonV2 {
  const baseline = readBenchmarkRawReportV2(baselinePath);
  const candidate = readBenchmarkRawReportV2(candidatePath);
  requireSame("protocol version", baseline.envelope.protocol_version, candidate.envelope.protocol_version);
  requireSame("corpus and case hashes", baseline.envelope.corpus, candidate.envelope.corpus);
  requireSame("execution lane", baseline.envelope.execution_lane, candidate.envelope.execution_lane);
  requireSame("fixture adapter and RVT hashes", baseline.envelope.fixture_adapter, candidate.envelope.fixture_adapter);
  requireSame("Revit version", baseline.envelope.revit_version, candidate.envelope.revit_version);
  requireSame("evaluator version", baseline.envelope.evaluator_version, candidate.envelope.evaluator_version);
  requireSame("instruction bundle hashes", baseline.envelope.instruction_bundle_hashes, candidate.envelope.instruction_bundle_hashes);
  requireSame("requested model and effort", baseline.envelope.requested_agent, candidate.envelope.requested_agent);
  requireSame("feature flags", baseline.envelope.feature_flags, candidate.envelope.feature_flags);
  requireSame("authorization mode", baseline.envelope.authorization_mode, candidate.envelope.authorization_mode);
  const baselineByCase = new Map(baseline.cases.map((entry) => [entry.case_id, entry]));
  requireSame("case result identities", baseline.cases.map((entry) => entry.case_id).sort(), candidate.cases.map((entry) => entry.case_id).sort());
  const caseDeltas = candidate.cases.map((next): ComparisonDeltaV2 => {
    const prior = baselineByCase.get(next.case_id)!;
    const priorDuration = prior.metrics.completion_time_ms;
    const nextDuration = next.metrics.completion_time_ms;
    return {
      case_id: next.case_id,
      baseline_delivery_verdict: prior.delivery_verdict,
      candidate_delivery_verdict: next.delivery_verdict,
      baseline_effect_state: prior.execution_truth.effect_state,
      candidate_effect_state: next.execution_truth.effect_state,
      baseline_first_failure: prior.first_failed_or_uncertain_stage,
      candidate_first_failure: next.first_failed_or_uncertain_stage,
      completion_time_delta_ms: priorDuration === null || nextDuration === null ? null : nextDuration - priorDuration
    };
  });
  const envelopeChanges = [
    baseline.envelope.installed_release_identity === candidate.envelope.installed_release_identity ? null : "installed_release_identity",
    baseline.envelope.source_revisions.public === candidate.envelope.source_revisions.public ? null : "public_source_revision",
    baseline.envelope.source_revisions.private === candidate.envelope.source_revisions.private ? null : "private_source_revision",
    sha256Value(baseline.envelope.policy_hashes) === sha256Value(candidate.envelope.policy_hashes) ? null : "policy_hashes",
    sha256Value(baseline.envelope.observed_provider_routes) === sha256Value(candidate.envelope.observed_provider_routes) ? null : "observed_provider_routes"
  ].filter((entry): entry is string => entry !== null);
  const unsigned = {
    schema: "revit-operator.benchmark-exact-rerun-comparison/v2" as const,
    baseline: { run_id: baseline.envelope.identity.run_id, report_sha256: baseline.report_sha256, public_revision: baseline.envelope.source_revisions.public, private_revision: baseline.envelope.source_revisions.private },
    candidate: { run_id: candidate.envelope.identity.run_id, report_sha256: candidate.report_sha256, public_revision: candidate.envelope.source_revisions.public, private_revision: candidate.envelope.source_revisions.private },
    immutable_case_contract_match: true as const,
    envelope_changes: envelopeChanges,
    case_deltas: caseDeltas
  };
  return { ...unsigned, comparison_sha256: sha256Value(unsigned) };
}

export function writeBenchmarkExactRerunComparisonV2(outputPath: string, comparison: BenchmarkExactRerunComparisonV2): string {
  if (fs.existsSync(outputPath)) throw new Error(`Immutable exact-rerun comparison already exists: ${outputPath}`);
  const { comparison_sha256: recorded, ...unsigned } = comparison;
  if (sha256Value(unsigned) !== recorded) throw new Error("Exact-rerun comparison hash does not match its content.");
  writeJsonFile(outputPath, comparison);
  return path.resolve(outputPath);
}
