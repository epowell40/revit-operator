import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ActionCall, ToolResult } from "./contracts.js";

export type EnvironmentErrorType =
  | "permission_denied"
  | "path_not_found"
  | "command_blocked"
  | "process_launch_blocked"
  | "network_blocked"
  | "backend_unreachable"
  | "revit_api_unavailable"
  | "screen_capture_failed"
  | "printer_unavailable"
  | "unknown";

type ToolCapability = {
  available: boolean;
  last_checked: string;
  last_error?: string;
  preferred_method?: string;
};

export type EnvironmentProfile = {
  schema_version: 1;
  machine_id_hash: string;
  machine_name: string;
  windows_user: string;
  user_profile: string;
  environment_type: "unknown" | "personal" | "corporate" | "dev" | "demo";
  network_context: "unknown" | "home" | "work" | "offline";
  created_at: string;
  updated_at: string;
  paths: {
    appdata_local: string;
    temp: string;
    documents: string;
    downloads: string;
    desktop: string;
    preferred_workspace: string;
    preferred_exports: string;
    preferred_logs: string;
    preferred_temp: string;
  };
  capabilities: {
    can_write_appdata: boolean;
    can_write_temp: boolean;
    can_write_documents: boolean;
    can_write_downloads: boolean;
    can_write_desktop: boolean;
    can_launch_processes: boolean;
    can_use_powershell: boolean;
    can_use_cmd: boolean;
    can_capture_screen: boolean;
    can_use_revit_api: boolean;
    can_access_backend: boolean;
    can_use_computer_control: boolean;
  };
  tools: Record<string, ToolCapability>;
  known_restrictions: string[];
  known_good_operations: Array<{
    operation: string;
    target_kind?: string;
    path?: string;
    tool_name?: string;
    command_category?: string;
    last_success: string;
  }>;
  known_failed_operations: Array<{
    operation: string;
    tool_name?: string;
    path?: string;
    command_category?: string;
    error_type: EnvironmentErrorType;
    error_summary: string;
    last_failure: string;
    fallback_attempted?: string;
    fallback_succeeded?: boolean;
    successful_fallback?: string;
  }>;
};

export type DemoReadinessResult = {
  ready: boolean;
  status: "ready" | "limited" | "needs_setup";
  title: string;
  checks: Array<{ name: string; ok: boolean; status: string; detail?: string; suggested_fix?: string }>;
  suggested_fix?: string;
};

const SCHEMA_VERSION = 1;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORY_ITEMS = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function defaultLocalAppData(): string {
  const env = trim(process.env.LOCALAPPDATA);
  if (env) return env;
  return process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share");
}

function defaultTemp(): string {
  return trim(process.env.TEMP) || trim(process.env.TMP) || os.tmpdir();
}

function defaultUserProfile(): string {
  return trim(process.env.USERPROFILE) || os.homedir();
}

export function getEnvironmentProfilePath(): string {
  const explicit = trim(process.env.OPERATOR_ENV_PROFILE_PATH);
  if (explicit) return explicit;

  const preferredBase = defaultLocalAppData();
  const preferred = path.join(preferredBase, "RevitOperator", "environment_profile.json");
  try {
    fs.mkdirSync(path.dirname(preferred), { recursive: true });
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(defaultTemp(), "RevitOperator", "environment_profile.json");
  }
}

function machineHash(machineName: string, userName: string): string {
  return crypto.createHash("sha256").update(`${machineName}\n${userName}`).digest("hex").slice(0, 24);
}

