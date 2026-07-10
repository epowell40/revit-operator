import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, repoRoot, writeJsonFile, writeTextFile } from "../benchmark/files.js";

type Actionable = boolean | "unclear";

type TextOpinionRecord = {
  id: string;
  actionable: Actionable;
  operation: string;
  target: string;
  confidence: number;
  rationale: string;
  visual_context_needed?: string;
};

type VisualRecord = {
  id: string;
  file: string;
  page: number;
  subtype: string;
  text_only?: Pick<TextOpinionRecord, "actionable" | "operation" | "target" | "confidence" | "visual_context_needed" | "rationale">;
  openai?: {
    actionable: Actionable;
    actionability_reason: string;
    operation: string;
    target: string;
    confidence: number;
    crop_sufficiency: string;
    requested_human_review: boolean;
    visual_evidence: string;
    error?: string;
  };
  gemini?: {
    actionable: Actionable;
    actionability_reason: string;
    operation: string;
    target: string;
    confidence: number;
    crop_sufficiency: string;
    requested_human_review: boolean;
    visual_evidence: string;
    error?: string;
  };
};

type ActionRecord = {
  id: string;
  source: "text" | "text+visual" | "visual";
  operation: string;
  target: string;
  confidence: number;
  reason: string;
  needsHumanReview: boolean;
  textExcerpt?: string;
};

const CAPABILITY_NOTES: Array<{
  key: string;
  title: string;
  match: (r: ActionRecord) => boolean;
  status: "covered" | "partial" | "gap";
  note: string;
  next: string;
}> = [
  {
    key: "mep_route",
    title: "MEP route creation",
    match: (r) => r.operation === "route" && ["duct", "pipe"].includes(r.target),
    status: "partial",
    note: "Route workflow exists with dry-run/apply, model ids, connector/readback checks, and visual gate, but corpus items still need reliable visual endpoint and system/level extraction.",
    next: "Use high-confidence route crops to benchmark endpoint projection and room/view anchoring."
  },
  {
    key: "mep_reroute_offset",
    title: "MEP reroute and offsets",
    match: (r) => r.operation === "reroute_offset" && ["duct", "pipe"].includes(r.target),
    status: "partial",
    note: "Segment reroute and dogleg offset support exists for bounded straight-curve cases.",
    next: "Create live corpus tasks for offset middle segment, 45-degree dogleg, and connected endpoint preservation."
  },
  {
    key: "mep_size_transition",
    title: "MEP size transitions",
    match: (r) => r.operation === "size_transition" && ["duct", "pipe"].includes(r.target),
    status: "partial",
    note: "Duct/pipe size transition tools exist for explicit target geometry, sizes, and transition point.",
    next: "Harden extraction of written size plus location, especially size/CFM calculation clusters."
  },
  {
    key: "mep_tap_branch",
    title: "MEP taps, tees, and branches",
    match: (r) => r.operation === "tap_branch" && ["duct", "pipe"].includes(r.target),
    status: "partial",
    note: "Branch/tap workflow supports guarded duct/pipe cases with fitting and connector verification.",
    next: "Add more corpus-derived branch/tap live requests, including pipe top taps and multi-branch racks."
  },
  {
    key: "mep_accessory",
    title: "MEP accessories and dampers",
    match: (r) => r.target === "mep_accessory" || (["add", "delete", "type_change", "move"].includes(r.operation) && r.target === "duct"),
    status: "partial",
    note: "Accessory insert/delete/type-change support exists when the family/type and target segment are explicit.",
    next: "Improve damper/accessory recognition from nearby symbols and handwritten directives."
  },
  {
    key: "graphics",
    title: "Graphics and lineweight overrides",
    match: (r) => r.operation === "graphics_override" || ["category_graphics", "view_filter", "cad_link"].includes(r.target),
    status: "partial",
    note: "Documentation primitive workflow covers category/filter/CAD layer override proof, including lineweight readback.",
    next: "Turn common future-work, hidden-line, CAD layer, and 1/16-scale plan requests into live benchmark fixtures."
  },
  {
    key: "tags",
    title: "Tags",
    match: (r) => r.operation === "tag" || r.target === "tag",
    status: "covered",
    note: "Tag add/move/delete workflows and native tag endpoints exist with visual/readback gates.",
    next: "Use corpus samples to expand target-category and tag-type inference."
  },
  {
    key: "text_schedule",
    title: "Text and schedules",
    match: (r) => r.operation === "text_edit" || ["text", "schedule"].includes(r.target),
    status: "partial",
    note: "Text/documentation primitives exist, but many corpus items are composite schedule-cell or note-list edits that need grouping before execution.",
    next: "Build composite grouping for strikeout plus replacement text, schedule row edits, and numbered note clusters."
  },
  {
    key: "generic_model_edits",
    title: "Generic add, move, delete, rotate, and type change",
    match: (r) => ["add", "move", "delete", "rotate", "type_change"].includes(r.operation),
    status: "partial",
    note: "General primitive workflows exist for tags, family instances, links, and explicit MEP targets.",
    next: "Broaden target selection so the same operation vocabulary works across tags, ducts, pipes, accessories, fixtures, receptacles, lights, and views."
  }
];

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function loadJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[fn(item)] = (out[fn(item)] ?? 0) + 1;
  return out;
}

