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
  return path.join(logsDir, "mcp-server-audit.jsonl");
}

export function auditLog(evt: string, data: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), evt, ...data }) + "\n";
    fs.appendFileSync(getAuditPath(), line, "utf8");
  } catch {
    // ignore
  }
}

export function summarize(value: unknown, maxString = 300, maxArray = 50, maxDepth = 4): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (depth <= 0) return "[truncated]";
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return v.length > maxString ? v.slice(0, maxString) + "…(truncated)" : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) {
      const out = v.slice(0, maxArray).map(x => walk(x, depth - 1));
      return v.length > maxArray ? [...out, `…(+${v.length - maxArray} more)`] : out;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) return "[circular]";
      seen.add(obj);
      const out: Record<string, unknown> = {};
      const keys = Object.keys(obj).slice(0, 80);
      for (const k of keys) {
        const vv = obj[k];
        // Avoid dumping obvious binary-ish payloads.
        if (typeof vv === "string" && (k.toLowerCase().includes("base64") || k.toLowerCase().includes("data"))) {
          out[k] = vv.length > 16 ? vv.slice(0, 16) + "…(redacted)" : vv;
          continue;
        }
        out[k] = walk(vv, depth - 1);
      }
      if (Object.keys(obj).length > keys.length) out["…"] = `(+${Object.keys(obj).length - keys.length} keys)`;
      return out;
    }
    return String(v);
  };

  return walk(value, maxDepth);
}
