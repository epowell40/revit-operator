import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectInlineImagesFromToolResults, readLocalImageAsDataUrl } from "../src/attachments/inline_images.js";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6nS7sAAAAASUVORK5CYII=";

function writeTinyPng(filePath: string): void {
  // 1x1 transparent PNG
  fs.writeFileSync(filePath, Buffer.from(tinyPngBase64, "base64"));
}

test("collectInlineImagesFromToolResults inlines allowed local_path images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-inline-images-"));
  const workspace = path.join(dir, "workspace");
  const priorRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  fs.mkdirSync(workspace);
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  const imgPath = path.join(workspace, "img.png");
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

  try {
    const images = collectInlineImagesFromToolResults(toolResults as any, { maxImages: 3, maxBytes: 5 * 1024 * 1024 });
    assert.equal(images.length, 1);
    assert.ok(images[0]!.startsWith("data:image/png;base64,"));
  } finally {
    if (priorRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local image transport allows only configured and exact native workspace roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-inline-root-policy-"));
  const configuredWorkspace = path.join(root, "configured-workspace");
  const fakeLocalAppData = path.join(root, "local-app-data");
  const nativeWorkspace = path.join(fakeLocalAppData, "RevitOperator", "Workspace");
  const revitOperatorSibling = path.join(fakeLocalAppData, "RevitOperator", "config");
  const arbitraryTempImage = path.join(root, "arbitrary-temp.png");
  const configuredImage = path.join(configuredWorkspace, "configured.png");
  const nativeImage = path.join(nativeWorkspace, "native.png");
  const siblingImage = path.join(revitOperatorSibling, "sibling.png");
  const priorRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const priorLocalAppData = process.env.LOCALAPPDATA;
  fs.mkdirSync(configuredWorkspace, { recursive: true });
  fs.mkdirSync(nativeWorkspace, { recursive: true });
  fs.mkdirSync(revitOperatorSibling, { recursive: true });
  for (const filePath of [arbitraryTempImage, configuredImage, nativeImage, siblingImage]) writeTinyPng(filePath);
  process.env.OPERATOR_WORKSPACE_ROOT = configuredWorkspace;
  process.env.LOCALAPPDATA = fakeLocalAppData;
  try {
    assert.notEqual(readLocalImageAsDataUrl(configuredImage, 5 * 1024 * 1024), null);
    assert.notEqual(readLocalImageAsDataUrl(nativeImage, 5 * 1024 * 1024), null);
    assert.equal(readLocalImageAsDataUrl(arbitraryTempImage, 5 * 1024 * 1024), null);
    assert.equal(readLocalImageAsDataUrl(siblingImage, 5 * 1024 * 1024), null);
  } finally {
    if (priorRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = priorRoot;
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
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

test("collectInlineImagesFromToolResults validates inline size, base64, MIME, and signature", () => {
  const result = (mime: string, data_base64: string): any => ({
    action_id: "inline",
    method: "POST",
    path: "/revit/export-visible-elements",
    status: "done",
    attachments: [{ kind: "image", mime, data_base64 }]
  });
  assert.equal(collectInlineImagesFromToolResults([result("image/png", tinyPngBase64)] as any).length, 1);
  assert.equal(collectInlineImagesFromToolResults([result("image/gif", tinyPngBase64)] as any).length, 0);
  assert.equal(collectInlineImagesFromToolResults([result("image/jpeg", tinyPngBase64)] as any).length, 0);
  assert.equal(collectInlineImagesFromToolResults([result("image/png", "%%%not-base64%%%")] as any).length, 0);
  assert.equal(collectInlineImagesFromToolResults([result("image/png", tinyPngBase64)] as any, { maxBytes: 8 }).length, 0);
});

test("collectInlineImagesFromToolResults keeps the newest distinct observations at the cap", () => {
  const png = Buffer.from(tinyPngBase64, "base64");
  const imageResult = (id: string, suffix: string): any => ({
    action_id: id,
    method: "POST",
    path: "/revit/export-visible-elements",
    status: "done",
    attachments: [{ kind: "image", mime: "image/png", data_base64: Buffer.concat([png, Buffer.from(suffix)]).toString("base64") }]
  });
  const oldResult = imageResult("old", "old");
  const middleResult = imageResult("middle", "middle");
  const newestResult = imageResult("newest", "newest");
  const images = collectInlineImagesFromToolResults([oldResult, middleResult, newestResult] as any, { maxImages: 2 });
  assert.deepEqual(images, [
    `data:image/png;base64,${newestResult.attachments[0].data_base64}`,
    `data:image/png;base64,${middleResult.attachments[0].data_base64}`
  ]);
});

test("collectInlineImagesFromToolResults rejects symlink escapes and disguised local images", () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), "inline-images-security-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const priorRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const outsideImage = path.join(outside, "outside.png");
  writeTinyPng(outsideImage);
  const link = path.join(workspace, "outside-link");
  fs.symlinkSync(outside, link, "junction");
  const disguised = path.join(workspace, "disguised.png");
  fs.writeFileSync(disguised, Buffer.from([0x42, 0x4d, 0, 0, 0, 0]));
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  try {
    const result = (local_path: string): any => ({ action_id: "local", method: "POST", path: "/revit/export-visible-elements", status: "done", attachments: [{ kind: "image", local_path }] });
    assert.equal(collectInlineImagesFromToolResults([result(path.join(link, "outside.png"))] as any).length, 0);
    assert.equal(collectInlineImagesFromToolResults([result(disguised)] as any).length, 0);
    const raceDir = path.join(workspace, "race");
    const raceBackup = path.join(workspace, "race-original");
    const raceImage = path.join(raceDir, "outside.png");
    fs.mkdirSync(raceDir);
    writeTinyPng(raceImage);
    const raced = readLocalImageAsDataUrl(raceImage, 5 * 1024 * 1024, {
      afterResolve: () => {
        fs.renameSync(raceDir, raceBackup);
        fs.symlinkSync(outside, raceDir, "junction");
      },
      afterOpen: () => {
        fs.rmSync(raceDir);
        fs.renameSync(raceBackup, raceDir);
      }
    });
    assert.equal(raced, null);
  } finally {
    if (priorRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
