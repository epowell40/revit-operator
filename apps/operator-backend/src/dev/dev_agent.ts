import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DevAction =
  | { type: "apply_patch"; patch: string; workdir?: string }
  | { type: "shell"; command: string; workdir?: string; timeout_ms?: number }
  | { type: "write_file"; file_path: string; content: string }
  | { type: "restart_backend" };

export type DevActionResult = {
  type: DevAction["type"];
  ok: boolean;
  detail: string;
};

export type DevAgentOptions = {
  /**
   * Second hard gate: the caller must explicitly unlock dev actions per-request
   * (e.g. via HTTP header) in addition to OPERATOR_DEV_AGENT_ENABLED=1.
   */
  unlocked?: boolean;
};

let restartRequested = false;
let activeWorktree: { repoRoot: string; worktreeDir: string; branch: string } | null = null;

export function requestRestart(): void {
  restartRequested = true;
}

export function consumeRestartRequested(): boolean {
  const v = restartRequested;
  restartRequested = false;
  return v;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function devAgentEnabled(): boolean {
  return isTruthy(process.env.OPERATOR_DEV_MODE) && isTruthy(process.env.OPERATOR_DEV_AGENT_ENABLED);
}

function devAgentConfigured(): boolean {
  const token = (process.env.OPERATOR_DEV_AGENT_TOKEN || "").trim();
  return token.length > 0;
}

function normalizeSpace(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ");
}

function shellCommandAllowlisted(command: string): boolean {
  const normalized = normalizeSpace(command);
  if (!normalized) return false;

  // Default: safe-ish read-only / build/test commands. Extend via OPERATOR_DEV_AGENT_SHELL_ALLOWLIST.
  const defaults = [
    "git status",
    "git diff",
    "git log",
    "npm -v",
    "node -v",
    "npm test",
    "npm run build",
    "npm run lint",
    "npm run typecheck",
    "dotnet --info",
    "dotnet build",
    "dotnet test",
    "rg ",
    "Get-ChildItem",
    "Get-Content",
    "dir",
    "ls"
  ];

  const fromEnv = (process.env.OPERATOR_DEV_AGENT_SHELL_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const allow = [...defaults, ...fromEnv];

  for (const prefix of allow) {
    const p = normalizeSpace(prefix);
    if (!p) continue;
    if (p.endsWith(" ")) {
      if (normalized.toLowerCase().startsWith(p.toLowerCase())) return true;
    } else {
      if (normalized.toLowerCase() === p.toLowerCase() || normalized.toLowerCase().startsWith(p.toLowerCase() + " ")) return true;
    }
  }

  return false;
}

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  for (let i = 0; i < 8; i++) {
    const operatorBackend = path.join(cur, "operator-backend");
    const addin = path.join(cur, "revit-bridge-addin");
    if (fs.existsSync(operatorBackend) && fs.existsSync(addin)) return cur;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir, "..");
}

function normalizeWorkdir(workdir?: string): string {
  if (workdir && workdir.trim()) return workdir.trim();
  return findRepoRoot(process.cwd());
}

function safeBranchName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `dev-agent/${stamp}-${rand}`;
}

function safeWorktreeDirName(branch: string): string {
  return branch.replace(/[^\w.-]+/g, "_");
}

async function ensureDevWorktree(repoRoot: string): Promise<{ repoRoot: string; worktreeDir: string; branch: string }> {
  if (activeWorktree && activeWorktree.repoRoot === repoRoot) {
    try {
      if (fs.existsSync(activeWorktree.worktreeDir)) return activeWorktree;
    } catch {
      // ignore
    }
  }

  const branch = safeBranchName();
  const parent = path.join(os.tmpdir(), "revitoperator-dev-agent-worktrees");
  const baseDir = path.join(parent, safeWorktreeDirName(branch));
  fs.mkdirSync(parent, { recursive: true });

  // Best-effort: if the directory already exists, choose a unique suffix.
  let worktreeDir = baseDir;
  for (let i = 0; i < 8; i++) {
    if (!fs.existsSync(worktreeDir)) break;
    worktreeDir = baseDir + `_${i + 1}`;
  }

  const r = await runShell(`git worktree add -b "${branch}" "${worktreeDir}"`, repoRoot, 120_000);
  if (r.code !== 0) {
    throw new Error(`git worktree add failed (exit=${r.code}): ${(r.err || r.out || "").trim()}`);
  }

  activeWorktree = { repoRoot, worktreeDir, branch };
  return activeWorktree;
}

