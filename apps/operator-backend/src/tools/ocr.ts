import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { resolveExistingFileUnderWorkspace } from "../workspace.js";

export type OcrKind = "text" | "date";

export type OcrRequest = {
  image_path: string;
  kind?: OcrKind;
  expected?: string | null;
  timeout_ms?: number | null;
};

export type OcrResponse = {
  ok: boolean;
  kind: OcrKind;
  image_path: string;
  full_path: string;
  bytes: number;
  text: string;
  extracted_dates: string[];
  best_date: string | null;
  expected: string | null;
  match_expected: boolean | null;
  error?: string;
  hint?: string;
};

function normalizeWhitespace(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForTextMatch(s: string): string {
  const t = (s ?? "").toString().toLowerCase();
  // Similar to Revit-side TextNote normalization: keep only letters/digits, collapse others to spaces.
  const cleaned = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[^a-z0-9]+/g, " ");
  const tokens = cleaned.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  // OCR sometimes inserts spaces between single letters (e.g. "W S P"). Collapse such runs to improve matching.
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.length === 1) {
      let run = tok;
      while (i + 1 < tokens.length && (tokens[i + 1] ?? "").length === 1) {
        i++;
        run += tokens[i] ?? "";
      }
      out.push(run);
    } else {
      out.push(tok);
    }
  }

  return out.join(" ").trim();
}

export function matchExpectedText(ocrText: string, expected: string | null | undefined): boolean | null {
  if (typeof expected !== "string") return null;
  const nText = normalizeForTextMatch(ocrText);
  const nExp = normalizeForTextMatch(expected);
  if (!nExp) return null;
  return nText.includes(nExp);
}

export function extractCandidateDates(text: string): string[] {
  const t = (text ?? "").toString();
  const out: string[] = [];

  // Common numeric formats.
  const patterns: RegExp[] = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g, // 2026-02-10
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // 2/10/2026
    /\b\d{1,2}-\d{1,2}-\d{2,4}\b/g, // 2-10-2026
    /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g // 2.10.2026
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    for (const s of m) out.push(s);
  }

  // Month name formats (best-effort; keep conservative).
  const month = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const reMonth = new RegExp(`\\b${month}\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*\\d{2,4}\\b`, "gi");
  const mm = t.match(reMonth);
  if (mm) for (const s of mm) out.push(s);

  // Dedup while preserving order.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const s of out.map(x => normalizeWhitespace(x))) {
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(s);
  }
  return dedup;
}

function normalizeDateish(s: string): string {
  const t = normalizeWhitespace(s).toLowerCase();
  // Keep only alnum and separators we care about, then unify runs.
  const cleaned = t.replace(/[^a-z0-9\/\-. ,]/g, "");
  return cleaned.replace(/\s+/g, " ").replace(/[,.]/g, "").trim();
}

export function bestDateMatch(extracted: string[], expected: string | null | undefined): { best: string | null; match: boolean | null } {
  const exp = expected ? normalizeDateish(expected) : "";
  if (!exp) return { best: extracted.length > 0 ? extracted[0] : null, match: null };
  const normExp = exp;

  let best: string | null = null;
  let bestScore = -1;
  let matched = false;

  for (const d of extracted) {
    const nd = normalizeDateish(d);
    if (!nd) continue;
    // Exact / substring match.
    const exact = nd === normExp;
    const sub = nd.includes(normExp) || normExp.includes(nd);
    const score = exact ? 100 : sub ? 60 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
    if (exact || sub) matched = true;
  }

  // If we didn't match any extracted candidate date, allow a fallback: expected appears somewhere in OCR text.
  if (!matched) return { best, match: false };
  return { best, match: true };
}

function defaultTesseractHints(): string {
  const workspace = ensureWorkspaceLayout().root;
  return [
    "OCR is not configured.",
    "Install Tesseract OCR and either:",
    "- put `tesseract` on PATH, or",
    "- set OPERATOR_TESSERACT_PATH to the full path (e.g. C:\\\\Program Files\\\\Tesseract-OCR\\\\tesseract.exe).",
    `Workspace root: ${workspace}`
  ].join(" ");
}

