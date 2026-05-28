import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectInlineImagesFromToolResults } from "../src/attachments/inline_images.js";

function writeTinyPng(filePath: string): void {
  // 1x1 transparent PNG
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6nS7sAAAAASUVORK5CYII=";
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

test("collectInlineImagesFromToolResults inlines allowed local_path images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-inline-images-"));
  const imgPath = path.join(dir, "img.png");
  writeTinyPng(imgPath);

  const toolResults: any[] = [
    {
      action_id: "a1",
      method: "POST",
      path: "/revit/capture-sheet-region",
      status: "done",
      attachments: [{ kind: "image", local_path: imgPath }]
    }
  ];

  const images = collectInlineImagesFromToolResults(toolResults as any, { maxImages: 3, maxBytes: 5 * 1024 * 1024 });
  assert.equal(images.length, 1);
  assert.ok(images[0]!.startsWith("data:image/png;base64,"));

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("collectInlineImagesFromToolResults refuses images outside allowlisted roots", () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "inline-images-test-"));
  const imgPath = path.join(dir, "img.png");
  writeTinyPng(imgPath);

  const toolResults: any[] = [
    {
      action_id: "a1",
      method: "POST",
      path: "/revit/capture-sheet-region",
      status: "done",
      attachments: [{ kind: "image", local_path: imgPath }]
    }
  ];

  const images = collectInlineImagesFromToolResults(toolResults as any, { maxImages: 3, maxBytes: 5 * 1024 * 1024 });
  assert.equal(images.length, 0);

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

