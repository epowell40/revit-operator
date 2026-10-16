import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorkspaceLayout } from "../src/workspace.js";
import { getAttachmentExcerptsForPrompt } from "../src/attachments/extract.js";
import type { UserAttachment } from "../src/contracts.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";

test("DWG context gives a registered binary source without inventing units or geometry", async () => {
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_cad_excerpt_"));
  const rec = storeAttachmentUpload({ filename: "layers.dwg", data_base64: Buffer.from("AC1027\u0000unparsed private binary").toString("base64") });
  const [result] = await getAttachmentExcerptsForPrompt([rec]);
  assert.equal(result?.sha256, rec.sha256);
  assert.equal(result?.mime, "application/acad");
  assert.equal(result?.excerpts.length, 1);
  const info = JSON.parse(result!.excerpts[0]!.text);
  assert.equal(info.source_path, rec.relative_path);
  assert.equal(info.signature, "AC1027");
  assert.equal(info.geometry_extracted, false);
  assert.equal(info.units_known, false);
  assert.equal(info.text_height_known, false);
  assert.doesNotMatch(result!.excerpts[0]!.text, /unparsed private binary/);
});

test("Changed CAD bytes and unknown headers do not produce usable extracted reference claims", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_cad_changed_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const rec = storeAttachmentUpload({ filename: "layers.dwg", data_base64: Buffer.from("AC1027fixture").toString("base64") });
  fs.writeFileSync(path.join(root, rec.relative_path), "AC1032changed");
  const [changed] = await getAttachmentExcerptsForPrompt([rec]);
  assert.equal(changed?.excerpts.length, 0);
  assert.match(changed?.warning ?? "", /changed since upload/);
  const invalid = storeAttachmentUpload({ filename: "invalid.dwg", data_base64: Buffer.from("not DWG").toString("base64") });
  const [unknown] = await getAttachmentExcerptsForPrompt([invalid]);
  assert.equal(unknown?.excerpts.length, 0);
  assert.match(unknown?.warning ?? "", /Unrecognized DWG/);
});

test("xlsx attachments produce excerpts with anchors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-workspace-"));
  process.env.OPERATOR_WORKSPACE_ROOT = tmp;
  const layout = ensureWorkspaceLayout();

  const uploadsDir = path.join(layout.artifacts, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const full = path.join(uploadsDir, "vent.xlsx");
  const xMod: any = await import("xlsx");
  const xlsx: any = xMod?.default ?? xMod;
  xlsx.set_fs?.(fs);
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
