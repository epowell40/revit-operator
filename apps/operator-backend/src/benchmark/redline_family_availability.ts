import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso, writeJsonFile, writeTextFile } from "./files.js";

export type RedlineFamilyAvailabilityMatch = {
  path: string;
  file_name: string;
  extension: ".rfa" | ".rft";
  size_bytes: number;
  last_write_time: string;
  matched_patterns: string[];
  score: number;
};

export type RedlineFamilyAvailabilityRoot = {
  root: string;
  exists: boolean;
  scanned_files: number;
  scanned_dirs: number;
  skipped_dirs: string[];
  timed_out: boolean;
  errors: string[];
};

export type RedlineFamilyAvailabilityReport = {
  schema_version: 1;
  generated_at: string;
  roots: RedlineFamilyAvailabilityRoot[];
  patterns: string[];
  extensions: Array<".rfa" | ".rft">;
  max_scan_ms: number;
  max_files_per_root: number;
  matches: RedlineFamilyAvailabilityMatch[];
  metrics: {
    root_count: number;
    existing_root_count: number;
    total_scanned_files: number;
    total_scanned_dirs: number;
    timed_out_root_count: number;
    match_count: number;
    rfa_match_count: number;
    rft_match_count: number;
  };
  recommendation: string;
};

export type RedlineFamilyAvailabilityOptions = {
  roots: string[];
  patterns?: string[];
  extensions?: string[];
  outputDir: string;
  maxScanMs?: number;
  maxFilesPerRoot?: number;
};

export type RedlineFamilyAvailabilityPaths = {
  json_path: string;
  markdown_path: string;
  report: RedlineFamilyAvailabilityReport;
};

const DEFAULT_PATTERNS = ["damper", "duct accessory", "pipe accessory", "valve", "accessory"];
const DEFAULT_EXTENSIONS: Array<".rfa" | ".rft"> = [".rfa", ".rft"];
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

function normalizeExtension(extension: string): ".rfa" | ".rft" | null {
  const value = extension.trim().toLowerCase();
  const withDot = value.startsWith(".") ? value : `.${value}`;
  return withDot === ".rfa" || withDot === ".rft" ? withDot : null;
}

function matchesPatterns(filePath: string, patterns: string[]): string[] {
  const haystack = filePath.toLowerCase();
  return patterns.filter((pattern) => haystack.includes(normalizePattern(pattern)));
}

function scoreMatch(filePath: string, extension: ".rfa" | ".rft", matchedPatterns: string[]): number {
  const name = path.basename(filePath).toLowerCase();
  let score = matchedPatterns.length * 10;
  if (/damper|valve|accessor/i.test(name)) score += 20;
  if (/duct|pipe/i.test(name)) score += 10;
  if (extension === ".rfa") score += 25;
  return score;
}

function shouldSkipDir(dirName: string): boolean {
  return SKIP_DIR_NAMES.has(dirName.toLowerCase());
}

