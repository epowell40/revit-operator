import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  __testOnlyEstimateWallLocalChainagesFromPng,
  __testOnlyBuildRedlineRouteCandidates,
  __testOnlyGroupNearbyRegions,
  __testOnlyIsDeleteLikeAnnotation,
  __testOnlyNormalizePdfRectToUnit,
  analyzeRedlineFile,
  extractSheetCandidatesFromFilename,
  extractSheetCandidatesFromText,
  inferMepIntentFromRedlineText
} from "../src/redline/redline_analyzer.js";

function writeRgbPng(filePath: string, width: number, height: number, paint: (pixels: Uint8Array) => void): void {
  const rowBytes = width * 3;
  const pixels = new Uint8Array(width * height * 3).fill(255);
  paint(pixels);
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    Buffer.from(pixels.buffer, y * rowBytes, rowBytes).copy(raw, y * (rowBytes + 1) + 1);
  }
  const chunks: Buffer[] = [];
  const writeChunk = (type: string, data: Buffer): void => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 4, "ascii");
    const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc >>> 0, 0);
    chunks.push(head, data, tail);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  writeChunk("IHDR", ihdr);
  writeChunk("IDAT", zlib.deflateSync(raw));
  writeChunk("IEND", Buffer.alloc(0));
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]));
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function setPixel(pixels: Uint8Array, width: number, x: number, y: number, rgb: [number, number, number]): void {
  const p = (y * width + x) * 3;
  pixels[p] = rgb[0];
  pixels[p + 1] = rgb[1];
  pixels[p + 2] = rgb[2];
}

function drawRect(pixels: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setPixel(pixels, width, x, y, rgb);
  }
}

test("redline analyzer: extracts sheet candidates from mixed text", () => {
  const text = `
  Please revise Sheet M501 and coordinate with detail on M5.01.
  Also check A1.00 title block issue date.
  `;
  const cands = extractSheetCandidatesFromText({ text, maxCandidates: 10 });
  assert.ok(cands.length >= 2);
  const nums = new Set(cands.map(c => c.sheet_number));
  assert.ok(nums.has("M501") || nums.has("M5.01"));
  assert.ok(nums.has("A1.00"));
});

test("redline analyzer: boosts expected sheet score", () => {
  const text = `
  markups on sheet M601.
  note also references A2.00 for coordination only.
  `;
  const cands = extractSheetCandidatesFromText({ text, expectedSheet: "M601", maxCandidates: 10 });
  assert.ok(cands.length > 0);
  assert.equal(cands[0]?.sheet_number, "M601");
});

test("redline analyzer: ignores pure numeric/date-like tokens", () => {
  const text = `
  Issued 2026-02-28 and revised 03/01/2026.
  Room 101 and detail 3 are noted.
  `;
  const cands = extractSheetCandidatesFromText({ text, maxCandidates: 10 });
  assert.equal(cands.length, 0);
});

test("redline analyzer: extracts strong filename sheet hint", () => {
  const cands = extractSheetCandidatesFromFilename({
    filePath: "artifacts/uploads/20260228191318_M000_Cover_Sheet.pdf",
    maxCandidates: 10
  });
  assert.ok(cands.length > 0);
  assert.equal(cands[0]?.sheet_number, "M000");
  assert.equal(cands[0]?.source, "filename");
  assert.ok((cands[0]?.score ?? 0) >= 60);
});

test("redline analyzer: resolves bare filename from artifacts/uploads fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploads = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploads, { recursive: true });

  const fileName = "20260228193422_M000_Cover_Sheet.txt";
  const full = path.join(uploads, fileName);
  fs.writeFileSync(full, "dummy", "utf8");

  const r = await analyzeRedlineFile({ file_path: "M000_Cover_Sheet.txt" });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "unknown");
  assert.equal(r.file_path.replace(/\\/g, "/"), `artifacts/uploads/${fileName}`);
});

test("redline analyzer: resolves missing timestamp-prefixed upload path by basename fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploads = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploads, { recursive: true });

  const actual = "20260301000440_M000_Cover_Sheet.txt";
  fs.writeFileSync(path.join(uploads, actual), "dummy", "utf8");

  const r = await analyzeRedlineFile({ file_path: "artifacts/uploads/20260228_091734_M000_Cover_Sheet.txt" });
  assert.equal(r.ok, true);
  assert.equal(r.file_path.replace(/\\/g, "/"), `artifacts/uploads/${actual}`);
});

test("redline analyzer: normalizes PDF rect with non-zero page origin", () => {
  const norm = __testOnlyNormalizePdfRectToUnit({
    rect: [750.2133333, 59, 1461.5466667, 993.6666667],
    pageView: [-1512.12, -1080, 1512.12, 1080],
    viewportWidth: 3024.24,
    viewportHeight: 2160
  });
  assert.ok(norm);
  assert.ok((norm?.minX ?? 0) > 0.70);
  assert.ok((norm?.maxX ?? 0) > 0.95);
  assert.ok((norm?.minY ?? 1) < 0.15);
  assert.ok((norm?.maxY ?? 0) < 0.55);
});

test("redline analyzer: identifies delete-like annotation intent", () => {
  assert.equal(__testOnlyIsDeleteLikeAnnotation({ subtype: "StrikeOut", contents: "" }), true);
  assert.equal(__testOnlyIsDeleteLikeAnnotation({ subtype: "Text", contents: "delete this stuff" }), true);
  assert.equal(__testOnlyIsDeleteLikeAnnotation({ subtype: "Text", contents: "coordinate with sheet M201" }), false);
});

