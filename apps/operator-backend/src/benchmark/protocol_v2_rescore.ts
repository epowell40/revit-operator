import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./files.js";
import { sha256File, sha256Value } from "./protocol_v2_hash.js";
import { readBenchmarkRawReportV2, validateBenchmarkCaseResultV2 } from "./protocol_v2_report.js";
import {
  BENCHMARK_RESCORE_V2_SCHEMA,
  type BenchmarkCaseResultV2,
  type BenchmarkRescoreArtifactV2,
  type BenchmarkVerdictChangeV2
} from "./protocol_v2_types.js";

export type BenchmarkRescoreDecisionV2 = {
  result: BenchmarkCaseResultV2;
  explanation: string;
};

export function buildBenchmarkRescoreV2(args: {
  sourceReportPath: string;
  evaluatorVersion: string;
  rescoredAt: string;
  reevaluate: (source: BenchmarkCaseResultV2) => BenchmarkRescoreDecisionV2;
}): BenchmarkRescoreArtifactV2 {
  const source = readBenchmarkRawReportV2(args.sourceReportPath);
  if (!args.evaluatorVersion.trim()) throw new Error("Rescore requires an explicit evaluator version.");
  const changes: BenchmarkVerdictChangeV2[] = [];
  const cases = source.cases.map((original) => {
    const decision = args.reevaluate(structuredClone(original));
    validateBenchmarkCaseResultV2(decision.result);
    if (decision.result.case_id !== original.case_id || decision.result.raw_trace_sha256 !== original.raw_trace_sha256) {
      throw new Error(`Rescore cannot change case or raw execution evidence identity for ${original.case_id}.`);
    }
    if (JSON.stringify(decision.result.original_evaluator_verdict) !== JSON.stringify(original.original_evaluator_verdict)) {
      throw new Error(`Rescore cannot overwrite the original evaluator verdict for ${original.case_id}.`);
    }
    if (decision.result.current_evaluator_verdict.version !== args.evaluatorVersion) {
      throw new Error(`Rescore evaluator version mismatch for ${original.case_id}.`);
    }
    if (decision.result.current_evaluator_verdict.verdict !== original.current_evaluator_verdict.verdict) {
      if (!decision.explanation.trim()) throw new Error(`Changed verdict for ${original.case_id} requires an explanation.`);
      changes.push({
        case_id: original.case_id,
        original_verdict: original.current_evaluator_verdict.verdict,
        current_verdict: decision.result.current_evaluator_verdict.verdict,
        explanation: decision.explanation.trim()
      });
    }
    return decision.result;
  });
  const unsigned = {
    schema: BENCHMARK_RESCORE_V2_SCHEMA,
    source_report_ref: path.resolve(args.sourceReportPath),
    source_report_sha256: sha256File(args.sourceReportPath),
    source_run_id: source.envelope.identity.run_id,
    evaluator_version: args.evaluatorVersion,
    rescored_at: args.rescoredAt,
    cases,
    verdict_changes: changes
  };
  return { ...unsigned, rescore_sha256: sha256Value(unsigned) };
}

export function writeBenchmarkRescoreV2(outputPath: string, artifact: BenchmarkRescoreArtifactV2): string {
  if (fs.existsSync(outputPath)) throw new Error(`Immutable rescore artifact already exists: ${outputPath}`);
  const { rescore_sha256: recorded, ...unsigned } = artifact;
  if (artifact.schema !== BENCHMARK_RESCORE_V2_SCHEMA || sha256Value(unsigned) !== recorded) {
    throw new Error("Benchmark rescore artifact is invalid or has been modified.");
  }
  if (sha256File(artifact.source_report_ref) !== artifact.source_report_sha256) {
    throw new Error("Benchmark rescore source report changed after it was identified.");
  }
  writeJsonFile(outputPath, artifact);
  return path.resolve(outputPath);
}

export function readBenchmarkRescoreV2(inputPath: string): BenchmarkRescoreArtifactV2 {
  const artifact = readJsonFile<BenchmarkRescoreArtifactV2>(inputPath);
  const { rescore_sha256: recorded, ...unsigned } = artifact;
  if (sha256Value(unsigned) !== recorded) throw new Error("Benchmark rescore hash does not match immutable content.");
  return artifact;
}
