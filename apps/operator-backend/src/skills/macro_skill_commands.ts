import fs from "node:fs";
import path from "node:path";
import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { appendEvent, appendNotification } from "../memory/sqlite_store.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { buildAllowlistFromPairs, filterAllowlistedActions } from "../allowlist.js";
import { getMacroSkillsDirs, listMacroSkills, loadDisabledMacroSkill, loadMacroSkill, loadStagedMacroSkill, type MacroSkill } from "./macro_skills.js";
import { hasValidWriteGrant } from "../operator_write_grant.js";
import { disableInstalledSkill, enableDisabledSkill, installStagedSkill, stageLocalSkill } from "./local_skill_registry.js";
import { persistence } from "../persistence/persistence_manager.js";
import { appendDailyMemory, appendLongtermMemory, retrieveMemoryContext } from "../memory/jsonl_memory_store.js";
import { addProjectStandard, formatProjectProfileForUser } from "../memory/project_profile.js";
import {
  createRequirement,
  deriveRequirementScopesForChat,
  formatRequirementsForUser,
  listRequirements,
  resolveRequirements
} from "../memory/requirements_store.js";

type ActiveRun = {
  sessionId: string;
  messageId: string;
  skill: MacroSkill;
  inputs: Record<string, unknown>;
  nextIndex: number; // 0-based index into skill.actions
  results: Array<{ action_id: string; status: "done" | "failed"; result_json?: unknown; error?: string }>;
  lastActionId?: string;
  startedAt: string;
};

const activeRuns = new Map<string, ActiveRun>();

function extractFirstJsonObject(raw: string): string | null {
  const s = raw || "";
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseInputsFromText(text: string): Record<string, unknown> {
  const idx = text.toLowerCase().indexOf(" with ");
  if (idx < 0) return {};
  const tail = text.slice(idx + " with ".length);
  const json = extractFirstJsonObject(tail);
  if (!json) throw new Error("Expected JSON object after 'with'.");
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Inputs must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function isTruthy(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function requireWriteGrantForSkillSaves(): boolean {
  // Default on: local skills/macros are a persistence mechanism and should be explicitly gated.
  const v = (process.env.OPERATOR_MACRO_SKILL_SAVE_REQUIRES_GRANT ?? "1").toString().trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

function sanitizeForFileName(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed) return "proposal";
  return trimmed
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64)
    .replace(/^_+|_+$/g, "") || "proposal";
}

function nowStampUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function truncate(s: string, max = 320): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…(truncated)";
}

function normalizeMemoryText(s: string, max = 800): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function formatMemoryHits(query: string): string {
  const hits = retrieveMemoryContext({ queryText: query, maxEntries: 8 });
  if (hits.length === 0) return `No memory hits for: ${query}`;
  const lines: string[] = [];
  lines.push(`Memory hits for: ${query}`);
  for (const h of hits) {
    const when = typeof h.ts === "string" ? h.ts : "";
    const scope = h.scope || "unknown";
    const kind = h.kind || "note";
    lines.push(`- [${scope}/${kind}] ${when}: ${truncate(h.text, 220)}`);
  }
  return lines.join("\n");
}

function parseProjectStandardCommand(raw: string, prefix: string): { category: string; text: string } {
  const body = normalizeMemoryText(raw.slice(prefix.length), 1200);
  if (!body) return { category: "general", text: "" };
  const colon = body.indexOf(":");
  if (colon > 0 && colon <= 48) {
    const category = body.slice(0, colon).trim();
    const text = body.slice(colon + 1).trim();
    if (category && text) return { category, text };
  }
  return { category: "general", text: body };
}

function summarizeResult(r: ToolResult): Record<string, unknown> {
  return {
    action_id: r.action_id,
    method: r.method,
    path: r.path,
    status: r.status,
    ...(r.error ? { error: truncate(r.error, 240) } : {}),
    ...(r.result_json !== undefined ? { result_json: r.result_json } : {})
  };
}

function buildVars(run: ActiveRun, req: ChatRequest): Record<string, unknown> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const now_stamp =
    String(now.getUTCFullYear()) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());

  const steps = run.results.map((r, i) => ({
    index: i + 1,
    action_id: r.action_id,
    status: r.status,
    result: r.result_json,
    error: r.error
  }));
  const last = steps.length > 0 ? steps[steps.length - 1] : null;
  const step: Record<string, unknown> = {};
  for (const s of steps) step[String((s as any).index)] = s;
  return {
    ...run.inputs,
    inputs: run.inputs,
    steps,
    step,
    last,
    session_id: req.session_id,
    message_id: req.message_id,
    context: req.context ?? null,
    now_iso: now.toISOString(),
    now_stamp
  };
}