let missingHintShown = false;
function hintOnce(): string | undefined {
  if (missingHintShown) return undefined;
  missingHintShown = true;
  return defaultTesseractHints();
}

type TesseractJsWorker = any;
let tesseractJsWorkerPromise: Promise<TesseractJsWorker> | null = null;

export async function warmOcr(): Promise<void> {
  try {
    await getTesseractJsWorker();
  } catch {
    // ignore
  }
}

async function getTesseractJsWorker(): Promise<TesseractJsWorker> {
  if (tesseractJsWorkerPromise) return tesseractJsWorkerPromise;

  tesseractJsWorkerPromise = (async () => {
    const workspaceRoot = ensureWorkspaceLayout().root;
    const cachePath = path.join(workspaceRoot, "artifacts", "cache", "ocr");
    try {
      fs.mkdirSync(cachePath, { recursive: true });
    } catch {
      // ignore
    }

    const mod: any = await import("tesseract.js");
    const createWorker: any =
      mod?.createWorker ??
      mod?.default?.createWorker ??
      mod?.default ??
      null;
    if (typeof createWorker !== "function") throw new Error("tesseract.js does not export createWorker().");

    let worker: any;
    try {
      // tesseract.js v5 uses createWorker(langs, oem, options). Passing an
      // options object as the first argument, or passing a logger function to
      // the worker, can fail in modern Node with DataCloneError.
      worker = await Promise.resolve(createWorker("eng", 1, { cachePath }));
    } catch {
      try {
        worker = await Promise.resolve(createWorker("eng"));
      } catch {
        worker = await Promise.resolve(createWorker());
      }
    }

    try {
      if (typeof worker.load === "function") await worker.load();
    } catch {
      // ignore
    }
    if (typeof worker.loadLanguage === "function") await worker.loadLanguage("eng");
    if (typeof worker.initialize === "function") await worker.initialize("eng");

    try {
      if (typeof worker.setParameters === "function") {
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
      }
    } catch {
      // ignore
    }

    return worker;
  })();

  return tesseractJsWorkerPromise;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(message));
    }, Math.max(500, timeoutMs));
    promise.then(
      v => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        reject(e);
      }
    );
  });
}

async function runTesseractJs(imagePath: string, timeoutMs: number): Promise<string> {
  const enabled = /^(1|true|yes|on)$/i.test((process.env.OPERATOR_ENABLE_TESSERACT_JS ?? "").trim());
  if (!enabled) {
    throw new Error("tesseract.js fallback is disabled. Install tesseract CLI or set OPERATOR_ENABLE_TESSERACT_JS=1.");
  }
  // First-use can involve downloading language data; be more generous than the caller's default.
  const effectiveTimeoutMs = Math.max(timeoutMs, 60_000);
  const worker = await getTesseractJsWorker();
  const res: any = await withTimeout(worker.recognize(imagePath), effectiveTimeoutMs, `OCR timed out after ${effectiveTimeoutMs}ms.`);
  const text = res?.data?.text;
  return typeof text === "string" ? text : "";
}

