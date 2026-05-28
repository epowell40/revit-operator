import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureWorkspaceLayout } from "../workspace.js";

type StepRow = {
  created_at: string;
  session_id: string;
  planned_actions_json: string | null;
  tool_results_json: string | null;
  stop_reason: string | null;
};

type ToolResult = {
  method?: string;
  path?: string;
  status?: string;
  duration_ms?: number;
  error?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).trim();
    const next = argv[i + 1] ?? "";
    if (!key) continue;
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function safeNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeError(input: string): string {
  const t = (input ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "unknown";
  return t.length > 240 ? `${t.slice(0, 239)}...` : t;
}

function defaultReportPath(): string {
  const d = new Date();
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const base = path.join(ensureWorkspaceLayout().artifacts, "reports", "runs");
  return path.join(base, `${yyyy}.${mm}.${dd}_run_report.md`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const days = Math.max(1, Math.min(90, Number.parseInt(String(args.days ?? "7"), 10) || 7));
  const sessionId = typeof args.session === "string" ? args.session.trim() : "";
  const outPath = typeof args.output === "string" && args.output.trim() ? args.output.trim() : defaultReportPath();

  const layout = ensureWorkspaceLayout();
  const dbPath = path.join(layout.db, "operator.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite DB not found: ${dbPath}`);
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT created_at, session_id, planned_actions_json, tool_results_json, stop_reason
       FROM steps
       WHERE created_at >= ?
       ${sessionId ? "AND session_id = ?" : ""}
       ORDER BY created_at ASC`
    )
    .all(...(sessionId ? [sinceIso, sessionId] : [sinceIso])) as StepRow[];

  const stopReasons = new Map<string, number>();
  const endpointStats = new Map<string, { total: number; done: number; failed: number; durationSum: number; durationCount: number }>();
  const errorStats = new Map<string, number>();

  let plannedActions = 0;
  let toolResults = 0;
  let done = 0;
  let failed = 0;

  for (const r of rows) {
    const plans = parseJsonArray<any>(r.planned_actions_json);
    plannedActions += plans.length;

    const sr = (r.stop_reason ?? "").trim();
    if (sr) stopReasons.set(sr, (stopReasons.get(sr) ?? 0) + 1);

    const results = parseJsonArray<ToolResult>(r.tool_results_json);
    for (const tr of results) {
      toolResults++;
      const method = String(tr?.method ?? "").toUpperCase();
      const p = String(tr?.path ?? "");
      const key = method && p ? `${method} ${p}` : "UNKNOWN";
      const cur = endpointStats.get(key) ?? { total: 0, done: 0, failed: 0, durationSum: 0, durationCount: 0 };
      cur.total++;

      const st = String(tr?.status ?? "").toLowerCase();
      if (st === "done") {
        cur.done++;
        done++;
      } else if (st === "failed") {
        cur.failed++;
        failed++;
        const err = normalizeError(String(tr?.error ?? ""));
        const errKey = `${key} :: ${err}`;
        errorStats.set(errKey, (errorStats.get(errKey) ?? 0) + 1);
      }

      const dMs = safeNum(tr?.duration_ms);
      if (dMs !== null && dMs >= 0) {
        cur.durationSum += dMs;
        cur.durationCount++;
      }

      endpointStats.set(key, cur);
    }
  }

  const successRate = toolResults > 0 ? ((done / toolResults) * 100).toFixed(1) : "n/a";
  const topEndpoints = [...endpointStats.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);
  const topErrors = [...errorStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const stopSummary = [...stopReasons.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [];
  lines.push("# Revit Operator Run Report");
  lines.push("");
  lines.push(`- Generated: ${nowIso()}`);
  lines.push(`- Window: last ${days} day(s) since ${sinceIso}`);
  if (sessionId) lines.push(`- Session filter: ${sessionId}`);
  lines.push(`- DB: ${dbPath}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Steps: ${rows.length}`);
  lines.push(`- Planned actions: ${plannedActions}`);
  lines.push(`- Tool results: ${toolResults}`);
  lines.push(`- Success: ${done}`);
  lines.push(`- Failed: ${failed}`);
  lines.push(`- Tool success rate: ${successRate}${successRate === "n/a" ? "" : "%"}`);
  lines.push("");
  lines.push("## Stop Reasons");
  if (stopSummary.length === 0) lines.push("- (none)");
  for (const [reason, count] of stopSummary) lines.push(`- ${reason}: ${count}`);
  lines.push("");
  lines.push("## Top Endpoints");
  if (topEndpoints.length === 0) lines.push("- (none)");
  for (const [key, s] of topEndpoints) {
    const avg = s.durationCount > 0 ? Math.round(s.durationSum / s.durationCount) : null;
    lines.push(`- ${key}: total=${s.total} done=${s.done} failed=${s.failed}${avg === null ? "" : ` avgMs=${avg}`}`);
  }
  lines.push("");
  lines.push("## Top Errors");
  if (topErrors.length === 0) lines.push("- (none)");
  for (const [err, count] of topErrors) lines.push(`- ${count}x ${err}`);
  lines.push("");
  lines.push("## Recommendations");
  if (topErrors.length === 0) {
    lines.push("- No dominant tool errors in this window. Focus on broader regression coverage.");
  } else {
    lines.push("- Add/expand acceptance tests for the top failing endpoint signatures above.");
    lines.push("- For repeated failures, add endpoint-specific post-condition checks and clearer error guidance.");
    lines.push("- Track these metrics over time to confirm failure-rate reductions after each fix.");
  }

  const report = `${lines.join("\n")}\n`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report, "utf8");
  console.log(`Wrote run report: ${outPath}`);
}

main();
