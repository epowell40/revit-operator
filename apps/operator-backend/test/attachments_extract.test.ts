import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorkspaceLayout } from "../src/workspace.js";
import { getAttachmentExcerptsForPrompt } from "../src/attachments/extract.js";
import type { UserAttachment } from "../src/contracts.js";

test("xlsx attachments produce excerpts with anchors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-workspace-"));
  process.env.OPERATOR_WORKSPACE_ROOT = tmp;
  const layout = ensureWorkspaceLayout();

  const uploadsDir = path.join(layout.artifacts, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const full = path.join(uploadsDir, "vent.xlsx");
  const xMod: any = await import("xlsx");
  const xlsx: any = xMod?.default ?? xMod;
  const ws = xlsx.utils.aoa_to_sheet([
    ["Ventilation Table", "", ""],
    ["Room", "CFM", "Notes"],
    ["101", "120", "OK"]
  ]);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Vent");
  xlsx.writeFile(wb, full);

  const attachments: UserAttachment[] = [
    { id: "a1", relative_path: "artifacts/uploads/vent.xlsx", filename: "vent.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  ];

  const excerpts = await getAttachmentExcerptsForPrompt(attachments);
  assert.equal(excerpts.length, 1);
  assert.equal(excerpts[0]!.id, "a1");
  assert.ok(excerpts[0]!.excerpts.length >= 1);
  assert.match(excerpts[0]!.excerpts[0]!.anchor, /Excel Sheet=Vent/i);
  assert.match(excerpts[0]!.excerpts[0]!.text, /Ventilation Table/i);
  assert.match(excerpts[0]!.excerpts[0]!.text, /Room/i);
});
