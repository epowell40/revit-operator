import fs from "node:fs";
import path from "node:path";

type SkillManifestEntry = {
  path: string;
  max_chars?: number;
};

type SkillLibraryManifest = {
  schema_version?: number;
  files?: SkillManifestEntry[];
};

function fail(msg: string): never {
  throw new Error(msg);
}

function findRepoRoot(startDir: string): string {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, "skills", "skill_library_manifest.json")) && fs.existsSync(path.join(cur, "operator-backend"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir, "..");
}

function normalizeRelForChecks(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function isSafeRepoRelative(rel: string): boolean {
  const t = rel.trim();
  if (!t) return false;
  if (path.isAbsolute(t)) return false;
  const normalized = path.posix.normalize(t.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) return false;
  return true;
}

function main(): void {
  const repoRoot = findRepoRoot(process.cwd());
  const manifestPath = path.join(repoRoot, "skills", "skill_library_manifest.json");
  if (!fs.existsSync(manifestPath)) fail(`Missing manifest: ${manifestPath}`);

  const raw = fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as SkillLibraryManifest;

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!parsed || typeof parsed !== "object") errors.push("Manifest root must be an object.");
  if (parsed.schema_version !== 1) errors.push(`schema_version must be 1 (found: ${String(parsed.schema_version)})`);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) errors.push("files must be a non-empty array.");

  const seen = new Set<string>();
  const entries = Array.isArray(parsed.files) ? parsed.files : [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as SkillManifestEntry;
    const idx = `files[${i}]`;
    const rel = typeof e?.path === "string" ? normalizeRelForChecks(e.path) : "";

    if (!rel) {
      errors.push(`${idx}.path is required.`);
      continue;
    }
    if (!isSafeRepoRelative(rel)) {
      errors.push(`${idx}.path must be a safe repo-relative path: ${rel}`);
      continue;
    }
    if (seen.has(rel)) {
      errors.push(`${idx}.path is duplicated: ${rel}`);
      continue;
    }
    seen.add(rel);

    const full = path.join(repoRoot, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(full)) {
      errors.push(`${idx}.path does not exist: ${rel}`);
      continue;
    }
    if (!fs.statSync(full).isFile()) {
      errors.push(`${idx}.path is not a file: ${rel}`);
      continue;
    }

    if (e.max_chars !== undefined) {
      if (!Number.isFinite(e.max_chars) || e.max_chars < 200 || e.max_chars > 50000) {
        errors.push(`${idx}.max_chars must be between 200 and 50000 when provided: ${String(e.max_chars)}`);
      }
    } else {
      warnings.push(`${idx} has no max_chars (using default truncation).`);
    }
  }

  console.log(
    [
      "Skill library manifest summary:",
      `- manifest: ${manifestPath}`,
      `- entries: ${entries.length}`
    ].join("\n")
  );

  if (warnings.length > 0) {
    console.warn("\nWarnings:");
    for (const w of warnings) console.warn(`- ${w}`);
  }

  if (errors.length > 0) {
    fail(`\nSkill library manifest checks failed:\n${errors.join("\n")}`);
  }

  console.log("Skill library manifest checks passed.");
}

main();
