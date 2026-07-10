import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type { RedlineHardeningScorecard, RedlineStructuredActionRecord } from "./redline_hardening_scorecard.js";
import type { RedlineModelAvailabilityReport } from "./redline_model_availability.js";

type JsonMap = Record<string, unknown>;

type GroundingTemplateLink = {
  batch_id: string;
  task_key: string;
  template_path: string;
  checklist_path?: string;
  output_override_path?: string;
  placeholder_paths: string[];
  placeholder_evidence_hints: Array<{
    placeholder_path: string;
    suggested_evidence: string;
  }>;
  validation_command: string;
  promotion_command: string;
  preflight_command: string;
};

type GroundingCandidate = {
  redline_id: string;
  source_file_path: string;
  redline_type: string;
  task_id: string;
  workflow: string;
  missing_live_inputs: string[];
  evidence_requirements: string[];
  reviewed_live_evidence_available: boolean;
  repeatability_ready: boolean;
  needs_human_review: boolean;
  priority_score: number;
  next_actions: string[];
  template_link?: GroundingTemplateLink;
};

type GroundingModelAvailability = {
  source_path: string;
  metrics: RedlineModelAvailabilityReport["metrics"];
  patterns: string[];
  recommendation: string;
  top_matches: Array<{
    path: string;
    file_name: string;
    score: number;
    matched_patterns: string[];
    last_write_time: string;
  }>;
};

export type RedlineGroundingReport = {
  schema_version: 1;
  source_scorecard_path: string;
  model_availability?: GroundingModelAvailability;
  metrics: RedlineHardeningScorecard["metrics"];
  top_required_context: RedlineHardeningScorecard["top_required_context"];
  ranked_candidates: GroundingCandidate[];
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
}

function missingInputAction(input: string): string {
  if (input === "open_revit_model") return "Open and verify the exact source Revit model, not a Snowdon surrogate.";
  if (/view|sheet/i.test(input)) return "Resolve the exact live view/sheet id and confirm it matches the redline source.";
  if (/category/i.test(input)) return "Resolve the exact Revit category and confirm the redline is not a filter/template/link override.";
  if (/graphics|override/i.test(input)) return "Capture before-state graphics/readback and define the requested override plus revert behavior.";
  if (/visual|capture/i.test(input)) return "Capture before/after/final visual evidence from the target view.";
  if (/cleanup|revert/i.test(input)) return "Define and verify cleanup or revert evidence before promotion.";
  if (/route|point|connector|system|level|plane/i.test(input)) return "Resolve route endpoints, system, level/plane, connector/readback, and cleanup evidence from the live model.";
  if (/tag/i.test(input)) return "Resolve exact tag id, tagged element, type/value source, inventory, visual, and revert evidence.";
  return `Fill and verify \`${input}\` from live Revit evidence.`;
}