function topEntries(map: Record<string, number>, limit = 20): Array<[string, number]> {
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function latestById(rows: VisualRecord[]): Map<string, VisualRecord> {
  const map = new Map<string, VisualRecord>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")} |`)
  ].join("\n");
}

async function main(): Promise<void> {
  const textOpinionPath = path.resolve(flagValue(process.argv, "--text-opinion") ?? path.join(repoRoot(), "local-work", "redline-corpus", "gemini-second-opinion", "structured-gemini35-full", "gemini_redline_second_opinion.jsonl"));
  const provider = (flagValue(process.argv, "--provider") || "openai").toLowerCase() === "gemini" ? "gemini" : "openai";
  const defaultVisualDir = provider === "gemini" ? "gemini-unresolved-visual-context" : "openai-full-visual-context";
  const visualPath = path.resolve(flagValue(process.argv, "--visual") ?? path.join(repoRoot(), "local-work", "redline-corpus", "visual-model-compare", defaultVisualDir, "visual_model_compare.jsonl"));
  const outputDir = path.resolve(flagValue(process.argv, "--output") ?? path.join(repoRoot(), "local-work", "redline-corpus", "capability-summary", defaultVisualDir));
  ensureDir(outputDir);

  const textRows = loadJsonl<TextOpinionRecord>(textOpinionPath);
  const visualRows = Array.from(latestById(loadJsonl<VisualRecord>(visualPath)).values());
  const textById = new Map(textRows.map((row) => [row.id, row]));
  const actionById = new Map<string, ActionRecord>();

  for (const row of textRows) {
    if (row.actionable !== true) continue;
    actionById.set(row.id, {
      id: row.id,
      source: "text",
      operation: row.operation || "unknown",
      target: row.target || "unknown",
      confidence: Number(row.confidence) || 0,
      reason: row.rationale || "",
      needsHumanReview: false,
      textExcerpt: row.rationale || ""
    });
  }
  for (const row of visualRows) {
    const visual = provider === "gemini" ? row.gemini : row.openai;
    if (visual?.actionable !== true) continue;
    const textActionable = textById.get(row.id)?.actionable === true;
    actionById.set(row.id, {
      id: row.id,
      source: textActionable ? "text+visual" : "visual",
      operation: visual.operation || "unknown",
      target: visual.target || "unknown",
      confidence: Number(visual.confidence) || 0,
      reason: visual.visual_evidence || "",
      needsHumanReview: Boolean(visual.requested_human_review || visual.crop_sufficiency !== "enough"),
      textExcerpt: row.text_only?.rationale || visual.visual_evidence || ""
    });
  }

  const actionRows = Array.from(actionById.values());
  const textActionable = countBy(textRows, (row) => String(row.actionable));
  const visualActionable = countBy(visualRows, (row) => String((provider === "gemini" ? row.gemini : row.openai)?.actionable ?? "missing"));
  const visualReasons = countBy(visualRows, (row) => (provider === "gemini" ? row.gemini : row.openai)?.actionability_reason ?? "missing");
  const newVisual = actionRows.filter((row) => row.source === "visual");
  const coverage = CAPABILITY_NOTES.map((cap) => {
    const matches = actionRows.filter(cap.match);
    return {
      key: cap.key,
      title: cap.title,
      status: cap.status,
      count: matches.length,
      share_of_actionable: actionRows.length ? Number((matches.length / actionRows.length).toFixed(4)) : 0,
      note: cap.note,
      next: cap.next
    };
  }).sort((a, b) => b.count - a.count);
  const priorityPairs = topEntries(countBy(actionRows, (row) => `${row.operation}:${row.target}`), 80).map(([pair, count], index) => {
    const [operation, target] = pair.split(":");
    const examples = actionRows
      .filter((row) => row.operation === operation && row.target === target)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        source: row.source,
        confidence: row.confidence,
        needs_human_review: row.needsHumanReview,
        evidence: row.reason.slice(0, 240)
      }));
    return {
      rank: index + 1,
      operation,
      target,
      count,
      capability_area: coverage.find((cap) => CAPABILITY_NOTES.find((note) => note.key === cap.key)?.match({ id: "", source: "text", operation: operation || "unknown", target: target || "unknown", confidence: 1, reason: "", needsHumanReview: false }))?.title ?? "Unmapped",
      examples
    };
  });

  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    visual_provider: provider,
    text_opinion: textOpinionPath,
    visual_opinion: visualPath,
    text_total: textRows.length,
    visual_total: visualRows.length,
    text_actionable: textActionable,
    visual_actionable: visualActionable,
    visual_reasons: visualReasons,
    union_actionable_total: actionRows.length,
    union_by_source: countBy(actionRows, (row) => row.source),
    new_visual_actionable_total: newVisual.length,
    new_visual_needs_human_review: newVisual.filter((row) => row.needsHumanReview).length,
    operations: topEntries(countBy(actionRows, (row) => row.operation), 40),
    targets: topEntries(countBy(actionRows, (row) => row.target), 40),
    operation_target_pairs: topEntries(countBy(actionRows, (row) => `${row.operation}:${row.target}`), 60),
    priority_pairs: priorityPairs,
    coverage
  };
  writeJsonFile(path.join(outputDir, "redline_capability_summary.json"), summary);
  writeJsonFile(path.join(outputDir, "redline_capability_priority_queue.json"), {
    schema_version: 1,
    generated_at: summary.generated_at,
    visual_provider: provider,
    instructions: [
      "Use this queue to pick implementation and benchmark work from the highest-volume corpus operation/target pairs.",
      "Each item includes examples from the merged text+visual actionable corpus; examples are training/eval candidates, not automatic live write requests.",
      "Modeled MEP items still require dry-run, actual model write evidence, connector/readback audit where applicable, and a passing visual gate."
    ],
    items: priorityPairs
  });

  const lines = [
    "# Redline Corpus Capability Summary",
    "",
    `Generated: ${summary.generated_at}`,
    "",
    "## Pipeline Counts",
    "",
    markdownTable(["Metric", "Count"], [
      ["Text/metadata opinions", summary.text_total],
      [`${provider} visual-context opinions`, summary.visual_total],
      ["Text actionable", textActionable.true ?? 0],
      [`${provider} visual actionable`, visualActionable.true ?? 0],
      ["Union actionable", summary.union_actionable_total],
      ["New visual-only actionable", summary.new_visual_actionable_total],
      ["New visual-only needing human review", summary.new_visual_needs_human_review]
    ]),
    "",
    "## Union Actionable By Source",
    "",
    markdownTable(["Source", "Count"], topEntries(summary.union_by_source, 10)),
    "",
    "## Top Operations",
    "",
    markdownTable(["Operation", "Count"], summary.operations.slice(0, 20)),
    "",
    "## Top Targets",
    "",
    markdownTable(["Target", "Count"], summary.targets.slice(0, 20)),
    "",
    "## Priority Operation/Target Queue",
    "",
    markdownTable(["Rank", "Operation", "Target", "Count", "Area"], priorityPairs.slice(0, 25).map((row) => [row.rank, row.operation, row.target, row.count, row.capability_area])),
    "",
    "## Capability Coverage",
    "",
    markdownTable(["Area", "Status", "Count", "Next"], coverage.map((row) => [row.title, row.status, row.count, row.next])),
    "",
    "## Highest-Leverage Next Steps",
    "",
    "1. Composite grouping: group FreeText, Ink, strikeouts, replacement text, arrows, clouds, and schedule cells before classifying/executing.",
    "2. Schedule and text edits: add a redline workflow for schedule row/cell replacement with readback and focused capture.",
    "3. MEP size extraction: turn size plus airflow/calculation clusters into explicit size-transition or resize requests with target geometry.",
    "4. Graphics overrides: convert lineweight/hidden/future/CAD layer requests into view/category/filter/CAD override benchmark tasks.",
    "5. MEP accessory recognition: improve damper/accessory symbol recognition and target-segment binding before write.",
    "",
    "## Notes",
    "",
    provider === "gemini"
      ? "The Gemini visual pass is used only for items that were not already actionable in the text/metadata pass. Yellow-status-heavy crops are expected to be filtered before this summary."
      : "The OpenAI visual pass was conservative. Most visual-actionable items overlapped with the earlier text pass; the new visual-only set is smaller than the 200-sample extrapolation because the full text/metadata pass already captured many obvious directives.",
    `${provider} visual-only items with \`needsHumanReview\` should be treated as candidate training/evaluation examples, not automatic model-write instructions.`
  ];
  writeTextFile(path.join(outputDir, "redline_capability_summary.md"), `${lines.join("\n")}\n`);
  console.log(`Summary: ${path.join(outputDir, "redline_capability_summary.md")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