async function runTesseract(imagePath: string, timeoutMs: number): Promise<string> {
  const tesseractFromEnv = (process.env.OPERATOR_TESSERACT_PATH || "").trim();
  const exe = tesseractFromEnv || "tesseract";

  return await new Promise<string>((resolve, reject) => {
    const args = [imagePath, "stdout", "-l", "eng", "--psm", "6"];
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`OCR timed out after ${timeoutMs}ms.`));
    }, Math.max(500, timeoutMs));

    child.stdout.on("data", d => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", d => {
      stderr += d.toString("utf8");
    });
    child.on("error", err => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`tesseract exited with code ${code}. ${normalizeWhitespace(stderr)}`.trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function ocrImage(req: OcrRequest): Promise<OcrResponse> {
  const workspaceRoot = ensureWorkspaceLayout().root;
  const image_path = (req.image_path ?? "").toString().trim();
  const kind: OcrKind = (req.kind ?? "text") === "date" ? "date" : "text";
  const expected = typeof req.expected === "string" ? req.expected : null;

  if (!image_path) {
    return {
      ok: false,
      kind,
      image_path,
      full_path: "",
      bytes: 0,
      text: "",
      extracted_dates: [],
      best_date: null,
      expected,
      match_expected: null,
      error: "image_path is required."
    };
  }

  let full_path = "";
  try {
    // Enforce workspace-only access; allow workspace-relative paths.
    full_path = resolveExistingFileUnderWorkspace(image_path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    return {
      ok: false,
      kind,
      image_path,
      full_path: "",
      bytes: 0,
      text: "",
      extracted_dates: [],
      best_date: null,
      expected,
      match_expected: null,
      error: `Invalid image_path (must be an existing file under Workspace): ${msg}`
    };
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(full_path).size;
  } catch {
    bytes = 0;
  }

  // Keep OCR bounded: do not try to OCR huge images.
  if (bytes > 35_000_000) {
    return {
      ok: false,
      kind,
      image_path,
      full_path,
      bytes,
      text: "",
      extracted_dates: [],
      best_date: null,
      expected,
      match_expected: null,
      error: "Image too large for OCR (max 35MB).",
      hint: "Capture a smaller region (e.g. titleblock crop) and retry."
    };
  }

  const timeoutMs = Number.isFinite(req.timeout_ms as any) ? Math.max(500, Number(req.timeout_ms)) : 20_000;

  let text = "";
  try {
    // Provider fallbacks + retries (handles flaky OCR and first-run tesseract.js downloads).
    const maxAttempts = 3;
    const errors: string[] = [];
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backoffMs = attempt === 0 ? 0 : 150 * 3 ** Math.min(4, attempt - 1);
      if (backoffMs) await new Promise(r => setTimeout(r, backoffMs));

      const attemptTimeout = attempt === 0 ? Math.min(timeoutMs, 10_000) : attempt === 1 ? Math.max(timeoutMs, 20_000) : Math.max(timeoutMs, 60_000);

      // Prefer CLI, then fallback to JS; if CLI is missing, JS is the primary.
      try {
        text = await runTesseract(full_path, attemptTimeout);
        lastErr = null;
        break;
      } catch (e1) {
        lastErr = e1;
        errors.push(e1 instanceof Error ? e1.message : String(e1 ?? ""));
        try {
          text = await runTesseractJs(full_path, attemptTimeout);
          lastErr = null;
          break;
        } catch (e2) {
          lastErr = e2;
          errors.push(e2 instanceof Error ? e2.message : String(e2 ?? ""));
        }
      }
    }

    if (lastErr) throw lastErr;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    const hint = hintOnce();
    return {
      ok: false,
      kind,
      image_path,
      full_path,
      bytes,
      text: "",
      extracted_dates: [],
      best_date: null,
      expected,
      match_expected: null,
      error: msg || "OCR failed.",
      hint
    };
  }

  text = text.replace(/\r\n/g, "\n");
  // Keep tool results lightweight; OCR can be noisy/large.
  const maxTextChars = 8000;
  if (text.length > maxTextChars) text = text.slice(0, maxTextChars) + "\n…(truncated)";
  const extracted_dates = kind === "date" ? extractCandidateDates(text) : [];
  const { best, match } = bestDateMatch(extracted_dates, expected);

  // If we didn't extract any structured date candidates, allow a fallback textual match for expected.
  let match_expected: boolean | null = match;
  let best_date: string | null = best;
  if (kind === "date" && expected && extracted_dates.length === 0) {
    const normText = normalizeDateish(text);
    const normExpected = normalizeDateish(expected);
    if (normExpected && normText.includes(normExpected)) {
      match_expected = true;
      best_date = expected;
    } else {
      match_expected = false;
      best_date = null;
    }
  }

  if (kind === "text") {
    match_expected = matchExpectedText(text, expected);
    best_date = null;
  }

  return {
    ok: true,
    kind,
    image_path,
    full_path,
    bytes,
    text,
    extracted_dates,
    best_date,
    expected,
    match_expected
  };
}
