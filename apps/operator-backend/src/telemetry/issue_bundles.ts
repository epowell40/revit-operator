import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type IssueBundle = {
  schema_version: 1;
  captured_at: string;
  kind: "backend.error";
  backend: {
    version: string;
  };
  session: {
    session_id: string;
    message_id?: string;
  };
  error: {
    message: string;
    stack?: string;
  };
  context?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeSlug(input: string, maxLen = 80): string {
  const s = (input ?? "").trim() || "na";
  const slug = s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (slug || "na").slice(0, maxLen);
}

export function writeIssueBundle(bundle: IssueBundle): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const layout = ensureWorkspaceLayout();
    const dir = path.join(layout.artifacts, "issue-bundles");
    fs.mkdirSync(dir, { recursive: true });

    const stamp = nowIso().replace(/[:.]/g, "-");
    const session = safeSlug(bundle?.session?.session_id ?? "na", 64);
    const msg = safeSlug(bundle?.session?.message_id ?? "na", 64);
    const file = `${stamp}__${session}__${msg}.json`;
    const full = path.join(dir, file);

    fs.writeFileSync(full, JSON.stringify(bundle, null, 2), "utf8");
    return { ok: true, path: full };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown write error";
    return { ok: false, error: message };
  }
}