function renderTemplateString(s: string, vars: Record<string, unknown>): string {
  const getByPath = (obj: any, dotted: string): any => {
    const parts = dotted.split(".").map(x => x.trim()).filter(Boolean);
    let cur: any = obj;
    for (const part of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  };

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
      const parts = String(m[1])
        .split(".")
        .map(x => x.trim())
        .filter(Boolean);
      let cur: any = vars;
      for (const part of parts) {
        if (!cur || typeof cur !== "object") {
          cur = undefined;
          break;
        }
        cur = cur[part];
      }
      if (cur === undefined || cur === null) return "";
      return cur;
    }
    return renderTemplateString(value, vars);
  }
  if (Array.isArray(value)) return value.map(v => renderTemplates(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderTemplates(v, vars);
    return out;
  }
  return value;
}

function allowlistOne(req: ChatRequest, action: ActionCall): ActionCall | null {
  const allowlistFromContext = buildAllowlistFromPairs((req.context as any)?.capabilities?.allowlist);
  const allowlisted = filterAllowlistedActions([action], allowlistFromContext ?? undefined);
  return allowlisted.length === 1 ? allowlisted[0]! : null;
}

function buildNextAction(req: ChatRequest, run: ActiveRun): ActionCall | null {
  if (run.nextIndex >= run.skill.actions.length) return null;
  const spec = run.skill.actions[run.nextIndex]!;
  const vars = buildVars(run, req);
  const action_id = `${req.message_id}:${run.skill.id}:${run.nextIndex + 1}`;
  const body = spec.body === undefined ? undefined : renderTemplates(spec.body, vars);
  const action: ActionCall = {
    action_id,
    method: spec.method,
    path: spec.path,
    ...(spec.method === "GET" ? {} : body === undefined ? {} : { body })
  };
  return allowlistOne(req, action);
}

function finishRun(sessionId: string): void {
  activeRuns.delete(sessionId);
}

function formatSkillList(): string {
  const skills = listMacroSkills();
  if (skills.length === 0) {
    return "No macro skills found. Create one with: create skill draft";
  }
  const lines: string[] = [];
  lines.push(`Macro skills (${skills.length}):`);
  for (const s of skills.slice(0, 60)) {
    const req = s.inputs.filter(i => i.required).map(i => i.name);
    const opt = s.inputs.filter(i => !i.required).map(i => i.name);
    const io = req.length || opt.length ? ` (required=[${req.join(", ")}] optional=[${opt.join(", ")}])` : "";
    lines.push(`- ${s.id}: ${s.name} — ${s.description}${io}`);
  }
  if (skills.length > 60) lines.push(`…(+${skills.length - 60} more)`);
  lines.push("");
  lines.push("Run: run skill <id> with { ... }");
  lines.push("Stop: cancel skill");
  lines.push("Local skills: save skill {...} (stages) | install skill <id> | disable skill <id> | enable skill <id>");
  lines.push("Memory: remember preference <text> | remember project requirement <key>: <text> | remember engineer preference <key>: <text> | remember requirement <office|engineer|project|client> <scope-id> <key>: <text> | show requirements | explain requirements <query>");
  lines.push("More: list staged skills | list disabled skills");
  return lines.join("\n");
}

