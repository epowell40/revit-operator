import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace, resolveFileUnderWorkspace } from "../workspace.js";
import { analyzeRedlineFile } from "../redline/redline_analyzer.js";
import { mapSheetRegions } from "../redline/sheet_region_mapper.js";
import { orientRedlineFile } from "../redline/redline_orienter.js";
import { analyzeRedlineWithGemini } from "../vision/gemini_agentic_vision.js";

export type WorkbenchAction =
  | {
      type: "shell";
      command: string;
      workdir?: string;
      timeout_ms?: number;
    }
  | {
      type: "python";
      code: string;
      workdir?: string;
      timeout_ms?: number;
    }
  | {
      type: "write_file";
      file_path: string;
      content: string;
    }
  | {
      type: "read_file";
      file_path: string;
      max_bytes?: number;
    }
  | {
      type: "list_files";
      dir_path?: string;
      recursive?: boolean;
      max_items?: number;
    }
  | {
      type: "analyze_redline";
      file_path: string;
      expected_sheet?: string;
      max_pages?: number;
      include_pdf_annotations?: boolean;
      include_ocr_for_images?: boolean;
      timeout_ms?: number;
      baseline_file_path?: string;
    }
  | {
      type: "map_sheet_regions";
      image_width: number;
      image_height: number;
      boxes: Array<Record<string, unknown>>;
      sheet_outline: Record<string, unknown>;
      viewport_geometry?: Array<Record<string, unknown>>;
      title_blocks?: Array<Record<string, unknown>>;
    }
  | {
      type: "redline_orient";
      file_path: string;
      expected_sheet?: string;
      max_pages?: number;
      include_pdf_annotations?: boolean;
      include_ocr_for_images?: boolean;
      timeout_ms?: number;
      baseline_file_path?: string;
      image_width?: number;
      image_height?: number;
      boxes?: Array<Record<string, unknown>>;
      sheet_outline?: Record<string, unknown>;
      viewport_geometry?: Array<Record<string, unknown>>;
      title_blocks?: Array<Record<string, unknown>>;
    }
  | {
      type: "gemini_redline_analyze";
      file_path: string;
      image_paths?: string[];
      expected_sheet?: string;
      max_pages?: number;
      baseline_file_path?: string;
      objective?: string;
      region_boxes?: Array<Record<string, unknown>>;
      max_regions?: number;
      min_confidence?: number;
      include_code_execution?: boolean;
      timeout_ms?: number;
    };

export type WorkbenchActionResult = {
  index: number;
  type: WorkbenchAction["type"];
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
};

type RunProcessResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missingCommand: boolean;
};

function parseBool(v: string | undefined, fallback: boolean): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function toInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, maxChars: number): string {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n...(truncated)";
}

function normalizeNewlines(s: string): string {
  return (s ?? "").replace(/\r\n/g, "\n");
}

function minimalProcessEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "LANG",
    "LC_ALL"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.OPERATOR_WORKBENCH_SANDBOX = "1";
  return env;
}

function resolveWorkbenchDir(workdir?: string): string {
  const layout = ensureWorkspaceLayout();
  const root = layout.root;
  if (!workdir || !workdir.trim()) return root;
  return resolveFileUnderWorkspace(workdir.trim());
}

function shellAllowlistPrefixes(): string[] {
  const defaults = [
    "python ",
    "python3 ",
    "node ",
    "npm ",
    "npx ",
    "jq ",
    "awk ",
    "sed ",
    "grep ",
    "rg ",
    "cat ",
    "ls",
    "find ",
    "wc ",
    "sort ",
    "uniq ",
    "head ",
    "tail ",
    "cut ",
    "paste ",
    "echo "
  ];
  const fromEnv = (process.env.OPERATOR_WORKBENCH_SHELL_ALLOWLIST || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x.endsWith(" ") ? x : x + " "));
  return [...defaults, ...fromEnv];
}

function shellCommandAllowlisted(command: string): boolean {
  const c = (command ?? "").trim();
  if (!c) return false;
  const lower = c.toLowerCase();
  const prefixes = shellAllowlistPrefixes();
  for (const p of prefixes) {
    const pl = p.toLowerCase();
    if (pl.endsWith(" ")) {
      if (lower.startsWith(pl)) return true;
    } else if (lower === pl || lower.startsWith(pl + " ")) {
      return true;
    }
  }
  return false;
}

