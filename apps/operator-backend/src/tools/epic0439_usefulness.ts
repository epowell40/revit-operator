import path from "node:path";
import {
  loadEpic0439UsefulnessManifest,
  materializeEpic0439Cases,
  readEpic0439Results,
  validateEpic0439UsefulnessManifest,
  writeEpic0439ReportArtifacts
} from "../benchmark/epic0439_usefulness.js";
import { ingestEpic0439EvidenceCampaign } from "../benchmark/epic0439_evidence.js";
import { readJsonFile, writeJsonFile } from "../benchmark/files.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error([
    "EPIC-0439 usefulness benchmark",
    "",
    "  npm run benchmark:epic0439 -- validate",
    "  npm run benchmark:epic0439 -- materialize --seed <seed> --output <cases.json> [--variants 1] [--holdout] [--reviewer-wording <json>]",
    "  npm run benchmark:epic0439 -- report --results <results.json> --output-dir <dir>",
    "  npm run benchmark:epic0439 -- report-evidence --cases <cases.json> --manifest <evidence.json> --evidence-root <dir> --output-dir <dir>",
    "",
    "Materialization creates task cases only. It does not execute Revit or fabricate outcomes."
  ].join("\n"));
  process.exit(2);
}

const command = process.argv[2];
const manifest = loadEpic0439UsefulnessManifest();

if (command === "validate") {
  validateEpic0439UsefulnessManifest(manifest);
  console.log(JSON.stringify({ valid: true, suite_id: manifest.suite_id, task_count: manifest.tasks.length }, null, 2));
} else if (command === "materialize") {
  const seed = flag("--seed");
  const output = flag("--output");
  if (!seed || !output) usage();
  const variants = Number(flag("--variants") ?? "1");
  if (!Number.isInteger(variants) || variants < 1) throw new Error("--variants must be a positive integer.");
  const reviewerWordingPath = flag("--reviewer-wording");
  const reviewerWording = reviewerWordingPath
    ? readJsonFile<Record<string, string[]>>(path.resolve(reviewerWordingPath))
    : undefined;
  const wordingPartition = reviewerWordingPath
    ? "reviewer_holdout" as const
    : process.argv.includes("--holdout")
      ? "holdout" as const
      : "implementation" as const;
  const cases = materializeEpic0439Cases(manifest, {
    seed,
    variants_per_task: variants,
    wording_partition: wordingPartition,
    reviewer_wording: reviewerWording
  });
  const outputPath = path.resolve(output);
  writeJsonFile(outputPath, {
    schema_version: "epic0439_case_set/v1",
    suite_id: manifest.suite_id,
    evidence_tier: "source_only",
    generated_outcomes: false,
    seed,
    wording_partition: wordingPartition,
    cases
  });
  console.log(JSON.stringify({ output: outputPath, cases: cases.length, evidence_tier: "source_only" }, null, 2));
} else if (command === "report") {
  const resultsPath = flag("--results");
  const outputDir = flag("--output-dir");
  if (!resultsPath || !outputDir) usage();
  const results = readEpic0439Results(path.resolve(resultsPath));
  const report = writeEpic0439ReportArtifacts(path.resolve(outputDir), manifest, results);
  console.log(JSON.stringify({
    output_dir: path.resolve(outputDir),
    result_count: report.result_count,
    live_revit_result_count: report.live_revit_result_count,
    live_acceptance_claimable: report.live_acceptance_claimable,
    evidence_warning: report.evidence_warning
  }, null, 2));
} else if (command === "report-evidence") {
  const casesPath = flag("--cases");
  const evidenceManifestPath = flag("--manifest");
  const evidenceRoot = flag("--evidence-root");
  const outputDir = flag("--output-dir");
  if (!casesPath || !evidenceManifestPath || !evidenceRoot || !outputDir) usage();
  const resolvedOutput = path.resolve(outputDir);
  const results = ingestEpic0439EvidenceCampaign({
    manifest,
    caseSetPath: path.resolve(casesPath),
    evidenceManifestPath: path.resolve(evidenceManifestPath),
    evidenceRoot: path.resolve(evidenceRoot)
  });
  writeJsonFile(path.join(resolvedOutput, "epic0439_scorer_owned_results.json"), results);
  const report = writeEpic0439ReportArtifacts(resolvedOutput, manifest, results);
  console.log(JSON.stringify({
    output_dir: resolvedOutput,
    result_count: report.result_count,
    unverified_live_result_count: report.unverified_live_result_count,
    live_acceptance_claimable: report.live_acceptance_claimable,
    evidence_warning: report.evidence_warning
  }, null, 2));
} else {
  usage();
}
