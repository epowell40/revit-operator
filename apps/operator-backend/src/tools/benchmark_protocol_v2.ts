import path from "node:path";
import { buildBenchmarkCaseResultV2 } from "../benchmark/protocol_v2_case.js";
import { selectReleaseCanaryCasesV2 } from "../benchmark/protocol_v2_canary.js";
import { compareBenchmarkExactRerunsV2, writeBenchmarkExactRerunComparisonV2 } from "../benchmark/protocol_v2_compare.js";
import { benchmarkDataRoot, readJsonFile, sourceControlledRoots, writeJsonFile } from "../benchmark/files.js";
import {
  generalRevitExecutionCase,
  loadGeneralRevitCapabilityCorpus,
  type GeneralRevitCapabilityCase
} from "../benchmark/general_revit_capability_acceptance.js";
import {
  assertExternalHoldoutOutputV2,
  loadExternalHiddenHoldoutV2,
  redactedExternalHoldoutDescriptorV2
} from "../benchmark/protocol_v2_holdout.js";
import { validateBenchmarkRepairCohortV2, type BenchmarkRepairCohortV2 } from "../benchmark/protocol_v2_maintenance.js";
import { buildBenchmarkRescoreV2, writeBenchmarkRescoreV2 } from "../benchmark/protocol_v2_rescore.js";
import { readBenchmarkRawReportV2 } from "../benchmark/protocol_v2_report.js";
import { writeProtocolV2ReportFromFlight } from "../benchmark/protocol_v2_runner.js";
import { validateBenchmarkProtocolV2Contract, type BenchmarkProtocolV2Contract } from "../benchmark/protocol_v2_schema.js";
import type { BenchmarkCaseResultV2 } from "../benchmark/protocol_v2_types.js";

type JsonRecord = Record<string, unknown>;