function runProcess(args: {
  file: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  inputText?: string;
  maxOutputChars: number;
}): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    let missingCommand = false;
    let timer: NodeJS.Timeout | null = null;

    let child;
    try {
      child = spawn(args.file, args.argv, { cwd: args.cwd, env: minimalProcessEnv(), stdio: "pipe" });
    } catch (e: any) {
      resolve({
        ok: false,
        code: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        missingCommand: true
      });
      return;
    }

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout: truncate(normalizeNewlines(stdout), args.maxOutputChars),
        stderr: truncate(normalizeNewlines(stderr), args.maxOutputChars),
        timedOut,
        missingCommand
      });
    };

    child.on("error", (err: any) => {
      const code = typeof err?.code === "string" ? err.code : "";
      if (code === "ENOENT") missingCommand = true;
      stderr += (err instanceof Error ? err.message : String(err)) + "\n";
      finish(null);
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > args.maxOutputChars * 3) stdout = stdout.slice(-args.maxOutputChars * 3);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > args.maxOutputChars * 3) stderr = stderr.slice(-args.maxOutputChars * 3);
    });

    if (args.inputText && args.inputText.length > 0) {
      try {
        child.stdin.write(args.inputText);
      } catch {
        // ignore
      }
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, args.timeoutMs);

    child.on("close", (code) => finish(code));
  });
}

async function runPythonCode(code: string, cwd: string, timeoutMs: number, maxOutputChars: number): Promise<RunProcessResult> {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let last: RunProcessResult | null = null;
  for (const file of candidates) {
    const argv = file === "py" ? ["-3", "-"] : ["-"];
    const r = await runProcess({ file, argv, cwd, timeoutMs, inputText: code, maxOutputChars });
    last = r;
    if (!r.missingCommand) return r;
  }
  return (
    last ?? {
      ok: false,
      code: null,
      stdout: "",
      stderr: "No Python interpreter available (tried python3/python).",
      timedOut: false,
      missingCommand: true
    }
  );
}

function safeWriteFile(relPath: string, content: string): { pathRel: string; bytes: number } {
  const full = resolveFileUnderWorkspace(relPath);
  const dir = path.dirname(full);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  const layout = ensureWorkspaceLayout();
  const rel = path.relative(layout.root, full).replace(/\\/g, "/");
  return { pathRel: rel, bytes: Buffer.byteLength(content, "utf8") };
}