function listSkillFilesInDir(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".skill.json"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function formatStagedSkills(): string {
  const dirs = getMacroSkillsDirs();
  const files = listSkillFilesInDir(dirs.staging);
  if (files.length === 0) return `No staged skills.\nStaging folder: ${dirs.staging}`;
  return [`Staged skills (${files.length}):`, ...files.slice(0, 80).map(f => `- ${f.replace(/\.skill\.json$/i, "")}`), "", `Staging folder: ${dirs.staging}`].join("\n");
}

function formatDisabledSkills(): string {
  const dirs = getMacroSkillsDirs();
  const files = listSkillFilesInDir(dirs.disabled);
  if (files.length === 0) return `No disabled skills.\nDisabled folder: ${dirs.disabled}`;
  return [`Disabled skills (${files.length}):`, ...files.slice(0, 80).map(f => `- ${f.replace(/\.skill\.json$/i, "")}`), "", `Disabled folder: ${dirs.disabled}`].join("\n");
}

function createDraftSkill(): MacroSkill {
  return {
    id: "example_export_active_view_pdf",
    name: "Export active view PDF",
    description: "Exports the active view to a PDF in the workspace prints folder.",
    inputs: [{ name: "fileName", required: false, default: "Print_{{now_stamp}}" }],
    actions: [{ method: "POST", path: "/revit/export-pdf", body: { fileName: "{{fileName}}" } }],
    requiresApproval: false,
    tags: ["documentation"]
  };
}

export function maybeHandleMacroSkill(req: ChatRequest): ChatResponse | null {
  const userText = (req.user_text ?? "").trim();
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];

  // Continuation: if a run is active and we have tool results, continue deterministically.
  const active = activeRuns.get(req.session_id);
  if (active && toolResults.length > 0 && !userText) {
    const filtered = toolResults.filter(tr => {
      const id = (tr?.action_id ?? "").toString();
      return !id.includes(":__auto_capture");
    });

    for (const tr of filtered) {
      active.results.push({
        action_id: tr.action_id,
        status: tr.status,
        ...(tr.result_json !== undefined ? { result_json: tr.result_json } : {}),
        ...(tr.error ? { error: tr.error } : {})
      });
      try { appendEvent(req.session_id, "tool", "skill.step_result", summarizeResult(tr)); } catch { }
    }

    // If any failed, abort the run.
    const failed = filtered.find(r => r.status === "failed");
    if (failed) {
      finishRun(req.session_id);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `Skill aborted: step failed (${failed.method} ${failed.path}).`,
        actions: []
      };
    }

    active.nextIndex++;
    const next = buildNextAction(req, active);
    if (!next) {
      finishRun(req.session_id);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `Skill complete: ${active.skill.name} (${active.skill.id}).`,
        actions: []
      };
    }

    active.lastActionId = next.action_id;
    try { appendEvent(req.session_id, "assistant", "skill.step", { id: active.skill.id, step: active.nextIndex + 1, action: { method: next.method, path: next.path } }); } catch { }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Skill ${active.skill.name}: running step ${active.nextIndex + 1}/${active.skill.actions.length}…`,
      actions: [next]
    };
  }

  if (!userText) return null;
  const lower = userText.toLowerCase();

  if (lower === "skills" || lower === "list skills" || lower === "list skill") {
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatSkillList(), actions: [] };
  }

  if (
    lower === "project profile" ||
    lower === "show project profile" ||
    lower === "standards profile" ||
    lower === "show standards profile" ||
    lower === "show project standards"
  ) {
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatProjectProfileForUser(), actions: [] };
  }

  if (lower === "show requirements" || lower === "list requirements") {
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatRequirementsForUser(listRequirements({ status: "all", limit: 200 })), actions: [] };
  }

  if (lower === "explain requirements" || lower.startsWith("explain requirements ")) {
    const query = normalizeMemoryText(userText.slice("explain requirements".length), 1000);
    const receipt = resolveRequirements({ scope_refs: deriveRequirementScopesForChat(req), query, max_results: 80 });
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: JSON.stringify(receipt, null, 2), actions: [] };
  }

  if (lower === "list staged skills" || lower === "staged skills" || lower === "list staged skill") {
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatStagedSkills(), actions: [] };
  }

  if (lower === "list disabled skills" || lower === "disabled skills" || lower === "list disabled skill") {
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatDisabledSkills(), actions: [] };
  }

  if (lower === "cancel skill" || lower === "stop skill") {
    if (activeRuns.has(req.session_id)) {
      finishRun(req.session_id);
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Cancelled active skill run.", actions: [] };
    }
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "No active skill run.", actions: [] };
  }

  if (lower.startsWith("remember preference ")) {
    const text = normalizeMemoryText(userText.slice("remember preference ".length));
    if (!text) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: remember preference <text>", actions: [] };
    try {
      const daily = appendDailyMemory({ kind: "preference", text, session_id: req.session_id, source: "chat.command", tags: ["preference"] });
      const longterm = appendLongtermMemory({ kind: "preference", text, session_id: req.session_id, source: "chat.command", tags: ["preference"] });
      try { appendEvent(req.session_id, "assistant", "memory.saved.preference", { text, daily_path: daily, longterm_path: longterm }); } catch { }
      try { appendNotification(req.session_id, "memory.saved", "Saved preference to memory.", { daily_path: daily, longterm_path: longterm }); } catch { }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Saved preference to memory.\nDaily: ${daily}\nLong-term: ${longterm}`,
        actions: []
      };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save preference: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("remember engineer preference ") || lower.startsWith("remember project requirement ")) {
    const isProject = lower.startsWith("remember project requirement ");
    const prefix = isProject ? "remember project requirement " : "remember engineer preference ";
    const parsed = parseProjectStandardCommand(userText, prefix);
    if (!parsed.text || parsed.category === "general") {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Usage: ${prefix}<key>: <text>`, actions: [] };
    }
    const kind = isProject ? "project" : "engineer";
    const scope = deriveRequirementScopesForChat(req).find(row => row.kind === kind);
    if (!scope) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: isProject ? "No active Revit project identity is available. Open the target model or use the generic scoped command." : "No engineer identity is available.", actions: [] };
    }
    try {
      const saved = createRequirement({ scope, key: parsed.category, text: parsed.text, source: "chat.command", session_id: req.session_id, tags: [kind, isProject ? "requirement" : "preference"] });
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Saved durable ${kind} requirement ${saved.requirement.requirement_id}@1 [${saved.requirement.key}] for ${scope.id}.`, actions: [] };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save durable requirement: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("remember requirement ")) {
    const body = normalizeMemoryText(userText.slice("remember requirement ".length), 1400);
    const match = /^(office|engineer|project|client)\s+([^\s]+)\s+([^:]{1,160}):\s*(.+)$/i.exec(body);
    if (!match) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: remember requirement <office|engineer|project|client> <scope-id> <key>: <text>", actions: [] };
    }
    try {
      const saved = createRequirement({ scope: { kind: match[1]!.toLowerCase() as any, id: match[2]! }, key: match[3]!, text: match[4]!, source: "chat.command", session_id: req.session_id, tags: [match[1]!.toLowerCase(), "requirement"] });
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Saved durable requirement ${saved.requirement.requirement_id}@1 [${saved.requirement.scope.kind}:${saved.requirement.scope.id}] [${saved.requirement.key}].`, actions: [] };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save durable requirement: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("remember project standard ") || lower.startsWith("remember standard ")) {
    const prefix = lower.startsWith("remember project standard ") ? "remember project standard " : "remember standard ";
    const parsed = parseProjectStandardCommand(userText, prefix);
    if (!parsed.text) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "Usage: remember project standard <category>: <standard>",
        actions: []
      };
    }
    try {
      const saved = addProjectStandard({
        category: parsed.category,
        text: parsed.text,
        session_id: req.session_id,
        source: "chat.command",
        mirror_to_memory: true
      });
      try {
        appendEvent(req.session_id, "assistant", "project_profile.standard.saved", {
          id: saved.standard.id,
          category: saved.standard.category,
          profile_path: saved.profile_path,
          memory_daily_path: saved.memory_daily_path ?? null,
          memory_longterm_path: saved.memory_longterm_path ?? null
        });
      } catch { }
      try {
        appendNotification(req.session_id, "project_profile.saved", "Saved project standard.", {
          id: saved.standard.id,
          category: saved.standard.category,
          profile_path: saved.profile_path
        });
      } catch { }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Saved project standard [${saved.standard.category}].\n` +
          `Profile: ${saved.profile_path}\n` +
          `Memory: ${saved.memory_longterm_path ?? "(not mirrored)"}`,
        actions: []
      };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save project standard: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("remember workflow ")) {
    const text = normalizeMemoryText(userText.slice("remember workflow ".length));
    if (!text) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: remember workflow <text>", actions: [] };
    try {
      const daily = appendDailyMemory({ kind: "note", text, session_id: req.session_id, source: "chat.command", tags: ["workflow"] });
      const longterm = appendLongtermMemory({
        kind: "note",
        text,
        session_id: req.session_id,
        source: "chat.command",
        tags: ["workflow", "runbook_candidate"]
      });
      try { appendEvent(req.session_id, "assistant", "memory.saved.workflow", { text, daily_path: daily, longterm_path: longterm }); } catch { }
      try { appendNotification(req.session_id, "memory.saved", "Saved workflow note to memory.", { daily_path: daily, longterm_path: longterm }); } catch { }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Saved workflow note.\nDaily: ${daily}\nLong-term: ${longterm}`,
        actions: []
      };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save workflow note: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("remember note ")) {
    const text = normalizeMemoryText(userText.slice("remember note ".length));
    if (!text) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: remember note <text>", actions: [] };
    try {
      const daily = appendDailyMemory({ kind: "note", text, session_id: req.session_id, source: "chat.command", tags: ["note"] });
      try { appendEvent(req.session_id, "assistant", "memory.saved.note", { text, daily_path: daily }); } catch { }
      try { appendNotification(req.session_id, "memory.saved", "Saved note to daily memory.", { daily_path: daily }); } catch { }
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Saved note to daily memory.\nDaily: ${daily}`, actions: [] };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save note: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("search memory ") || lower.startsWith("recall memory ")) {
    const prefix = lower.startsWith("search memory ") ? "search memory " : "recall memory ";
    const query = normalizeMemoryText(userText.slice(prefix.length), 240);
    if (!query) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: search memory <query>", actions: [] };
    try {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: formatMemoryHits(query), actions: [] };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Memory search failed: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("show skill ")) {
    const id = userText.slice("show skill ".length).trim().split(/\s+/)[0] ?? "";
    const skill = loadMacroSkill(id);
    if (!skill) {
      const staged = loadStagedMacroSkill(id);
      if (staged) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Staged skill '${id}':\n\n` + JSON.stringify(staged, null, 2), actions: [] };
      const disabled = loadDisabledMacroSkill(id);
      if (disabled) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Disabled skill '${id}':\n\n` + JSON.stringify(disabled, null, 2), actions: [] };
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Skill not found: ${id}`, actions: [] };
    }
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: JSON.stringify(skill, null, 2), actions: [] };
  }

  if (lower === "create skill draft") {
    const draft = createDraftSkill();
    const dirs = getMacroSkillsDirs();
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Draft macro skill JSON (edit as needed). To save: paste into a message starting with `save skill` (stages to skills/local/.staging).\n" +
        `Skills folder: ${dirs.core}\nLocal skills: ${dirs.local}\nStaging: ${dirs.staging}\nDisabled: ${dirs.disabled}\n\n` +
        JSON.stringify(draft, null, 2),
      actions: []
    };
  }

  if (lower.startsWith("save skill")) {
    const json = extractFirstJsonObject(userText);
    if (!json) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Missing skill JSON object.", actions: [] };
    try {
      if (requireWriteGrantForSkillSaves() && !hasValidWriteGrant()) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            "Saving local skills is gated. In Revit → Operator pane → Writes, choose **Allow this session** (or **YOLO**), then retry `save skill ...`.",
          actions: []
        };
      }
      const parsed = JSON.parse(json) as any;
      try {
        const id = typeof parsed?.id === "string" ? parsed.id.trim() : "";
        const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        appendNotification(req.session_id, "skill.stage.planning", `Planning to stage macro skill${id ? ` '${id}'` : ""}${name ? ` (${name})` : ""}…`);
      } catch {
        // ignore
      }

      try {
        persistence.appendToolCall(req.session_id, {
          ts: new Date().toISOString(),
          kind: "skill.op",
          session_id: req.session_id,
          message_id: req.message_id,
          op: "stage",
          skill_id: typeof parsed?.id === "string" ? parsed.id : null,
          skill_name: typeof parsed?.name === "string" ? parsed.name : null
        });
      } catch {
        // ignore
      }

      const r = stageLocalSkill(parsed as any);
      if (!r.ok) {
        try { appendEvent(req.session_id, "assistant", "skill.quarantined", { id: parsed?.id, error: r.error, quarantine_path: r.quarantinePath ?? null }); } catch { }
        try {
          appendNotification(req.session_id, "skill.quarantined", `Skill rejected by gate and quarantined: ${r.error}`, { quarantine_path: r.quarantinePath ?? null });
        } catch {
          // ignore
        }
        try {
          persistence.appendToolOutput(req.session_id, {
            ts: new Date().toISOString(),
            kind: "skill.op.result",
            session_id: req.session_id,
            message_id: req.message_id,
            op: "stage",
            ok: false,
            skill_id: typeof parsed?.id === "string" ? parsed.id : null,
            error: r.error,
            paths: { quarantine_path: r.quarantinePath ?? null }
          });
        } catch {
          // ignore
        }
        return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Skill rejected: ${r.error}${r.quarantinePath ? `\nQuarantine: ${r.quarantinePath}` : ""}`, actions: [] };
      }

      const dirs = getMacroSkillsDirs();
      try { appendEvent(req.session_id, "assistant", "skill.staged", { id: r.id, path: r.stagedPath }); } catch { }
      try {
        appendNotification(req.session_id, "skill.staged", `Staged macro skill '${r.id}'.`, { staged_path: r.stagedPath });
      } catch {
        // ignore
      }
      try {
        persistence.appendToolOutput(req.session_id, {
          ts: new Date().toISOString(),
          kind: "skill.op.result",
          session_id: req.session_id,
          message_id: req.message_id,
          op: "stage",
          ok: true,
          skill_id: r.id,
          paths: { staged_path: r.stagedPath }
        });
      } catch {
        // ignore
      }

      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Staged skill '${r.id}' under ${dirs.staging}.\n` +
          `To enable it: install skill ${r.id}\n` +
          `To inspect: [Open staging folder](op://open-folder?path=${encodeURIComponent(dirs.staging)})`,
        actions: []
      };
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Failed to save skill: ${String(e)}`, actions: [] };
    }
  }

  if (lower.startsWith("install skill ")) {
    const id = userText.slice("install skill ".length).trim().split(/\s+/)[0] ?? "";
    if (!id) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: install skill <id>", actions: [] };
    if (requireWriteGrantForSkillSaves() && !hasValidWriteGrant()) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Installing local skills is gated. In Revit → Operator pane → Writes, choose **Allow this session** (or **YOLO**), then retry `install skill <id>`.",
        actions: []
      };
    }
    try {
      persistence.appendToolCall(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "install",
        skill_id: id,
        skill_name: null
      });
    } catch {
      // ignore
    }
    const r = installStagedSkill(id);
    if (!r.ok) {
      try {
        persistence.appendToolOutput(req.session_id, {
          ts: new Date().toISOString(),
          kind: "skill.op.result",
          session_id: req.session_id,
          message_id: req.message_id,
          op: "install",
          ok: false,
          skill_id: id,
          error: r.error,
          paths: {}
        });
      } catch {
        // ignore
      }
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Install failed: ${r.error}`, actions: [] };
    }
    try { appendEvent(req.session_id, "assistant", "skill.installed", { id, path: r.installedPath }); } catch { }
    try { appendNotification(req.session_id, "skill.installed", `Installed macro skill '${id}'.`, { installed_path: r.installedPath }); } catch { }
    try {
      persistence.appendToolOutput(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op.result",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "install",
        ok: true,
        skill_id: id,
        paths: { installed_path: r.installedPath }
      });
    } catch {
      // ignore
    }
    const dirs = getMacroSkillsDirs();
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Installed skill '${id}' into ${dirs.local}.\nTo view: show skill ${id}`,
      actions: []
    };
  }

  if (lower.startsWith("disable skill ")) {
    const id = userText.slice("disable skill ".length).trim().split(/\s+/)[0] ?? "";
    if (!id) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: disable skill <id>", actions: [] };
    if (requireWriteGrantForSkillSaves() && !hasValidWriteGrant()) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Disabling local skills is gated. In Revit → Operator pane → Writes, choose **Allow this session** (or **YOLO**), then retry `disable skill <id>`.",
        actions: []
      };
    }
    try {
      persistence.appendToolCall(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "disable",
        skill_id: id,
        skill_name: null
      });
    } catch {
      // ignore
    }
    const r = disableInstalledSkill(id);
    if (!r.ok) {
      try {
        persistence.appendToolOutput(req.session_id, {
          ts: new Date().toISOString(),
          kind: "skill.op.result",
          session_id: req.session_id,
          message_id: req.message_id,
          op: "disable",
          ok: false,
          skill_id: id,
          error: r.error,
          paths: {}
        });
      } catch {
        // ignore
      }
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Disable failed: ${r.error}`, actions: [] };
    }
    try { appendEvent(req.session_id, "assistant", "skill.disabled", { id, path: r.disabledPath }); } catch { }
    try { appendNotification(req.session_id, "skill.disabled", `Disabled macro skill '${id}'.`, { disabled_path: r.disabledPath }); } catch { }
    try {
      persistence.appendToolOutput(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op.result",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "disable",
        ok: true,
        skill_id: id,
        paths: { disabled_path: r.disabledPath }
      });
    } catch {
      // ignore
    }
    const dirs = getMacroSkillsDirs();
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Disabled skill '${id}'.\nDisabled folder: ${dirs.disabled}`,
      actions: []
    };
  }

  if (lower.startsWith("enable skill ")) {
    const id = userText.slice("enable skill ".length).trim().split(/\s+/)[0] ?? "";
    if (!id) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Usage: enable skill <id>", actions: [] };
    if (requireWriteGrantForSkillSaves() && !hasValidWriteGrant()) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Enabling local skills is gated. In Revit → Operator pane → Writes, choose **Allow this session** (or **YOLO**), then retry `enable skill <id>`.",
        actions: []
      };
    }
    try {
      persistence.appendToolCall(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "enable",
        skill_id: id,
        skill_name: null
      });
    } catch {
      // ignore
    }
    const r = enableDisabledSkill(id);
    if (!r.ok) {
      try {
        persistence.appendToolOutput(req.session_id, {
          ts: new Date().toISOString(),
          kind: "skill.op.result",
          session_id: req.session_id,
          message_id: req.message_id,
          op: "enable",
          ok: false,
          skill_id: id,
          error: r.error,
          paths: {}
        });
      } catch {
        // ignore
      }
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Enable failed: ${r.error}`, actions: [] };
    }
    try { appendEvent(req.session_id, "assistant", "skill.enabled", { id, path: r.installedPath }); } catch { }
    try { appendNotification(req.session_id, "skill.enabled", `Enabled macro skill '${id}'.`, { installed_path: r.installedPath }); } catch { }
    try {
      persistence.appendToolOutput(req.session_id, {
        ts: new Date().toISOString(),
        kind: "skill.op.result",
        session_id: req.session_id,
        message_id: req.message_id,
        op: "enable",
        ok: true,
        skill_id: id,
        paths: { installed_path: r.installedPath }
      });
    } catch {
      // ignore
    }
    const dirs = getMacroSkillsDirs();
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Enabled skill '${id}'.\nLocal skills folder: ${dirs.local}`,
      actions: []
    };
  }

  if (lower.startsWith("run skill ")) {
    const rest = userText.slice("run skill ".length).trim();
    const id = rest.split(/\s+/)[0] ?? "";
    const skill = loadMacroSkill(id);
    if (!skill) {
      // Helpful diagnosis for staged/disabled skills.
      const staged = loadStagedMacroSkill(id);
      if (staged) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Skill '${id}' is staged. Run: install skill ${id}`, actions: [] };
      const disabled = loadDisabledMacroSkill(id);
      if (disabled) return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Skill '${id}' is disabled. Run: enable skill ${id}`, actions: [] };
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Skill not found: ${id}`, actions: [] };
    }

    let inputs: Record<string, unknown> = {};
    try {
      inputs = parseInputsFromText(userText);
    } catch (e) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: `Invalid inputs: ${String(e)}`, actions: [] };
    }

    // Optional: allow re-entry while already running (dev).
    if (activeRuns.has(req.session_id) && !isTruthy((req.context as any)?.dev?.enabled)) {
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "A skill is already running. Say `cancel skill` first.", actions: [] };
    }

    const run: ActiveRun = {
      sessionId: req.session_id,
      messageId: req.message_id,
      skill,
      inputs,
      nextIndex: 0,
      results: [],
      startedAt: new Date().toISOString()
    };
    activeRuns.set(req.session_id, run);
    try { appendEvent(req.session_id, "assistant", "skill.start", { id: skill.id, inputs }); } catch { }

    const first = buildNextAction(req, run);
    if (!first) {
      finishRun(req.session_id);
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "Skill step is not allowlisted for this session.", actions: [] };
    }
    run.lastActionId = first.action_id;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Skill ${skill.name}: running step 1/${skill.actions.length}…`,
      actions: [first]
    };
  }

  if (lower.startsWith("create proposal")) {
    const rest = userText.slice("create proposal".length).trim();
    const titleRaw = rest.split(" with ")[0]?.trim() || "proposal";
    let inputs: Record<string, unknown> = {};
    try {
      inputs = parseInputsFromText(userText);
    } catch {
      inputs = {};
    }

    const layout = ensureWorkspaceLayout();
    const proposalsRoot = path.join(layout.root, "proposals");
    const folder = `${nowStampUtc()}_${sanitizeForFileName(titleRaw)}`;
    const bundleDir = path.join(proposalsRoot, folder);
    const logsDir = path.join(bundleDir, "logs");
    const artifactsDir = path.join(bundleDir, "artifacts");

    try {
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(artifactsDir, { recursive: true });
    } catch {
      // ignore
    }

    const summary = typeof inputs.summary === "string" ? inputs.summary : "";
    const repro = typeof inputs.repro_steps === "string" ? inputs.repro_steps : "";
    const patchDiff = typeof inputs.patch_diff === "string" ? inputs.patch_diff : "";
    const includeLogs = inputs.include_logs === undefined ? true : !!inputs.include_logs;

    const summaryMd =
      `# Proposal: ${titleRaw}\n\n` +
      (summary.trim() ? summary.trim() + "\n\n" : "_Summary pending._\n\n") +
      `## Context\n\n- session_id: ${req.session_id}\n- message_id: ${req.message_id}\n- created_at: ${new Date().toISOString()}\n`;

    const reproMd = repro.trim()
      ? repro.trim() + "\n"
      : "1. (Describe the steps to reproduce / validate)\n2. ...\n";

    try { fs.writeFileSync(path.join(bundleDir, "summary.md"), summaryMd, "utf8"); } catch { }
    try { fs.writeFileSync(path.join(bundleDir, "repro_steps.md"), reproMd, "utf8"); } catch { }
    try { fs.writeFileSync(path.join(bundleDir, "patch.diff"), patchDiff.trim() ? patchDiff : "# Add a unified diff here.\n", "utf8"); } catch { }
    try {
      fs.writeFileSync(
        path.join(bundleDir, "metadata.json"),
        JSON.stringify({ title: titleRaw, created_at: new Date().toISOString(), session_id: req.session_id, message_id: req.message_id, inputs }, null, 2),
        "utf8"
      );
    } catch { }

    if (includeLogs) {
      try {
        const files = fs
          .readdirSync(layout.logs)
          .map(f => path.join(layout.logs, f))
          .filter(p => {
            try { return fs.statSync(p).isFile(); } catch { return false; }
          })
          .sort((a, b) => {
            try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
          })
          .slice(0, 20);

        for (const f of files) {
          try {
            fs.copyFileSync(f, path.join(logsDir, path.basename(f)));
          } catch {
            // ignore per file
          }
        }
      } catch {
        // ignore
      }
    }

    try { appendEvent(req.session_id, "assistant", "proposal.created", { title: titleRaw, dir: bundleDir }); } catch { }

    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Created proposal bundle under Workspace:\n" +
        bundleDir +
        "\n\nFiles:\n- summary.md\n- repro_steps.md\n- patch.diff\n- metadata.json\n\nTo open the folder: click " +
        `[Open proposal folder](op://open-folder?path=${encodeURIComponent(bundleDir)})`,
      actions: []
    };
  }

  return null;
}
