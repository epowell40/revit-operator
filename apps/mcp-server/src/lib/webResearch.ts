import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureWorkspaceLayout, getWorkspaceRoot } from "./workspace.js";

export type WebResearchMode = "off" | "whitelist" | "unrestricted";

export type WebResearchPolicy = {
  mode: WebResearchMode;
  allowlistDomains: string[];
  denylistDomains: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return nowIso().slice(0, 10);
}

function splitDomains(raw: string | undefined): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/g)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function getWebResearchPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): WebResearchPolicy {
  const rawMode = (env.OPERATOR_WEB_RESEARCH_MODE ?? "unrestricted").toString().trim().toLowerCase();
  const mode: WebResearchMode = rawMode === "off" || rawMode === "whitelist" || rawMode === "unrestricted" ? (rawMode as any) : "unrestricted";
  const allowlistDomains = splitDomains(env.OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS);
  const denylistDomains = splitDomains(env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS);
  return { mode, allowlistDomains, denylistDomains };
}

function hostMatchesRule(host: string, rule: string): boolean {
  const h = host.toLowerCase();
  const r = rule.toLowerCase();
  if (!h || !r) return false;
  const suffix = r.startsWith("*.") ? r.slice(2) : r.startsWith(".") ? r.slice(1) : null;
  if (suffix) return h === suffix || h.endsWith("." + suffix);
  return h === r || h.endsWith("." + r);
}

export function isUrlAllowedByPolicy(urlString: string, policy: WebResearchPolicy): { ok: true; host: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return { ok: false, error: "Only http/https URLs are supported." };
  const host = (url.hostname ?? "").toLowerCase();
  if (!host) return { ok: false, error: "URL is missing a host." };

  if (policy.mode === "off") return { ok: false, error: "Web research is disabled (OPERATOR_WEB_RESEARCH_MODE=off)." };

  if (policy.mode === "whitelist") {
    if (!policy.allowlistDomains || policy.allowlistDomains.length === 0) {
      return { ok: false, error: "Whitelist mode enabled, but OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS is empty." };
    }
    const allowed = policy.allowlistDomains.some((r) => hostMatchesRule(host, r));
    if (!allowed) return { ok: false, error: `Domain not allowed by whitelist: ${host}` };
    return { ok: true, host };
  }

  const denied = (policy.denylistDomains ?? []).some((r) => hostMatchesRule(host, r));
  if (denied) return { ok: false, error: `Domain blocked by denylist: ${host}` };
  return { ok: true, host };
}

function tryWorkspaceRelative(fullPath: string): string | null {
  try {
    const root = path.resolve(getWorkspaceRoot());
    const full = path.resolve(fullPath);
    const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
    const fullNorm = process.platform === "win32" ? full.toLowerCase() : full;
    if (fullNorm === rootNorm) return ".";
    const prefix = rootNorm.endsWith(path.sep) ? rootNorm : rootNorm + path.sep;
    if (!fullNorm.startsWith(prefix)) return null;
    const rel = path.relative(root, full);
    return rel.replace(/\\/g, "/");
  } catch {
    return null;
  }
}

function extFromContentType(ct: string | null): string {
  const c = (ct ?? "").toLowerCase();
  if (c.includes("text/html")) return ".html";
  if (c.includes("application/pdf")) return ".pdf";
  if (c.includes("application/json")) return ".json";
  if (c.includes("text/plain")) return ".txt";
  return ".bin";
}

