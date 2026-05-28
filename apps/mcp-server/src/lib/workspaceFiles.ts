import fs from "node:fs";
import path from "node:path";
import { getWorkspaceRoot } from "./workspace.js";

function getArtifactsRoot(): string {
  return path.join(getWorkspaceRoot(), "artifacts");
}

function ensureUnderDir(parentDir: string, fullPath: string): string {
  const parent = path.resolve(parentDir).replace(/[\\\/]+$/, "");
  const p = path.resolve(fullPath);
  if (p === parent) return p;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;

  if (process.platform === "win32") {
    if (!p.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new Error(`Path must be under: ${parent}`);
    }
  } else {
    if (!p.startsWith(prefix)) {
      throw new Error(`Path must be under: ${parent}`);
    }
  }
  return p;
}

export function resolvePathUnderWorkspaceArtifacts(userPath: string): string {
  if (!userPath || typeof userPath !== "string") throw new Error("path is required.");

  const workspaceRoot = getWorkspaceRoot();
  const candidate = path.isAbsolute(userPath) ? userPath : path.join(workspaceRoot, userPath);
  const resolved = path.resolve(candidate);
  return ensureUnderDir(getArtifactsRoot(), resolved);
}

export function resolveExistingPathUnderWorkspaceArtifacts(userPath: string): string {
  const full = resolvePathUnderWorkspaceArtifacts(userPath);
  if (!fs.existsSync(full)) throw new Error(`File not found: ${userPath}`);
  return full;
}

function ensurePdfExtension(p: string): void {
  if (!p.toLowerCase().endsWith(".pdf")) throw new Error("Expected a .pdf file path.");
}

export function renameFileUnderWorkspaceArtifacts(args: {
  from: string;
  to: string;
  overwrite: boolean;
}): { from: string; to: string; overwritten: boolean } {
  const fromFull = resolveExistingPathUnderWorkspaceArtifacts(args.from);
  const toFull = resolvePathUnderWorkspaceArtifacts(args.to);

  const fromStat = fs.statSync(fromFull);
  if (!fromStat.isFile()) throw new Error(`Source is not a file: ${args.from}`);

  if (path.resolve(fromFull) === path.resolve(toFull)) {
    return { from: args.from, to: args.to, overwritten: false };
  }

  const exists = fs.existsSync(toFull);
  if (exists && !args.overwrite) {
    throw new Error(`Refusing to overwrite existing file: ${args.to}`);
  }

  try {
    fs.mkdirSync(path.dirname(toFull), { recursive: true });
  } catch {
    // ignore
  }

  if (exists) {
    fs.rmSync(toFull, { force: true });
  }

  fs.renameSync(fromFull, toFull);
  return { from: args.from, to: args.to, overwritten: exists };
}

function validatePermutationOneBased(pageOrder: number[], pageCount: number): void {
  if (!Array.isArray(pageOrder) || pageOrder.length === 0) throw new Error("pageOrder must be a non-empty array.");
  if (pageOrder.length !== pageCount) throw new Error(`pageOrder must have length ${pageCount} (one entry per page).`);

  const seen = new Set<number>();
  for (const n of pageOrder) {
    if (!Number.isInteger(n)) throw new Error("pageOrder must contain integers (1-based).");
    if (n < 1 || n > pageCount) throw new Error(`pageOrder contains out-of-range index ${n}; valid range is 1..${pageCount}.`);
    if (seen.has(n)) throw new Error(`pageOrder contains duplicate index ${n}; it must be a permutation of 1..${pageCount}.`);
    seen.add(n);
  }
}

export async function reorderPdfUnderWorkspaceArtifacts(args: {
  input: string;
  output: string;
  pageOrder: number[];
}): Promise<{ input: string; output: string; pageCount: number }> {
  const { PDFDocument } = await import("pdf-lib");

  const inputFull = resolveExistingPathUnderWorkspaceArtifacts(args.input);
  const outputFull = resolvePathUnderWorkspaceArtifacts(args.output);
  ensurePdfExtension(inputFull);
  ensurePdfExtension(outputFull);

  if (fs.existsSync(outputFull)) throw new Error(`Refusing to overwrite existing file: ${args.output}`);

  const inputBytes = fs.readFileSync(inputFull);
  const inputPdf = await PDFDocument.load(inputBytes);
  const pageCount = inputPdf.getPageCount();

  validatePermutationOneBased(args.pageOrder, pageCount);

  const outPdf = await PDFDocument.create();
  const zeroBased = args.pageOrder.map((n) => n - 1);
  const copied = await outPdf.copyPages(inputPdf, zeroBased);
  for (const p of copied) outPdf.addPage(p);

  try {
    fs.mkdirSync(path.dirname(outputFull), { recursive: true });
  } catch {
    // ignore
  }
  const outBytes = await outPdf.save();
  fs.writeFileSync(outputFull, outBytes);

  return { input: args.input, output: args.output, pageCount };
}

export async function mergePdfsUnderWorkspaceArtifacts(args: {
  inputs: string[];
  output: string;
}): Promise<{ inputs: string[]; output: string; totalPages: number }> {
  const { PDFDocument } = await import("pdf-lib");

  const inputs = (args.inputs || []).map((p) => (p || "").trim()).filter(Boolean);
  if (inputs.length < 2) throw new Error("inputs must include at least two PDF paths.");

  const outputFull = resolvePathUnderWorkspaceArtifacts(args.output);
  ensurePdfExtension(outputFull);
  if (fs.existsSync(outputFull)) throw new Error(`Refusing to overwrite existing file: ${args.output}`);

  const outPdf = await PDFDocument.create();
  let totalPages = 0;

  for (const p of inputs) {
    const full = resolveExistingPathUnderWorkspaceArtifacts(p);
    ensurePdfExtension(full);
    const bytes = fs.readFileSync(full);
    const src = await PDFDocument.load(bytes);
    const indices = src.getPageIndices();
    const pages = await outPdf.copyPages(src, indices);
    for (const page of pages) outPdf.addPage(page);
    totalPages += pages.length;
  }

  try {
    fs.mkdirSync(path.dirname(outputFull), { recursive: true });
  } catch {
    // ignore
  }

  const outBytes = await outPdf.save();
  fs.writeFileSync(outputFull, outBytes);

  return { inputs, output: args.output, totalPages };
}