function safeResolveUnderRoot(root: string, maybeRelative: string): string {
  if (!maybeRelative || typeof maybeRelative !== "string") throw new Error("Invalid file path");
  if (path.isAbsolute(maybeRelative)) throw new Error("Absolute paths are not allowed");

  const cleaned = maybeRelative.replace(/\//g, path.sep);
  const resolved = path.resolve(root, cleaned);
  const rootResolved = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootResolved)) throw new Error("Path escapes repo root");
  return resolved;
}

async function runShell(command: string, workdir: string, timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? normalizePowerShellCommand(command) : command;

  const attempts = isWin ? unique([resolvePowerShellExe(), "powershell.exe", "pwsh.exe", "powershell"]) : ["bash"];
  const argsFor = (file: string) => (isWin ? ["-NoProfile", "-Command", cmd] : ["-lc", cmd]);

  let lastErr: unknown = null;
  for (const file of attempts) {
    try {
      return await runShellAttempt(file, argsFor(file), workdir, timeoutMs);
    } catch (e: any) {
      lastErr = e;
      // If PowerShell isn't found (ENOENT), try the next fallback.
      if (isWin && e && typeof e === "object" && (e as any).code === "ENOENT") continue;
      throw e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Failed to spawn shell");
}

function resolvePowerShellExe(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";

  // Prefer full paths (avoids PATH issues). Include Sysnative to bypass WOW64 redirection when applicable.
  const candidates = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join("C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join("C:\\Program Files (x86)", "PowerShell", "7", "pwsh.exe")
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }

  return "powershell.exe";
}

function unique<T>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const i of items) {
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

function normalizePowerShellCommand(command: string): string {
  // Windows PowerShell 5.1 does not support `&&` as a statement separator.
  // This is not a perfect parser, but covers the common dev_action pattern.
  return (command || "").replace(/\s*&&\s*/g, "; ");
}

async function runShellAttempt(
  file: string,
  args: string[],
  workdir: string,
  timeoutMs: number
): Promise<{ code: number; out: string; err: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: workdir, windowsHide: true });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ code: -1, out, err: err + "\n(timeout)" });
    }, Math.max(1_000, timeoutMs));

    child.stdout.on("data", d => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", d => {
      err += d.toString("utf8");
    });
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out, err });
    });
  });
}

