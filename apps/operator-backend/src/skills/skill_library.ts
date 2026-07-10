import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listMacroSkills } from "./macro_skills.js";
import { ensureWorkspaceLayout } from "../workspace.js";

const cacheByWorkspace = new Map<string, { value: string; atMs: number }>();

type SkillManifestEntry = {
  path: string;
  max_chars?: number;
};

type SkillLibraryManifest = {
  schema_version?: number;
  files?: SkillManifestEntry[];
};

const DEFAULT_MANIFEST_REL = path.join("skills", "skill_library_manifest.json");
const DEFAULT_MAX_TOTAL_CHARS = 24000;
const DEFAULT_MAX_FILE_CHARS = 3500;
const DEFAULT_LOCAL_MAX_FILE_CHARS = 2000;
const DEFAULT_MAX_LOCAL_FILES = 20;

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    const operatorBackend = fs.existsSync(path.join(cur, "apps", "operator-backend"))
      ? path.join(cur, "apps", "operator-backend")
      : path.join(cur, "operator-backend");
    const prompts = path.join(cur, "prompts");
    const skills = path.join(cur, "skills");
    const mcpServer = fs.existsSync(path.join(cur, "apps", "mcp-server"))
      ? path.join(cur, "apps", "mcp-server")
      : path.join(cur, "mcp-server");
    if (fs.existsSync(operatorBackend) && (fs.existsSync(prompts) || fs.existsSync(skills) || fs.existsSync(mcpServer))) return cur;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  // Fall back: assume we started in operator-backend
  return path.resolve(startDir, "..");
}

