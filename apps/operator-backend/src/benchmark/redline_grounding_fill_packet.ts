import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type { RedlineGroundingReport } from "./redline_grounding_report.js";

type JsonMap = Record<string, unknown>;

type PlaceholderFillEntry = {
  placeholder_path: string;
  current_template_value: unknown;
  suggested_evidence: string;
};

export type RedlineGroundingFillPacket = {
  schema_version: 1;
  source_report_path: string;
  selected_rank: number;
  selected_redline_id: string;
  candidate: RedlineGroundingReport["ranked_candidates"][number];
  model_availability?: RedlineGroundingReport["model_availability"];
  placeholder_fill_entries: PlaceholderFillEntry[];
  evidence_checklist: string[];
  command_sequence: string[];
  live_grounding_sequence: string[];
  guardrails: string[];
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
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

function valueAtPath(root: unknown, dottedPath: string): unknown {
  let current: unknown = root;
  for (const part of dottedPath.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonMap)[part];
  }
  return current;
}

function templateTaskValue(candidate: RedlineGroundingReport["ranked_candidates"][number]): unknown {
  const link = candidate.template_link;
  if (!link?.template_path || !fs.existsSync(link.template_path)) return undefined;
  const template = readJsonFile<unknown>(link.template_path);
  return asObject(asObject(template).tasks)[link.task_key];
}

function placeholderEntries(candidate: RedlineGroundingReport["ranked_candidates"][number]): PlaceholderFillEntry[] {
  const link = candidate.template_link;
  if (!link) return [];
  const task = templateTaskValue(candidate);
  return link.placeholder_paths.map((placeholderPath) => {
    const hint = link.placeholder_evidence_hints.find((entry) => entry.placeholder_path === placeholderPath);
    return {
      placeholder_path: placeholderPath,
      current_template_value: valueAtPath(task, placeholderPath),
      suggested_evidence: hint?.suggested_evidence ?? `Fill ${placeholderPath} from exact live Revit evidence.`
    };
  });
}

function commandSequence(candidate: RedlineGroundingReport["ranked_candidates"][number]): string[] {
  const link = candidate.template_link;
  if (!link) return [];
  return [
    link.promotion_command,
    link.validation_command,
    link.preflight_command,
    "$env:OPERATOR_BENCHMARK_USE_MOCKS='0'; npm run benchmark -- run --task " + candidate.task_id + " --config deterministic_skill_only --repeat 1 --batch-id real_corpus_grounding_candidate_smoke"
  ];
}

function selectCandidate(report: RedlineGroundingReport, input: { rank?: number; redlineId?: string }): { candidate: RedlineGroundingReport["ranked_candidates"][number]; rank: number } {
  if (input.redlineId) {
    const index = report.ranked_candidates.findIndex((candidate) => candidate.redline_id === input.redlineId);
    if (index < 0) throw new Error(`No grounding candidate found for redline id: ${input.redlineId}`);
    return { candidate: report.ranked_candidates[index]!, rank: index + 1 };
  }
  const rank = Math.max(1, input.rank ?? 1);
  const candidate = report.ranked_candidates[rank - 1];
  if (!candidate) throw new Error(`No grounding candidate found at rank ${rank}.`);
  return { candidate, rank };
}

export function buildRedlineGroundingFillPacket(input: {
  report: RedlineGroundingReport;
  sourceReportPath: string;
  rank?: number;
  redlineId?: string;
}): RedlineGroundingFillPacket {
  const selected = selectCandidate(input.report, { rank: input.rank, redlineId: input.redlineId });
  const candidate = selected.candidate;
  const commands = commandSequence(candidate);
  const modelAvailability = input.report.model_availability;
  const sourceModelGate = modelAvailability?.metrics.match_count === 0
    ? ["No local source-model candidate was found by the attached model availability scan; locate and open the exact project RVT before filling this row."]
    : [];
  return {
    schema_version: 1,
    source_report_path: input.sourceReportPath,
    selected_rank: selected.rank,
    selected_redline_id: candidate.redline_id,
    candidate,
    ...(modelAvailability ? { model_availability: modelAvailability } : {}),
    placeholder_fill_entries: placeholderEntries(candidate),
    evidence_checklist: [
      ...sourceModelGate,
      ...candidate.next_actions,
      ...candidate.missing_live_inputs.map((inputName) => `Record live evidence for missing input: ${inputName}.`)
    ],
    command_sequence: commands,
    live_grounding_sequence: [
      "Open the exact source Revit model identified by the corpus row.",
      "Confirm active document and target view/sheet with the bridge and visible UI.",
      "Collect no-write inventory/readback evidence for every placeholder.",
      "Fill the linked template and validate it with placeholder count zero.",
      "Run preflight with the filled override and selected task only.",
      "Run a mocks-disabled live benchmark only after the filled override has ready_to_run:true and reviewed evidence.",
      "Generate a run-specific promotion manifest only after the live run passes with cleanup/revert evidence."
    ],
    guardrails: [
      "This packet is not an approval and does not set ready_to_run.",
      "Do not use Snowdon workflow proof to promote B300/Duke corpus rows.",
      ...(modelAvailability?.metrics.match_count === 0 ? ["The attached model availability scan found no candidate source RVT; do not run this row until the exact source model is available."] : []),
      "Do not run mutating live commands until exact model/view/target/change/readback/visual/revert evidence is reviewed.",
      "Do not mark the row executable until the scorecard sees a row-linked approved promotion with ready_to_run:true."
    ]
  };
}

