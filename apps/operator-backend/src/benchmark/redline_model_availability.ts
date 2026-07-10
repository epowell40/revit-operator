import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso, writeJsonFile, writeTextFile } from "./files.js";

export type RedlineModelAvailabilityMatch = {
  path: string;
  file_name: string;
  size_bytes: number;
  last_write_time: string;
  matched_patterns: string[];
  score: number;
};

export type RedlineModelAvailabilityRoot = {
  root: string;
  exists: boolean;
  scanned_files: number;
  scanned_dirs: number;
  skipped_dirs: string[];
  timed_out: boolean;
  errors: string[];
};

export type RedlineModelAvailabilityReport = {
  schema_version: 1;
  generated_at: string;
  roots: RedlineModelAvailabilityRoot[];
  patterns: string[];
  max_scan_ms: number;
  max_files_per_root: number;
  matches: RedlineModelAvailabilityMatch[];
  metrics: {
    root_count: number;
    existing_root_count: number;
    total_scanned_files: number;
    total_scanned_dirs: number;
    timed_out_root_count: number;
    match_count: number;
  };
  recommendation: string;
};

export type RedlineModelAvailabilityOptions = {
  roots: string[];
  patterns?: string[];
  outputDir: string;
  maxScanMs?: number;
  maxFilesPerRoot?: number;
};

export type RedlineModelAvailabilityPaths = {
  json_path: string;
  markdown_path: string;
  report: RedlineModelAvailabilityReport;
};

const DEFAULT_PATTERNS = ["B300", "Duke", "Mechanical", "Mech", "Plumb"];
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "benchmark-tests",
  "local-work",
  ".cache",
  ".next",
  ".turbo",
  ".vs",
  ".vscode",
  "coverage",
  "dist",
  "build",
  "bin",
  "obj",
  "artifacts",
  "packages",
  ".venv",
  "venv"
]);

function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

function matchesPatterns(filePath: string, patterns: string[]): string[] {
  const haystack = filePath.toLowerCase();
  return patterns.filter((pattern) => haystack.includes(normalizePattern(pattern)));
}

function scoreMatch(filePath: string, matchedPatterns: string[]): number {
  const name = path.basename(filePath).toLowerCase();
  let score = matchedPatterns.length * 10;
  if (/b300|duke/i.test(name)) score += 20;
  if (/mech|mechanical|plumb|plumbing/i.test(name)) score += 10;
  if (name.endsWith(".rvt")) score += 5;
  return score;
}

function shouldSkipDir(dirName: string): boolean {
  return SKIP_DIR_NAMES.has(dirName.toLowerCase());
}