function makeBaseProfile(createdAt = nowIso()): EnvironmentProfile {
  const userProfile = defaultUserProfile();
  const appdata = defaultLocalAppData();
  const temp = defaultTemp();
  const machineName = os.hostname();
  const userName = os.userInfo().username || trim(process.env.USERNAME) || "";
  return {
    schema_version: SCHEMA_VERSION,
    machine_id_hash: machineHash(machineName, userName),
    machine_name: machineName,
    windows_user: userName,
    user_profile: userProfile,
    environment_type: "unknown",
    network_context: "unknown",
    created_at: createdAt,
    updated_at: createdAt,
    paths: {
      appdata_local: appdata,
      temp,
      documents: path.join(userProfile, "Documents"),
      downloads: path.join(userProfile, "Downloads"),
      desktop: path.join(userProfile, "Desktop"),
      preferred_workspace: path.join(userProfile, "Documents", "RevitOperator"),
      preferred_exports: path.join(userProfile, "Documents", "RevitOperator", "Exports"),
      preferred_logs: path.join(appdata, "RevitOperator", "Logs"),
      preferred_temp: path.join(appdata, "RevitOperator", "Temp")
    },
    capabilities: {
      can_write_appdata: false,
      can_write_temp: false,
      can_write_documents: false,
      can_write_downloads: false,
      can_write_desktop: false,
      can_launch_processes: false,
      can_use_powershell: false,
      can_use_cmd: false,
      can_capture_screen: false,
      can_use_revit_api: false,
      can_access_backend: true,
      can_use_computer_control: false
    },
    tools: {},
    known_restrictions: [
      "Avoid writing generated files to Program Files.",
      "Avoid writing generated files to C:\\Windows or the root of C:\\.",
      "Prefer Documents\\RevitOperator\\Exports or AppData Local RevitOperator folders."
    ],
    known_good_operations: [],
    known_failed_operations: []
  };
}

function readJsonSafe(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProfile(raw: unknown): EnvironmentProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as any;
  if (p.schema_version !== SCHEMA_VERSION) return null;
  const base = makeBaseProfile(trim(p.created_at) || nowIso());
  return {
    ...base,
    ...p,
    paths: { ...base.paths, ...(p.paths && typeof p.paths === "object" ? p.paths : {}) },
    capabilities: { ...base.capabilities, ...(p.capabilities && typeof p.capabilities === "object" ? p.capabilities : {}) },
    tools: p.tools && typeof p.tools === "object" ? p.tools : {},
    known_restrictions: Array.isArray(p.known_restrictions) ? p.known_restrictions.map(String).slice(0, 80) : base.known_restrictions,
    known_good_operations: Array.isArray(p.known_good_operations) ? p.known_good_operations.slice(-MAX_MEMORY_ITEMS) : [],
    known_failed_operations: Array.isArray(p.known_failed_operations) ? p.known_failed_operations.slice(-MAX_MEMORY_ITEMS) : []
  };
}

export function readEnvironmentProfile(): EnvironmentProfile | null {
  return normalizeProfile(readJsonSafe(getEnvironmentProfilePath()));
}

function writeEnvironmentProfile(profile: EnvironmentProfile): EnvironmentProfile {
  const filePath = getEnvironmentProfilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profile;
}