function flag(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function requiredFlag(name: string): string {
  const value = flag(name).trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function tracesById(legacy: JsonRecord): Map<string, JsonRecord> {
  const traces = Array.isArray(legacy.task_traces) ? legacy.task_traces.map(record) : [];
  return new Map(traces.map((trace) => [String(trace.case_id || ""), trace]));
}

function help(): string {
  return [
    "Benchmark Protocol V2 utilities",
    "",
    "npm run benchmark:protocol-v2 -- canary-list",
    "npm run benchmark:protocol-v2 -- validate --kind run_envelope_draft|run_envelope|case_result|raw_report|rescore|external_holdout --input FILE",
    "npm run benchmark:protocol-v2 -- project --envelope FILE --legacy-report FILE --output FILE",
    "npm run benchmark:protocol-v2 -- rescore --source FILE --legacy-report FILE --evaluator-version VERSION --output FILE",
    "npm run benchmark:protocol-v2 -- compare --baseline FILE --candidate FILE [--output FILE]",
    "npm run benchmark:protocol-v2 -- holdout-describe --manifest EXTERNAL_FILE --output EXTERNAL_FILE",
    "npm run benchmark:protocol-v2 -- validate-repair-cohort --input FILE",
    "",
    "Run the frozen canary through probe:general-revit-capabilities with --release-canary and --protocol-v2-envelope."
  ].join("\n");
}

function sourceRoots(): string[] {
  return sourceControlledRoots();
}

function loadCases(): GeneralRevitCapabilityCase[] {
  return loadGeneralRevitCapabilityCorpus().cases;
}

function main(): void {
  const command = process.argv[2] || "help";
  if (command === "help" || process.argv.includes("--help")) {
    console.log(help());
    return;
  }
  if (command === "canary-list") {
    const selected = selectReleaseCanaryCasesV2(loadCases());
    console.log(JSON.stringify({ schema: "revit-operator.release-canary/v2", non_resumed_default: true, case_ids: selected.map((entry) => entry.case_id) }, null, 2));
    return;
  }
  if (command === "validate") {
    const kind = requiredFlag("--kind") as BenchmarkProtocolV2Contract;
    validateBenchmarkProtocolV2Contract(kind, readJsonFile<unknown>(path.resolve(requiredFlag("--input"))));
    console.log(JSON.stringify({ ok: true, kind }, null, 2));
    return;
  }
  if (command === "project") {
    const legacyPath = path.resolve(requiredFlag("--legacy-report"));
    const result = writeProtocolV2ReportFromFlight({
      draftPath: path.resolve(requiredFlag("--envelope")),
      legacyReportPath: legacyPath,
      outputPath: path.resolve(requiredFlag("--output")),
      cases: loadCases(),
      corpusValue: loadGeneralRevitCapabilityCorpus(),
      originalManifestPath: path.join(benchmarkDataRoot(), "general-agent", "revit-capability-acceptance.v1.json")
    });
    console.log(JSON.stringify({ output: result.json_path, report_sha256: result.report.report_sha256 }, null, 2));
    return;
  }
  if (command === "rescore") {
    const sourcePath = path.resolve(requiredFlag("--source"));
    const legacyPath = path.resolve(requiredFlag("--legacy-report"));
    const evaluatorVersion = requiredFlag("--evaluator-version");
    const source = readBenchmarkRawReportV2(sourcePath);
    const legacy = readJsonFile<JsonRecord>(legacyPath);
    const traces = tracesById(legacy);
    const cases = new Map(loadCases().map((entry) => [entry.case_id, entry]));
    const rescoredAt = new Date().toISOString();
    const artifact = buildBenchmarkRescoreV2({
      sourceReportPath: sourcePath,
      evaluatorVersion,
      rescoredAt,
      reevaluate: (original): { result: BenchmarkCaseResultV2; explanation: string } => {
        const trace = traces.get(original.case_id);
        const testCase = cases.get(original.case_id);
        if (!trace || !testCase) throw new Error(`Rescore is missing retained trace or corpus case ${original.case_id}.`);
        const executionCase = generalRevitExecutionCase(testCase, original.execution_truth.requested_effect === "apply");
        const current = buildBenchmarkCaseResultV2({
          runId: original.run_id,
          lane: original.lane,
          testCase: executionCase,
          trace,
          rawTraceRef: original.raw_trace_ref,
          judgedAt: rescoredAt,
          evaluatorVersion
        });
        current.execution_truth = original.execution_truth;
        current.original_runtime_verdict = original.original_runtime_verdict;
        current.original_evaluator_verdict = original.original_evaluator_verdict;
        current.raw_trace_sha256 = original.raw_trace_sha256;
        const changed = current.current_evaluator_verdict.verdict !== original.current_evaluator_verdict.verdict;
        return {
          result: current,
          explanation: changed
            ? `Evaluator ${evaluatorVersion} changed the verdict after reapplying the versioned stage/oracle rules to the same raw trace; first failed or uncertain stage is ${current.first_failed_or_uncertain_stage ?? "none"}.`
            : ""
        };
      }
    });
    const output = writeBenchmarkRescoreV2(path.resolve(requiredFlag("--output")), artifact);
    console.log(JSON.stringify({ output, source_report_sha256: artifact.source_report_sha256, changed_verdicts: artifact.verdict_changes.length }, null, 2));
    return;
  }
  if (command === "compare") {
    const comparison = compareBenchmarkExactRerunsV2(path.resolve(requiredFlag("--baseline")), path.resolve(requiredFlag("--candidate")));
    const output = flag("--output").trim();
    const written = output ? writeBenchmarkExactRerunComparisonV2(path.resolve(output), comparison) : null;
    console.log(JSON.stringify({ ...comparison, output: written }, null, 2));
    return;
  }
  if (command === "holdout-describe") {
    const output = path.resolve(requiredFlag("--output"));
    assertExternalHoldoutOutputV2(output, sourceRoots());
    const loaded = loadExternalHiddenHoldoutV2({ manifestPath: requiredFlag("--manifest"), forbiddenSourceRoots: sourceRoots() });
    writeJsonFile(output, redactedExternalHoldoutDescriptorV2(loaded.descriptor));
    console.log(JSON.stringify({ output, manifest_id: loaded.descriptor.manifest_id, case_count: loaded.descriptor.case_count }, null, 2));
    return;
  }
  if (command === "validate-repair-cohort") {
    validateBenchmarkRepairCohortV2(readJsonFile<BenchmarkRepairCohortV2>(path.resolve(requiredFlag("--input"))));
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }
  throw new Error(`Unknown Benchmark Protocol V2 command '${command}'.\n\n${help()}`);
}

main();
