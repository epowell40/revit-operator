import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getMacroSkillsDirs, isSafeMacroSkillId, validateMacroSkillObject, type MacroSkill } from "./macro_skills.js";
import { isAllowlisted } from "../allowlist.js";

export type LocalSkillStatus = "staged" | "enabled" | "disabled" | "quarantined";

export type LocalSkillRegistryEntry = {
  id: string;
  name: string;
  description: string;
  status: LocalSkillStatus;
  updated_at: string;
  created_at: string;
  path?: string | null;
  sha256?: string | null;
  last_error?: string | null;
};

export type LocalSkillRegistry = {
  schema_version: 1;
  updated_at: string;
  skills: Record<string, LocalSkillRegistryEntry>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(buf: Buffer): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function atomicWriteJson(filePath: string, obj: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function registryPath(): string {
  const dirs = getMacroSkillsDirs();
  return path.join(dirs.local, "registry.json");
}

export function loadLocalSkillRegistry(): LocalSkillRegistry {
  const p = registryPath();
  try {
    if (!fs.existsSync(p)) {
      return { schema_version: 1, updated_at: nowIso(), skills: {} };
    }
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const parsed: any = JSON.parse(raw);
    if (parsed?.schema_version !== 1) return { schema_version: 1, updated_at: nowIso(), skills: {} };
    const skills = parsed?.skills && typeof parsed.skills === "object" ? parsed.skills : {};
    return { schema_version: 1, updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : nowIso(), skills };
  } catch {
    return { schema_version: 1, updated_at: nowIso(), skills: {} };
  }
}

export function saveLocalSkillRegistry(reg: LocalSkillRegistry): void {
  const next: LocalSkillRegistry = {
    schema_version: 1,
    updated_at: nowIso(),
    skills: reg?.skills && typeof reg.skills === "object" ? reg.skills : {}
  };
  atomicWriteJson(registryPath(), next);
}

export type SkillGateResult = { ok: true; skill: MacroSkill; normalizedJson: string } | { ok: false; error: string };

export function gateLocalMacroSkill(rawObj: unknown): SkillGateResult {
  let skill: MacroSkill;
  try {
    skill = validateMacroSkillObject(rawObj);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!isSafeMacroSkillId(skill.id)) return { ok: false, error: "Invalid skill id." };
  if (skill.actions.length > 40) return { ok: false, error: "Skill has too many actions (max 40)." };

  // Reject unknown/unsafe actions by default (host-controlled allowlist remains in force at runtime).
  for (const a of skill.actions) {
    if (!isAllowlisted(a.method, a.path)) {
      return { ok: false, error: `Forbidden action for local skills: ${a.method} ${a.path}` };
    }
    if (!a.path.startsWith("/revit/")) {
      return { ok: false, error: `Forbidden action path (must start with /revit/): ${a.path}` };
    }
  }

  const normalized = JSON.stringify(skill, null, 2) + "\n";
  return { ok: true, skill, normalizedJson: normalized };
}

function updateEntry(reg: LocalSkillRegistry, entry: LocalSkillRegistryEntry): void {
  reg.skills[entry.id] = entry;
}

function ensureEntry(reg: LocalSkillRegistry, skill: MacroSkill, status: LocalSkillStatus, filePath: string | null, sha256: string | null, lastError?: string | null): LocalSkillRegistryEntry {
  const existing = reg.skills[skill.id];
  const created_at = existing?.created_at && typeof existing.created_at === "string" ? existing.created_at : nowIso();
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    status,
    created_at,
    updated_at: nowIso(),
    path: filePath,
    sha256,
    last_error: lastError ?? null
  };
}

function safeQuarantineName(id: string): string {
  const base = (id ?? "").toString().trim();
  const s = base && isSafeMacroSkillId(base) ? base : "unknown";
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

export function stageLocalSkill(rawObj: unknown): { ok: true; id: string; stagedPath: string } | { ok: false; error: string; quarantinePath?: string } {
  const dirs = getMacroSkillsDirs();
  const reg = loadLocalSkillRegistry();

  const gated = gateLocalMacroSkill(rawObj);
  if (!gated.ok) {
    // Quarantine the raw object for debugging.
    try {
      fs.mkdirSync(dirs.quarantine, { recursive: true });
      const idGuess = typeof (rawObj as any)?.id === "string" ? (rawObj as any).id : "";
      const name = safeQuarantineName(idGuess);
      const p = path.join(dirs.quarantine, `${Date.now()}_${name}.skill.json`);
      fs.writeFileSync(p, JSON.stringify(rawObj, null, 2) + "\n", "utf8");
      fs.writeFileSync(p + ".reason.txt", gated.error + "\n", "utf8");

      // Best-effort registry update.
      const fakeId = isSafeMacroSkillId(idGuess) ? idGuess.trim() : `quarantine_${Date.now()}`;
      try {
        const entry: LocalSkillRegistryEntry = {
          id: fakeId,
          name: typeof (rawObj as any)?.name === "string" ? (rawObj as any).name : "(invalid skill)",
          description: typeof (rawObj as any)?.description === "string" ? (rawObj as any).description : "",
          status: "quarantined",
          created_at: nowIso(),
          updated_at: nowIso(),
          path: p,
          sha256: sha256Hex(Buffer.from(JSON.stringify(rawObj), "utf8")),
          last_error: gated.error
        };
        updateEntry(reg, entry);
        saveLocalSkillRegistry(reg);
      } catch {
        // ignore
      }

      return { ok: false, error: gated.error, quarantinePath: p };
    } catch {
      return { ok: false, error: gated.error };
    }
  }

  const staged = path.join(dirs.staging, `${gated.skill.id}.skill.json`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, gated.normalizedJson, "utf8");
  const sha = sha256Hex(Buffer.from(gated.normalizedJson, "utf8"));

  const entry = ensureEntry(reg, gated.skill, "staged", staged, sha, null);
  updateEntry(reg, entry);
  saveLocalSkillRegistry(reg);
  return { ok: true, id: gated.skill.id, stagedPath: staged };
}

export function installStagedSkill(id: string): { ok: true; installedPath: string } | { ok: false; error: string } {
  const dirs = getMacroSkillsDirs();
  if (!isSafeMacroSkillId(id)) return { ok: false, error: "Invalid skill id." };

  const staged = path.join(dirs.staging, `${id}.skill.json`);
  if (!fs.existsSync(staged)) return { ok: false, error: `No staged skill found: ${id}` };

  const raw = fs.readFileSync(staged, "utf8").replace(/^\uFEFF/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Staged skill file is not valid JSON." };
  }

  const gated = gateLocalMacroSkill(obj);
  if (!gated.ok) return { ok: false, error: `Staged skill failed gating: ${gated.error}` };

  const installed = path.join(dirs.local, `${id}.skill.json`);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, gated.normalizedJson, "utf8");
  const sha = sha256Hex(Buffer.from(gated.normalizedJson, "utf8"));

  // Remove staged file (best-effort).
  try {
    fs.unlinkSync(staged);
  } catch {
    // ignore
  }

  const reg = loadLocalSkillRegistry();
  const entry = ensureEntry(reg, gated.skill, "enabled", installed, sha, null);
  updateEntry(reg, entry);
  saveLocalSkillRegistry(reg);
  return { ok: true, installedPath: installed };
}

export function disableInstalledSkill(id: string): { ok: true; disabledPath: string } | { ok: false; error: string } {
  const dirs = getMacroSkillsDirs();
  if (!isSafeMacroSkillId(id)) return { ok: false, error: "Invalid skill id." };

  const installed = path.join(dirs.local, `${id}.skill.json`);
  if (!fs.existsSync(installed)) return { ok: false, error: `Local skill not found: ${id}` };

  fs.mkdirSync(dirs.disabled, { recursive: true });
  const disabled = path.join(dirs.disabled, `${id}.skill.json`);
  fs.renameSync(installed, disabled);

  const reg = loadLocalSkillRegistry();
  const existing = reg.skills[id];
  const entry: LocalSkillRegistryEntry = {
    id,
    name: existing?.name ?? id,
    description: existing?.description ?? "",
    status: "disabled",
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    path: disabled,
    sha256: existing?.sha256 ?? null,
    last_error: null
  };
  updateEntry(reg, entry);
  saveLocalSkillRegistry(reg);
  return { ok: true, disabledPath: disabled };
}

export function enableDisabledSkill(id: string): { ok: true; installedPath: string } | { ok: false; error: string } {
  const dirs = getMacroSkillsDirs();
  if (!isSafeMacroSkillId(id)) return { ok: false, error: "Invalid skill id." };

  const disabled = path.join(dirs.disabled, `${id}.skill.json`);
  if (!fs.existsSync(disabled)) return { ok: false, error: `Disabled skill not found: ${id}` };

  const raw = fs.readFileSync(disabled, "utf8").replace(/^\uFEFF/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Disabled skill file is not valid JSON." };
  }

  const gated = gateLocalMacroSkill(obj);
  if (!gated.ok) return { ok: false, error: `Disabled skill failed gating: ${gated.error}` };

  const installed = path.join(dirs.local, `${id}.skill.json`);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, gated.normalizedJson, "utf8");
  const sha = sha256Hex(Buffer.from(gated.normalizedJson, "utf8"));

  try {
    fs.unlinkSync(disabled);
  } catch {
    // ignore
  }

  const reg = loadLocalSkillRegistry();
  const entry = ensureEntry(reg, gated.skill, "enabled", installed, sha, null);
  updateEntry(reg, entry);
  saveLocalSkillRegistry(reg);
  return { ok: true, installedPath: installed };
}