function safeReadFile(relPath: string, maxBytes: number): { pathRel: string; content: string; bytes: number; truncated: boolean } {
  const full = resolveExistingFileUnderWorkspace(relPath);
  const st = fs.statSync(full);
  const bytes = Math.max(0, st.size);
  const toRead = Math.min(bytes, maxBytes);
  const fd = fs.openSync(full, "r");
  try {
    const buf = Buffer.alloc(toRead);
    const read = fs.readSync(fd, buf, 0, toRead, 0);
    const text = buf.slice(0, read).toString("utf8");
    const layout = ensureWorkspaceLayout();
    const pathRel = path.relative(layout.root, full).replace(/\\/g, "/");
    return { pathRel, content: text, bytes, truncated: bytes > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function safeListFiles(relDir: string | undefined, recursive: boolean, maxItems: number): Array<{ path: string; bytes: number; mtime_utc: string }> {
  const normalized = (relDir ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const rootAlias = normalized === "" || normalized === "." || normalized === "/" || normalized.toLowerCase() === "workspace" || normalized.toLowerCase() === "workspace/";
  const base = rootAlias ? ensureWorkspaceLayout().root : resolveFileUnderWorkspace(normalized);
  const out: Array<{ path: string; bytes: number; mtime_utc: string }> = [];
  const layout = ensureWorkspaceLayout();

  const walk = (dir: string) => {
    if (out.length >= maxItems) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxItems) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        out.push({
          path: path.relative(layout.root, full).replace(/\\/g, "/"),
          bytes: st.size,
          mtime_utc: st.mtime.toISOString()
        });
      } catch {
        // ignore
      }
    }
  };

  walk(base);
  return out;
}

export function workbenchEnabled(): boolean {
  const raw = process.env.OPERATOR_WORKBENCH_ENABLED;
  const relayMode = false;
  return parseBool(raw, !relayMode);
}

export function safeRedlineWorkbenchEnabled(): boolean {
  return parseBool(process.env.OPERATOR_WORKBENCH_SAFE_REDLINES_ENABLED, true);
}

function isSafeRedlineWorkbenchAction(action: WorkbenchAction): boolean {
  return action.type === "analyze_redline" ||
    action.type === "map_sheet_regions" ||
    action.type === "redline_orient" ||
    action.type === "gemini_redline_analyze";
}

export function maxWorkbenchActions(): number {
  return toInt(process.env.OPERATOR_WORKBENCH_MAX_ACTIONS, 6, 1, 20);
}

export async function executeWorkbenchActions(actions: WorkbenchAction[]): Promise<WorkbenchActionResult[]> {
  const results: WorkbenchActionResult[] = [];
  const fullWorkbenchEnabled = workbenchEnabled();
  const redlineOnlyEnabled = !fullWorkbenchEnabled && safeRedlineWorkbenchEnabled();
  if (!fullWorkbenchEnabled && !redlineOnlyEnabled) {
    return [{ index: 1, type: "shell", ok: false, summary: "Workbench disabled by OPERATOR_WORKBENCH_ENABLED=0." }];
  }

  const maxActions = maxWorkbenchActions();
  const maxTimeoutMs = toInt(process.env.OPERATOR_WORKBENCH_MAX_TIMEOUT_MS, 90_000, 1_000, 10 * 60_000);
  const maxReadBytes = toInt(process.env.OPERATOR_WORKBENCH_MAX_READ_BYTES, 256_000, 2_048, 5 * 1024 * 1024);
  const maxOutputChars = toInt(process.env.OPERATOR_WORKBENCH_MAX_OUTPUT_CHARS, 24_000, 800, 200_000);

  const list = Array.isArray(actions) ? actions.slice(0, maxActions) : [];
  for (let i = 0; i < list.length; i++) {
    const action = list[i]!;
    try {
      if (!fullWorkbenchEnabled && !isSafeRedlineWorkbenchAction(action)) {
        results.push({
          index: i + 1,
          type: action.type,
          ok: false,
          summary: `Workbench action '${action.type}' disabled in hosted safe-redline mode.`
        });
        continue;
      }

      if (action.type === "write_file") {
        const p = (action.file_path ?? "").trim();
        const content = action.content ?? "";
        if (!p) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "write_file requires file_path." });
          continue;
        }
        const saved = safeWriteFile(p, content);
        results.push({
          index: i + 1,
          type: action.type,
          ok: true,
          summary: `Wrote ${saved.pathRel} (${saved.bytes} bytes).`,
          details: { path: saved.pathRel, bytes: saved.bytes }
        });
        continue;
      }

      if (action.type === "read_file") {
        const p = (action.file_path ?? "").trim();
        if (!p) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "read_file requires file_path." });
          continue;
        }
        const maxBytes = Math.max(512, Math.min(maxReadBytes, action.max_bytes ?? maxReadBytes));
        const r = safeReadFile(p, maxBytes);
        results.push({
          index: i + 1,
          type: action.type,
          ok: true,
          summary: `Read ${r.pathRel}${r.truncated ? " (truncated)." : "."}`,
          details: { path: r.pathRel, bytes: r.bytes, truncated: r.truncated, content: r.content }
        });
        continue;
      }

      if (action.type === "list_files") {
        const recursive = !!action.recursive;
        const maxItems = Math.max(1, Math.min(200, action.max_items ?? 80));
        const files = safeListFiles(action.dir_path, recursive, maxItems);
        results.push({
          index: i + 1,
          type: action.type,
          ok: true,
          summary: `Listed ${files.length} file(s).`,
          details: { files }
        });
        continue;
      }

      if (action.type === "analyze_redline") {
        const fp = (action.file_path ?? "").trim();
        if (!fp) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "analyze_redline requires file_path." });
          continue;
        }
        const timeoutMs = Math.max(1_500, Math.min(maxTimeoutMs, action.timeout_ms ?? 30_000));
        const analyzed = await analyzeRedlineFile({
          file_path: fp,
          expected_sheet: typeof action.expected_sheet === "string" ? action.expected_sheet : undefined,
          max_pages: typeof action.max_pages === "number" && Number.isFinite(action.max_pages) ? Math.floor(action.max_pages) : undefined,
          include_pdf_annotations: typeof action.include_pdf_annotations === "boolean" ? action.include_pdf_annotations : undefined,
          include_ocr_for_images: typeof action.include_ocr_for_images === "boolean" ? action.include_ocr_for_images : undefined,
          timeout_ms: timeoutMs,
          baseline_file_path: typeof action.baseline_file_path === "string" ? action.baseline_file_path : undefined
        });
        results.push({
          index: i + 1,
          type: action.type,
          ok: analyzed.ok,
          summary: analyzed.ok
            ? `Redline analyzed (${analyzed.kind}); primary_sheet=${analyzed.primary_sheet_number ?? "none"}.`
            : `Redline analysis failed: ${analyzed.warning ?? "unknown error"}`,
          details: {
            ...(analyzed as unknown as Record<string, unknown>),
            file_path: fp,
            request: {
              file_path: fp,
              ...(typeof action.expected_sheet === "string" ? { expected_sheet: action.expected_sheet } : {}),
              ...(typeof action.baseline_file_path === "string" ? { baseline_file_path: action.baseline_file_path } : {})
            }
          }
        });
        continue;
      }

      if (action.type === "map_sheet_regions") {
        const mapped = mapSheetRegions({
          image_width: action.image_width,
          image_height: action.image_height,
          boxes: Array.isArray(action.boxes) ? action.boxes : [],
          sheet_outline: (action.sheet_outline ?? {}) as Record<string, unknown>,
          viewport_geometry: Array.isArray(action.viewport_geometry) ? action.viewport_geometry : [],
          title_blocks: Array.isArray(action.title_blocks) ? action.title_blocks : []
        });
        results.push({
          index: i + 1,
          type: action.type,
          ok: mapped.ok,
          summary: mapped.ok
            ? `Mapped ${mapped.summary.region_count} region(s); viewport_targets=${mapped.summary.viewport_regions}, titleblock_targets=${mapped.summary.titleblock_regions}.`
            : `Region mapping failed: ${mapped.warning ?? "unknown error"}`,
          details: mapped as unknown as Record<string, unknown>
        });
        continue;
      }

      if (action.type === "redline_orient") {
        const fp = (action.file_path ?? "").trim();
        if (!fp) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "redline_orient requires file_path." });
          continue;
        }
        const timeoutMs = Math.max(1_500, Math.min(maxTimeoutMs, action.timeout_ms ?? 30_000));
        const oriented = await orientRedlineFile({
          file_path: fp,
          expected_sheet: typeof action.expected_sheet === "string" ? action.expected_sheet : undefined,
          max_pages: typeof action.max_pages === "number" && Number.isFinite(action.max_pages) ? Math.floor(action.max_pages) : undefined,
          include_pdf_annotations: typeof action.include_pdf_annotations === "boolean" ? action.include_pdf_annotations : undefined,
          include_ocr_for_images: typeof action.include_ocr_for_images === "boolean" ? action.include_ocr_for_images : undefined,
          timeout_ms: timeoutMs,
          baseline_file_path: typeof action.baseline_file_path === "string" ? action.baseline_file_path : undefined,
          image_width: typeof action.image_width === "number" && Number.isFinite(action.image_width) ? action.image_width : undefined,
          image_height: typeof action.image_height === "number" && Number.isFinite(action.image_height) ? action.image_height : undefined,
          boxes: Array.isArray(action.boxes) ? action.boxes : [],
          sheet_outline: action.sheet_outline && typeof action.sheet_outline === "object" ? action.sheet_outline : undefined,
          viewport_geometry: Array.isArray(action.viewport_geometry) ? action.viewport_geometry : [],
          title_blocks: Array.isArray(action.title_blocks) ? action.title_blocks : []
        });
        results.push({
          index: i + 1,
          type: action.type,
          ok: oriented.ok,
          summary: oriented.ok
            ? `Redline orientation completed; primary_sheet=${oriented.analysis.primary_sheet_number ?? "none"}${oriented.mapping ? `, mapped_regions=${oriented.mapping.summary.region_count}` : ""}.`
            : `Redline orientation failed: ${oriented.warning ?? "unknown error"}`,
          details: oriented as unknown as Record<string, unknown>
        });
        continue;
      }

      if (action.type === "gemini_redline_analyze") {
        const fp = (action.file_path ?? "").trim();
        const imagePaths = Array.isArray(action.image_paths) ? action.image_paths.filter(x => typeof x === "string") : [];
        if (!fp && imagePaths.length === 0) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "gemini_redline_analyze requires file_path or image_paths." });
          continue;
        }

        const timeoutMs = Math.max(2_000, Math.min(maxTimeoutMs, action.timeout_ms ?? 45_000));
        const analyzed = await analyzeRedlineWithGemini({
          file_path: fp,
          image_paths: imagePaths,
          expected_sheet: typeof action.expected_sheet === "string" ? action.expected_sheet : undefined,
          max_pages: typeof action.max_pages === "number" && Number.isFinite(action.max_pages) ? Math.floor(action.max_pages) : undefined,
          baseline_file_path: typeof action.baseline_file_path === "string" ? action.baseline_file_path : undefined,
          objective: typeof action.objective === "string" ? action.objective : undefined,
          region_boxes: Array.isArray(action.region_boxes) ? action.region_boxes : [],
          max_regions: typeof action.max_regions === "number" && Number.isFinite(action.max_regions) ? Math.floor(action.max_regions) : undefined,
          min_confidence: typeof action.min_confidence === "number" && Number.isFinite(action.min_confidence) ? action.min_confidence : undefined,
          include_code_execution: fullWorkbenchEnabled && typeof action.include_code_execution === "boolean" ? action.include_code_execution : false,
          timeout_ms: timeoutMs
        });

        results.push({
          index: i + 1,
          type: action.type,
          ok: analyzed.ok,
          summary: analyzed.ok
            ? `Gemini redline analysis completed; regions=${analyzed.regions.length}, global_confidence=${analyzed.global_confidence.toFixed(2)}.`
            : `Gemini redline analysis failed: ${analyzed.warning ?? "unknown error"}`,
          details: analyzed as unknown as Record<string, unknown>
        });
        continue;
      }

      if (action.type === "python") {
        const code = (action.code ?? "").trim();
        if (!code) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "python requires code." });
          continue;
        }
        const cwd = resolveWorkbenchDir(action.workdir);
        const timeoutMs = Math.max(1_000, Math.min(maxTimeoutMs, action.timeout_ms ?? 25_000));
        const r = await runPythonCode(code, cwd, timeoutMs, maxOutputChars);
        results.push({
          index: i + 1,
          type: action.type,
          ok: r.ok,
          summary: r.ok ? "Python completed." : `Python failed${r.timedOut ? " (timeout)." : "."}`,
          details: { cwd, code: r.code, timed_out: r.timedOut, stdout: r.stdout, stderr: r.stderr }
        });
        continue;
      }

      if (action.type === "shell") {
        const cmd = (action.command ?? "").trim();
        if (!cmd) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "shell requires command." });
          continue;
        }
        if (!shellCommandAllowlisted(cmd)) {
          results.push({ index: i + 1, type: action.type, ok: false, summary: "shell command blocked by allowlist.", details: { command: cmd } });
          continue;
        }

        const cwd = resolveWorkbenchDir(action.workdir);
        const timeoutMs = Math.max(1_000, Math.min(maxTimeoutMs, action.timeout_ms ?? 25_000));
        const shellFile = process.platform === "win32" ? "powershell" : "bash";
        const argv = process.platform === "win32" ? ["-NoProfile", "-Command", cmd] : ["-lc", cmd];
        const r = await runProcess({ file: shellFile, argv, cwd, timeoutMs, maxOutputChars });
        results.push({
          index: i + 1,
          type: action.type,
          ok: r.ok,
          summary: r.ok ? "Shell completed." : `Shell failed${r.timedOut ? " (timeout)." : "."}`,
          details: { cwd, command: cmd, code: r.code, timed_out: r.timedOut, stdout: r.stdout, stderr: r.stderr }
        });
      }
    } catch (e) {
      results.push({
        index: i + 1,
        type: action.type,
        ok: false,
        summary: e instanceof Error ? e.message : String(e),
        details: { host: os.hostname() }
      });
    }
  }

  return results;
}