function scanRoot(root: string, patterns: string[], extensions: Array<".rfa" | ".rft">, maxScanMs: number, maxFilesPerRoot: number): {
  root: RedlineFamilyAvailabilityRoot;
  matches: RedlineFamilyAvailabilityMatch[];
} {
  const resolvedRoot = path.resolve(root);
  const rootReport: RedlineFamilyAvailabilityRoot = {
    root: resolvedRoot,
    exists: fs.existsSync(resolvedRoot),
    scanned_files: 0,
    scanned_dirs: 0,
    skipped_dirs: [],
    timed_out: false,
    errors: []
  };
  const matches: RedlineFamilyAvailabilityMatch[] = [];
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
      const extension = normalizeExtension(path.extname(entry.name));
      if (!extension || !extensions.includes(extension)) continue;
      const matchedPatterns = matchesPatterns(next, patterns);
      if (matchedPatterns.length === 0) continue;
      try {
        const stat = fs.statSync(next);
        matches.push({
          path: next,
          file_name: entry.name,
          extension,
          size_bytes: stat.size,
          last_write_time: stat.mtime.toISOString(),
          matched_patterns: matchedPatterns,
          score: scoreMatch(next, extension, matchedPatterns)
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

function renderMarkdown(report: RedlineFamilyAvailabilityReport): string {
  const lines = [
    "# Redline Family Availability",
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
        ["score", "extension", "file", "matched_patterns", "size_bytes", "last_write_time", "path"],
        report.matches.map((match) => [
          String(match.score),
          match.extension,
          match.file_name,
          match.matched_patterns.join(", "),
          String(match.size_bytes),
          match.last_write_time,
          match.path
        ])
      )
      : "No matching Revit family or family-template files were found in the scanned roots.",
    "",
    "## Recommendation",
    report.recommendation,
    ""
  ];
  return lines.join("\n");
}

export function buildRedlineFamilyAvailabilityReport(options: Omit<RedlineFamilyAvailabilityOptions, "outputDir">): RedlineFamilyAvailabilityReport {
  const patterns = (options.patterns && options.patterns.length > 0 ? options.patterns : DEFAULT_PATTERNS)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const extensions = (options.extensions && options.extensions.length > 0 ? options.extensions : DEFAULT_EXTENSIONS)
    .map(normalizeExtension)
    .filter((extension): extension is ".rfa" | ".rft" => extension !== null);
  const effectiveExtensions = extensions.length > 0 ? Array.from(new Set(extensions)) : DEFAULT_EXTENSIONS;
  const maxScanMs = Math.max(100, Math.floor(options.maxScanMs ?? 10_000));
  const maxFilesPerRoot = Math.max(1, Math.floor(options.maxFilesPerRoot ?? 250_000));
  const rootResults = options.roots.map((root) => scanRoot(root, patterns, effectiveExtensions, maxScanMs, maxFilesPerRoot));
  const roots = rootResults.map((result) => result.root);
  const matches = rootResults
    .flatMap((result) => result.matches)
    .sort((a, b) => b.score - a.score || b.last_write_time.localeCompare(a.last_write_time) || a.path.localeCompare(b.path));
  const totalScannedFiles = roots.reduce((sum, root) => sum + root.scanned_files, 0);
  const totalScannedDirs = roots.reduce((sum, root) => sum + root.scanned_dirs, 0);
  const timedOutRootCount = roots.filter((root) => root.timed_out).length;
  const rfaMatchCount = matches.filter((match) => match.extension === ".rfa").length;
  const rftMatchCount = matches.filter((match) => match.extension === ".rft").length;
  return {
    schema_version: 1,
    generated_at: nowIso(),
    roots,
    patterns,
    extensions: effectiveExtensions,
    max_scan_ms: maxScanMs,
    max_files_per_root: maxFilesPerRoot,
    matches,
    metrics: {
      root_count: roots.length,
      existing_root_count: roots.filter((root) => root.exists).length,
      total_scanned_files: totalScannedFiles,
      total_scanned_dirs: totalScannedDirs,
      timed_out_root_count: timedOutRootCount,
      match_count: matches.length,
      rfa_match_count: rfaMatchCount,
      rft_match_count: rftMatchCount
    },
    recommendation: matches.length > 0
      ? "Review the highest-scoring family candidates, stage the approved .rfa under the workspace if needed, load it into the live model, and verify the loaded category/type before promoting an accessory workflow."
      : "No candidate family or template was found. Keep accessory-family redlines gated until a compatible family/type is available in the live model or staged under the workspace."
  };
}

export function writeRedlineFamilyAvailabilityReport(options: RedlineFamilyAvailabilityOptions): RedlineFamilyAvailabilityPaths {
  const report = buildRedlineFamilyAvailabilityReport(options);
  const outputDir = ensureDir(options.outputDir);
  const jsonPath = path.join(outputDir, "redline_family_availability.json");
  const markdownPath = path.join(outputDir, "redline_family_availability.md");
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, renderMarkdown(report));
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    report
  };
}
