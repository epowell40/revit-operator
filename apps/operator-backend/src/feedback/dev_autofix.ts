import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureWorkspaceLayout } from "../workspace.js";
import { ensureCodexHomeAuth, ensureCodexHomeConfig } from "../codex/config.js";
import type { DevHandoff } from "./dev_handoff.js";

export type DevAutofixStartResult = {
  started: boolean;
  run_id?: string;
  run_dir_rel?: string;
  error?: string;
};

export type DevAutofixFinishResult = {
  ok: boolean;
  run_id: string;
  run_dir_full: string;
  run_dir_rel: string;
  repo_root?: string;
  summary_path_rel?: string;
  stdout_path_rel: string;
  stderr_path_rel: string;
  result_path_rel: string;
  changed_files: string[];
  backend_touched: boolean;
  backend_rebuild_ok: boolean;
  exit_code?: number;
  error?: string;
};

export type StartFeedbackDevAutofixArgs = {
  session_id: string;
  chat_id?: string | null;
  rating: string;
  note?: string | null;
  dev_handoff?: DevHandoff | null;
  dev_apply_repo_changes?: boolean;
};

export type StartFeedbackDevAutofixHooks = {
  onStarted?: (x: { run_id: string; run_dir_rel: string }) => void;
  onFinished?: (x: DevAutofixFinishResult) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isTruthy(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function enabledInEnv(): boolean {
  const devRaw = (process.env.OPERATOR_DEV_MODE ?? "").trim().toLowerCase();
  if (devRaw && !isTruthy(devRaw)) return false;
  const raw = (process.env.OPERATOR_FEEDBACK_DEV_AUTOFIX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return isTruthy(raw);
}

function getCodexHomeForDevAutofix(): string {
  return path.join(ensureWorkspaceLayout().root, ".codex");
}

function pathKey(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find(k => k.toLowerCase() === "path");
  return key || "PATH";
}

function appendPath(env: NodeJS.ProcessEnv, dir: string | undefined): void {
  const d = (dir ?? "").trim();
  if (!d) return;
  const key = pathKey(env);
  const sep = process.platform === "win32" ? ";" : ":";
  const current = (env[key] ?? "").toString();
  const parts = current
    .split(sep)
    .map(x => x.trim())
    .filter(Boolean);
  const exists = parts.some(x => process.platform === "win32" ? x.toLowerCase() === d.toLowerCase() : x === d);
  if (exists) return;
  env[key] = current ? `${d}${sep}${current}` : d;
}

function buildCodexExecEnv(codexHome: string, repoRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Force login-backed Codex auth for dev autofix runs; avoid passing API keys through.
  delete env.OPENAI_API_KEY;
  delete env.OPERATOR_OPENAI_API_KEY;
  env.CODEX_HOME = codexHome;
  env.OPERATOR_WORKSPACE_ROOT = ensureWorkspaceLayout().root;
  // Service-launched backend processes can miss interactive PATH additions.
  // Include common npm-global bin dirs so `codex` resolves reliably.
  appendPath(env, path.join(process.env.APPDATA ?? "", "npm"));
  appendPath(env, path.join(process.env.LOCALAPPDATA ?? "", "npm"));
  ensureCodexHomeAuth({ codexHome });
  ensureCodexHomeConfig({ codexHome, repoRoot });
  return env;
}

function workspaceRel(fullPath: string): string {
  const root = path.resolve(ensureWorkspaceLayout().root);
  const full = path.resolve(fullPath);
  const rel = path.relative(root, full).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return full;
  return rel;
}

function findRepoRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const hasBackend = fs.existsSync(path.join(cur, "operator-backend"));
    const hasAddin = fs.existsSync(path.join(cur, "revit-bridge-addin"));
    if (hasBackend && hasAddin) return cur;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  envOverrides?: NodeJS.ProcessEnv,
  useShell?: boolean
): Promise<{ code: number; stdout: string; stderr: string; error?: string }> {
  return await new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      shell: !!useShell
    });
    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: { code: number; stdout: string; stderr: string; error?: string }) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ code: -1, stdout, stderr: stderr + "\n(timeout)", error: "timeout" });
    }, Math.max(5_000, timeoutMs));

    child.stdout.on("data", d => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", d => {
      stderr += d.toString("utf8");
    });
    child.on("error", e => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr, error: e instanceof Error ? e.message : String(e) });
    });
    child.on("close", code => {
      clearTimeout(timer);
      finish({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function gitChangedFiles(repoRoot: string): Promise<string[]> {
  const r = await runCommand("git", ["diff", "--name-only"], repoRoot, 30_000);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function buildPrompt(args: StartFeedbackDevAutofixArgs, runDirRel: string): string {
  const rating = (args.rating || "").trim().toLowerCase();
  const note = (args.note || "").trim();
  const devHandoffJson = (() => {
    try {
      if (!args.dev_handoff) return "(none)";
      const raw = JSON.stringify(args.dev_handoff, null, 2);
      return raw.length > 20_000 ? raw.slice(0, 20_000) + "\n...(truncated)" : raw;
    } catch {
      return "(unavailable: could not serialize)";
    }
  })();
  return [
    "You are updating the local RevitOperator repo based on immediate in-app feedback.",
    "Constraints:",
    "- Prefer backend-only changes when possible.",
    "- Keep frontend/add-in changes isolated if needed.",
    "- Do not run destructive git commands.",
    "- Make focused fixes tied directly to the feedback.",
    "- Prioritize the highest-signal issues from the auto-generated dev handoff.",
    "- Run only targeted validations for changed components.",
    "",
    `Feedback rating: ${rating}`,
    `Feedback note: ${note || "(none provided)"}`,
    `Session id: ${(args.session_id || "").trim()}`,
    `Chat id: ${(args.chat_id || "").trim() || "(none)"}`,
    "",
    "Auto-generated dev handoff (structured):",
    devHandoffJson,
    "",
    "Deliverables:",
    "1) Implement code changes directly in this repository.",
    "2) Summarize exactly what changed and why.",
    "3) List verification steps executed and outcomes.",
    "",
    `Run artifacts should be referenced under: ${runDirRel}`
  ].join("\n");
}

export function startFeedbackDevAutofix(args: StartFeedbackDevAutofixArgs, hooks?: StartFeedbackDevAutofixHooks): DevAutofixStartResult {
  const sessionId = (args.session_id ?? "").trim();
  const rating = (args.rating ?? "").trim().toLowerCase();
  const note = (args.note ?? "").trim();
  const apply = !!args.dev_apply_repo_changes;

  if (!sessionId) return { started: false, error: "Missing session_id." };
  if (!apply) return { started: false, error: "Dev auto-update not requested." };
  if (!(rating === "failed" || rating === "partial")) return { started: false, error: "Dev auto-update only runs for failed/partial feedback." };
  if (!enabledInEnv()) return { started: false, error: "Dev auto-update disabled by environment (OPERATOR_DEV_MODE/OPERATOR_FEEDBACK_DEV_AUTOFIX_ENABLED)." };

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) return { started: false, error: "Repo root not found from backend process cwd." };

  const layout = ensureWorkspaceLayout();
  const runId = `${Date.now()}_${sessionId.slice(0, 12)}`;
  const runDir = path.join(layout.feedback, "dev_autofix", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const runDirRel = workspaceRel(runDir);
  hooks?.onStarted?.({ run_id: runId, run_dir_rel: runDirRel });

  void (async () => {
    const stdoutPath = path.join(runDir, "codex_stdout.log");
    const stderrPath = path.join(runDir, "codex_stderr.log");
    const summaryPath = path.join(runDir, "codex_summary.txt");
    const resultPath = path.join(runDir, "result.json");
    const buildLogPath = path.join(runDir, "backend_build.log");

    let beforeFiles: string[] = [];
    let afterFiles: string[] = [];
    let backendTouched = false;
    let backendRebuildOk = false;
    let exitCode = -1;
    let error: string | undefined;

    try {
      beforeFiles = await gitChangedFiles(repoRoot);
      const prompt = buildPrompt(args, runDirRel);
      fs.writeFileSync(path.join(runDir, "prompt.txt"), prompt, "utf8");
      fs.writeFileSync(path.join(runDir, "input.json"), JSON.stringify({ ts: nowIso(), ...args }, null, 2), "utf8");

      const codexArgs: string[] = [
        "exec",
        "--cd",
        repoRoot,
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--output-last-message",
        summaryPath
      ];
      const model = (process.env.OPERATOR_FEEDBACK_DEV_AUTOFIX_MODEL ?? "").trim();
      if (model) codexArgs.push("--model", model);
      codexArgs.push(prompt);

      const timeoutMs = Math.max(60_000, Number.parseInt(process.env.OPERATOR_FEEDBACK_DEV_AUTOFIX_TIMEOUT_MS ?? "1200000", 10) || 1_200_000);
      const codexHome = getCodexHomeForDevAutofix();
      const codexEnv = buildCodexExecEnv(codexHome, repoRoot);
      const codexBinOverride = (process.env.OPERATOR_CODEX_BIN ?? "").trim();
      let codexCommand = codexBinOverride || "codex";
      if (codexBinOverride) {
        if (!fs.existsSync(codexBinOverride)) {
          error = `OPERATOR_CODEX_BIN is set but not found: ${codexBinOverride}`;
          fs.writeFileSync(path.join(runDir, "codex_resolve.log"), error, "utf8");
        } else {
          fs.writeFileSync(path.join(runDir, "codex_resolve.log"), `using OPERATOR_CODEX_BIN=${codexBinOverride}`, "utf8");
        }
      } else {
        const whereCmd = process.platform === "win32" ? "where" : "which";
        const where = await runCommand(whereCmd, ["codex"], repoRoot, 10_000, codexEnv);
        fs.writeFileSync(
          path.join(runDir, "codex_resolve.log"),
          [
            `command=${whereCmd} codex`,
            `exit_code=${where.code}`,
            "",
            "[stdout]",
            where.stdout || "",
            "",
            "[stderr]",
            where.stderr || ""
          ].join("\n"),
          "utf8"
        );
        if (where.code !== 0) {
          error =
            "codex CLI not found in backend environment PATH. " +
            "Install Codex CLI or set OPERATOR_CODEX_BIN/PATH for the backend process.";
        } else {
          const resolved = (where.stdout || "")
            .split(/\r?\n/)
            .map(x => x.trim())
            .find(Boolean);
          if (resolved) codexCommand = resolved;
        }
      }

      const run = error
        ? { code: -1, stdout: "", stderr: "", error }
        : await runCommand(codexCommand, codexArgs, repoRoot, timeoutMs, codexEnv, process.platform === "win32");
      exitCode = run.code;
      fs.writeFileSync(stdoutPath, run.stdout || "", "utf8");
      fs.writeFileSync(stderrPath, run.stderr || "", "utf8");
      if (run.error) error = run.error;
      if (run.code !== 0 && !error) error = `codex exec failed (exit=${run.code})`;

      afterFiles = await gitChangedFiles(repoRoot);
      const before = new Set(beforeFiles);
      const changedNow = afterFiles.filter(f => !before.has(f));
      backendTouched = changedNow.some(f => f.toLowerCase().startsWith("operator-backend/"));

      if (backendTouched) {
        const build = await runCommand("npm", ["run", "build"], path.join(repoRoot, "operator-backend"), 300_000);
        const buildOut = [
          `exit_code=${build.code}`,
          "",
          "[stdout]",
          build.stdout || "",
          "",
          "[stderr]",
          build.stderr || ""
        ].join("\n");
        fs.writeFileSync(buildLogPath, buildOut, "utf8");
        backendRebuildOk = build.code === 0;
        if (!backendRebuildOk && !error) error = `backend build failed after dev auto-update (exit=${build.code})`;
      }

      const changedFiles = (() => {
        const before = new Set(beforeFiles);
        return afterFiles.filter(f => !before.has(f));
      })();

      const result: DevAutofixFinishResult = {
        ok: !error && exitCode === 0,
        run_id: runId,
        run_dir_full: runDir,
        run_dir_rel: runDirRel,
        repo_root: repoRoot,
        summary_path_rel: fs.existsSync(summaryPath) ? workspaceRel(summaryPath) : undefined,
        stdout_path_rel: workspaceRel(stdoutPath),
        stderr_path_rel: workspaceRel(stderrPath),
        result_path_rel: workspaceRel(resultPath),
        changed_files: changedFiles,
        backend_touched: backendTouched,
        backend_rebuild_ok: backendRebuildOk,
        exit_code: exitCode,
        ...(error ? { error } : {})
      };
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
      hooks?.onFinished?.(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const result: DevAutofixFinishResult = {
        ok: false,
        run_id: runId,
        run_dir_full: runDir,
        run_dir_rel: runDirRel,
        repo_root: repoRoot,
        summary_path_rel: fs.existsSync(summaryPath) ? workspaceRel(summaryPath) : undefined,
        stdout_path_rel: workspaceRel(stdoutPath),
        stderr_path_rel: workspaceRel(stderrPath),
        result_path_rel: workspaceRel(resultPath),
        changed_files: [],
        backend_touched: false,
        backend_rebuild_ok: false,
        exit_code: exitCode,
        error: msg
      };
      try {
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
      } catch {
        // ignore
      }
      hooks?.onFinished?.(result);
    }
  })();

  return {
    started: true,
    run_id: runId,
    run_dir_rel: runDirRel
  };
}
