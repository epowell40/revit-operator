import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureWorkspaceLayout, getWorkspaceRoot } from "../workspace.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { enqueueNightlyTriageImprovementJobs } from "../improvement/job_worker.js";

type StepRow = {
  id: number;
  created_at: string;
  session_id: string;
  message_id: string;
  user_text: string | null;
  planned_actions_json: string | null;
  tool_results_json: string | null;
  stop_reason: string | null;
};

type EventRow = {
  ts: string;
  session_id: string;
  role: string;
  kind: string;
  payload_json: string | null;
};

type ToolResult = {
  action_id: string;
  method: "GET" | "POST";
  path: string;
  status: "done" | "failed";
  error?: string;
  duration_ms?: number;
  result_json?: unknown;
};

type IssueSignature = {
  key: string;
  count: number;
  first_seen: string;
  last_seen: string;
  examples: Array<{
    ts: string;
    session_id: string;
    message_id: string;
    user_text?: string;
    tool?: { method: string; path: string };
    error?: string;
  }>;
  suggested_fix_area: "backend" | "frontend-addin" | "unknown";
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const k = a.slice(2).trim();
    const next = argv[i + 1] ?? "";
    if (!k) continue;
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function startOfLocalDayIso(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

function endOfLocalDayIso(d: Date): string {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
}

function safeText(input: unknown, maxLen: number): string {
  const s = typeof input === "string" ? input : input === null || input === undefined ? "" : String(input);
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

function redact(input: string): string {
  let s = input ?? "";
  // Windows paths.
  s = s.replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "<user-home>");
  s = s.replace(/[A-Z]:\\[^\s"]+/g, "<path>");
  // Emails.
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  // GUIDs.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<guid>");
  // Long-ish tokens.
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, "<token>");
  return s;
}

function normalizeErrorText(input: string): string {
  let s = redact(safeText(input, 400));
  // De-noise numbers that tend to vary (durations, counts, ids).
  s = s.replace(/\b\d{3,}\b/g, "<n>");
  return s.trim() || "unknown";
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

function suggestedFixAreaFromTool(tr: ToolResult | null, stopReason: string | null, errorText: string | null): "backend" | "frontend-addin" | "unknown" {
  const err = (errorText ?? "").toLowerCase();
  const pathLower = (tr?.path ?? "").toLowerCase();

  if (err.includes("unsupported contract version") || err.includes("not allowlisted") || err.includes("openai")) return "backend";
  if (err.includes("revit") || err.includes("autodesk") || err.includes("externalcommand") || err.includes("transaction")) return "frontend-addin";
  if (pathLower.startsWith("/revit/") || pathLower.startsWith("/bridge/")) return "frontend-addin";
  if (stopReason === "ERROR" && !tr) return "backend";
  return "unknown";
}

function formatIssueKey(tr: ToolResult | null, stopReason: string | null, errorText: string | null): string {
  const errNorm = normalizeErrorText(errorText ?? "");
  if (tr) return `${tr.method} ${tr.path} :: ${errNorm}`;
  return `backend.exception :: ${errNorm}`;
}

function isoOrNull(input: string | undefined): string | null {
  const t = (input ?? "").trim();
  if (!t) return null;
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function getDefaultDbPath(): string {
  const layout = ensureWorkspaceLayout();
  return path.join(layout.db, "operator.sqlite");
}

function computeDailyReportPath(day: Date): string {
  const yyyy = day.getFullYear().toString().padStart(4, "0");
  const mm = (day.getMonth() + 1).toString().padStart(2, "0");
  const dd = day.getDate().toString().padStart(2, "0");
  const reportsRoot = path.join(ensureWorkspaceLayout().artifacts, "reports", "issues");
  return path.join(reportsRoot, `${yyyy}.${mm}.${dd}_issues.txt`);
}

function loadRecentBackendErrors(db: Database.Database, sinceIso: string, untilIso: string): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT ts, session_id, payload_json
       FROM events
       WHERE ts >= ? AND ts <= ? AND kind = 'backend.error'
       ORDER BY ts ASC`
    )
    .all(sinceIso, untilIso) as Array<{ ts: string; session_id: string; payload_json: string | null }>;

  for (const r of rows) {
    if (!r.session_id) continue;
    if (!r.payload_json) continue;
    try {
      const p: any = JSON.parse(r.payload_json);
      const msg = typeof p?.message === "string" ? p.message : "";
      if (!msg) continue;
      const key = `${r.session_id}::${typeof p?.message_id === "string" ? p.message_id : ""}`;
      out.set(key, msg);
    } catch {
      // ignore
    }
  }
  return out;
}

async function maybeAskOpenAIForProposals(issues: IssueSignature[], opts: { maxItems: number }): Promise<string | null> {
  const use = (process.env.OPERATOR_TRIAGE_USE_OPENAI ?? "").trim().toLowerCase();
  if (!(use === "1" || use === "true" || use === "yes")) return null;
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) return null;

  const top = issues.slice(0, Math.max(1, Math.min(opts.maxItems, 12))).map(i => ({
    key: i.key,
    count: i.count,
    suggested_fix_area: i.suggested_fix_area,
    example: i.examples[0] ?? null
  }));

  const client = createOpenAiClient(apiKey);
  const model = (process.env.OPERATOR_TRIAGE_MODEL ?? "").trim() || "gpt-4o-mini";

  const prompt = [
    "You are a senior engineer triaging an in-development Revit automation product.",
    "Given aggregated issue signatures (deduped), propose concrete, actionable engineering changes.",
    "Output plain text with two sections: BACKEND and FRONTEND-ADDIN.",
    "Each bullet: short title + what to change + where to implement + quick test/validation idea.",
    "Avoid vague advice; prioritize high-impact, low-risk changes; assume limited context.",
    "",
    "Issue signatures:",
    JSON.stringify(top, null, 2)
  ].join("\n");

  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You write concise engineering triage proposals." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });
    const text = resp.choices?.[0]?.message?.content ?? "";
    const t = typeof text === "string" ? text.trim() : "";
    return t || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const today = new Date();
  const reportPathFromArgs = typeof args.out === "string" ? args.out : null;
  const outPath = reportPathFromArgs ? path.resolve(reportPathFromArgs) : computeDailyReportPath(today);

  const sinceIso = isoOrNull(typeof args.since === "string" ? args.since : undefined) ?? startOfLocalDayIso(today);
  const untilIso = isoOrNull(typeof args.until === "string" ? args.until : undefined) ?? endOfLocalDayIso(today);

  const dbPath = typeof args.db === "string" ? path.resolve(args.db) : getDefaultDbPath();
  const maxIssues = Math.max(5, Math.min(80, Number.parseInt(typeof args["max-issues"] === "string" ? args["max-issues"] : "30", 10) || 30));
  const queueImprovementJobs =
    args["queue-improvement-jobs"] === true ||
    (typeof args["queue-improvement-jobs"] === "string" && ["1", "true", "yes"].includes(args["queue-improvement-jobs"].toLowerCase()));

  const writeBundles =
    args["write-bundles"] === true ||
    (typeof args["write-bundles"] === "string" && ["1", "true", "yes"].includes(args["write-bundles"].toLowerCase()));

  const bundlesDir =
    typeof args["bundles-dir"] === "string"
      ? path.resolve(args["bundles-dir"])
      : path.join(ensureWorkspaceLayout().artifacts, "issue-bundles-nightly");

  if (!fs.existsSync(dbPath)) {
    const lines = [
      `RevitOperator nightly issues`,
      `Range: ${sinceIso} -> ${untilIso}`,
      `DB: ${dbPath}`,
      "",
      `No database found. Operator backend stores sessions in SQLite under workspace root: ${getWorkspaceRoot()}`
    ];
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const steps = db
    .prepare(
      `SELECT id, created_at, session_id, message_id, user_text, planned_actions_json, tool_results_json, stop_reason
       FROM steps
       WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC`
    )
    .all(sinceIso, untilIso) as StepRow[];

  const events = db
    .prepare(
      `SELECT ts, session_id, role, kind, payload_json
       FROM events
       WHERE ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    )
    .all(sinceIso, untilIso) as EventRow[];

  const backendErrors = loadRecentBackendErrors(db, sinceIso, untilIso);

  const sessionsTouched = new Set<string>();
  const signatures = new Map<string, IssueSignature>();

  let totalSteps = 0;
  let errorSteps = 0;
  let toolFailures = 0;
  let notifications = 0;

  for (const ev of events) {
    if (ev?.session_id) sessionsTouched.add(ev.session_id);
    if (ev?.kind === "notification") notifications++;
  }

  for (const s of steps) {
    totalSteps++;
    sessionsTouched.add(s.session_id);
    const toolResults = parseJsonArray<ToolResult>(s.tool_results_json);
    const failedTools = toolResults.filter(tr => tr && tr.status === "failed");
    if (failedTools.length > 0) toolFailures += failedTools.length;

    const keyForBackendError = `${s.session_id}::${s.message_id}`;
    const backendErr = backendErrors.get(keyForBackendError) ?? null;

    const isError = s.stop_reason === "ERROR" || failedTools.length > 0;
    if (!isError) continue;
    errorSteps++;

    const firstFailed = failedTools.length > 0 ? failedTools[0]! : null;
    const errorText =
      (firstFailed?.error && String(firstFailed.error)) ||
      (backendErr && String(backendErr)) ||
      (s.stop_reason === "ERROR" ? "backend error (see backend.error event for details)" : "tool failed");

    const sigKey = formatIssueKey(firstFailed, s.stop_reason, errorText);
    const area = suggestedFixAreaFromTool(firstFailed, s.stop_reason, errorText);

    const existing = signatures.get(sigKey);
    const ex = {
      ts: s.created_at,
      session_id: s.session_id,
      message_id: s.message_id,
      ...(s.user_text ? { user_text: safeText(redact(s.user_text), 220) } : {}),
      ...(firstFailed ? { tool: { method: firstFailed.method, path: firstFailed.path } } : {}),
      ...(errorText ? { error: safeText(normalizeErrorText(errorText), 220) } : {})
    };

    if (!existing) {
      signatures.set(sigKey, {
        key: sigKey,
        count: 1,
        first_seen: s.created_at,
        last_seen: s.created_at,
        examples: [ex],
        suggested_fix_area: area
      });
    } else {
      existing.count++;
      existing.last_seen = s.created_at;
      if (existing.examples.length < 3) existing.examples.push(ex);
      if (existing.suggested_fix_area === "unknown" && area !== "unknown") existing.suggested_fix_area = area;
    }

    if (writeBundles) {
      try {
        fs.mkdirSync(bundlesDir, { recursive: true });
        const fileSafe = `${s.created_at.replace(/[:.]/g, "-")}__${s.session_id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64)}__${s.message_id
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .slice(0, 64)}.json`;
        const full = path.join(bundlesDir, fileSafe);
        const bundle = {
          schema_version: 1,
          captured_at: nowIso(),
          source: "nightly-triage",
          session_id: s.session_id,
          message_id: s.message_id,
          created_at: s.created_at,
          stop_reason: s.stop_reason,
          suggested_fix_area: area,
          user_text: s.user_text ? safeText(redact(s.user_text), 2000) : null,
          planned_actions: parseJsonArray<unknown>(s.planned_actions_json),
          tool_results: toolResults
        };
        fs.writeFileSync(full, JSON.stringify(bundle, null, 2), "utf8");
      } catch {
        // ignore
      }
    }
  }

  const sorted = [...signatures.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, maxIssues);
  const queuedJobs = queueImprovementJobs ? enqueueNightlyTriageImprovementJobs({ issues: sorted, report_path: outPath, since_iso: sinceIso, until_iso: untilIso }) : [];

  const proposals = await maybeAskOpenAIForProposals(sorted, { maxItems: 10 });

  const lines: string[] = [];
  lines.push("RevitOperator nightly issues");
  lines.push(`Range: ${sinceIso} -> ${untilIso}`);
  lines.push(`DB: ${dbPath}`);
  if (writeBundles) lines.push(`Bundles: ${bundlesDir}`);
  lines.push("");
  lines.push(`Sessions touched: ${sessionsTouched.size}`);
  lines.push(`Steps: ${totalSteps}`);
  lines.push(`Error steps (stop_reason=ERROR or tool failed): ${errorSteps}`);
  lines.push(`Tool failures: ${toolFailures}`);
  lines.push(`Notifications: ${notifications}`);
  if (queueImprovementJobs) lines.push(`Improvement jobs queued/updated: ${queuedJobs.filter(x => x.job).length}`);
  lines.push("");

  if (sorted.length === 0) {
    lines.push("No errors detected for this range.");
  } else {
    lines.push("Top issues:");
    let idx = 0;
    for (const it of sorted) {
      idx++;
      lines.push("");
      lines.push(`${idx}. [${it.count}x] (${it.suggested_fix_area}) ${it.key}`);
      lines.push(`   first_seen: ${it.first_seen}`);
      lines.push(`   last_seen:  ${it.last_seen}`);
      for (const ex of it.examples) {
        lines.push(`   - ${ex.ts} session=${ex.session_id} msg=${ex.message_id}`);
        if (ex.user_text) lines.push(`     user: ${ex.user_text}`);
        if (ex.tool) lines.push(`     tool: ${ex.tool.method} ${ex.tool.path}`);
        if (ex.error) lines.push(`     err:  ${ex.error}`);
      }
    }
  }

  if (proposals) {
    lines.push("");
    lines.push("Proposed changes (LLM-assisted):");
    lines.push(proposals.trim());
  } else {
    lines.push("");
    lines.push("Proposed changes:");
    lines.push("- Backend: capture `backend.error` events + stop reasons; add more validation around tool actions and attachment handling.");
    lines.push("- Frontend-addin: standardize tool error payloads and include stable error codes (so failures dedupe cleanly).");
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