function placeholderEvidenceHint(placeholderPath: string, candidate: GroundingCandidate): string {
  const normalizedPath = placeholderPath.toLowerCase();
  const type = candidate.redline_type.toLowerCase();
  if (/viewid|visualviewid|sheetid|sheetnumber/.test(normalizedPath)) {
    return "Use live bridge context/view discovery to fill the exact target view or sheet id, then confirm it matches the source redline sheet.";
  }
  if (/categoryvisibility\.categoryname|categoryname/.test(normalizedPath)) {
    return "Use live visible-element/category inventory and the redline markup to choose the exact Revit category; confirm it is not a filter, template, linked model, phase, or CAD-layer override.";
  }
  if (/graphics|override|lineweight|halftone|visibility/.test(normalizedPath) || /graphics_override/.test(type)) {
    return "Capture before-state graphics/readback, define the requested override and revert value, and require after/final visual evidence.";
  }
  if (/elementid|tagid|target.*id/.test(normalizedPath) || /tag/.test(type)) {
    return "Resolve the exact live element/tag id from inventory, verify its owner view and visible text or geometry, and preserve before/after/revert evidence.";
  }
  if (/route|point|connector|system|level|plane/.test(normalizedPath) || /route|reroute|tap_branch|size_transition/.test(type)) {
    return "Resolve route endpoints, host/connectors, system, level or work plane, and cleanup ids from the exact live model before applying writes.";
  }
  if (/parameter|value|mark|text|note/.test(normalizedPath)) {
    return "Read the current source value, define the requested value, verify visible/readback change, and capture revert evidence.";
  }
  return `Fill \`${placeholderPath}\` from exact live Revit evidence before validation.`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalized(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedPathTail(value: unknown): string {
  const raw = text(value).replace(/\\/g, "/");
  return normalized(raw.split("/").filter(Boolean).pop() ?? raw);
}

function sourceFileMatches(candidateSourceFile: string, templateSourceFile: string): boolean {
  const candidate = normalized(candidateSourceFile);
  const template = normalized(templateSourceFile);
  if (!candidate || !template) return false;
  return candidate === template || normalizedPathTail(candidateSourceFile) === normalizedPathTail(templateSourceFile);
}

function operationTargetFromType(redlineType: string): { operation: string; target: string } {
  const parts = redlineType.split("_");
  if (parts.length <= 1) return { operation: redlineType, target: "" };
  if (parts[0] === "graphics" && parts[1] === "override") return { operation: "graphics_override", target: parts.slice(2).join("_") };
  if (parts[0] === "reroute" && parts[1] === "offset") return { operation: "reroute_offset", target: parts.slice(2).join("_") };
  if (parts[0] === "size" && parts[1] === "transition") return { operation: "size_transition", target: parts.slice(2).join("_") };
  if (parts[0] === "type" && parts[1] === "change") return { operation: "type_change", target: parts.slice(2).join("_") };
  if (parts[0] === "parameter" && parts[1] === "edit") return { operation: "parameter_edit", target: parts.slice(2).join("_") };
  return { operation: parts[0] ?? "", target: parts.slice(1).join("_") };
}

function candidateMatchesTask(candidate: GroundingCandidate, taskKey: string, task: JsonMap): boolean {
  const source = asObject(task.corpus_source);
  const request = asObject(task.request);
  const opTarget = operationTargetFromType(candidate.redline_type);
  const sourceFile = text(source.file_path ?? request.corpusSourceFile);
  const operation = text(source.operation_class ?? request.corpusOperationClass);
  const target = text(source.target_class ?? request.corpusTargetClass);
  const benchmarkTaskId = text(task.benchmark_task_id ?? taskKey);
  return sourceFileMatches(candidate.source_file_path, sourceFile) &&
    normalized(operation) === normalized(opTarget.operation) &&
    normalized(target) === normalized(opTarget.target) &&
    (normalized(benchmarkTaskId) === normalized(candidate.task_id) || normalized(taskKey) === normalized(candidate.task_id));
}

function outputOverridePath(templatePath: string): string {
  const dir = path.dirname(templatePath);
  const match = path.basename(templatePath).match(/batch-(\d+)\.json$/i);
  return path.join(dir, `filled-live-override.${match ? `batch-${match[1]}` : "batch"}.json`);
}

function templateChecklistPath(templatePath: string): string | undefined {
  const match = path.basename(templatePath).match(/batch-(\d+)\.json$/i);
  if (!match) return undefined;
  const checklist = path.join(path.dirname(templatePath), `redline_corpus_live_fill_checklist.batch-${match[1]}.md`);
  return fs.existsSync(checklist) ? checklist : undefined;
}

function templateLinkForCandidate(candidate: GroundingCandidate, templateDir?: string): GroundingTemplateLink | undefined {
  if (!templateDir) return undefined;
  const resolvedDir = path.resolve(templateDir);
  if (!fs.existsSync(resolvedDir)) return undefined;
  const templates = fs.readdirSync(resolvedDir)
    .filter((file) => /^redline_corpus_live_request_template\.batch-\d+\.json$/i.test(file))
    .map((file) => path.join(resolvedDir, file))
    .sort();
  for (const templatePath of templates) {
    const root = readJsonFile<unknown>(templatePath);
    const rootObj = asObject(root);
    const tasks = asObject(rootObj.tasks);
    for (const [taskKey, taskValue] of Object.entries(tasks)) {
      const task = asObject(taskValue);
      if (!candidateMatchesTask(candidate, taskKey, task)) continue;
      const outputPath = outputOverridePath(templatePath);
      const placeholderPaths = Array.isArray(task.placeholder_paths) ? task.placeholder_paths.map(String) : [];
      return {
        batch_id: text(rootObj.batch_id) || path.basename(templatePath).replace(/^redline_corpus_live_request_template\./, "").replace(/\.json$/i, ""),
        task_key: taskKey,
        template_path: templatePath,
        checklist_path: templateChecklistPath(templatePath),
        output_override_path: outputPath,
        placeholder_paths: placeholderPaths,
        placeholder_evidence_hints: placeholderPaths.map((placeholderPath) => ({
          placeholder_path: placeholderPath,
          suggested_evidence: placeholderEvidenceHint(placeholderPath, candidate)
        })),
        validation_command: `npm run benchmark -- validate-revit-requests --input ${outputPath}`,
        promotion_command: `npm run redline:promote-live-template -- --template ${templatePath} --key ${taskKey} --output ${outputPath}`,
        preflight_command: `$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON='${outputPath}'; npm run benchmark -- preflight-revit`
      };
    }
  }
  return undefined;
}

function priority(record: RedlineStructuredActionRecord): number {
  let score = 100;
  score -= record.missing_live_inputs.length * 6;
  if (record.live_evidence.repeatability_ready) score += 25;
  else if (record.live_evidence.reviewed_live_evidence_available) score += 10;
  if (record.backend_ready_without_missing_inputs) score += 20;
  if (record.needs_human_review) score -= 25;
  if (!record.action.benchmark_task_exists) score -= 30;
  if (record.evidence_requirements.includes("model_write")) score -= 20;
  if (record.evidence_requirements.includes("connector_network_audit")) score -= 8;
  if (/delete/i.test(record.redline_type)) score -= 15;
  if (/route|reroute|tap_branch|size_transition/i.test(record.redline_type)) score -= 10;
  if (/reroute/i.test(record.redline_type)) score -= 10;
  if (/graphics_override|text_edit|tag/i.test(record.redline_type) && !record.evidence_requirements.includes("model_write")) score += 8;
  return score;
}

function candidateFromRecord(record: RedlineStructuredActionRecord): GroundingCandidate {
  const nextActions = unique(record.missing_live_inputs.map(missingInputAction));
  if (record.backend_ready_without_missing_inputs && !record.executable) {
    nextActions.push("Attach a reviewed row-specific promotion key from a mocks-disabled live run, or run the exact live workflow and approve its evidence.");
  }
  if (!record.live_evidence.reviewed_live_evidence_available && record.action.benchmark_task_exists) {
    nextActions.push("Run and approve live evidence for the matched benchmark task before promotion.");
  }
  return {
    redline_id: record.redline_id,
    source_file_path: record.source_file_path,
    redline_type: record.redline_type,
    task_id: record.action.benchmark_task_id ?? "",
    workflow: record.action.workflow ?? record.action.skill ?? "",
    missing_live_inputs: record.missing_live_inputs,
    evidence_requirements: record.evidence_requirements,
    reviewed_live_evidence_available: record.live_evidence.reviewed_live_evidence_available,
    repeatability_ready: record.live_evidence.repeatability_ready,
    needs_human_review: record.needs_human_review,
    priority_score: priority(record),
    next_actions: nextActions
  };
}

function modelAvailabilitySummary(reportPath?: string): GroundingModelAvailability | undefined {
  if (!reportPath) return undefined;
  const resolvedPath = path.resolve(reportPath);
  const report = readJsonFile<RedlineModelAvailabilityReport>(resolvedPath);
  return {
    source_path: resolvedPath,
    metrics: report.metrics,
    patterns: report.patterns,
    recommendation: report.recommendation,
    top_matches: report.matches.slice(0, 5).map((match) => ({
      path: match.path,
      file_name: match.file_name,
      score: match.score,
      matched_patterns: match.matched_patterns,
      last_write_time: match.last_write_time
    }))
  };
}

export function buildRedlineGroundingReport(input: {
  scorecard: RedlineHardeningScorecard;
  sourceScorecardPath: string;
  modelAvailabilityReportPath?: string;
  templateDir?: string;
  limit?: number;
}): RedlineGroundingReport {
  const limit = input.limit ?? 20;
  const ranked = input.scorecard.records
    .filter((record) => !record.executable)
    .map(candidateFromRecord)
    .sort((a, b) =>
      b.priority_score - a.priority_score ||
      a.missing_live_inputs.length - b.missing_live_inputs.length ||
      a.source_file_path.localeCompare(b.source_file_path)
    )
    .slice(0, limit)
    .map((candidate) => {
      const templateLink = templateLinkForCandidate(candidate, input.templateDir);
      return {
        ...candidate,
        ...(templateLink ? { template_link: templateLink } : {})
      };
    });

  return {
    schema_version: 1,
    source_scorecard_path: input.sourceScorecardPath,
    ...(input.modelAvailabilityReportPath ? { model_availability: modelAvailabilitySummary(input.modelAvailabilityReportPath) } : {}),
    metrics: input.scorecard.metrics,
    top_required_context: input.scorecard.top_required_context,
    ranked_candidates: ranked
  };
}

function reportMarkdown(report: RedlineGroundingReport): string {
  const metricRows = Object.entries(report.metrics).map(([metric, value]) => [metric, value]);
  const modelAvailabilityRows = report.model_availability
    ? Object.entries(report.model_availability.metrics).map(([metric, value]) => [metric, value])
    : [];
  const modelMatchRows = report.model_availability?.top_matches.map((match) => [
    match.score,
    match.file_name,
    match.matched_patterns.join(", "),
    match.last_write_time,
    match.path
  ]) ?? [];
  const candidateRows = report.ranked_candidates.map((candidate, index) => [
    index + 1,
    candidate.priority_score,
    candidate.redline_type,
    candidate.task_id,
    candidate.reviewed_live_evidence_available ? "yes" : "no",
    candidate.repeatability_ready ? "yes" : "no",
    candidate.template_link?.batch_id ?? "",
    candidate.template_link?.task_key ?? "",
    candidate.missing_live_inputs.join(", "),
    candidate.source_file_path
  ]);
  const first = report.ranked_candidates[0];
  return [
    "# Redline Grounding Report",
    "",
    `Source scorecard: ${report.source_scorecard_path}`,
    "",
    "## Metrics",
    markdownTable(["metric", "value"], metricRows),
    "",
    "## Top Required Context",
    report.top_required_context.length > 0
      ? markdownTable(["context", "count"], report.top_required_context.map((entry) => [entry.context, entry.count]))
      : "No missing required context.",
    "",
    ...(report.model_availability ? [
      "## Source Model Availability",
      `Scan report: ${report.model_availability.source_path}`,
      "",
      markdownTable(["metric", "value"], modelAvailabilityRows),
      "",
      `Patterns: ${report.model_availability.patterns.join(", ")}`,
      "",
      `Recommendation: ${report.model_availability.recommendation}`,
      "",
      modelMatchRows.length > 0
        ? markdownTable(["score", "file", "matched_patterns", "last_write_time", "path"], modelMatchRows)
        : "No candidate source RVT files were found in the provided model availability report.",
      ""
    ] : []),
    "## Ranked Grounding Candidates",
    candidateRows.length > 0
      ? markdownTable(["rank", "score", "type", "task", "reviewed", "repeatable", "batch", "template_key", "missing_live_inputs", "source"], candidateRows)
      : "No non-executable candidates.",
    "",
    "## Recommended Next Action",
  first
      ? [
          `Work row \`${first.redline_id}\` from \`${first.source_file_path}\`.`,
          "",
          ...(first.template_link ? [
            `Template: \`${first.template_link.template_path}\``,
            `Checklist: \`${first.template_link.checklist_path ?? "not found"}\``,
            `Key: \`${first.template_link.task_key}\``,
            "",
            ...(first.template_link.placeholder_evidence_hints.length > 0 ? [
              "Placeholder evidence hints:",
              "",
              ...first.template_link.placeholder_evidence_hints.map((hint) => `- \`${hint.placeholder_path}\`: ${hint.suggested_evidence}`),
              ""
            ] : []),
            "Commands after placeholders are filled:",
            "",
            "```powershell",
            first.template_link.promotion_command,
            first.template_link.validation_command,
            first.template_link.preflight_command,
            "```",
            ""
          ] : []),
          ...first.next_actions.map((action) => `- ${action}`)
        ].join("\n")
      : "No action required.",
    "",
    "## Guardrail",
    "Do not promote a row until the exact source model/view/target/change/readback/visual/revert evidence is filled and a mocks-disabled live run has reviewed run-specific promotion evidence.",
    ""
  ].join("\n");
}

export function writeRedlineGroundingReport(input: {
  scorecardPath: string;
  outputDir: string;
  modelAvailabilityReportPath?: string;
  templateDir?: string;
  limit?: number;
}): { json_path: string; markdown_path: string; report: RedlineGroundingReport } {
  const scorecardPath = path.resolve(input.scorecardPath);
  const outputDir = path.resolve(input.outputDir);
  const scorecard = readJsonFile<RedlineHardeningScorecard>(scorecardPath);
  const report = buildRedlineGroundingReport({
    scorecard,
    sourceScorecardPath: scorecardPath,
    modelAvailabilityReportPath: input.modelAvailabilityReportPath,
    templateDir: input.templateDir,
    limit: input.limit
  });
  ensureDir(outputDir);
  const jsonPath = path.join(outputDir, "redline_grounding_report.json");
  const markdownPath = path.join(outputDir, "redline_grounding_report.md");
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, reportMarkdown(report));
  return { json_path: jsonPath, markdown_path: markdownPath, report };
}
