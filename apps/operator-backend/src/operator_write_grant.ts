import fs from "node:fs";
import path from "node:path";
import { getWorkspaceRoot } from "./workspace.js";

type WriteGrantFile = {
  token?: unknown;
  expires_at_utc?: unknown;
};

function getGrantFilePath(): string {
  return path.join(getWorkspaceRoot(), "write_grant.json");
}

export function getWriteGrantToken(): string {
  try {
    const p = getGrantFilePath();
    if (!fs.existsSync(p)) return "";
    const raw = fs.readFileSync(p, "utf8") ?? "";
    if (!raw.trim()) return "";
    const cleaned = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(cleaned) as WriteGrantFile;

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

export function hasValidWriteGrant(): boolean {
  return !!getWriteGrantToken();
}