test("redline analyzer: extracts deterministic MEP facts from route text", () => {
  const duct = inferMepIntentFromRedlineText({ text: "12x10 SA duct 450 CFM", hasRouteGeometry: true });
  assert.equal(duct.geometryRole, "route_geometry");
  assert.equal(duct.actionability, "actionable");
  assert.equal(duct.kind, "duct");
  assert.equal(duct.sizeText, "12x10");
  assert.equal(duct.airflowCfm, 450);
  assert.equal(duct.systemHint, "supply air");
  assert.deepEqual(duct.blockers, []);
  assert.ok(duct.confidence >= 0.85);

  const pipe = inferMepIntentFromRedlineText({ text: "Route 6-inch domestic cold water pipe to fixture", hasRouteGeometry: true });
  assert.equal(pipe.geometryRole, "route_geometry");
  assert.equal(pipe.actionability, "actionable");
  assert.equal(pipe.kind, "pipe");
  assert.equal(pipe.sizeText, "6\"");
  assert.equal(pipe.systemHint, "domestic cold water");
});

test("redline analyzer: classifies MEP label text without route geometry as callout-only", () => {
  const intent = inferMepIntentFromRedlineText({ text: "12x10 supply duct 450 CFM" });
  assert.equal(intent.geometryRole, "callout_only");
  assert.equal(intent.actionability, "review");
  assert.equal(intent.kind, "duct");
  assert.equal(intent.sizeText, "12x10");
  assert.equal(intent.airflowCfm, 450);
  assert.ok(intent.blockers.includes("route_geometry_not_detected"));
});

test("redline analyzer: groups nearby annotation regions for shared context", () => {
  const groups = __testOnlyGroupNearbyRegions({
    regions: [
      { index: 1, x: 100, y: 150, w: 80, h: 45 },
      { index: 2, x: 220, y: 160, w: 90, h: 50 },
      { index: 3, x: 1600, y: 1200, w: 120, h: 70 }
    ],
    imageWidth: 2400,
    imageHeight: 1800
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.region_indices, [1, 2]);
});

test("redline analyzer: route candidates carry MEP size airflow and system intent", () => {
  const candidates = __testOnlyBuildRedlineRouteCandidates([
    {
      page: 1,
      annotation_index: 1,
      subtype: "PolyLine",
      is_red_like: true,
      box_norm: { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.24 },
      vertices_norm: [{ x: 0.2, y: 0.22 }, { x: 0.6, y: 0.22 }]
    },
    {
      page: 1,
      annotation_index: 2,
      subtype: "FreeText",
      is_red_like: true,
      contents: "12x10 SA duct 450 CFM",
      box_norm: { minX: 0.22, minY: 0.26, maxX: 0.48, maxY: 0.32 }
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.mep_kind_hint, "duct");
  assert.equal(candidates[0]?.size_text, "12x10");
  assert.equal(candidates[0]?.airflow_cfm, 450);
  assert.equal(candidates[0]?.system_hint, "supply air");
  assert.equal(candidates[0]?.geometry_role, "route_geometry");
  assert.equal(candidates[0]?.actionability, "actionable");
});

test("redline analyzer: preserves marked.pdf PolyLine vertices and related FreeText label", async () => {
  const source = "C:\\Users\\User\\Desktop\\marked.pdf";
  if (!fs.existsSync(source)) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-marked-vector-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploads = path.join(root, "artifacts", "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  fs.copyFileSync(source, path.join(uploads, "marked.pdf"));

  const r = await analyzeRedlineFile({
    file_path: "artifacts/uploads/marked.pdf",
    include_pdf_annotations: true,
    max_pages: 1
  });

  assert.equal(r.ok, true);
  const annotations = r.pdf_annotations ?? [];
  const route = annotations.find(a => a.subtype === "PolyLine");
  const label = annotations.find(a => a.subtype === "FreeText");
  assert.ok(route);
  assert.ok(label);
  assert.ok((route?.vertices_pdf?.length ?? 0) > 10);
  assert.ok((route?.vertices_norm?.length ?? 0) > 10);
  assert.match(route?.related_text ?? "", /12x10 supply duct/i);
  assert.deepEqual(route?.related_annotation_indices, [label?.annotation_index]);

  const region = r.mark_regions?.find(x => x.annotation_subtype === "PolyLine");
  assert.ok(region);
  assert.match(region?.annotation_related_text ?? region?.annotation_contents ?? "", /12x10 supply duct/i);
  assert.ok((region?.annotation_vertices_norm?.length ?? 0) > 10);
  assert.ok(region?.annotation_box_norm);
});

test("redline analyzer: wall-local chainage ignores invalid local runs that start after the mark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-wall-local-"));
  try {
    const png = path.join(root, "lower-mark.png");
    writeRgbPng(png, 400, 300, (pixels) => {
      const gray: [number, number, number] = [150, 150, 150];
      const red: [number, number, number] = [230, 20, 20];
      for (let y = 10; y <= 200; y++) setPixel(pixels, 400, 80, y, gray);
      for (let y = 205; y <= 270; y++) setPixel(pixels, 400, 100, y, gray);
      drawRect(pixels, 400, 94, 184, 110, 196, red);
    });

    const [estimate] = __testOnlyEstimateWallLocalChainagesFromPng(png, [
      { x: 94, y: 184, w: 16, h: 12, area: 192 }
    ]) ?? [];
    assert.ok(estimate);
    assert.equal(estimate?.axis, "vertical");
    assert.deepEqual(estimate?.span_px, [10, 200]);
    assert.ok((estimate?.normalized_chainage ?? 0) > 0.9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
