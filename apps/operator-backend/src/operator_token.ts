import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getWorkspaceBaseRoot } from "./workspace.js";

function getTokenFilePath(): string {
  // The local Revit bridge token is machine-scoped, not request-scoped.
  // In JWT mode the backend workspace root is per-user/per-tenant, but the
  // localhost bridge still expects the shared machine token under the base
  // workspace root alongside the Revit add-in.
  return path.join(getWorkspaceBaseRoot(), "operator_token.txt");
}

function tryReadTokenFile(): string {
  try {
    const p = getTokenFilePath();
    if (!fs.existsSync(p)) return "";
    return (fs.readFileSync(p, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function tryWriteTokenFile(token: string): void {
  try {
    const p = getTokenFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, token, "utf8");
  } catch {
    // ignore
  }
}

export function getOrCreateOperatorToken(): string {
  const fromEnv = (process.env.OPERATOR_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  const fromFile = tryReadTokenFile();
  if (fromFile) {
    process.env.OPERATOR_TOKEN = fromFile;
    return fromFile;
  }

  const token = randomUUID().replace(/-/g, "");
  process.env.OPERATOR_TOKEN = token;
  tryWriteTokenFile(token);
  return token;
}
