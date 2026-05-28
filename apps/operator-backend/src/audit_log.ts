import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "./workspace.js";

function getAuditPath(): string {
  const logsDir = ensureWorkspaceLayout().logs;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // ignore
  }
  return path.join(logsDir, "operator-backend-audit.jsonl");
}

export function appendAuditLine(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(getAuditPath(), line, "utf8");
  } catch {
    // ignore
  }
}
