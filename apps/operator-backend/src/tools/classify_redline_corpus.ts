import path from "node:path";
import { repoRoot } from "../benchmark/files.js";
import { classifyRedlineCorpusDirectory, classifyRedlineCorpusDirectoryWithAnalyzer, writeRedlineCorpusReport } from "../redline/corpus_classifier.js";

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const source = flagValue(process.argv, "--source");
const output = flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus-classification");
const useAnalyzer = hasFlag(process.argv, "--analyze");
const maxPages = numberFlag(process.argv, "--max-pages") ?? 2;

if (!source) {
  console.error("Usage: npm run redline:classify-corpus -- --source <pdf-folder> [--output <output-folder>] [--analyze] [--max-pages <n>]");
  process.exit(2);
}

const sourceDir = path.resolve(source);
const outputDir = path.resolve(output);
const originalWorkspaceRoot = process.env.OPERATOR_WORKSPACE_ROOT;
let report;
try {
  if (useAnalyzer) process.env.OPERATOR_WORKSPACE_ROOT = sourceDir;
  report = useAnalyzer
    ? await classifyRedlineCorpusDirectoryWithAnalyzer(sourceDir, { maxPages, timeoutMs: 60_000 })
    : classifyRedlineCorpusDirectory(sourceDir);
} finally {
  if (useAnalyzer) {
    if (originalWorkspaceRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = originalWorkspaceRoot;
  }
}
const written = writeRedlineCorpusReport(report, outputDir);

console.log(JSON.stringify({
  ok: true,
  source_dir: sourceDir,
  output_dir: outputDir,
  input_count: report.input_count,
  classified_count: report.classified_count,
  by_operation: report.by_operation,
  by_target: report.by_target,
  by_context: report.by_context,
  by_evidence_requirement: report.by_evidence_requirement,
  by_model_write_requirement: report.by_model_write_requirement,
  by_visual_gate_requirement: report.by_visual_gate_requirement,
  manual_review_count: report.manual_review_count,
  live_benchmark_queue_count: report.live_benchmark_queue.length,
  by_recommended_task: report.by_recommended_task,
  analyzer_enabled: useAnalyzer,
  max_pages: useAnalyzer ? maxPages : undefined,
  json: written.jsonPath,
  csv: written.csvPath,
  queue_json: written.queueJsonPath,
  queue_csv: written.queueCsvPath,
  live_request_template: written.liveOverrideTemplatePath,
  review_markdown: written.reviewMarkdownPath
}, null, 2));
