import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";
import type { UserAttachment } from "../contracts.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";

export type AttachmentExcerpt = {
  anchor: string;
  text: string;
};

type ImageMeta = { widthPx: number; heightPx: number; kind: "png" | "jpeg" };

async function sha256HexFile(fullPath: string): Promise<string> {
  const h = createHash("sha256");
  const s = fs.createReadStream(fullPath);
  return await new Promise<string>((resolve, reject) => {
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", (e) => reject(e));
  });
}

function safeId(a: UserAttachment): string {
  return (a.id ?? "").toString().trim();
}

function safeRelPath(a: UserAttachment): string {
  const rp = (a.relative_path ?? "").toString().trim();
  return rp;
}

function cachePathFor(sha: string, kind: string): string {
  const layout = ensureWorkspaceLayout();
  const dir = path.join(layout.artifacts, "extracted");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return path.join(dir, `${sha}.${kind}.json`);
}

function tryReadCache(sha: string, kind: string): AttachmentExcerpt[] | null {
  try {
    const p = cachePathFor(sha, kind);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as any;
    const excerpts = Array.isArray(parsed?.excerpts) ? parsed.excerpts : null;
    if (!excerpts) return null;
    return excerpts
      .filter((x: any) => x && typeof x === "object" && typeof x.anchor === "string" && typeof x.text === "string")
      .map((x: any) => ({ anchor: x.anchor, text: x.text })) as AttachmentExcerpt[];
  } catch {
    return null;
  }
}

function tryWriteCache(sha: string, kind: string, excerpts: AttachmentExcerpt[]): void {
  try {
    const p = cachePathFor(sha, kind);
    fs.writeFileSync(p, JSON.stringify({ sha256: sha, kind, excerpts }, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function truncateText(s: string, maxChars: number): string {
  const t = (s ?? "").toString().replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "…(truncated)";
}

async function extractJsonExcerpts(fullPath: string): Promise<AttachmentExcerpt[]> {
  const raw = fs.readFileSync(fullPath, "utf8");
  const trimmed = truncateText(raw, 3500);
  return trimmed ? [{ anchor: "JSON", text: trimmed }] : [];
}

async function extractPdfExcerpts(fullPath: string): Promise<AttachmentExcerpt[]> {
  const bytes = fs.readFileSync(fullPath);
  const pdfData = new Uint8Array(bytes);
  // pdfjs-dist in Node: use legacy build + disableWorker to avoid bundling worker.
  const pdfjs = await loadPdfJsForNode();
  const doc = await pdfjs.getDocument(buildPdfJsDocumentOptions(pdfData)).promise;
  const pageCount = Math.max(0, Number(doc.numPages ?? 0));
  const pageNumbers = selectPdfExcerptPages(pageCount);
  const out: AttachmentExcerpt[] = pageCount > 0
    ? [{
        anchor: "PDF package inventory",
        text: `page_count=${pageCount}; prompt_excerpt_pages=${pageNumbers.join(",")}; full comment/page analysis is handled by the redline PDF package analyzer.`
      }]
    : [];
  for (const p of pageNumbers) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = (content?.items ?? []).map((it: any) => (typeof it?.str === "string" ? it.str : "")).join(" ");
    const trimmed = truncateText(text, 1800);
    if (trimmed) out.push({ anchor: `PDF p${p}`, text: trimmed });
  }
  return out;
}

export function selectPdfExcerptPages(pageCount: number): number[] {
  const total = Math.max(0, Math.floor(pageCount));
  if (total <= 0) return [];
  const candidates = [1, 2, Math.ceil(total / 2), Math.max(1, total - 1), total];
  return Array.from(new Set(candidates.filter((page) => page >= 1 && page <= total))).sort((a, b) => a - b);
}

async function extractDocxExcerpts(fullPath: string): Promise<AttachmentExcerpt[]> {
  const mammoth: any = await import("mammoth");
  const r = await mammoth.extractRawText({ path: fullPath });
  const text = typeof r?.value === "string" ? r.value : "";
  const trimmed = truncateText(text, 3500);
  return trimmed ? [{ anchor: "DOCX", text: trimmed }] : [];
}

function decodePngSize(buf: Buffer): ImageMeta | null {
  // PNG signature + IHDR: width/height are big-endian uint32 at bytes 16..23.
  if (!buf || buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  const widthPx = buf.readUInt32BE(16);
  const heightPx = buf.readUInt32BE(20);
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) return null;
  return { widthPx, heightPx, kind: "png" };
}

function decodeJpegSize(buf: Buffer): ImageMeta | null {
  // JPEG SOF segment contains width/height. Scan markers in a header chunk.
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI

  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }

    // Skip fill bytes 0xFF.
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) break;
    const marker = buf[i] as number;
    i++;

    // Standalone markers without length.
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS (image data follows)
    if (i + 2 >= buf.length) break;

    const len = buf.readUInt16BE(i);
    if (len < 2) break;

    // SOF markers that define frame size.
    const isSof =
      marker === 0xc0 || // SOF0
      marker === 0xc1 ||
      marker === 0xc2 || // SOF2
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;

    if (isSof) {
      // Segment layout: [len(2)] [precision(1)] [height(2)] [width(2)] ...
      if (i + 7 < buf.length) {
        const heightPx = buf.readUInt16BE(i + 3);
        const widthPx = buf.readUInt16BE(i + 5);
        if (widthPx > 0 && heightPx > 0) return { widthPx, heightPx, kind: "jpeg" };
      }
      return null;
    }

    i += len;
  }

  return null;
}

