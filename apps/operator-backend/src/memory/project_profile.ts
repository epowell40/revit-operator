import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureWorkspaceLayout } from "../workspace.js";
import { appendDailyMemory, appendLongtermMemory } from "./jsonl_memory_store.js";

export type ProjectStandard = {
  id: string;
  category: string;
  text: string;
  source: string;
  created_at: string;
  updated_at: string;
  session_id?: string;
  tags?: string[];
};

export type ProjectProfile = {
  version: 1;
  updated_at: string;
  standards: ProjectStandard[];
};

export type AddProjectStandardArgs = {
  text: string;
  category?: string | null;
  source?: string | null;
  session_id?: string | null;
  tags?: string[] | null;
  mirror_to_memory?: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function profilePath(): string {
  return path.join(ensureWorkspaceLayout().memory, "project_profile.json");
}

function emptyProfile(): ProjectProfile {
  return { version: 1, updated_at: nowIso(), standards: [] };
}

function normalizeText(value: unknown, max = 1200): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max).trim();
}

function normalizeCategory(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "general";
}

function normalizeTags(tags: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = normalizeCategory(tag);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}

function readJsonFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProfile(raw: unknown): ProjectProfile {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const updated = typeof source.updated_at === "string" && source.updated_at.trim() ? source.updated_at.trim() : nowIso();
  const standardsRaw = Array.isArray(source.standards) ? source.standards : [];
  const standards: ProjectStandard[] = [];
  const seen = new Set<string>();

  for (const item of standardsRaw) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!row) continue;
    const text = normalizeText(row.text);
    if (!text) continue;
    let id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `ps_${randomUUID()}`;
    if (seen.has(id)) id = `ps_${randomUUID()}`;
    seen.add(id);
    const created = typeof row.created_at === "string" && row.created_at.trim() ? row.created_at.trim() : updated;
    const changed = typeof row.updated_at === "string" && row.updated_at.trim() ? row.updated_at.trim() : created;
    const sourceText = normalizeText(row.source, 120) || "manual";
    standards.push({
      id,
      category: normalizeCategory(row.category),
      text,
      source: sourceText,
      created_at: created,
      updated_at: changed,
      ...(typeof row.session_id === "string" && row.session_id.trim() ? { session_id: row.session_id.trim() } : {}),
      ...(normalizeTags(Array.isArray(row.tags) ? row.tags.filter((x): x is string => typeof x === "string") : undefined) ? { tags: normalizeTags(Array.isArray(row.tags) ? row.tags.filter((x): x is string => typeof x === "string") : undefined) } : {})
    });
  }

  standards.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { version: 1, updated_at: updated, standards };
}

function writeProfile(profile: ProjectProfile): string {
  const p = profilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
  return p;
}

function standardKey(category: string, text: string): string {
  return `${category}\n${text.toLowerCase()}`;
}

export function readProjectProfile(): ProjectProfile {
  return normalizeProfile(readJsonFile(profilePath()));
}

export function addProjectStandard(args: AddProjectStandardArgs): { ok: true; profile: ProjectProfile; standard: ProjectStandard; profile_path: string; memory_daily_path?: string; memory_longterm_path?: string } {
  const text = normalizeText(args.text);
  if (!text) throw new Error("standard text is required.");
  const category = normalizeCategory(args.category);
  const ts = nowIso();
  const profile = readProjectProfile();
  const key = standardKey(category, text);
  const existing = profile.standards.find((s) => standardKey(s.category, s.text) === key);
  const source = normalizeText(args.source, 120) || "manual";
  const tags = normalizeTags(["project_standard", category, ...(args.tags ?? [])]);

  let standard: ProjectStandard;
  if (existing) {
    standard = { ...existing, source, updated_at: ts, ...(args.session_id ? { session_id: String(args.session_id).trim() } : {}), ...(tags ? { tags } : {}) };
    profile.standards = [standard, ...profile.standards.filter((s) => s.id !== existing.id)];
  } else {
    standard = {
      id: `ps_${randomUUID()}`,
      category,
      text,
      source,
      created_at: ts,
      updated_at: ts,
      ...(args.session_id ? { session_id: String(args.session_id).trim() } : {}),
      ...(tags ? { tags } : {})
    };
    profile.standards = [standard, ...profile.standards];
  }

  profile.updated_at = ts;
  const p = writeProfile(profile);

  let memory_daily_path: string | undefined;
  let memory_longterm_path: string | undefined;
  if (args.mirror_to_memory !== false) {
    const memoryText = `Project standard [${category}]: ${text}`;
    memory_daily_path = appendDailyMemory({
      kind: "preference",
      text: memoryText,
      session_id: args.session_id || undefined,
      source: "project_profile",
      tags
    });
    memory_longterm_path = appendLongtermMemory({
      kind: "preference",
      text: memoryText,
      session_id: args.session_id || undefined,
      source: "project_profile",
      tags
    });
  }

  return {
    ok: true,
    profile,
    standard,
    profile_path: p,
    ...(memory_daily_path ? { memory_daily_path } : {}),
    ...(memory_longterm_path ? { memory_longterm_path } : {})
  };
}

export function formatProjectProfileForPrompt(args: { maxStandards?: number; maxChars?: number } = {}): string {
  const profile = readProjectProfile();
  if (profile.standards.length === 0) return "";

  const maxStandards = Math.max(1, Math.min(40, Math.floor(args.maxStandards ?? 16)));
  const maxChars = Math.max(800, Math.min(8000, Math.floor(args.maxChars ?? 3200)));
  const lines: string[] = [];
  lines.push("PROJECT STANDARDS PROFILE (read-only; apply when relevant before generic memory):");
  lines.push(`updated_at=${profile.updated_at}`);
  let i = 0;
  for (const standard of profile.standards.slice(0, maxStandards)) {
    i++;
    const tag = Array.isArray(standard.tags) && standard.tags.length > 0 ? ` tags=${standard.tags.slice(0, 5).join(",")}` : "";
    lines.push(`[PS${i}] (${standard.category}; source=${standard.source}${tag}) ${standard.text}`);
    if (lines.join("\n").length >= maxChars) break;
  }
  if (profile.standards.length > i) lines.push(`... ${profile.standards.length - i} more standards omitted.`);
  const block = lines.join("\n");
  return block.length <= maxChars ? block : `${block.slice(0, maxChars).trimEnd()}\n...(truncated)`;
}

export function formatProjectProfileForUser(): string {
  const profile = readProjectProfile();
  if (profile.standards.length === 0) {
    return "No project standards saved yet. Use: remember project standard <category>: <standard>";
  }
  const lines: string[] = [];
  lines.push(`Project standards profile (${profile.standards.length} standard${profile.standards.length === 1 ? "" : "s"})`);
  lines.push(`Updated: ${profile.updated_at}`);
  for (const s of profile.standards.slice(0, 80)) {
    lines.push(`- ${s.id} [${s.category}] ${s.text}`);
  }
  if (profile.standards.length > 80) lines.push(`... ${profile.standards.length - 80} more`);
  return lines.join("\n");
}