async function applyGitPatch(patchText: string, workdir: string): Promise<{ code: number; out: string; err: string }> {
  const tmp = path.join(os.tmpdir(), `revitoperator-devpatch-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  fs.writeFileSync(tmp, patchText, "utf8");

  try {
    // Apply without staging; keep it simple.
    return await runShell(`git apply "${tmp}"`, workdir, 60_000);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

export async function executeDevActions(actions: DevAction[], opts?: DevAgentOptions): Promise<DevActionResult[]> {
  const results: DevActionResult[] = [];
  if (!devAgentEnabled()) {
    return [{ type: "shell", ok: false, detail: "Dev agent is disabled (set OPERATOR_DEV_MODE=1 and OPERATOR_DEV_AGENT_ENABLED=1)." }];
  }
  if (!devAgentConfigured()) {
    return [
      {
        type: "shell",
        ok: false,
        detail: "Dev agent is not configured (set OPERATOR_DEV_AGENT_TOKEN, and unlock per-request with X-Operator-Dev-Agent-Token)."
      }
    ];
  }
  if (!opts?.unlocked) {
    return [{ type: "shell", ok: false, detail: "Dev agent locked (missing/invalid X-Operator-Dev-Agent-Token)." }];
  }

  const firstWithWorkdir = actions.find(a => a && typeof a === "object" && typeof (a as any).workdir === "string") as any;
  const repoRoot = normalizeWorkdir(firstWithWorkdir?.workdir);
  const worktree = await ensureDevWorktree(repoRoot);
  let mutated = false;

  for (const a of actions) {
    try {
      if (a.type === "restart_backend") {
        requestRestart();
        results.push({ type: a.type, ok: true, detail: "restart requested" });
        continue;
      }

      if (a.type === "apply_patch") {
        const r = await applyGitPatch(a.patch, worktree.worktreeDir);
        mutated = mutated || r.code === 0;
        results.push({
          type: a.type,
          ok: r.code === 0,
          detail: `git apply exit=${r.code}\n${(r.out || "").trim()}\n${(r.err || "").trim()}`.trim()
        });
        continue;
      }

      if (a.type === "shell") {
        if (!shellCommandAllowlisted(a.command)) {
          results.push({
            type: a.type,
            ok: false,
            detail:
              "Shell command blocked by allowlist. " +
              "Edit OPERATOR_DEV_AGENT_SHELL_ALLOWLIST (comma-separated prefixes) if you really need this command."
          });
          continue;
        }
        const timeoutMs = typeof a.timeout_ms === "number" ? a.timeout_ms : 300_000;
        const r = await runShell(a.command, worktree.worktreeDir, timeoutMs);
        results.push({
          type: a.type,
          ok: r.code === 0,
          detail: `exit=${r.code}\n${(r.out || "").trim()}\n${(r.err || "").trim()}`.trim()
        });
        continue;
      }

      if (a.type === "write_file") {
        const full = safeResolveUnderRoot(worktree.worktreeDir, a.file_path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, a.content ?? "", "utf8");
        mutated = true;
        results.push({ type: a.type, ok: true, detail: `wrote ${a.file_path} (in worktree)` });
        continue;
      }

      results.push({ type: (a as any).type, ok: false, detail: "unknown dev action" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ type: a.type, ok: false, detail: msg });
    }
  }

  // Dev-only patch pipeline: after any repo mutation, run verification and show a diff summary.
  if (mutated) {
    try {
      const status = await runShell("git status --porcelain", worktree.worktreeDir, 60_000);
      const stat = await runShell("git diff --stat", worktree.worktreeDir, 60_000);
      const build = await runShell("npm -C operator-backend run build", worktree.worktreeDir, 300_000);
      const test = await runShell("npm -C operator-backend test", worktree.worktreeDir, 300_000);
      const csproj =
        process.platform === "win32"
          ? "revit-bridge-addin\\RevitBridge\\RevitBridge.csproj"
          : "revit-bridge-addin/RevitBridge/RevitBridge.csproj";
      const dotnet = await runShell(`dotnet build "${csproj}" -c Release`, worktree.worktreeDir, 300_000);

      const ok = build.code === 0 && test.code === 0 && dotnet.code === 0;
      const detail =
        `Worktree: ${worktree.worktreeDir}\n` +
        `Branch: ${worktree.branch}\n\n` +
        `git status --porcelain:\n${(status.out || status.err || "").trim()}\n\n` +
        `git diff --stat:\n${(stat.out || stat.err || "").trim()}\n\n` +
        `Checks:\n` +
        `- npm -C operator-backend run build: exit=${build.code}\n` +
        `- npm -C operator-backend test: exit=${test.code}\n` +
        `- dotnet build RevitBridge.csproj: exit=${dotnet.code}\n\n` +
        `To merge after review:\n` +
        `- cd \"${worktree.repoRoot}\"\n` +
        `- git merge \"${worktree.branch}\"`;

      results.push({ type: "shell", ok, detail });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ type: "shell", ok: false, detail: `post-change verification failed: ${msg}` });
    }
  } else {
    results.push({
      type: "shell",
      ok: true,
      detail: `Dev actions ran in worktree (no mutations detected). Worktree: ${worktree.worktreeDir} Branch: ${worktree.branch}`
    });
  }

  return results;
}

export function scheduleBackendRestart(): void {
  if (!devAgentEnabled()) return;

  const repoRoot = findRepoRoot(process.cwd());
  const script = path.join(repoRoot, "start_operator_backend.ps1");
  const isWin = process.platform === "win32";

  if (!isWin || !fs.existsSync(script)) return;

  try {
    const child = spawn(
      resolvePowerShellExe(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Restart"],
      { cwd: repoRoot, windowsHide: true, detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch {
    // ignore
  }
}
