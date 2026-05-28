import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActionCall, ChatRequest, ChatResponse } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { buildAllowlistFromPairs, filterAllowlistedActions } from "../allowlist.js";
import { ensureWorkspaceLayout } from "../workspace.js";

export type MacroSkillInput = {
  name: string;
  description?: string;
  required?: boolean;
  default?: unknown;
};

export type MacroSkillAction = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  title?: string;
};

export type MacroSkill = {
  id: string;
  name: string;
  description: string;
  inputs?: MacroSkillInput[];
  actions: MacroSkillAction[];
  requiresApproval?: boolean;
  tags?: string[];
};

export type MacroSkillSummary = {
  id: string;
  name: string;
  description: string;
  inputs: Array<{ name: string; required: boolean }>;
};

export type MacroSkillsDirs = {
  core: string;
  local: string;
  staging: string;
  disabled: string;
  quarantine: string;
};

export function getMacroSkillsDirs(): MacroSkillsDirs {
  const layout = ensureWorkspaceLayout();
  const core = layout.skills;
  const local = path.join(core, "local");
  const staging = path.join(local, ".staging");
  const disabled = path.join(core, "disabled");
  const quarantine = path.join(disabled, "quarantine");
  return { core, local, staging, disabled, quarantine };
}

function skillsDirCore(): string {
  return getMacroSkillsDirs().core;
}

function skillsDirLocal(): string {
  return getMacroSkillsDirs().local;
}

function skillsDirStaging(): string {
  return getMacroSkillsDirs().staging;
}

function skillsDirDisabled(): string {
  return getMacroSkillsDirs().disabled;
}

export function isSafeMacroSkillId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(id);
}

function skillPathForIdInDir(dir: string, id: string): string {
  if (!isSafeMacroSkillId(id)) throw new Error("Invalid skill id (use letters/numbers/._-)");
  return path.join(dir, `${id}.skill.json`);
}

function parseJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function getString(o: any, key: string): string {
  const v = o?.[key];
  if (typeof v !== "string") return "";
  return v.trim();
}

function validateAction(a: any): MacroSkillAction {
  const method = getString(a, "method").toUpperCase();
  const pathv = getString(a, "path");
  if (method !== "GET" && method !== "POST") throw new Error("Invalid action.method (must be GET or POST)");
  if (!pathv.startsWith("/")) throw new Error("Invalid action.path");

  const out: MacroSkillAction = { method: method as any, path: pathv };
  if (a?.title !== undefined) {
    const t = getString(a, "title");
    if (t) out.title = t;
  }
  if (method === "POST" && a?.body !== undefined) out.body = a.body;
  return out;
}

function validateSkill(obj: any): MacroSkill {
  const id = getString(obj, "id");
  const name = getString(obj, "name");
  const description = getString(obj, "description");
  if (!id || !isSafeMacroSkillId(id)) throw new Error("Skill.id is required and must be a safe id.");
  if (!name) throw new Error("Skill.name is required.");
  if (!description) throw new Error("Skill.description is required.");

  const actionsRaw = obj?.actions;
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) throw new Error("Skill.actions must be a non-empty array.");
  const actions = actionsRaw.map(validateAction);

  const inputsRaw = obj?.inputs;
  const inputs: MacroSkillInput[] = [];
  if (Array.isArray(inputsRaw)) {
    for (const i of inputsRaw) {
      const n = getString(i, "name");
      if (!n) continue;
      inputs.push({
        name: n,
        description: typeof i?.description === "string" ? i.description : undefined,
        required: typeof i?.required === "boolean" ? i.required : false,
        default: i?.default
      });
    }
  }

  const requiresApproval = typeof obj?.requiresApproval === "boolean" ? obj.requiresApproval : undefined;
  const tags = Array.isArray(obj?.tags) ? obj.tags.filter((t: any) => typeof t === "string").slice(0, 25) : undefined;

  return { id, name, description, inputs: inputs.length ? inputs : undefined, actions, requiresApproval, tags };
}

export function validateMacroSkillObject(obj: unknown): MacroSkill {
  if (!obj || typeof obj !== "object") throw new Error("Skill must be a JSON object.");
  return validateSkill(obj as any);
}

function findMacroSkillFiles(): Array<{ filePath: string; kind: "core" | "local" }> {
  const coreDir = skillsDirCore();
  const localDir = skillsDirLocal();
  try {
    const out: Array<{ filePath: string; kind: "core" | "local" }> = [];
    const coreFiles = fs
      .readdirSync(coreDir)
      .filter(f => f.toLowerCase().endsWith(".skill.json"))
      .map(f => ({ filePath: path.join(coreDir, f), kind: "core" as const }));

    let localFiles: Array<{ filePath: string; kind: "local" }> = [];
    try {
      localFiles = fs
        .readdirSync(localDir)
        .filter(f => f.toLowerCase().endsWith(".skill.json"))
        .map(f => ({ filePath: path.join(localDir, f), kind: "local" as const }));
    } catch {
      localFiles = [];
    }

    out.push(...coreFiles, ...localFiles);
    out.sort((a, b) => a.filePath.localeCompare(b.filePath));
    return out;
  } catch {
    return [];
  }
}

