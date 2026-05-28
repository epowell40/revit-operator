import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createArtifactShare } from "../artifacts/artifact_bus.js";
import { getRecentStepToolResults } from "../memory/sqlite_store.js";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace, resolveFileUnderWorkspace } from "../workspace.js";

export type VerificationCheckInput = {
  id?: string;
  check?: string;
  label?: string;
  expected?: unknown;
  observed?: unknown;
  pass?: boolean;
  required?: boolean;
};

export type VerificationCheckResult = {
  id: string;
  check: string;
  expected: string;
  observed: string;
  pass: boolean;
  required: boolean;
};

export type Feature2DiffSummary = {
  status: "available" | "empty" | "unavailable" | "skipped";
  base_branch: string;
  feature_branch: string;
  files_changed: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  sample_files: string[];
  note?: string;
};

export type EvidencePackBuildInput = {
  session_id?: string;
  title?: string;
  run_label?: string;
  verification_checklist?: VerificationCheckInput[];
  before_images?: string[];
  after_images?: string[];
  pdf_paths?: string[];
  artifact_paths?: string[];
  change_summary_items?: string[];
  include_feature2_diff?: boolean;
  feature2_branch?: string;
  feature2_base_branch?: string;
  halt_on_verification_failure?: boolean;
  package_zip?: boolean;
  output_folder?: string;
  share_ttl_seconds?: number;
  max_session_tool_results?: number;
};

export type EvidencePackBuildResult =
  | {
      ok: false;
      status: "verification_failed";
      error: string;
      verification: {
        overall_pass: boolean;
        passed_count: number;
        failed_count: number;
        checks: VerificationCheckResult[];
      };
      change_summary: {
        user_items: string[];
        feature2_diff: Feature2DiffSummary;
      };
      summary_markdown: string;
      warnings: string[];
    }
  | {
      ok: true;
      status: "built";
      evidence_id: string;
      title: string;
      output_dir: string;
      zip_path?: string;
      share: {
        token: string;
        relative_path: string;
        file_name: string;
        expires_at_utc: string;
        download_path: string;
      };
      verification: {
        overall_pass: boolean;
        passed_count: number;
        failed_count: number;
        checks: VerificationCheckResult[];
      };
      change_summary: {
        user_items: string[];
        feature2_diff: Feature2DiffSummary;
      };
      included: {
        before_images: string[];
        after_images: string[];
        pdfs: string[];
        artifacts: string[];
        manifest: string;
        summary: string;
      };
      summary_markdown: string;
      warnings: string[];
    };

type ResolvedPaths = {
  before: string[];
  after: string[];
  pdfs: string[];
  artifacts: string[];
};

function nowStamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function isUnder(baseDir: string, candidate: string): boolean {
  const b = path.resolve(baseDir);
  const c = path.resolve(candidate);
  if (process.platform === "win32") {
    const bn = b.toLowerCase();
    const cn = c.toLowerCase();
    return cn === bn || cn.startsWith(bn.endsWith(path.sep) ? bn : bn + path.sep);
  }
  return c === b || c.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function toWorkspaceRelative(existingPath: string): string | null {
  const p = (existingPath ?? "").trim();
  if (!p) return null;
  try {
    const full = resolveExistingFileUnderWorkspace(p);
    const rel = path.relative(ensureWorkspaceLayout().root, full).replace(/\\/g, "/");
    return rel || null;
  } catch {
    return null;
  }
}

function normalizeArtifactsOutputFolder(raw: string | undefined): string {
  const p = (raw ?? "").trim().replace(/\\/g, "/");
  if (!p) return "artifacts/evidence-packs";
  if (p === "artifacts" || p.startsWith("artifacts/")) return p;
  return `artifacts/${p.replace(/^\/+/, "")}`;
}

function normalizePathList(values: string[] | undefined): string[] {
  const list = Array.isArray(values) ? values : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const rel = toWorkspaceRelative(v);
    if (!rel) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  return out;
}

function valueToString(v: unknown): string {
  if (v === undefined) return "(missing)";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function stableStringify(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const src = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return x;
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return String(v);
  }
}

function compareValues(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return stableStringify(a) === stableStringify(b);
}

function evaluateChecklist(raw: VerificationCheckInput[] | undefined): {
  overall_pass: boolean;
  passed_count: number;
  failed_count: number;
  checks: VerificationCheckResult[];
} {
  const inChecks = Array.isArray(raw) ? raw : [];
  const checks: VerificationCheckResult[] = [];

  if (inChecks.length === 0) {
    checks.push({
      id: "checklist-provided",
      check: "Verification checklist provided",
      expected: "At least one check",
      observed: "0 checks",
      pass: false,
      required: true
    });
  }

  let idx = 0;
  for (const c of inChecks) {
    idx++;
    const id = (c?.id ?? `check-${idx}`).toString().trim() || `check-${idx}`;
    const check = (c?.check ?? c?.label ?? id).toString().trim() || id;
    const required = typeof c?.required === "boolean" ? c.required : true;
    const expectedRaw = c?.expected;
    const observedRaw = c?.observed;

    let pass = false;
    if (typeof c?.pass === "boolean") {
      pass = c.pass;
    } else if (expectedRaw !== undefined) {
      pass = compareValues(expectedRaw, observedRaw);
    } else {
      if (observedRaw === undefined || observedRaw === null) {
        pass = false;
      } else if (typeof observedRaw === "boolean") {
        pass = observedRaw;
      } else if (typeof observedRaw === "string") {
        pass = observedRaw.trim().length > 0;
      } else {
        pass = true;
      }
    }

    checks.push({
      id,
      check,
      expected: valueToString(expectedRaw),
      observed: valueToString(observedRaw),
      pass,
      required
    });
  }

  const failed_count = checks.filter(c => c.required && !c.pass).length;
  const passed_count = checks.length - failed_count;
  return {
    overall_pass: failed_count === 0,
    passed_count,
    failed_count,
    checks
  };
}

function maybePathLike(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.startsWith("artifacts/") || s.startsWith("artifacts\\")) return true;
  const ext = path.extname(s).toLowerCase();
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".pdf" || ext === ".csv" || ext === ".xlsx" || ext === ".json") return true;
  return s.includes("/") || s.includes("\\");
}

function collectWorkspacePathsFromUnknown(input: unknown, out: string[], seen: Set<string>): void {
  if (input == null) return;
  if (typeof input === "string") {
    if (!maybePathLike(input)) return;
    const rel = toWorkspaceRelative(input);
    if (!rel) return;
    const key = rel.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rel);
    return;
  }
  if (Array.isArray(input)) {
    for (const x of input) collectWorkspacePathsFromUnknown(x, out, seen);
    return;
  }
  if (typeof input === "object") {
    for (const v of Object.values(input as Record<string, unknown>)) {
      collectWorkspacePathsFromUnknown(v, out, seen);
    }
  }
}

function classifyPaths(paths: string[]): { images: string[]; pdfs: string[]; other: string[] } {
  const images: string[] = [];
  const pdfs: string[] = [];
  const other: string[] = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
      images.push(p);
      continue;
    }
    if (ext === ".pdf") {
      pdfs.push(p);
      continue;
    }
    other.push(p);
  }
  return { images, pdfs, other };
}

function inferBeforeAfter(images: string[]): { before: string[]; after: string[] } {
  if (images.length === 0) return { before: [], after: [] };
  const beforeHint = images.filter(p => path.basename(p).toLowerCase().includes("before"));
  const afterHint = images.filter(p => path.basename(p).toLowerCase().includes("after"));
  let before = beforeHint.length > 0 ? beforeHint : [images[0]!];
  let after = afterHint.length > 0 ? afterHint : [images[images.length - 1]!];

  const bFirst = before[0];
  const aFirst = after[0];
  if (bFirst && aFirst && bFirst.toLowerCase() === aFirst.toLowerCase() && images.length > 1) {
    const alt = images.find(p => p.toLowerCase() !== bFirst.toLowerCase());
    if (alt) after = [alt];
  }
  return { before, after };
}

