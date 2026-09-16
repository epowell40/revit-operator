import path from "node:path";
import { createRequire } from "node:module";

type PdfJsLike = {
  getDocument: (options: Record<string, unknown>) => { promise: Promise<any> };
  OPS: Record<string, number>;
};

let cachedPdfJs: Promise<PdfJsLike> | null = null;
let cachedStandardFontDataUrl: string | null = null;

function resolveStandardFontDataUrl(): string | null {
  if (cachedStandardFontDataUrl !== null) return cachedStandardFontDataUrl;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("pdfjs-dist/package.json");
    const fontsDir = path.join(path.dirname(pkgJson), "standard_fonts");
    const withTrailingSep = fontsDir.endsWith(path.sep) ? fontsDir : `${fontsDir}${path.sep}`;
    // PDF.js's NodeStandardFontDataFactory passes this string to readFile.
    // A file: URL string is not a filesystem path (on Windows or POSIX).
    cachedStandardFontDataUrl = withTrailingSep;
  } catch {
    cachedStandardFontDataUrl = null;
  }
  return cachedStandardFontDataUrl;
}

export async function loadPdfJsForNode(): Promise<PdfJsLike> {
  if (!cachedPdfJs) {
    cachedPdfJs = import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJsLike>;
  }
  return cachedPdfJs;
}

export function buildPdfJsDocumentOptions(data: Uint8Array): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    data,
    disableWorker: true
  };
  const standardFontDataUrl = resolveStandardFontDataUrl();
  if (standardFontDataUrl) {
    // Required for some PDFs that reference standard fonts in Node runtime.
    opts.standardFontDataUrl = standardFontDataUrl;
  }
  return opts;
}