function probeWrite(dir: string): { ok: boolean; error?: string } {
  if (!dir) return { ok: false, error: "missing path" };
  const probeDir = dir;
  const file = path.join(probeDir, `.revit_operator_probe_${process.pid}_${Date.now()}.tmp`);
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(file, "ok", "utf8");
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function commandProbe(command: string, args: string[], timeoutMs = 3500): { ok: boolean; error?: string } {
  try {
    const r = spawnSync(command, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status === 0) return { ok: true };
    const err = trim(r.stderr) || trim(r.stdout) || `exit ${r.status}`;
    return { ok: false, error: err.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function addRestriction(profile: EnvironmentProfile, text: string): void {
  if (!text || profile.known_restrictions.includes(text)) return;
  profile.known_restrictions.push(text);
  profile.known_restrictions = profile.known_restrictions.slice(-80);
}

function setTool(profile: EnvironmentProfile, name: string, ok: boolean, error?: string, extra?: Partial<ToolCapability>): void {
  profile.tools[name] = {
    available: ok,
    last_checked: nowIso(),
    ...(error ? { last_error: error.slice(0, 300) } : {}),
    ...(extra ?? {})
  };
}

function applyWriteProbe(profile: EnvironmentProfile, capKey: keyof EnvironmentProfile["capabilities"], targetKind: string, dir: string): void {
  const result = probeWrite(dir);
  (profile.capabilities as any)[capKey] = result.ok;
  if (result.ok) {
    recordPathSuccess(dir, `write_probe:${targetKind}`, profile);
  } else if (result.error) {
    recordPathFailure(dir, `write_probe:${targetKind}`, result.error, profile);
  }
}

export function refreshEnvironmentProfile(): EnvironmentProfile {
  const existing = readEnvironmentProfile();
  const profile = existing ?? makeBaseProfile();
  const fresh = makeBaseProfile(profile.created_at);

  profile.machine_id_hash = fresh.machine_id_hash;
  profile.machine_name = fresh.machine_name;
  profile.windows_user = fresh.windows_user;
  profile.user_profile = fresh.user_profile;
  profile.paths = { ...fresh.paths, ...profile.paths };
  profile.updated_at = nowIso();

  applyWriteProbe(profile, "can_write_appdata", "appdata", path.join(profile.paths.appdata_local, "RevitOperator"));
  applyWriteProbe(profile, "can_write_temp", "temp", path.join(profile.paths.temp, "RevitOperator"));
  applyWriteProbe(profile, "can_write_documents", "documents", profile.paths.preferred_workspace);
  applyWriteProbe(profile, "can_write_downloads", "downloads", path.join(profile.paths.downloads, "RevitOperator"));
  // Desktop probing should leave no visible folder behind; create/delete only a tiny file
  // in the existing Desktop directory.
  applyWriteProbe(profile, "can_write_desktop", "desktop", profile.paths.desktop);
  applyWriteProbe(profile, "can_write_appdata", "logs", profile.paths.preferred_logs);
  applyWriteProbe(profile, "can_write_appdata", "temp", profile.paths.preferred_temp);
  applyWriteProbe(profile, "can_write_documents", "exports", profile.paths.preferred_exports);

  const cmd = commandProbe("cmd.exe", ["/d", "/c", "ver"]);
  profile.capabilities.can_use_cmd = cmd.ok;
  profile.capabilities.can_launch_processes = cmd.ok;
  setTool(profile, "cmd", cmd.ok, cmd.error);
  if (!cmd.ok) addRestriction(profile, "Basic cmd.exe execution appears blocked by policy.");

  const psBin = trim(process.env.OPERATOR_POWERSHELL_BIN) || "powershell.exe";
  const ps = commandProbe(psBin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  profile.capabilities.can_use_powershell = ps.ok;
  setTool(profile, "powershell", ps.ok, ps.error);
  if (!ps.ok) addRestriction(profile, "Avoid relying on PowerShell when policy blocks execution.");

  const screenConfigured = trim(process.env.OPERATOR_DESKTOP_ENABLE_SCREEN_CAPTURE) !== "0";
  profile.capabilities.can_capture_screen = screenConfigured;
  setTool(profile, "screen_capture", screenConfigured, screenConfigured ? undefined : "disabled by configuration");

  const computerUse = trim(process.env.OPERATOR_DESKTOP_COMPUTER_PROVIDER || process.env.OPERATOR_COMPUTER_USE_ENABLED) !== "0";
  profile.capabilities.can_use_computer_control = computerUse;
  setTool(profile, "computer_use", computerUse, computerUse ? undefined : "disabled by configuration");

  profile.capabilities.can_use_revit_api = existing?.capabilities.can_use_revit_api ?? false;
  setTool(profile, "revit_api", profile.capabilities.can_use_revit_api, profile.capabilities.can_use_revit_api ? undefined : "not checked or unavailable");
  setTool(profile, "pdf_export", existing?.tools?.pdf_export?.available ?? true, existing?.tools?.pdf_export?.last_error, {
    preferred_method: existing?.tools?.pdf_export?.preferred_method || "revit_api_export"
  });
  setTool(profile, "backend_api", true);
  profile.capabilities.can_access_backend = true;

  if (!profile.capabilities.can_write_documents && profile.capabilities.can_write_temp) {
    profile.paths.preferred_workspace = path.join(profile.paths.temp, "RevitOperator");
    profile.paths.preferred_exports = path.join(profile.paths.temp, "RevitOperator", "Exports");
    addRestriction(profile, "Documents\\RevitOperator is not writable; use the temp RevitOperator fallback.");
  }

  return writeEnvironmentProfile(profile);
}

export function ensureEnvironmentProfile(opts: { refreshIfStale?: boolean } = {}): EnvironmentProfile {
  const p = readEnvironmentProfile();
  if (!p) return refreshEnvironmentProfile();
  if (opts.refreshIfStale) {
    const updated = Date.parse(p.updated_at);
    if (!Number.isFinite(updated) || Date.now() - updated > STALE_MS) return refreshEnvironmentProfile();
  }
  return p;
}

export function clearEnvironmentProfile(): void {
  const p = getEnvironmentProfilePath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

function isBadPathPrefix(fullPath: string): boolean {
  const p = path.resolve(fullPath).toLowerCase();
  const roots = [
    "c:\\program files\\",
    "c:\\program files (x86)\\",
    "c:\\windows\\",
    "c:\\programdata\\",
    "c:\\autodesk\\"
  ];
  if (/^[a-z]:\\?$/i.test(p)) return true;
  return roots.some(root => p.startsWith(root));
}

export function isPathAllowed(targetPath: string, profile = ensureEnvironmentProfile()): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  const full = path.resolve(targetPath);
  if (isBadPathPrefix(full)) return false;
  const allowedRoots = [
    profile.paths.preferred_workspace,
    profile.paths.preferred_exports,
    profile.paths.preferred_logs,
    profile.paths.preferred_temp,
    path.join(profile.paths.temp, "RevitOperator"),
    path.join(profile.paths.appdata_local, "RevitOperator")
  ].map(p => path.resolve(p).toLowerCase());
  const lower = full.toLowerCase();
  return allowedRoots.some(root => lower === root || lower.startsWith(root + path.sep.toLowerCase()));
}

export function getPreferredWorkspace(profile = ensureEnvironmentProfile()): string {
  return profile.paths.preferred_workspace;
}

export function getPreferredExportDirectory(profile = ensureEnvironmentProfile()): string {
  return profile.paths.preferred_exports;
}

export function getPreferredTempDirectory(profile = ensureEnvironmentProfile()): string {
  return profile.capabilities.can_write_appdata ? profile.paths.preferred_temp : path.join(profile.paths.temp, "RevitOperator");
}

export function getPreferredLogDirectory(profile = ensureEnvironmentProfile()): string {
  return profile.capabilities.can_write_appdata ? profile.paths.preferred_logs : path.join(profile.paths.temp, "RevitOperator", "Logs");
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "output").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 160);
  return base || "output";
}

export function getSafeOutputPath(filename: string, purpose: "exports" | "logs" | "temp" | "workspace" = "exports", profile = ensureEnvironmentProfile()): string {
  const dir =
    purpose === "logs"
      ? getPreferredLogDirectory(profile)
      : purpose === "temp"
        ? getPreferredTempDirectory(profile)
        : purpose === "workspace"
          ? getPreferredWorkspace(profile)
          : getPreferredExportDirectory(profile);
  return path.join(dir, sanitizeFileName(filename));
}

function upsertByKey<T>(items: T[], key: (item: T) => string, next: T): T[] {
  const nextKey = key(next);
  return [...items.filter(item => key(item) !== nextKey), next].slice(-MAX_MEMORY_ITEMS);
}

export function classifyEnvironmentError(error: unknown): EnvironmentErrorType {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/access is denied|permission denied|unauthorizedaccess|eperm|eacces/.test(msg)) return "permission_denied";
  if (/could not find|not found|enoent|path.*does not exist|directory.*missing/.test(msg)) return "path_not_found";
  if (/powershell|execution policy|script.*disabled|blocked by policy|not recognized/.test(msg)) return "command_blocked";
  if (/spawn|process launch|application control|applocker/.test(msg)) return "process_launch_blocked";
  if (/network|proxy|dns|enotfound|econnrefused|timed out|timeout/.test(msg)) return "network_blocked";
  if (/backend.*unreachable|backend.*not reachable/.test(msg)) return "backend_unreachable";
  if (/revit.*unavailable|revit.*not.*running|bridge.*unreachable/.test(msg)) return "revit_api_unavailable";
  if (/screen|screenshot|capture/.test(msg)) return "screen_capture_failed";
  if (/printer|pdf driver|print/.test(msg)) return "printer_unavailable";
  return "unknown";
}

export function recordPathFailure(pathValue: string, operation: string, error: unknown, profile = ensureEnvironmentProfile()): EnvironmentProfile {
  const errorType = classifyEnvironmentError(error);
  const summary = error instanceof Error ? error.message : String(error ?? "");
  profile.known_failed_operations = upsertByKey(
    profile.known_failed_operations,
    item => `${item.operation}|${item.path || ""}|${item.error_type}`,
    {
      operation,
      path: pathValue,
      error_type: errorType,
      error_summary: summary.slice(0, 300),
      last_failure: nowIso()
    }
  );
  if (errorType === "permission_denied") addRestriction(profile, `Avoid writing to ${pathValue}.`);
  profile.updated_at = nowIso();
  return writeEnvironmentProfile(profile);
}

export function recordPathSuccess(pathValue: string, operation: string, profile = ensureEnvironmentProfile()): EnvironmentProfile {
  profile.known_good_operations = upsertByKey(
    profile.known_good_operations,
    item => `${item.operation}|${item.path || ""}`,
    { operation, path: pathValue, target_kind: operation.split(":")[1] || undefined, last_success: nowIso() }
  );
  profile.updated_at = nowIso();
  return writeEnvironmentProfile(profile);
}

function inferPathFromToolResult(result: ToolResult): string {
  const data = result.result_json && typeof result.result_json === "object" ? (result.result_json as any) : {};
  const body = data.body && typeof data.body === "object" ? data.body : {};
  return trim(data.path) || trim(data.output_path) || trim(data.outputPath) || trim(data.backend_path) || trim(body.outputFolder) || trim(body.output_folder);
}

export function recordToolResultsEnvironmentMemory(results: ToolResult[]): void {
  if (!Array.isArray(results) || results.length === 0) return;
  let profile = ensureEnvironmentProfile();
  for (const result of results) {
    const toolName = `${result.method || ""} ${result.path || ""}`.trim();
    const targetPath = inferPathFromToolResult(result);
    if (result.status === "done") {
      if (targetPath) profile = recordPathSuccess(targetPath, result.path || "tool", profile);
      profile.known_good_operations = upsertByKey(
        profile.known_good_operations,
        item => `${item.operation}|${item.tool_name || ""}|${item.path || ""}`,
        { operation: result.path || "tool", tool_name: toolName, path: targetPath || undefined, last_success: nowIso() }
      );
      continue;
    }
    if (result.status === "failed") {
      const msg = trim(result.error) || trim(result.failure_hint) || trim(result.result_summary) || "Tool failed.";
      const errorType = classifyEnvironmentError(`${result.failure_kind || ""} ${result.failure_code || ""} ${msg}`);
      profile.known_failed_operations = upsertByKey(
        profile.known_failed_operations,
        item => `${item.operation}|${item.tool_name || ""}|${item.path || ""}|${item.error_type}`,
        {
          operation: result.path || "tool",
          tool_name: toolName,
          path: targetPath || undefined,
          error_type: errorType,
          error_summary: msg.slice(0, 300),
          last_failure: nowIso()
        }
      );
      if (errorType === "command_blocked") addRestriction(profile, `Avoid retrying blocked command/tool category: ${toolName}.`);
      if (errorType === "permission_denied" && targetPath) addRestriction(profile, `Avoid writing to ${targetPath}.`);
    }
  }
  profile.updated_at = nowIso();
  writeEnvironmentProfile(profile);
}

export function buildCapabilityManifest(profile = ensureEnvironmentProfile()): Record<string, unknown> {
  const restrictions = [...profile.known_restrictions];
  if (!profile.capabilities.can_use_powershell) restrictions.push("PowerShell restricted or unavailable");
  if (!profile.capabilities.can_write_documents && profile.capabilities.can_write_temp) restrictions.push("Documents output folder not writable; use temp fallback");
  return {
    environment_type: profile.environment_type,
    preferred_output_dir: getPreferredExportDirectory(profile),
    fallback_temp_dir: getPreferredTempDirectory(profile),
    capabilities: {
      filesystem_write: profile.capabilities.can_write_documents || profile.capabilities.can_write_appdata || profile.capabilities.can_write_temp,
      screen_capture: profile.capabilities.can_capture_screen,
      revit_api: profile.capabilities.can_use_revit_api,
      powershell: profile.capabilities.can_use_powershell,
      cmd: profile.capabilities.can_use_cmd,
      computer_use: profile.capabilities.can_use_computer_control,
      pdf_export: profile.tools.pdf_export?.available !== false
    },
    restrictions: Array.from(new Set(restrictions)).slice(0, 12),
    recommended_tool_order: ["revit_api", "bounded_operator_skill", "backend_agent", "computer_use_fallback"]
  };
}

function boolLabel(v: boolean): string {
  return v ? "available" : "restricted/unavailable";
}

export function formatEnvironmentSummaryForPrompt(profile = ensureEnvironmentProfile()): string {
  const failed = profile.known_failed_operations.slice(-4).map(f => {
    const target = f.path ? ` (${f.path})` : f.command_category ? ` (${f.command_category})` : "";
    return `- Avoid repeating ${f.operation}${target}: ${f.error_type}${f.successful_fallback ? `; fallback=${f.successful_fallback}` : ""}`;
  });
  const restrictions = Array.from(new Set(profile.known_restrictions)).slice(0, 6).map(x => `- ${x}`);
  return [
    "Local Operator Environment Summary:",
    `- Environment type: ${profile.environment_type}`,
    `- Windows user: ${profile.windows_user || "unknown"}`,
    `- Preferred exports: ${getPreferredExportDirectory(profile)}`,
    `- Preferred temp: ${getPreferredTempDirectory(profile)}`,
    `- Preferred logs: ${getPreferredLogDirectory(profile)}`,
    `- Revit API: ${boolLabel(profile.capabilities.can_use_revit_api)}`,
    `- Screen capture: ${boolLabel(profile.capabilities.can_capture_screen)}`,
    `- Backend: ${boolLabel(profile.capabilities.can_access_backend)}`,
    `- PowerShell: ${boolLabel(profile.capabilities.can_use_powershell)}`,
    `- cmd: ${boolLabel(profile.capabilities.can_use_cmd)}`,
    `- Computer use: ${boolLabel(profile.capabilities.can_use_computer_control)}`,
    "Known policy:",
    ...(restrictions.length > 0 ? restrictions : ["- Use known-good output folders first; do not write to protected directories."]),
    ...(failed.length > 0 ? ["Recent environment failures:", ...failed] : []),
    "Agent behavior rules:",
    "- Use preferred output paths from the environment profile.",
    "- Do not probe random directories before using known-good paths.",
    "- Do not rediscover username/home directory unless the profile is missing or stale.",
    "- If a command is known blocked, do not retry it.",
    "- If a save fails, retry once in preferred export/temp directory and record the outcome.",
    "- Ask the user only when no safe fallback is available."
  ].join("\n");
}

export function applyEnvironmentPolicyToActions(actions: ActionCall[], profile = ensureEnvironmentProfile()): ActionCall[] {
  return (Array.isArray(actions) ? actions : []).map(action => {
    const p = (action.path || "").trim().toLowerCase();
    if (action.method !== "POST" || !p) return action;
    if (p !== "/revit/export-pdf" && p !== "/revit/print") return action;
    const body = action.body && typeof action.body === "object" && !Array.isArray(action.body) ? { ...(action.body as any) } : {};
    if (!body.outputFolder && !body.output_folder) {
      body.outputFolder = getPreferredExportDirectory(profile);
    }
    return { ...action, body };
  });
}

export function runDemoReadinessCheck(profile = ensureEnvironmentProfile()): DemoReadinessResult {
  const checks: DemoReadinessResult["checks"] = [];
  const exportProbe = probeWrite(getPreferredExportDirectory(profile));
  const logProbe = probeWrite(getPreferredLogDirectory(profile));
  if (exportProbe.ok) recordPathSuccess(getPreferredExportDirectory(profile), "demo_readiness:exports", profile);
  else recordPathFailure(getPreferredExportDirectory(profile), "demo_readiness:exports", exportProbe.error || "not writable", profile);
  if (logProbe.ok) recordPathSuccess(getPreferredLogDirectory(profile), "demo_readiness:logs", profile);
  else recordPathFailure(getPreferredLogDirectory(profile), "demo_readiness:logs", logProbe.error || "not writable", profile);

  checks.push({ name: "Revit API", ok: profile.capabilities.can_use_revit_api, status: profile.capabilities.can_use_revit_api ? "Available" : "Unknown or unavailable", suggested_fix: "Open Revit and refresh environment profile." });
  checks.push({ name: "Active document", ok: profile.capabilities.can_use_revit_api, status: profile.capabilities.can_use_revit_api ? "Likely available" : "Not verified", suggested_fix: "Open a Revit document and rerun the check." });
  checks.push({ name: "Backend", ok: profile.capabilities.can_access_backend, status: profile.capabilities.can_access_backend ? "Connected" : "Unreachable", suggested_fix: "Restart Operator backend." });
  checks.push({ name: "Screen capture", ok: profile.capabilities.can_capture_screen, status: profile.capabilities.can_capture_screen ? "Available" : "Unavailable", suggested_fix: "Enable desktop capture or use Revit API evidence." });
  checks.push({ name: "Exports folder", ok: exportProbe.ok, status: exportProbe.ok ? "Writable" : "Not writable", detail: exportProbe.error, suggested_fix: "Refresh environment profile or choose another export folder." });
  checks.push({ name: "Action log", ok: logProbe.ok, status: logProbe.ok ? "Writable" : "Not writable", detail: logProbe.error, suggested_fix: "Refresh environment profile or use temp fallback." });
  checks.push({ name: "PDF export", ok: profile.tools.pdf_export?.available !== false, status: profile.tools.pdf_export?.available === false ? "Unavailable" : "Available" });
  checks.push({ name: "Computer use", ok: profile.capabilities.can_use_computer_control, status: profile.capabilities.can_use_computer_control ? "Available" : "Fallback disabled" });
  const failed = checks.filter(c => !c.ok);
  const status = failed.length === 0 ? "ready" : failed.some(c => ["Backend", "Exports folder", "Action log"].includes(c.name)) ? "needs_setup" : "limited";
  return {
    ready: status === "ready",
    status,
    title: status === "ready" ? "Demo Ready" : "Demo Not Ready",
    checks,
    suggested_fix: failed[0]?.suggested_fix
  };
}