function resolveEvidencePaths(input: EvidencePackBuildInput): ResolvedPaths {
  const explicitBefore = normalizePathList(input.before_images);
  const explicitAfter = normalizePathList(input.after_images);
  const explicitPdfs = normalizePathList(input.pdf_paths);
  const explicitArtifacts = normalizePathList(input.artifact_paths);

  if (!input.session_id) {
    return {
      before: explicitBefore,
      after: explicitAfter,
      pdfs: explicitPdfs,
      artifacts: explicitArtifacts
    };
  }

  const toolResults = getRecentStepToolResults(input.session_id, input.max_session_tool_results ?? 40);
  const discovered: string[] = [];
  const seen = new Set<string>();
  for (const tr of toolResults) {
    if (!tr || typeof tr !== "object") continue;
    const t: any = tr;
    const attachments = Array.isArray(t.attachments) ? t.attachments : [];
    for (const a of attachments) {
      const lp = typeof a?.local_path === "string" ? a.local_path.trim() : "";
      if (!lp) continue;
      const rel = toWorkspaceRelative(lp);
      if (!rel) continue;
      const key = rel.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(rel);
    }
    collectWorkspacePathsFromUnknown(t.result_json, discovered, seen);
  }

  const classified = classifyPaths(discovered);
  const inferred = inferBeforeAfter(classified.images);

  const before = explicitBefore.length > 0 ? explicitBefore : inferred.before;
  const after = explicitAfter.length > 0 ? explicitAfter : inferred.after;
  const pdfs = explicitPdfs.length > 0 ? explicitPdfs : classified.pdfs;

  const extraArtifacts = [...explicitArtifacts];
  const seenExtra = new Set(extraArtifacts.map(x => x.toLowerCase()));
  for (const p of classified.other) {
    const key = p.toLowerCase();
    if (seenExtra.has(key)) continue;
    seenExtra.add(key);
    extraArtifacts.push(p);
  }

  return { before, after, pdfs, artifacts: extraArtifacts };
}

function detectRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runGit(args: string[], repoRoot: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : ""
  };
}

function buildFeature2DiffSummary(input: EvidencePackBuildInput): Feature2DiffSummary {
  const include = input.include_feature2_diff !== false;
  const featureBranch = (input.feature2_branch ?? "feat/codex-feature2").trim() || "feat/codex-feature2";
  const baseBranch = (input.feature2_base_branch ?? "main").trim() || "main";
  if (!include) {
    return {
      status: "skipped",
      base_branch: baseBranch,
      feature_branch: featureBranch,
      files_changed: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      sample_files: [],
      note: "Feature 2 diff collection disabled by request."
    };
  }

  const repoRoot = detectRepoRoot();
  if (!repoRoot) {
    return {
      status: "unavailable",
      base_branch: baseBranch,
      feature_branch: featureBranch,
      files_changed: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      sample_files: [],
      note: "Git repository not detected; Feature 2 diff unavailable."
    };
  }

  const exists = runGit(["rev-parse", "--verify", featureBranch], repoRoot);
  if (!exists.ok) {
    return {
      status: "unavailable",
      base_branch: baseBranch,
      feature_branch: featureBranch,
      files_changed: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      sample_files: [],
      note: `Branch '${featureBranch}' not found locally.`
    };
  }

  const diff = runGit(["diff", "--name-status", "--find-renames", `${baseBranch}...${featureBranch}`], repoRoot);
  if (!diff.ok) {
    return {
      status: "unavailable",
      base_branch: baseBranch,
      feature_branch: featureBranch,
      files_changed: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      sample_files: [],
      note: `Unable to compute diff '${baseBranch}...${featureBranch}'.`
    };
  }

  const lines = diff.stdout
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      status: "empty",
      base_branch: baseBranch,
      feature_branch: featureBranch,
      files_changed: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      sample_files: [],
      note: "No diff found (already merged or no changes)."
    };
  }

  let added = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;
  const sample_files: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\t+/).filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0] ?? "";
    if (status.startsWith("A")) added++;
    else if (status.startsWith("D")) deleted++;
    else if (status.startsWith("R")) renamed++;
    else modified++;
    if (sample_files.length < 20) {
      const p = parts[parts.length - 1] ?? "";
      if (p) sample_files.push(`${status} ${p}`);
    }
  }

  return {
    status: "available",
    base_branch: baseBranch,
    feature_branch: featureBranch,
    files_changed: lines.length,
    added,
    modified,
    deleted,
    renamed,
    sample_files
  };
}