function reportMarkdown(packet: RedlineGroundingFillPacket): string {
  const candidate = packet.candidate;
  return [
    "# Redline Grounding Fill Packet",
    "",
    `Source report: ${packet.source_report_path}`,
    `Selected rank: ${packet.selected_rank}`,
    `Redline id: ${packet.selected_redline_id}`,
    "",
    "## Candidate",
    markdownTable(["field", "value"], [
      ["source", candidate.source_file_path],
      ["type", candidate.redline_type],
      ["task", candidate.task_id],
      ["workflow", candidate.workflow],
      ["priority_score", candidate.priority_score],
      ["reviewed_live_evidence_available", candidate.reviewed_live_evidence_available ? "yes" : "no"],
      ["repeatability_ready", candidate.repeatability_ready ? "yes" : "no"],
      ["missing_live_inputs", candidate.missing_live_inputs.join(", ")]
    ]),
    "",
    ...(packet.model_availability ? [
      "## Source Model Availability",
      markdownTable(["field", "value"], [
        ["scan_report", packet.model_availability.source_path],
        ["match_count", packet.model_availability.metrics.match_count],
        ["timed_out_root_count", packet.model_availability.metrics.timed_out_root_count],
        ["patterns", packet.model_availability.patterns.join(", ")],
        ["recommendation", packet.model_availability.recommendation]
      ]),
      packet.model_availability.top_matches.length > 0
        ? markdownTable(["score", "file", "matched_patterns", "last_write_time", "path"], packet.model_availability.top_matches.map((match) => [
          match.score,
          match.file_name,
          match.matched_patterns.join(", "),
          match.last_write_time,
          match.path
        ]))
        : "No candidate source RVT files were found in the attached model availability report.",
      ""
    ] : []),
    "## Template",
    candidate.template_link
      ? markdownTable(["field", "value"], [
        ["batch", candidate.template_link.batch_id],
        ["key", candidate.template_link.task_key],
        ["template", candidate.template_link.template_path],
        ["checklist", candidate.template_link.checklist_path ?? ""],
        ["output_override", candidate.template_link.output_override_path ?? ""]
      ])
      : "No linked template was found for this candidate.",
    "",
    "## Placeholder Fill Entries",
    packet.placeholder_fill_entries.length > 0
      ? markdownTable(["placeholder", "current_template_value", "suggested_evidence"], packet.placeholder_fill_entries.map((entry) => [
        entry.placeholder_path,
        typeof entry.current_template_value === "undefined" ? "" : JSON.stringify(entry.current_template_value),
        entry.suggested_evidence
      ]))
      : "No placeholders were linked.",
    "",
    "## Evidence Checklist",
    ...packet.evidence_checklist.map((entry) => `- ${entry}`),
    "",
    "## Command Sequence",
    packet.command_sequence.length > 0
      ? ["```powershell", ...packet.command_sequence, "```"].join("\n")
      : "No command sequence is available until a template is linked.",
    "",
    "## Live Grounding Sequence",
    ...packet.live_grounding_sequence.map((entry) => `- ${entry}`),
    "",
    "## Guardrails",
    ...packet.guardrails.map((entry) => `- ${entry}`),
    ""
  ].join("\n");
}

export function writeRedlineGroundingFillPacket(input: {
  reportPath: string;
  outputDir: string;
  rank?: number;
  redlineId?: string;
}): { json_path: string; markdown_path: string; packet: RedlineGroundingFillPacket } {
  const reportPath = path.resolve(input.reportPath);
  const outputDir = path.resolve(input.outputDir);
  const report = readJsonFile<RedlineGroundingReport>(reportPath);
  const packet = buildRedlineGroundingFillPacket({
    report,
    sourceReportPath: reportPath,
    rank: input.rank,
    redlineId: input.redlineId
  });
  ensureDir(outputDir);
  const jsonPath = path.join(outputDir, "redline_grounding_fill_packet.json");
  const markdownPath = path.join(outputDir, "redline_grounding_fill_packet.md");
  writeJsonFile(jsonPath, packet);
  writeTextFile(markdownPath, reportMarkdown(packet));
  return { json_path: jsonPath, markdown_path: markdownPath, packet };
}
