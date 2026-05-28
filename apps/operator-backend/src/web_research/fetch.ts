import { isUrlAllowedByPolicy, type WebResearchPolicy } from "./policy.js";
import { writeWebEvidenceBundle } from "./evidence.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";

export type WebFetchResult = {
  request_id: string;
  url: string;
  ok: boolean;
  host?: string;
  status?: number | null;
  content_type?: string | null;
  title?: string | null;
  paywall?: boolean;
  error?: string;
  evidence_dir?: string;
  meta_path?: string;
  snapshot_path?: string | null;
  text_path?: string | null;
  text_snippet?: string | null;
};

function truncate(s: string, maxChars: number): string {
  const t = (s ?? "").toString();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "…(truncated)";
}

function looksLikePaywall(html: string): boolean {
  const t = (html ?? "").toLowerCase();
  if (!t) return false;
  const hints = ["paywall", "subscribe to continue", "subscribe to read", "to continue reading", "sign in to continue", "register to continue"];
  return hints.some(h => t.includes(h));
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

async function extractPdfText(bytes: Buffer, maxPages: number): Promise<string> {
  // pdfjs-dist in Node: use legacy build + disableWorker to avoid bundling worker.
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  const pages = Math.min(maxPages, doc.numPages || 0);
  const out: string[] = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = (content?.items ?? []).map((it: any) => (typeof it?.str === "string" ? it.str : "")).join(" ");
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed) out.push(`(p${p}) ${trimmed}`);
  }
  return out.join("\n\n");
}

async function readBodyLimited(resp: Response, maxBytes: number): Promise<Buffer> {
  const body = resp.body as any;
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

export async function fetchWebEvidence(args: {
  requestId: string;
  url: string;
  policy: WebResearchPolicy;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebFetchResult> {
  const request_id = (args.requestId ?? "").toString().trim();
  const url = (args.url ?? "").toString().trim();
  const maxBytes = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes) ? Math.max(16 * 1024, Math.floor(args.maxBytes)) : 10 * 1024 * 1024;
  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? Math.max(500, Math.floor(args.timeoutMs)) : 25_000;
  const fetchImpl = args.fetchImpl ?? fetch;

  const allowed = isUrlAllowedByPolicy(url, args.policy);
  const fetchedAt = new Date().toISOString();
  if (!allowed.ok) {
    const paths = writeWebEvidenceBundle({
      url,
      ok: false,
      fetchedAtIso: fetchedAt,
      policy: { mode: args.policy.mode, host: null, decision: allowed.error },
      http: { status: null, contentType: null },
      error: allowed.error,
      snapshotBytes: null,
      extractedText: null
    });
    return {
      request_id,
      url,
      ok: false,
      error: allowed.error,
      evidence_dir: paths.evidenceDirRel,
      meta_path: paths.metaPathRel,
      snapshot_path: paths.snapshotPathRel,
      text_path: paths.textPathRel,
      text_snippet: null
    };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let status: number | null = null;
  let contentType: string | null = null;
  let finalUrl: string | null = null;
  let title: string | null = null;
  let extractedText: string | null = null;
  let extractedTextMethod: string | null = null;
  let paywall = false;
  let snapshotBytes: Buffer | null = null;
  let error: string | null = null;

  const headersOut: Record<string, string> = {};

  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "RevitOperator/1.0 (+local evidence fetch)",
        accept: "text/html,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.1"
      }
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
      } else if (isText) {
        extractedText = asText.replace(/\r\n/g, "\n").trim();
        extractedTextMethod = "text.utf8";
      } else if (isJson) {
        extractedText = asText.replace(/\r\n/g, "\n").trim();
        extractedTextMethod = "json.utf8";
      }
    } else if (snapshotBytes && snapshotBytes.length > 0 && isPdf) {
      try {
        extractedText = await extractPdfText(snapshotBytes, 5);
        extractedTextMethod = "pdf.pdfjs.pages<=5";
      } catch (e) {
        extractedText = null;
        extractedTextMethod = null;
      }
    }

    if (!status || status < 200 || status >= 400) {
      error = `HTTP ${status ?? "?"} while fetching URL.`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(t);
  }

  const ok = !error && !!status && status >= 200 && status < 400;
  const paths = writeWebEvidenceBundle({
    url,
    finalUrl,
    ok,
    fetchedAtIso: fetchedAt,
    policy: { mode: args.policy.mode, host: allowed.host, decision: "allowed" },
    http: { status, contentType, headers: Object.keys(headersOut).length > 0 ? headersOut : undefined },
    error,
    paywall,
    title,
    snapshotBytes,
    snapshotContentType: contentType,
    extractedText,
    extractedTextMethod
  });

  const snippet = extractedText ? truncate(extractedText.replace(/\s+/g, " ").trim(), 1400) : null;
  const result: WebFetchResult = {
    request_id,
    url,
    ok,
    host: allowed.host,
    status,
    content_type: contentType,
    title,
    paywall,
    ...(error ? { error } : {}),
    evidence_dir: paths.evidenceDirRel,
    meta_path: paths.metaPathRel,
    snapshot_path: paths.snapshotPathRel,
    text_path: paths.textPathRel,
    text_snippet: snippet
  };

  if (!ok && paywall) {
    result.error = (result.error ? result.error + " " : "") + "Likely paywall/blocked. Ask the user to provide an excerpt or PDF.";
  }

  return result;
}

