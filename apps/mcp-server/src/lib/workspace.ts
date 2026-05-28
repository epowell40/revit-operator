import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

function getTokenFilePath(): string {
  return path.join(getWorkspaceRoot(), "operator_token.txt");
}

export function getWorkspaceRoot(): string {
  const override = (process.env.OPERATOR_WORKSPACE_ROOT || "").trim();
  if (override) {
    try {
      fs.mkdirSync(override, { recursive: true });
    } catch {
      // ignore
    }
    return override;
  }

  // Compatibility alias for the persistence architecture spec.
  // Treat REVIT_OPERATOR_HOME as an alternate workspace-root override.
  const specHome = (process.env.REVIT_OPERATOR_HOME || "").trim();
  if (specHome) {
    try {
      fs.mkdirSync(specHome, { recursive: true });
    } catch {
      // ignore
    }
    return specHome;
  }

  // Codex runs MCP servers in a sandbox where platform-specific env vars (like LOCALAPPDATA)
  // may not always be present. When CODEX_HOME is set, derive workspace root as its parent
  // (our backend sets CODEX_HOME to "<workspace>\\.codex").
  const codexHome = (process.env.CODEX_HOME || "").trim();
  if (codexHome) {
    try {
      const candidate = path.resolve(codexHome, "..");
      // Heuristic: treat as workspace root if it looks like our workspace layout.
      const tokenFile = path.join(candidate, "operator_token.txt");
      const grantFile = path.join(candidate, "write_grant.json");
      if (fs.existsSync(tokenFile) || fs.existsSync(grantFile) || fs.existsSync(path.join(candidate, "artifacts"))) {
        fs.mkdirSync(candidate, { recursive: true });
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  const appData = process.platform === "win32" ? process.env.LOCALAPPDATA : undefined;
  const base = appData && appData.trim() ? appData.trim() : path.join(os.homedir(), ".revitoperator");
  const root = path.join(base, "RevitOperator", "Workspace");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function ensureWorkspaceLayout(): {
  root: string;
  notes: string;
  skills: string;
  artifacts: string;
  logs: string;
  db: string;
  config: string;
  memory: string;
  memoryDaily: string;
  runs: string;
  runsSessions: string;
  feedback: string;
  feedbackUploadQueue: string;
  cache: string;
  evidence: string;
  evidenceWeb: string;
} {
  const root = getWorkspaceRoot();
  const notes = path.join(root, "notes");
  const skills = path.join(root, "skills");
  const artifacts = path.join(root, "artifacts");
  const logs = path.join(root, "logs");
  const db = path.join(root, "db");

  const config = path.join(root, "config");
  const memory = path.join(root, "memory");
  const memoryDaily = path.join(memory, "daily");
  const runs = path.join(root, "runs");
  const runsSessions = path.join(runs, "sessions");
  const feedback = path.join(root, "feedback");
  const feedbackUploadQueue = path.join(feedback, "upload_queue");
  const cache = path.join(root, "cache");
  const evidence = path.join(root, "evidence");
  const evidenceWeb = path.join(evidence, "web");

  const skillLocal = path.join(skills, "local");
  const skillStaging = path.join(skillLocal, ".staging");
  const skillDisabled = path.join(skills, "disabled");

  for (const d of [notes, skills, artifacts, logs, db, config, memoryDaily, runsSessions, feedbackUploadQueue, cache, evidenceWeb, skillStaging, skillDisabled]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
      // ignore
    }
  }

  return { root, notes, skills, artifacts, logs, db, config, memory, memoryDaily, runs, runsSessions, feedback, feedbackUploadQueue, cache, evidence, evidenceWeb };
}

export function getOperatorToken(): string {
  const fromEnv = (process.env.OPERATOR_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(getTokenFilePath(), "utf8");
    const token = (raw || "").trim();
    if (token) {
      process.env.OPERATOR_TOKEN = token;
      return token;
    }
  } catch {
    // ignore
  }
  return "";
}

export function getOrCreateOperatorToken(): string {
  const existing = getOperatorToken();
  if (existing) return existing;

  // Fall back to a new token and persist it (enables add-in/backend to pick it up).
  const token = randomUUID().replace(/-/g, "");
  process.env.OPERATOR_TOKEN = token;
  try {
    fs.writeFileSync(getTokenFilePath(), token, "utf8");
  } catch {
    // ignore
  }
  return token;
}

export function getWriteGrantToken(): string {
  try {
    const root = getWorkspaceRoot();
    const p = path.join(root, "write_grant.json");
    if (!fs.existsSync(p)) return "";
    const raw = fs.readFileSync(p, "utf8") ?? "";
    if (!raw.trim()) return "";
    // .NET often writes UTF-8 with BOM; JSON.parse will choke on the leading U+FEFF.
    const cleaned = raw.replace(/^\uFEFF/, "");
    const parsed: any = JSON.parse(cleaned);
    const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    const expires = typeof parsed?.expires_at_utc === "string" ? parsed.expires_at_utc.trim() : "";
    if (!token) return "";
    if (expires) {
      const t = Date.parse(expires);
      if (Number.isFinite(t) && Date.now() > t) return "";
    }
    return token;
  } catch {
    return "";
  }
}

function ensureUnderWorkspace(fullPath: string): string {
  const root = path.resolve(getWorkspaceRoot());
  const p = path.resolve(fullPath);
  if (p === root) return p;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (process.platform === "win32") {
    if (!p.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(`Path must be under workspace root: ${root}`);
  } else {
    if (!p.startsWith(prefix)) throw new Error(`Path must be under workspace root: ${root}`);
  }
  return p;
}

export function resolveFileUnderWorkspace(userPath: string): string {
  if (!userPath || typeof userPath !== "string") throw new Error("filePath is required.");
  const root = getWorkspaceRoot();
  const candidate = path.isAbsolute(userPath) ? userPath : path.join(root, userPath);
  return ensureUnderWorkspace(candidate);
}

export function resolveExistingFileUnderWorkspace(userPath: string): string {
  const full = resolveFileUnderWorkspace(userPath);
  if (!fs.existsSync(full)) throw new Error(`File not found in workspace: ${full}`);
  return full;
}

export function ensureDirUnderWorkspace(userDir: string | undefined, defaultRelative: string): string {
  const root = getWorkspaceRoot();
  const candidate = userDir && userDir.trim() ? userDir.trim() : defaultRelative;
  const full = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
  const resolved = ensureUnderWorkspace(full);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}