function tryGetImageMeta(fullPath: string): ImageMeta | null {
  try {
    const fd = fs.openSync(fullPath, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
      return decodePngSize(head) ?? decodeJpegSize(head);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
}

async function extractImageMetaExcerpts(fullPath: string): Promise<AttachmentExcerpt[]> {
  const st = fs.statSync(fullPath);
  const meta = tryGetImageMeta(fullPath);
  const bits: string[] = [];
  bits.push(`file=${path.basename(fullPath)}`);
  bits.push(`bytes=${st.size}`);
  if (meta) bits.push(`size=${meta.widthPx}x${meta.heightPx}px`);
  return [{ anchor: "Image meta", text: bits.join(", ") }];
}

async function extractXlsxExcerpts(fullPath: string): Promise<AttachmentExcerpt[]> {
  const xMod: any = await import("xlsx");
  const xlsx: any = xMod?.default ?? xMod;
  xlsx.set_fs?.(fs);
  const wb = xlsx.readFile(fullPath, { cellDates: false, dense: false });
  const sheetName = (wb.SheetNames && wb.SheetNames.length > 0 ? wb.SheetNames[0] : "") || "";
  if (!sheetName) return [{ anchor: "Excel", text: "Could not read any worksheet names." }];

  const ws = wb.Sheets[sheetName];
  if (!ws) return [{ anchor: "Excel", text: `Worksheet not found: ${sheetName}` }];

  const ref = typeof ws["!ref"] === "string" ? (ws["!ref"] as string) : "A1:A1";
  const used = xlsx.utils.decode_range(ref);

  const maxRows = 20;
  const maxCols = 10;
  const r0 = 0;
  const c0 = 0;
  const r1 = Math.min(used.e.r, r0 + (maxRows - 1));
  const c1 = Math.min(used.e.c, c0 + (maxCols - 1));

  const merges = Array.isArray(ws["!merges"]) ? (ws["!merges"] as any[]) : [];
  const mergedTopLeft = new Map<string, { r: number; c: number }>();
  for (const m of merges) {
    const s = m?.s;
    const e = m?.e;
    if (!s || !e) continue;
    const sr = Number(s.r);
    const sc = Number(s.c);
    const er = Number(e.r);
    const ec = Number(e.c);
    if (!Number.isFinite(sr) || !Number.isFinite(sc) || !Number.isFinite(er) || !Number.isFinite(ec)) continue;
    for (let rr = sr; rr <= er; rr++) {
      for (let cc = sc; cc <= ec; cc++) {
        mergedTopLeft.set(`${rr},${cc}`, { r: sr, c: sc });
      }
    }
  }

  function cellText(rr: number, cc: number): string {
    const tl = mergedTopLeft.get(`${rr},${cc}`);
    const addr = xlsx.utils.encode_cell(tl ? { r: tl.r, c: tl.c } : { r: rr, c: cc });
    const cell = ws[addr];
    if (!cell) return "";
    // Prefer formatted string if available.
    try {
      const s = xlsx.utils.format_cell(cell);
      return typeof s === "string" ? s : "";
    } catch {
      const v = cell.v;
      if (v === null || v === undefined) return "";
      return String(v);
    }
  }

  const grid: string[][] = [];
  for (let rr = r0; rr <= r1; rr++) {
    const row: string[] = [];
    for (let cc = c0; cc <= c1; cc++) row.push(cellText(rr, cc));
    grid.push(row);
  }

  // Trim trailing empty rows.
  while (grid.length > 0 && grid[grid.length - 1]!.every(x => !String(x ?? "").trim())) grid.pop();
  if (grid.length === 0) return [{ anchor: `Excel Sheet=${sheetName}, Range=A1:A1`, text: "(empty preview)" }];

  // Trim trailing empty columns.
  const cols = grid[0]!.length;
  let lastCol = cols - 1;
  for (; lastCol >= 0; lastCol--) {
    let any = false;
    for (const row of grid) {
      if (String(row[lastCol] ?? "").trim()) {
        any = true;
        break;
      }
    }
    if (any) break;
  }
  const trimmedGrid = grid.map(r => r.slice(0, lastCol + 1));

  const previewLines: string[] = [];
  const rowLimit = Math.min(trimmedGrid.length, 8);
  const colLimit = Math.min(trimmedGrid[0]!.length, 8);
  for (let rr = 0; rr < rowLimit; rr++) {
    const cells = trimmedGrid[rr]!.slice(0, colLimit).map(v => truncateText(String(v ?? ""), 60));
    previewLines.push(cells.join(" | "));
  }
  if (trimmedGrid.length > rowLimit) previewLines.push(`… (${trimmedGrid.length - rowLimit} more rows)`);
  if (trimmedGrid[0]!.length > colLimit) previewLines.push(`… (${trimmedGrid[0]!.length - colLimit} more cols)`);

  const endCell = xlsx.utils.encode_cell({ r: r0 + trimmedGrid.length - 1, c: c0 + trimmedGrid[0]!.length - 1 });
  const anchor = `Excel Sheet=${sheetName}, Range=A1:${endCell}`;
  return [{ anchor, text: previewLines.join("\n") }];
}

function extLower(p: string): string {
  return path.extname(p).toLowerCase();
}

export async function getAttachmentExcerptsForPrompt(attachments: UserAttachment[]): Promise<
  Array<{
    id: string;
    label: string;
    relative_path?: string;
    external_path?: string;
    mime?: string;
    sha256?: string;
    excerpts: AttachmentExcerpt[];
    warning?: string;
  }>
> {
  const list = Array.isArray(attachments) ? attachments : [];
  const out: any[] = [];

  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const id = safeId(a);
    if (!id) continue;

    const rp = safeRelPath(a);
    const extPath = (a.external_path ?? "").toString().trim();
    const label = (a.filename ?? rp ?? extPath ?? id).toString();

    if (!rp) {
      out.push({ id, label, relative_path: rp || undefined, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts: [], warning: rp ? undefined : "No workspace path (external-only reference)." });
      continue;
    }

    let full: string;
    try {
      full = resolveExistingFileUnderWorkspace(rp);
    } catch (e) {
      out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts: [], warning: `File not found under workspace: ${rp}` });
      continue;
    }

    const ext = extLower(full);
    if (ext !== ".pdf" && ext !== ".docx" && ext !== ".xlsx" && ext !== ".xls" && ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg" && ext !== ".json") {
      out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts: [], warning: "No auto-extraction for this file type (supported: .pdf, .docx, .xlsx/.xls, .png/.jpg, .json)." });
      continue;
    }

    if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
      try {
        const excerpts = await extractImageMetaExcerpts(full);
        out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts: [], warning: `Image meta extraction failed: ${msg}` });
      }
      continue;
    }

    if (ext === ".json") {
      try {
        const excerpts = await extractJsonExcerpts(full);
        out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: a.sha256, excerpts: [], warning: `JSON extraction failed: ${msg}` });
      }
      continue;
    }

    let sha = (a.sha256 ?? "").toString().trim();
    if (!sha) {
      try {
        sha = await sha256HexFile(full);
      } catch {
        sha = "";
      }
    }
    const kind = ext === ".pdf" ? "pdf_v2_large_package" : ext === ".docx" ? "docx" : "xlsx";
    const cached = sha ? tryReadCache(sha, kind) : null;
    if (cached) {
      out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: sha || undefined, excerpts: cached });
      continue;
    }

    try {
      const excerpts =
        ext === ".pdf"
          ? await extractPdfExcerpts(full)
          : ext === ".docx"
            ? await extractDocxExcerpts(full)
            : await extractXlsxExcerpts(full);
      if (sha) tryWriteCache(sha, kind, excerpts);
      out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: sha || undefined, excerpts });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ id, label, relative_path: rp, external_path: extPath || undefined, mime: a.mime, sha256: sha || undefined, excerpts: [], warning: `Extraction failed: ${msg}` });
    }
  }

  return out;
}