function sha256Hex(buf: Buffer): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function stripHtmlToText(html: string): { title: string | null; text: string } {
  const raw = html ?? "";
  let title: string | null = null;
  const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && typeof m[1] === "string") {
    const t = m[1].replace(/\s+/g, " ").trim();
    title = t ? t.slice(0, 240) : null;
  }

  let cleaned = raw;
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, " ");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, " ");
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, " ");
  cleaned = cleaned.replace(/<\/(p|div|br|li|h1|h2|h3|h4|h5|h6|tr|td)>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = cleaned.replace(/&nbsp;/gi, " ");
  cleaned = cleaned.replace(/&amp;/gi, "&");
  cleaned = cleaned.replace(/&lt;/gi, "<");
  cleaned = cleaned.replace(/&gt;/gi, ">");
  cleaned = cleaned.replace(/&quot;/gi, "\"");
  cleaned = cleaned.replace(/&#39;/gi, "'");
  cleaned = cleaned.replace(/\r\n/g, "\n");
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  return { title, text: cleaned.trim() };
}

function looksLikePaywall(html: string): boolean {
  const t = (html ?? "").toLowerCase();
  if (!t) return false;
  const hints = ["paywall", "subscribe to continue", "subscribe to read", "to continue reading", "sign in to continue", "register to continue"];
  return hints.some((h) => t.includes(h));
}

async function readBodyLimited(resp: Response, maxBytes: number): Promise<Buffer> {
  const body: any = (resp as any).body;
  if (!body || typeof body.getReader !== "function") {
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    return buf.length > maxBytes ? buf.slice(0, maxBytes) : buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const b = Buffer.from(value);
    total += b.length;
    if (total > maxBytes) throw new Error(`Response too large (>${maxBytes} bytes).`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export type WebEvidenceResult = {
  ok: boolean;
  url: string;
  final_url: string | null;
  status: number | null;
  content_type: string | null;
  title: string | null;
  paywall: boolean;
  error: string | null;
  evidence_dir: string;
  meta_path: string;
  snapshot_path: string | null;
  text_path: string | null;
  text_snippet: string | null;
};

export async function fetchWebEvidenceToWorkspace(args: {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
  policy?: WebResearchPolicy;
  fetchImpl?: typeof fetch;
  pdfParseImpl?: (bytes: Buffer) => Promise<{ text?: string }>;
}): Promise<WebEvidenceResult> {
  const policy = args.policy ?? getWebResearchPolicyFromEnv();
  const url = (args.url ?? "").toString().trim();
  const maxBytes = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes) ? Math.max(16 * 1024, Math.floor(args.maxBytes)) : 10 * 1024 * 1024;
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? Math.max(500, Math.floor(args.timeoutMs)) : 25_000;
  const fetchImpl = args.fetchImpl ?? fetch;

  const allowed = isUrlAllowedByPolicy(url, policy);
  const fetchedAt = nowIso();

  ensureWorkspaceLayout();
  const ws = ensureWorkspaceLayout();
  const evidenceId = randomUUID();
  const dirFull = path.join(ws.evidenceWeb, today(), evidenceId);
  fs.mkdirSync(dirFull, { recursive: true });

  const metaFull = path.join(dirFull, "meta.json");
  const evidenceDirRel = tryWorkspaceRelative(dirFull) ?? dirFull;
  const metaRel = tryWorkspaceRelative(metaFull) ?? metaFull;

  const writeMeta = (meta: any) => {
    fs.writeFileSync(metaFull, JSON.stringify(meta, null, 2), "utf8");
  };

  if (!allowed.ok) {
    writeMeta({
      schema_version: 1,
      evidence_id: evidenceId,
      fetched_at: fetchedAt,
      url,
      final_url: null,
      ok: false,
      policy: { mode: policy.mode, decision: allowed.error },
      http: null,
      title: null,
      paywall: false,
      error: allowed.error,
      snapshot: null,
      extracted_text: null,
    });
    return {
      ok: false,
      url,
      final_url: null,
      status: null,
      content_type: null,
      title: null,
      paywall: false,
      error: allowed.error,
      evidence_dir: evidenceDirRel,
      meta_path: metaRel,
      snapshot_path: null,
      text_path: null,
      text_snippet: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status: number | null = null;
  let contentType: string | null = null;
  let finalUrl: string | null = null;
  let title: string | null = null;
  let paywall = false;
  let snapshotBytes: Buffer | null = null;
  let extractedText: string | null = null;
  let extractedTextMethod: string | null = null;
  let error: string | null = null;

  const headersOut: Record<string, string> = {};

  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "RevitOperator/1.0 (+local evidence fetch)",
        accept: "text/html,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.1",
      },
    });
    status = resp.status;
    finalUrl = typeof (resp as any).url === "string" ? (resp as any).url : null;
    contentType = resp.headers.get("content-type");
    for (const [k, v] of (resp.headers as any).entries?.() ?? []) {
      if (typeof k === "string" && typeof v === "string") headersOut[k] = v;
    }
    snapshotBytes = await readBodyLimited(resp, maxBytes);

    const isHtml = (contentType ?? "").toLowerCase().includes("text/html");
    const isPdf = (contentType ?? "").toLowerCase().includes("application/pdf");
    const isText = (contentType ?? "").toLowerCase().includes("text/plain");
    const isJson = (contentType ?? "").toLowerCase().includes("application/json");

    if (status === 401 || status === 402 || status === 403 || status === 451) paywall = isHtml || isPdf || isText;

    if (snapshotBytes && snapshotBytes.length > 0 && (isHtml || isText || isJson)) {
      const asText = snapshotBytes.toString("utf8");
      if (isHtml) {
        const parsed = stripHtmlToText(asText);
        title = parsed.title;
        extractedText = parsed.text;
        extractedTextMethod = "html.strip";
        if (!paywall) paywall = looksLikePaywall(asText);
      } else {
        extractedText = asText.replace(/\r\n/g, "\n").trim();
        extractedTextMethod = isJson ? "json.utf8" : "text.utf8";
      }
    } else if (snapshotBytes && snapshotBytes.length > 0 && isPdf && args.pdfParseImpl) {
      try {
        const parsed = await args.pdfParseImpl(snapshotBytes);
        const txt = (parsed?.text ?? "").toString();
        extractedText = txt.replace(/\r\n/g, "\n").trim();
        extractedTextMethod = "pdf.pdf-parse";
      } catch {
        // ignore
      }
    }

    if (!status || status < 200 || status >= 400) error = `HTTP ${status ?? "?"} while fetching URL.`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const ok = !error && !!status && status >= 200 && status < 400;

  let snapshotRel: string | null = null;
  let textRel: string | null = null;
  let snippet: string | null = null;

  let snapshotInfo: any = null;
  if (snapshotBytes && snapshotBytes.length > 0) {
    const snapFull = path.join(dirFull, "snapshot" + extFromContentType(contentType));
    fs.writeFileSync(snapFull, snapshotBytes);
    snapshotRel = tryWorkspaceRelative(snapFull) ?? snapFull;
    snapshotInfo = { path: path.basename(snapFull), sha256: sha256Hex(snapshotBytes) };
  }

  let extractedInfo: any = null;
  if (extractedText && extractedText.trim()) {
    const txt = extractedText.replace(/\r\n/g, "\n");
    const textFull = path.join(dirFull, "text.txt");
    fs.writeFileSync(textFull, txt, "utf8");
    textRel = tryWorkspaceRelative(textFull) ?? textFull;
    extractedInfo = { path: path.basename(textFull), sha256: sha256Hex(Buffer.from(txt, "utf8")), method: extractedTextMethod, chars: txt.length };
    snippet = txt.replace(/\s+/g, " ").trim();
    if (snippet.length > 1400) snippet = snippet.slice(0, 1400) + "…(truncated)";
  }

  writeMeta({
    schema_version: 1,
    evidence_id: evidenceId,
    fetched_at: fetchedAt,
    url,
    final_url: finalUrl,
    ok,
    policy: { mode: policy.mode, host: allowed.host, decision: "allowed" },
    http: { status, contentType, headers: Object.keys(headersOut).length > 0 ? headersOut : undefined },
    title,
    paywall,
    error,
    snapshot: snapshotInfo,
    extracted_text: extractedInfo,
  });

  return {
    ok,
    url,
    final_url: finalUrl,
    status,
    content_type: contentType,
    title,
    paywall,
    error: paywall && !ok ? (error ? error + " " : "") + "Likely paywall/blocked. Ask the user for an excerpt or PDF." : error,
    evidence_dir: evidenceDirRel,
    meta_path: metaRel,
    snapshot_path: snapshotRel,
    text_path: textRel,
    text_snippet: snippet,
  };
}

