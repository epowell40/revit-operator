import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";

export type MemoryScope = "daily" | "longterm";

export type MemoryEntry = {
  ts: string;
  scope: MemoryScope;
  kind: "preference" | "fact" | "note";
  text: string;
  tags?: string[];
  session_id?: string;
  source?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return nowIso().slice(0, 10);
}

function dailyPath(date: string): string {
  const layout = ensureWorkspaceLayout();
  return path.join(layout.memoryDaily, `${date}.jsonl`);
}

function longtermPath(): string {
  const layout = ensureWorkspaceLayout();
  return path.join(layout.memory, "longterm.jsonl");
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveDailyLookbackDays(override?: number): number {
  if (override !== undefined) return normalizeInt(override, 14, 1, 90);
  return normalizeInt(process.env.OPERATOR_MEMORY_DAILY_LOOKBACK_DAYS, 14, 1, 90);
}

function listRecentDailyFiles(lookbackDays: number): string[] {
  const layout = ensureWorkspaceLayout();
  const dir = layout.memoryDaily;
  try {
    if (!fs.existsSync(dir)) return [];
    const names = fs
      .readdirSync(dir)
      .filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(x))
      .sort((a, b) => b.localeCompare(a));
    if (names.length === 0) return [];
    return names.slice(0, Math.max(1, lookbackDays)).map(x => path.join(dir, x));
  } catch {
    return [];
  }
}

function tokenize(s: string): string[] {
  const raw = (s ?? "").toString().toLowerCase();
  const parts = raw.split(/[^a-z0-9]+/g).map(x => x.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.length < 2) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function safeReadText(filePath: string, maxBytes: number): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const st = fs.statSync(filePath);
    if (!st.isFile()) return "";
    const size = st.size;
    if (size <= maxBytes) return fs.readFileSync(filePath, "utf8");

    // Read the last maxBytes for very large logs.
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const start = Math.max(0, size - maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, start);
      const slice = buf.subarray(0, Math.max(0, read));
      const txt = slice.toString("utf8");
      const idx = txt.indexOf("\n");
      return idx >= 0 ? txt.slice(idx + 1) : txt;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return "";
  }
}

function parseJsonlEntries(raw: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j: any = JSON.parse(t);
      const text = typeof j?.text === "string" ? j.text : "";
      const ts = typeof j?.ts === "string" ? j.ts : "";
      const scope = j?.scope === "daily" || j?.scope === "longterm" ? (j.scope as MemoryScope) : null;
      const kind = j?.kind === "preference" || j?.kind === "fact" || j?.kind === "note" ? j.kind : null;
      if (!text || !ts || !scope || !kind) continue;
      const tags = Array.isArray(j?.tags) ? j.tags.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : undefined;
      out.push({
        ts,
        scope,
        kind,
        text,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(typeof j?.session_id === "string" && j.session_id.trim() ? { session_id: j.session_id.trim() } : {}),
        ...(typeof j?.source === "string" && j.source.trim() ? { source: j.source.trim() } : {})
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function appendDailyMemory(entry: Omit<MemoryEntry, "scope" | "ts"> & { ts?: string; date?: string }): string {
  const ts = entry.ts ?? nowIso();
  const date = entry.date ?? today();
  const e: MemoryEntry = { ts, scope: "daily", kind: entry.kind, text: entry.text, ...(entry.tags ? { tags: entry.tags } : {}) };
  if (entry.session_id) e.session_id = entry.session_id;
  if (entry.source) e.source = entry.source;
  const p = dailyPath(date);
  atomicAppendJsonlLine(p, e);
  return p;
}

export function appendLongtermMemory(entry: Omit<MemoryEntry, "scope" | "ts"> & { ts?: string }): string {
  const ts = entry.ts ?? nowIso();
  const e: MemoryEntry = { ts, scope: "longterm", kind: entry.kind, text: entry.text, ...(entry.tags ? { tags: entry.tags } : {}) };
  if (entry.session_id) e.session_id = entry.session_id;
  if (entry.source) e.source = entry.source;
  const p = longtermPath();
  atomicAppendJsonlLine(p, e);
  return p;
}

export type RetrievedMemory = MemoryEntry & { score: number; file?: string };

export function retrieveMemoryContext(args: { queryText: string; maxEntries?: number; maxBytesPerFile?: number; dailyLookbackDays?: number }): RetrievedMemory[] {
  const qTokens = tokenize(args.queryText);
  if (qTokens.length === 0) return [];
  const qSet = new Set(qTokens);

  const maxEntries = typeof args.maxEntries === "number" && Number.isFinite(args.maxEntries) ? Math.max(1, Math.floor(args.maxEntries)) : 8;
  const maxBytes = typeof args.maxBytesPerFile === "number" && Number.isFinite(args.maxBytesPerFile) ? Math.max(1024, Math.floor(args.maxBytesPerFile)) : 5 * 1024 * 1024;
  const lookbackDays = resolveDailyLookbackDays(args.dailyLookbackDays);
  const dailyFiles = listRecentDailyFiles(lookbackDays);
  const rankedDailyFiles = (dailyFiles.length > 0 ? dailyFiles : [dailyPath(today())]).map((file, index) => ({ file, scope: "daily" as const, dailyRank: index }));

  const files: Array<{ file: string; scope: MemoryScope; dailyRank?: number }> = [
    ...rankedDailyFiles,
    { file: longtermPath(), scope: "longterm" }
  ];

  const candidates: RetrievedMemory[] = [];
  for (const f of files) {
    const raw = safeReadText(f.file, maxBytes);
    const entries = parseJsonlEntries(raw).filter(e => e.scope === f.scope);
    for (const e of entries) {
      const tokens = tokenize(e.text + " " + (Array.isArray(e.tags) ? e.tags.join(" ") : ""));
      let overlap = 0;
      for (const t of tokens) if (qSet.has(t)) overlap++;
      if (overlap <= 0) continue;
      const recencyBoost = f.scope === "daily" ? Math.max(0.05, 0.25 - ((f.dailyRank ?? 0) * 0.015)) : 0;
      const score = overlap + recencyBoost;
      candidates.push({ ...e, score, file: f.file });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
  return candidates.slice(0, maxEntries);
}