function nextAvailableFilePath(destDir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let idx = 0;
  while (true) {
    const candidate = idx === 0 ? path.join(destDir, fileName) : path.join(destDir, `${base}_${idx}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    idx++;
  }
}

function copyFilesToPack(srcRelPaths: string[], packSubDir: string): string[] {
  if (srcRelPaths.length === 0) return [];
  fs.mkdirSync(packSubDir, { recursive: true });
  const included: string[] = [];
  const root = ensureWorkspaceLayout().root;

  for (const rel of srcRelPaths) {
    try {
      const src = resolveExistingFileUnderWorkspace(rel);
      const fileName = path.basename(src);
      const dst = nextAvailableFilePath(packSubDir, fileName);
      fs.copyFileSync(src, dst);
      included.push(path.relative(root, dst).replace(/\\/g, "/"));
    } catch {
      // ignore missing files at packaging time
    }
  }
  return included;
}

function tryZipDirectory(sourceDir: string, zipPath: string): { ok: boolean; warning?: string } {
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  } catch {
    // ignore
  }

  if (process.platform === "win32") {
    const script = "param([string]$src,[string]$dest) Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dest -Force";
    const r = spawnSync("powershell", ["-NoProfile", "-Command", script, sourceDir, zipPath], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(zipPath)) return { ok: true };
    const msg = typeof r.stderr === "string" && r.stderr.trim() ? r.stderr.trim() : "Compress-Archive unavailable.";
    return { ok: false, warning: msg };
  }

  const r = spawnSync("zip", ["-r", zipPath, "."], { cwd: sourceDir, encoding: "utf8" });
  if (r.status === 0 && fs.existsSync(zipPath)) return { ok: true };
  const msg = typeof r.stderr === "string" && r.stderr.trim() ? r.stderr.trim() : "zip command unavailable.";
  return { ok: false, warning: msg };
}

function buildSummaryMarkdown(args: {
  title: string;
  verification: { overall_pass: boolean; checks: VerificationCheckResult[]; passed_count: number; failed_count: number };
  included: { before_images: string[]; after_images: string[]; pdfs: string[]; artifacts: string[] };
  changeSummary: { user_items: string[]; feature2_diff: Feature2DiffSummary };
  output_dir?: string;
  zip_path?: string;
  download_url?: string;
  download_path?: string;
  warnings: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Evidence Pack: ${args.title}`);
  lines.push(`Status: ${args.verification.overall_pass ? "PASS" : "FAIL"} (${args.verification.passed_count} passed, ${args.verification.failed_count} failed)`);
  lines.push("");
  lines.push("Verification Checklist:");
  for (const c of args.verification.checks) {
    const status = c.pass ? "PASS" : "FAIL";
    lines.push(`- [${status}] ${c.check} | observed: ${c.observed} | expected: ${c.expected}`);
  }
  lines.push("");
  lines.push("Visual Proof (Before):");
  if (args.included.before_images.length === 0) lines.push("- (none)");
  for (const p of args.included.before_images) lines.push(`- ${p}`);
  lines.push("");
  lines.push("Visual Proof (After):");
  if (args.included.after_images.length === 0) lines.push("- (none)");
  for (const p of args.included.after_images) lines.push(`- ${p}`);
  lines.push("");
  lines.push("Clean PDF Exports:");
  if (args.included.pdfs.length === 0) lines.push("- (none)");
  for (const p of args.included.pdfs) lines.push(`- ${p}`);
  lines.push("");
  lines.push("Additional Artifacts:");
  if (args.included.artifacts.length === 0) lines.push("- (none)");
  for (const p of args.included.artifacts) lines.push(`- ${p}`);
  lines.push("");
  lines.push("Change Summary:");
  if (args.changeSummary.user_items.length === 0) lines.push("- (none)");
  for (const item of args.changeSummary.user_items) lines.push(`- ${item}`);
  const f2 = args.changeSummary.feature2_diff;
  if (f2.status === "available") {
    lines.push(
      `- Feature 2 diff (${f2.base_branch}...${f2.feature_branch}): ${f2.files_changed} files (A:${f2.added} M:${f2.modified} D:${f2.deleted} R:${f2.renamed})`
    );
    for (const s of f2.sample_files.slice(0, 8)) lines.push(`-   ${s}`);
  } else {
    lines.push(`- Feature 2 diff: ${f2.note ?? f2.status}`);
  }
  lines.push("");
  if (args.output_dir) lines.push(`Evidence Folder: ${args.output_dir}`);
  if (args.zip_path) lines.push(`Evidence Zip: ${args.zip_path}`);
  if (args.download_url) lines.push(`Download: [Download evidence pack](${args.download_url})`);
  else if (args.download_path) lines.push(`Download path: ${args.download_path}`);
  if (args.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of args.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

export function buildEvidencePack(input: EvidencePackBuildInput): EvidencePackBuildResult {
  const warnings: string[] = [];
  const verification = evaluateChecklist(input.verification_checklist);
  const changeSummary = {
    user_items: (Array.isArray(input.change_summary_items) ? input.change_summary_items : []).map(x => String(x ?? "").trim()).filter(Boolean),
    feature2_diff: buildFeature2DiffSummary(input)
  };

  const haltOnVerificationFailure = input.halt_on_verification_failure !== false;
  if (!verification.overall_pass && haltOnVerificationFailure) {
    return {
      ok: false,
      status: "verification_failed",
      error: "Verification checklist failed. Evidence pack generation halted.",
      verification,
      change_summary: changeSummary,
      summary_markdown: buildSummaryMarkdown({
        title: input.title?.trim() || "Evidence Pack",
        verification,
        included: { before_images: [], after_images: [], pdfs: [], artifacts: [] },
        changeSummary,
        warnings
      }),
      warnings
    };
  }

  const resolved = resolveEvidencePaths(input);
  if (resolved.before.length === 0) warnings.push("No BEFORE visuals were found.");
  if (resolved.after.length === 0) warnings.push("No AFTER visuals were found.");
  if (resolved.pdfs.length === 0) warnings.push("No PDF exports were found.");

  const layout = ensureWorkspaceLayout();
  const outputFolderRel = normalizeArtifactsOutputFolder(input.output_folder);
  const outputFolderFull = resolveFileUnderWorkspace(outputFolderRel);
  if (!isUnder(layout.artifacts, outputFolderFull)) {
    throw new Error("output_folder must be under artifacts/.");
  }
  fs.mkdirSync(outputFolderFull, { recursive: true });

  const runLabel = (input.run_label ?? "").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const evidenceId = `${nowStamp()}_${runLabel || randomUUID().slice(0, 8)}`;
  const packDirFull = path.join(outputFolderFull, evidenceId);
  fs.mkdirSync(packDirFull, { recursive: true });

  const includedBefore = copyFilesToPack(resolved.before, path.join(packDirFull, "visuals", "before"));
  const includedAfter = copyFilesToPack(resolved.after, path.join(packDirFull, "visuals", "after"));
  const includedPdfs = copyFilesToPack(resolved.pdfs, path.join(packDirFull, "exports", "pdf"));
  const includedArtifacts = copyFilesToPack(resolved.artifacts, path.join(packDirFull, "artifacts"));

  const outputDirRel = path.relative(layout.root, packDirFull).replace(/\\/g, "/");
  const verificationRel = path.join(outputDirRel, "verification.json").replace(/\\/g, "/");
  const changeSummaryRel = path.join(outputDirRel, "change_summary.json").replace(/\\/g, "/");
  const manifestRel = path.join(outputDirRel, "manifest.json").replace(/\\/g, "/");
  const summaryRel = path.join(outputDirRel, "SUMMARY.md").replace(/\\/g, "/");

  fs.writeFileSync(
    resolveFileUnderWorkspace(verificationRel),
    JSON.stringify(
      {
        generated_at_utc: new Date().toISOString(),
        overall_pass: verification.overall_pass,
        passed_count: verification.passed_count,
        failed_count: verification.failed_count,
        checks: verification.checks
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    resolveFileUnderWorkspace(changeSummaryRel),
    JSON.stringify(
      {
        generated_at_utc: new Date().toISOString(),
        user_items: changeSummary.user_items,
        feature2_diff: changeSummary.feature2_diff
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    resolveFileUnderWorkspace(manifestRel),
    JSON.stringify(
      {
        schema_version: 1,
        generated_at_utc: new Date().toISOString(),
        evidence_id: evidenceId,
        title: input.title?.trim() || "Evidence Pack",
        session_id: input.session_id ?? null,
        verification_file: verificationRel,
        change_summary_file: changeSummaryRel,
        files: {
          before_images: includedBefore,
          after_images: includedAfter,
          pdfs: includedPdfs,
          artifacts: includedArtifacts
        },
        warnings
      },
      null,
      2
    ),
    "utf8"
  );

  let zipRel: string | undefined;
  if (input.package_zip !== false) {
    const zipFull = path.join(outputFolderFull, `${evidenceId}.zip`);
    const zipped = tryZipDirectory(packDirFull, zipFull);
    if (zipped.ok) {
      zipRel = path.relative(layout.root, zipFull).replace(/\\/g, "/");
    } else if (zipped.warning) {
      warnings.push(`ZIP packaging failed; sharing folder summary instead. ${zipped.warning}`);
    }
  }

  const summaryBeforeShare = buildSummaryMarkdown({
    title: input.title?.trim() || "Evidence Pack",
    verification,
    included: {
      before_images: includedBefore,
      after_images: includedAfter,
      pdfs: includedPdfs,
      artifacts: includedArtifacts
    },
    changeSummary,
    output_dir: outputDirRel,
    zip_path: zipRel,
    warnings
  });
  fs.writeFileSync(resolveFileUnderWorkspace(summaryRel), summaryBeforeShare, "utf8");

  const shareTargetRel = zipRel ?? summaryRel;
  const share = createArtifactShare({
    relativePath: shareTargetRel,
    ttlSeconds: input.share_ttl_seconds,
    fileName: zipRel ? path.basename(zipRel) : path.basename(summaryRel)
  });
  const download_path = `/artifacts/download-shared/${encodeURIComponent(share.token)}`;

  const summaryMarkdown = buildSummaryMarkdown({
    title: input.title?.trim() || "Evidence Pack",
    verification,
    included: {
      before_images: includedBefore,
      after_images: includedAfter,
      pdfs: includedPdfs,
      artifacts: includedArtifacts
    },
    changeSummary,
    output_dir: outputDirRel,
    zip_path: zipRel,
    download_path,
    warnings
  });
  fs.writeFileSync(resolveFileUnderWorkspace(summaryRel), summaryMarkdown, "utf8");

  return {
    ok: true,
    status: "built",
    evidence_id: evidenceId,
    title: input.title?.trim() || "Evidence Pack",
    output_dir: outputDirRel,
    ...(zipRel ? { zip_path: zipRel } : {}),
    share: {
      token: share.token,
      relative_path: share.relative_path,
      file_name: share.file_name,
      expires_at_utc: share.expires_at_utc,
      download_path
    },
    verification,
    change_summary: changeSummary,
    included: {
      before_images: includedBefore,
      after_images: includedAfter,
      pdfs: includedPdfs,
      artifacts: includedArtifacts,
      manifest: manifestRel,
      summary: summaryRel
    },
    summary_markdown: summaryMarkdown,
    warnings
  };
}