function scanRoot(root: string, patterns: string[], maxScanMs: number, maxFilesPerRoot: number): {
  root: RedlineModelAvailabilityRoot;
  matches: RedlineModelAvailabilityMatch[];
} {
  const resolvedRoot = path.resolve(root);
  const rootReport: RedlineModelAvailabilityRoot = {
    root: resolvedRoot,
    exists: fs.existsSync(resolvedRoot),
    scanned_files: 0,
    scanned_dirs: 0,
    skipped_dirs: [],
    timed_out: false,
    errors: []
  };
  const matches: RedlineModelAvailabilityMatch[] = [];
  if (!rootReport.exists) return { root: rootReport, matches };

  const started = Date.now();
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    if (Date.now() - started > maxScanMs) {
      rootReport.timed_out = true;
      break;
    }
    if (rootReport.scanned_files >= maxFilesPerRoot) {
      rootReport.timed_out = true;
      break;
    }
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      rootReport.errors.push(`${current}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    rootReport.scanned_dirs += 1;
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          rootReport.skipped_dirs.push(next);
        } else {
          stack.push(next);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      rootReport.scanned_files += 1;
      if (!entry.name.toLowerCase().endsWith(".rvt")) continue;
      const matchedPatterns = matchesPatterns(next, patterns);
      if (matchedPatterns.length === 0) continue;
      try {
        const stat = fs.statSync(next);
        matches.push({
          path: next,
          file_name: entry.name,
          size_bytes: stat.size,
          last_write_time: stat.mtime.toISOString(),
          matched_patterns: matchedPatterns,
          score: scoreMatch(next, matchedPatterns)
        });
      } catch (error) {
        rootReport.errors.push(`${next}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  rootReport.skipped_dirs = Array.from(new Set(rootReport.skipped_dirs)).sort((a, b) => a.localeCompare(b));
  return { root: rootReport, matches };
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`)
  ].join("\n");
}

function renderMarkdown(report: RedlineModelAvailabilityReport): string {
  const lines = [
    "# Redline Source Model Availability",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Metrics",
    markdownTable(["metric", "value"], Object.entries(report.metrics).map(([key, value]) => [key, String(value)])),
    "",
    "## Roots",
    markdownTable(
      ["root", "exists", "files", "dirs", "timed_out", "errors"],
      report.roots.map((root) => [
        root.root,
        String(root.exists),
        String(root.scanned_files),
        String(root.scanned_dirs),
        String(root.timed_out),
        String(root.errors.length)
      ])
    ),
    "",
    "## Matches",
    report.matches.length > 0
      ? markdownTable(
        ["score", "file", "matched_patterns", "size_bytes", "last_write_time", "path"],
        report.matches.map((match) => [
          String(match.score),
          match.file_name,
          match.matched_patterns.join(", "),
          String(match.size_bytes),
          match.last_write_time,
          match.path
        ])
      )
      : "No matching RVT files were found in the scanned roots.",
    "",
    "## Recommendation",
    report.recommendation,
    ""
  ];
  return lines.join("\n");
}

export function buildRedlineModelAvailabilityReport(options: Omit<RedlineModelAvailabilityOptions, "outputDir">): RedlineModelAvailabilityReport {
  const patterns = (options.patterns && options.patterns.length > 0 ? options.patterns : DEFAULT_PATTERNS)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const maxScanMs = Math.max(100, Math.floor(options.maxScanMs ?? 10_000));
  const maxFilesPerRoot = Math.max(1, Math.floor(options.maxFilesPerRoot ?? 250_000));
  const rootResults = options.roots.map((root) => scanRoot(root, patterns, maxScanMs, maxFilesPerRoot));
  const roots = rootResults.map((result) => result.root);
  const matches = rootResults
    .flatMap((result) => result.matches)
    .sort((a, b) => b.score - a.score || b.last_write_time.localeCompare(a.last_write_time) || a.path.localeCompare(b.path));
  const totalScannedFiles = roots.reduce((sum, root) => sum + root.scanned_files, 0);
  const totalScannedDirs = roots.reduce((sum, root) => sum + root.scanned_dirs, 0);
  const timedOutRootCount = roots.filter((root) => root.timed_out).length;
  return {
    schema_version: 1,
    generated_at: nowIso(),
    roots,
    patterns,
    max_scan_ms: maxScanMs,
    max_files_per_root: maxFilesPerRoot,
    matches,
    metrics: {
      root_count: roots.length,
      existing_root_count: roots.filter((root) => root.exists).length,
      total_scanned_files: totalScannedFiles,
      total_scanned_dirs: totalScannedDirs,
      timed_out_root_count: timedOutRootCount,
      match_count: matches.length
    },
    recommendation: matches.length > 0
      ? "Open the highest-scoring candidate model in Revit and verify it matches the redline source before filling live overrides."
      : "No candidate source model was found. Keep real-corpus rows gated at executable:0 until the exact project model is available."
  };
}

export function writeRedlineModelAvailabilityReport(options: RedlineModelAvailabilityOptions): RedlineModelAvailabilityPaths {
  const report = buildRedlineModelAvailabilityReport(options);
  const outputDir = ensureDir(options.outputDir);
  const jsonPath = path.join(outputDir, "redline_model_availability.json");
  const markdownPath = path.join(outputDir, "redline_model_availability.md");
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, renderMarkdown(report));
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    report
  };
}