function readTrimmed(filePath: string, maxChars: number): string {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const normalized = txt.replace(/\r\n/g, "\n");
    if (normalized.length <= maxChars) return normalized.trim();
    return (normalized.slice(0, maxChars) + "\n…(truncated)").trim();
  } catch {
    return "";
  }
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function parseIntEnv(raw: string | undefined, fallback: number, minValue: number, maxValue: number): number {
  const n = Number.parseInt((raw ?? "").toString().trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(minValue, Math.min(maxValue, n));
}

function normalizeRelForDisplay(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function toFsRelative(rel: string): string {
  return rel.replace(/[\\/]+/g, path.sep);
}

function isSafeRepoRelative(rel: string): boolean {
  const t = (rel ?? "").trim();
  if (!t) return false;
  if (path.isAbsolute(t)) return false;
  const normalized = path.posix.normalize(t.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) return false;
  return true;
}

function defaultManifestEntries(): SkillManifestEntry[] {
  return [
    { path: "prompts/system.md" },
    { path: "prompts/soul.md" },
    { path: "prompts/policies/privacy.md" },
    { path: "prompts/policies/file_io.md" },
    { path: "prompts/policies/revit_transactions.md" },
    { path: "prompts/policies/mep_resize.md" },
    { path: "prompts/policies/web_research.md" },
    { path: "prompts/templates/plan_execute_verify.md" },
    { path: "prompts/templates/plan_execute_verify_titleblock.md" },
    { path: "prompts/templates/tool_result_format.md" },
    { path: "skills/README.md" },
    { path: "skills/INDEX.md" },
    { path: "skills/workflows/mep_resize_scope.md" },
    { path: "skills/workflows/mep_trace_connected_network.md" },
    { path: "skills/runbooks/mep_resize_runbook.md" },
    { path: "skills/workflows/sheet_titleblock_update.md" },
    { path: "skills/workflows/print_sheet_sets.md" },
    { path: "docs/PRIMITIVES_VS_SKILLS.md" }
  ];
}

function loadManifestEntries(repoRoot: string): SkillManifestEntry[] {
  const configured = (process.env.OPERATOR_SKILL_LIBRARY_MANIFEST || "").trim();
  const relOrAbs = configured || DEFAULT_MANIFEST_REL;
  const manifestPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(repoRoot, toFsRelative(relOrAbs));

  try {
    if (!fs.existsSync(manifestPath)) return defaultManifestEntries();
    const raw = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as SkillLibraryManifest;
    if (!parsed || typeof parsed !== "object") return defaultManifestEntries();
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const out: SkillManifestEntry[] = [];
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      const rel = typeof (f as any).path === "string" ? (f as any).path.trim() : "";
      if (!isSafeRepoRelative(rel)) continue;
      const max_chars = Number.isFinite((f as any).max_chars) ? Number((f as any).max_chars) : undefined;
      out.push({ path: normalizeRelForDisplay(rel), ...(max_chars ? { max_chars } : {}) });
    }
    return out.length > 0 ? out : defaultManifestEntries();
  } catch {
    return defaultManifestEntries();
  }
}

function legacySkillDocRelPaths(): string[] {
  return [
    path.join("Feature Request", "01_revit_operator_codex_directive.txt"),
    path.join("Feature Request", "Persistent_memory_architecture.txt"),
    path.join("Feature Request", "02_Foundational skills.txt"),
    path.join("Feature Request", "03_quantify skill.txt"),
    path.join("Feature Request", "04_Trace Ex Conditions Pipeline.txt"),
    path.join("Feature Request", "05_Thermal zones skill.txt"),
    path.join("Feature Request", "06_zone to vav placement skill.txt"),
    path.join("Feature Request", "07_code_compliance_skill.txt"),
    path.join("Feature Request", "08_FA Device Layout.txt"),
    path.join("Feature Request", "09_Next_Steps_Tools_Scripts.txt"),
    path.join("Feature Request", "File_Uploads_and_Drafting_Automation_Plan.md"),
    path.join("Feature Request", "FGI_Detailed_Requirements.md"),
    path.join("Feature Request", "complete", "Plan_execute_prove.txt"),
    path.join("Feature Request", "complete", "drafting.txt"),
    path.join("Feature Request", "complete", "Manipulation.txt"),
    path.join("Feature Request", "complete", "place family.txt"),
    path.join("Feature Request", "complete", "Element Selection.txt"),
    path.join("Feature Request", "complete", "Fire_Damper_Audit_Spec.md"),
    path.join("docs", "epics", "EPIC-0002_room-intelligence", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0003_fire-rating-audit", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0004_auto-dimensioning", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0005_fire-damper-audit", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0006_lighting-audit", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0007_ceiling-alignment", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0008_element-selection", "01_detailed_plan.md"),
    path.join("docs", "epics", "EPIC-0009_code_compliance", "NOTES.md"),
    path.join("docs", "epics", "EPIC-0009_fire-alarm-device-layout", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0010_fire-alarm-device-layout", "00_brief.md"),
    path.join("docs", "epics", "EPIC-0017_connected-mep-resize-workflow", "00_brief.md"),
    path.join("docs", "agent-memory", "MEMORY.md"),
    path.join("docs", "agent-memory", "WORKFLOWS.md")
  ];
}

function shouldIncludeLegacySkillDocs(): boolean {
  return parseBool(process.env.OPERATOR_SKILL_LIBRARY_ENABLE_LEGACY, false);
}

export function getSkillLibraryText(): string {
  const cacheMs = Math.max(0, Number.parseInt(process.env.OPERATOR_SKILL_LIBRARY_CACHE_MS ?? "5000", 10) || 5000);
  const now = Date.now();
  const workspaceRoot = ensureWorkspaceLayout().root;
  const cacheKey = workspaceRoot.toLowerCase();
  const cached = cacheByWorkspace.get(cacheKey);
  if (cached && now - cached.atMs < cacheMs) return cached.value;

  const repoRoot = findRepoRoot(process.cwd());

  const parts: string[] = [];
  const maxTotalChars = parseIntEnv(process.env.OPERATOR_SKILL_LIBRARY_MAX_TOTAL_CHARS, DEFAULT_MAX_TOTAL_CHARS, 2000, 200000);
  const maxFileCharsDefault = parseIntEnv(process.env.OPERATOR_SKILL_LIBRARY_MAX_FILE_CHARS, DEFAULT_MAX_FILE_CHARS, 300, 50000);
  const seenRel = new Set<string>();

  let total = 0;
  const entries = loadManifestEntries(repoRoot);
  for (const entry of entries) {
    if (total >= maxTotalChars) break;
    const relDisplay = normalizeRelForDisplay(entry.path);
    if (seenRel.has(relDisplay)) continue;
    seenRel.add(relDisplay);
    const relFs = toFsRelative(entry.path);
    const full = path.join(repoRoot, relFs);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;

    const fileLimit = Math.max(200, Math.min(maxFileCharsDefault, Number.isFinite(entry.max_chars) ? Number(entry.max_chars) : maxFileCharsDefault));
    const chunk = readTrimmed(full, Math.min(fileLimit, maxTotalChars - total));
    if (!chunk) continue;

    parts.push(`--- ${relDisplay} ---`);
    parts.push(chunk);
    parts.push("");
    total += chunk.length;
  }

  if (shouldIncludeLegacySkillDocs()) {
    for (const rel of legacySkillDocRelPaths()) {
      if (total >= maxTotalChars) break;
      const relDisplay = normalizeRelForDisplay(rel);
      if (seenRel.has(relDisplay)) continue;
      seenRel.add(relDisplay);
      const full = path.join(repoRoot, rel);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      const chunk = readTrimmed(full, Math.min(maxFileCharsDefault, maxTotalChars - total));
      if (!chunk) continue;
      parts.push(`--- ${relDisplay} ---`);
      parts.push(chunk);
      parts.push("");
      total += chunk.length;
    }
  }

  // Local, user-specific skills (not committed): allow power users to extend behavior without changing global code.
  const localSkillDirs: string[] = [];
  try {
    const fromEnv = (process.env.OPERATOR_LOCAL_SKILLS_DIR || "").trim();
    if (fromEnv) localSkillDirs.push(fromEnv);
  } catch {
    // ignore
  }

  try {
    // Repo-local skills dir (gitignored).
    localSkillDirs.push(path.join(repoRoot, "skills", "local"));
    // Legacy repo-local path (pre-2026-02), still supported.
    const backendRoot = fs.existsSync(path.join(repoRoot, "apps", "operator-backend"))
      ? path.join(repoRoot, "apps", "operator-backend")
      : path.join(repoRoot, "operator-backend");
    localSkillDirs.push(path.join(backendRoot, "skills-local"));
  } catch {
    // ignore
  }

  try {
    // Machine-local skills dir.
    const appData = process.platform === "win32" ? process.env.LOCALAPPDATA : undefined;
    const base = appData && appData.trim() ? appData : path.join(os.homedir(), ".revitoperator");
    localSkillDirs.push(path.join(base, "RevitOperator", "Skills"));
  } catch {
    // ignore
  }

  const maxLocalFiles = parseIntEnv(process.env.OPERATOR_SKILL_LIBRARY_MAX_LOCAL_FILES, DEFAULT_MAX_LOCAL_FILES, 1, 200);
  const localMaxFileChars = parseIntEnv(process.env.OPERATOR_SKILL_LIBRARY_MAX_LOCAL_FILE_CHARS, DEFAULT_LOCAL_MAX_FILE_CHARS, 200, 50000);
  let localCount = 0;

  const uniqueLocalDirs = [...new Set(localSkillDirs.map(d => path.resolve(d)))];
  for (const d of uniqueLocalDirs) {
    if (total >= maxTotalChars) break;
    if (!d || !fs.existsSync(d)) continue;

    let files: string[] = [];
    try {
      files = fs
        .readdirSync(d)
        .filter(f => f.toLowerCase().endsWith(".md") || f.toLowerCase().endsWith(".txt"))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }

    for (const f of files) {
      if (total >= maxTotalChars) break;
      localCount++;
      if (localCount > maxLocalFiles) break;
      const full = path.join(d, f);
      const chunk = readTrimmed(full, Math.min(localMaxFileChars, maxTotalChars - total));
      if (!chunk) continue;
      parts.push(`--- local-skill ${full} ---`);
      parts.push(chunk);
      parts.push("");
      total += chunk.length;
    }
  }

  // Macro skills (Workspace/skills/*.skill.json): include a compact list (not full bodies).
  try {
    const skills = listMacroSkills();
    if (skills.length > 0 && total < maxTotalChars) {
      const layout = ensureWorkspaceLayout();
      parts.push("--- macro-skills (workspace) ---");
      parts.push(`Workspace skills dir: ${layout.skills}`);
      parts.push("Local skills (enabled): skills/local/*.skill.json");
      parts.push("Local skills (staging): skills/local/.staging/*.skill.json");
      parts.push("Local skills (disabled): skills/disabled/*.skill.json");
      const lines: string[] = [];
      lines.push(`Macro skills (${skills.length}):`);
      for (const s of skills.slice(0, 40)) {
        const req = s.inputs.filter(i => i.required).map(i => i.name);
        const opt = s.inputs.filter(i => !i.required).map(i => i.name);
        const io = req.length || opt.length ? ` (required=[${req.join(", ")}] optional=[${opt.join(", ")}])` : "";
        lines.push(`- ${s.id}: ${s.name} — ${s.description}${io}`);
      }
      if (skills.length > 40) lines.push(`…(+${skills.length - 40} more)`);
      lines.push("Commands: list skills | run skill <id> with {...} | save skill {...} | install skill <id> | disable skill <id> | enable skill <id>");
      const chunk = lines.join("\n");
      parts.push(chunk);
      parts.push("");
      total += chunk.length;
    }
  } catch {
    // ignore
  }

  const value = parts.join("\n").trim();
  cacheByWorkspace.set(cacheKey, { value, atMs: now });
  return value;
}
