import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import {
  mergePdfsUnderWorkspaceArtifacts,
  renameFileUnderWorkspaceArtifacts,
  reorderPdfUnderWorkspaceArtifacts,
  resolvePathUnderWorkspaceArtifacts,
} from "./workspaceFiles.js";

function makeTempWorkspaceRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-workspace-"));
  process.env.OPERATOR_WORKSPACE_ROOT = tmp;
  fs.mkdirSync(path.join(tmp, "artifacts", "prints"), { recursive: true });
  return tmp;
}

async function writePdfWithPageWidths(outPath: string, widths: number[]): Promise<void> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 100]);
  const bytes = await doc.save();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
}

async function readPageWidths(pdfPath: string): Promise<number[]> {
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getSize().width);
}

test("resolvePathUnderWorkspaceArtifacts rejects non-artifacts paths", () => {
  makeTempWorkspaceRoot();
  assert.throws(() => resolvePathUnderWorkspaceArtifacts("prints/a.pdf"));
});

test("renameFileUnderWorkspaceArtifacts moves files and blocks overwrite by default", () => {
  const root = makeTempWorkspaceRoot();
  const from = path.join(root, "artifacts", "prints", "a.txt");
  fs.writeFileSync(from, "hello", "utf8");

  const r1 = renameFileUnderWorkspaceArtifacts({
    from: "artifacts/prints/a.txt",
    to: "artifacts/prints/b.txt",
    overwrite: false,
  });
  assert.equal(r1.overwritten, false);
  assert.equal(fs.existsSync(path.join(root, "artifacts", "prints", "a.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "artifacts", "prints", "b.txt"), "utf8"), "hello");

  fs.writeFileSync(path.join(root, "artifacts", "prints", "c.txt"), "x", "utf8");
  assert.throws(() =>
    renameFileUnderWorkspaceArtifacts({
      from: "artifacts/prints/b.txt",
      to: "artifacts/prints/c.txt",
      overwrite: false,
    })
  );
});

test("reorderPdfUnderWorkspaceArtifacts reorders pages using 1-based permutation", async () => {
  const root = makeTempWorkspaceRoot();
  const input = path.join(root, "artifacts", "prints", "in.pdf");
  const output = path.join(root, "artifacts", "prints", "out.pdf");

  await writePdfWithPageWidths(input, [101, 102, 103, 104, 105]);
  await reorderPdfUnderWorkspaceArtifacts({
    input: "artifacts/prints/in.pdf",
    output: "artifacts/prints/out.pdf",
    pageOrder: [1, 2, 5, 3, 4],
  });

  const widths = await readPageWidths(output);
  assert.deepEqual(widths, [101, 102, 105, 103, 104]);
});

test("mergePdfsUnderWorkspaceArtifacts concatenates PDFs in order", async () => {
  const root = makeTempWorkspaceRoot();
  const a = path.join(root, "artifacts", "prints", "a.pdf");
  const b = path.join(root, "artifacts", "prints", "b.pdf");
  const out = path.join(root, "artifacts", "prints", "merged.pdf");

  await writePdfWithPageWidths(a, [201, 202]);
  await writePdfWithPageWidths(b, [301]);

  const result = await mergePdfsUnderWorkspaceArtifacts({
    inputs: ["artifacts/prints/a.pdf", "artifacts/prints/b.pdf"],
    output: "artifacts/prints/merged.pdf",
  });

  assert.equal(result.totalPages, 3);
  const widths = await readPageWidths(out);
  assert.deepEqual(widths, [201, 202, 301]);
});

