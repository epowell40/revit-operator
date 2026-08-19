import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRequestPrincipal, getScopedWorkspaceRoot } from "./request_context.js";

export type WorkspaceLayout = {
  root: string;
  notes: string;
  skills: string;
  artifacts: string;
  logs: string;
  db: string;
  // Phase 0/1 persistence skeleton (see Feature Request/Persistent_memory_architecture.txt)
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
};

const WRITABLE_DIRECTORY_RECHECK_MS = 60_000;
const writableDirectoryCache = new Map<string, number>();

function ensureDirBestEffort(p: string): boolean {
  const key = path.resolve(p);
  const now = Date.now();
  if ((writableDirectoryCache.get(key) ?? 0) > now) return true;
  try {
    fs.mkdirSync(p, { recursive: true });
    fs.accessSync(p, fs.constants.W_OK);
    writableDirectoryCache.set(key, now + WRITABLE_DIRECTORY_RECHECK_MS);
    return true;
  } catch {
    writableDirectoryCache.delete(key);
    return false;
  }
}

export function __testOnlyResetWorkspaceDirectoryCache(): void {
  writableDirectoryCache.clear();
}

export function getWorkspaceBaseRoot(): string {
  const override = (process.env.OPERATOR_WORKSPACE_ROOT || "").trim();
  if (override) {
    ensureDirBestEffort(override);
    return override;
  }

  // Compatibility alias for the persistence architecture spec.
  // Treat REVIT_OPERATOR_HOME as an alternate workspace-root override.
  const specHome = (process.env.REVIT_OPERATOR_HOME || "").trim();
  if (specHome) {
    ensureDirBestEffort(specHome);
    return specHome;
  }

  if (process.platform === "win32") {
    const appData = (process.env.LOCALAPPDATA || "").trim();
    const base = appData || path.join(os.homedir(), "AppData", "Local");
    const rootWin = path.join(base, "RevitOperator", "Workspace");
    ensureDirBestEffort(rootWin);
    return rootWin;
  }

  // Cloud/container-friendly default when mounted data volume is available.
  const mntData = path.join(path.sep, "mnt", "data");
  if (fs.existsSync(mntData)) {
    const rootMnt = path.join(mntData, "RevitOperator", "Workspace");
    if (ensureDirBestEffort(rootMnt)) return rootMnt;
  }

  const root = path.join(os.homedir(), ".revitoperator", "Workspace");
  ensureDirBestEffort(root);
  return root;
}

export function getWorkspaceRoot(): string {
  const baseRoot = getWorkspaceBaseRoot();
  const principal = getRequestPrincipal();
  if (!principal) return baseRoot;

  const scoped = getScopedWorkspaceRoot(baseRoot, principal);
  ensureDirBestEffort(scoped);
  return scoped;
}

export function ensureWorkspaceLayout(): WorkspaceLayout {
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
  const feedbackUploadQueueOutgoing = path.join(feedbackUploadQueue, ".outgoing");
  const cache = path.join(root, "cache");
  const evidence = path.join(root, "evidence");
  const evidenceWeb = path.join(evidence, "web");

  const skillLocal = path.join(skills, "local");
  const skillStaging = path.join(skillLocal, ".staging");
  const skillDisabled = path.join(skills, "disabled");

  for (const d of [
    notes,
    skills,
    artifacts,
    logs,
    db,
    config,
    memoryDaily,
    runsSessions,
    feedbackUploadQueue,
    feedbackUploadQueueOutgoing,
    cache,
    evidenceWeb,
    skillStaging,
    skillDisabled
  ]) {
    ensureDirBestEffort(d);
  }

  return {
    root,
    notes,
    skills,
    artifacts,
    logs,
    db,
    config,
    memory,
    memoryDaily,
    runs,
    runsSessions,
    feedback,
    feedbackUploadQueue,
    cache,
    evidence,
    evidenceWeb
  };
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
  if (!fs.existsSync(full)) throw new Error(`File not found in workspace: ${userPath}`);
  return full;
}
