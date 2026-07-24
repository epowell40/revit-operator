import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  associateSheetVectorSymbolsV1,
  type SheetVectorSymbolAssociationInputV1
} from "../src/existing_conditions/sheet_vector_symbol_association.js";

function hash(bytesOrPath: Buffer | string): string {
  const bytes = Buffer.isBuffer(bytesOrPath) ? bytesOrPath : fs.readFileSync(bytesOrPath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeJson(filePath: string, value: unknown): string {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return hash(filePath);
}

function fixture(args?: { labels?: Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }>; candidates?: Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }> }): SheetVectorSymbolAssociationInputV1 {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-vector-symbol-"));
  const sourcePath = path.join(directory, "source.png");
  const canvas = createCanvas(300, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 300, 200);
  context.strokeStyle = "#000";
  context.strokeRect(100, 63, 60, 10);
  fs.writeFileSync(sourcePath, canvas.toBuffer("image/png"));
  const sourceHash = hash(sourcePath);
  const labels = args?.labels ?? [
    { id: "label-near", minX: 120, minY: 50, maxX: 140, maxY: 60 },
    { id: "label-far", minX: 220, minY: 120, maxX: 240, maxY: 130 }
  ];
  const candidates = args?.candidates ?? [
    { id: "candidate-1", minX: 100, minY: 63, maxX: 160, maxY: 73 }
  ];
  const vectorPath = path.join(directory, "vector.json");
  const vectorHash = writeJson(vectorPath, {
    schema: "operator.sheet_vector_text.v1",
    source_pdf_sha256: "1".repeat(64),
    registered_render_sha256: sourceHash,
    page: 1,
    render_width_px: 300,
    render_height_px: 200,
    source_render_verification: { passed: true },
    include_exact_text: ["L43"],
    entries: labels.map(label => ({
      entry_id: label.id,
      text: "L43",
      normalized_text: "l43",
      page: 1,
      pixel_point: { x: (label.minX + label.maxX) / 2, y: (label.minY + label.maxY) / 2 },
      pixel_bounds: { min: { x: label.minX, y: label.minY }, max: { x: label.maxX, y: label.maxY } },
      rotation_degrees: 0,
      evidence_basis: "vector_pdf_text"
    })),
    native_write_allowed: false,
    capability_boundary: "source only"
  });
  const repeatedPath = path.join(directory, "repeated.json");
  const repeatedHash = writeJson(repeatedPath, {
    schema: "operator.mep_repeated_symbol_detection.v1",
    source_image_sha256: sourceHash,
    source_image_width_px: 300,
    source_image_height_px: 200,
    candidates: candidates.map(candidate => ({
      candidate_id: candidate.id,
      template_id: "linear-fixture",
      role_hint: "light_fixture",
      variant: "identity",
      score: 1,
      foreground_recall: 1,
      context_foreground_recall: 1,
      background_specificity: 1,
      pixel_bounds: { min: { x: candidate.minX, y: candidate.minY }, max: { x: candidate.maxX, y: candidate.maxY } },
      center: { x: (candidate.minX + candidate.maxX) / 2, y: (candidate.minY + candidate.maxY) / 2 },
      anchor: { x: (candidate.minX + candidate.maxX) / 2, y: (candidate.minY + candidate.maxY) / 2 },
      native_write_allowed: false
    })),
    capability_boundary: "source only"
  });
  return {
    schema_version: 1,
    source_image_path: sourcePath,
    source_image_sha256: sourceHash,
    source_image_width_px: 300,
    source_image_height_px: 200,
    vector_text_receipt_path: vectorPath,
    vector_text_receipt_sha256: vectorHash,
    repeated_symbol_receipt_path: repeatedPath,
    repeated_symbol_receipt_sha256: repeatedHash,
    required_label_text: "L43",
    allowed_role_hints: ["light_fixture"],
    maximum_label_distance_px: 20,
    minimum_ambiguity_margin_px: 12
  };
}

test("seals one hash-bound vector label to the nearest repeated fixture glyph", async () => {
  const result = await associateSheetVectorSymbolsV1(fixture());
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0]?.label_entry_id, "label-near");
  assert.equal(result.associations[0]?.candidate_id, "candidate-1");
  assert.equal(result.associations[0]?.label_to_candidate_distance_px, 3);
  assert.equal(result.associations[0]?.decision, "sealed_source_association");
  assert.equal(result.associations[0]?.native_write_allowed, false);
  assert.equal(result.native_write_allowed, false);
});

test("rejects a repeated glyph when two matching vector labels are spatially ambiguous", async () => {
  const input = fixture({
    labels: [
      { id: "label-a", minX: 110, minY: 50, maxX: 125, maxY: 60 },
      { id: "label-b", minX: 135, minY: 50, maxX: 150, maxY: 60 }
    ]
  });
  const result = await associateSheetVectorSymbolsV1(input);
  assert.equal(result.associations.length, 0);
  assert.equal(result.rejected_candidates[0]?.reason, "ambiguous_label_association");
});

test("allows only one repeated glyph to claim a matching vector label", async () => {
  const input = fixture({
    labels: [{ id: "label-one", minX: 120, minY: 50, maxX: 140, maxY: 60 }],
    candidates: [
      { id: "candidate-near", minX: 100, minY: 63, maxX: 160, maxY: 73 },
      { id: "candidate-second", minX: 102, minY: 65, maxX: 158, maxY: 75 }
    ]
  });
  const result = await associateSheetVectorSymbolsV1(input);
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0]?.candidate_id, "candidate-near");
  assert.equal(result.rejected_candidates[0]?.reason, "label_already_claimed");
});

test("rejects receipt hashes or source identities that are not exact", async () => {
  const hashMismatch = fixture();
  await assert.rejects(
    associateSheetVectorSymbolsV1({ ...hashMismatch, vector_text_receipt_sha256: "0".repeat(64) }),
    /vector_receipt_hash_mismatch/
  );
  const identityMismatch = fixture();
  const vector = JSON.parse(fs.readFileSync(identityMismatch.vector_text_receipt_path, "utf8"));
  vector.registered_render_sha256 = "2".repeat(64);
  identityMismatch.vector_text_receipt_sha256 = writeJson(identityMismatch.vector_text_receipt_path, vector);
  await assert.rejects(
    associateSheetVectorSymbolsV1(identityMismatch),
    /receipts_do_not_match_source_image/
  );
});