export function listMacroSkills(): MacroSkillSummary[] {
  const out: MacroSkillSummary[] = [];
  for (const f of findMacroSkillFiles()) {
    try {
      const parsed = parseJsonFile(f.filePath) as any;
      const s = validateSkill(parsed);
      out.push({
        id: s.id,
        name: s.name,
        description: s.description,
        inputs: (s.inputs ?? []).map(i => ({ name: i.name, required: !!i.required }))
      });
    } catch {
      // ignore invalid files
    }
  }
  return out;
}

export function loadMacroSkill(id: string): MacroSkill | null {
  try {
    const localPath = skillPathForIdInDir(skillsDirLocal(), id);
    if (fs.existsSync(localPath)) {
      const parsed = parseJsonFile(localPath) as any;
      return validateSkill(parsed);
    }

    const corePath = skillPathForIdInDir(skillsDirCore(), id);
    if (fs.existsSync(corePath)) {
      const parsed = parseJsonFile(corePath) as any;
      return validateSkill(parsed);
    }

    return null;
  } catch {
    return null;
  }
}

export function saveMacroSkillToDir(skill: MacroSkill, dir: string): void {
  const validated = validateSkill(skill as any);
  const p = skillPathForIdInDir(dir, validated.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function saveMacroSkill(skill: MacroSkill): void {
  saveMacroSkillToDir(skill, skillsDirCore());
}

export function loadStagedMacroSkill(id: string): MacroSkill | null {
  try {
    const p = skillPathForIdInDir(skillsDirStaging(), id);
    if (!fs.existsSync(p)) return null;
    const parsed = parseJsonFile(p) as any;
    return validateSkill(parsed);
  } catch {
    return null;
  }
}

export function loadDisabledMacroSkill(id: string): MacroSkill | null {
  try {
    const p = skillPathForIdInDir(skillsDirDisabled(), id);
    if (!fs.existsSync(p)) return null;
    const parsed = parseJsonFile(p) as any;
    return validateSkill(parsed);
  } catch {
    return null;
  }
}

function getByPath(obj: any, dotted: string): any {
  if (!dotted) return undefined;
  const parts = dotted.split(".").map(s => s.trim()).filter(Boolean);
  let cur: any = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function renderTemplateString(s: string, vars: Record<string, unknown>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = getByPath(vars, String(key));
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

function renderTemplates(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (m) {
      const v = getByPath(vars, String(m[1]));
      if (v === undefined || v === null) return "";
      return v;
    }
    return renderTemplateString(value, vars);
  }
  if (Array.isArray(value)) return value.map(v => renderTemplates(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTemplates(v, vars);
    }
    return out;
  }
  return value;
}

function buildInputs(skill: MacroSkill, provided: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided };
  for (const i of skill.inputs ?? []) {
    if (out[i.name] === undefined && i.default !== undefined) out[i.name] = i.default;
    if (i.required && out[i.name] === undefined) throw new Error(`Missing required input: ${i.name}`);
  }
  return out;
}

export function runMacroSkill(req: ChatRequest, skill: MacroSkill, providedInputs: Record<string, unknown>): ChatResponse {
  const vars = buildInputs(skill, providedInputs);

  const actions: ActionCall[] = [];
  for (let i = 0; i < skill.actions.length; i++) {
    const a = skill.actions[i]!;
    const action_id = `${req.message_id || randomUUID()}:${skill.id}:${i + 1}`;
    const body = a.body === undefined ? undefined : renderTemplates(a.body, vars);
    actions.push({
      action_id,
      method: a.method,
      path: a.path,
      ...(a.method === "GET" ? {} : body === undefined ? {} : { body })
    });
  }

  const allowlistFromContext = buildAllowlistFromPairs((req.context as any)?.capabilities?.allowlist);
  const allowlisted = filterAllowlistedActions(actions, allowlistFromContext ?? undefined);
  const dropped = actions.length - allowlisted.length;

  const inputSummary = Object.keys(vars).length ? `inputs=${JSON.stringify(vars)}` : "inputs={}";
  const msg =
    `Running skill ${skill.name} (${skill.id}) — ${skill.description}\n` +
    `Steps: ${actions.length}` +
    (dropped > 0 ? ` (dropped ${dropped} non-allowlisted step(s))` : "") +
    `\n${inputSummary}`;

  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: msg, actions: allowlisted };
}
