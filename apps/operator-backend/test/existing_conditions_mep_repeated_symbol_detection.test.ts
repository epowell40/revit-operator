import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  detectRepeatedMepSymbols,
  type MepRepeatedSymbolDetectionInputV1
} from "../src/existing_conditions/mep_repeated_symbol_detection.js";

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function drawDevice(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, side: "left" | "right"): void {
  context.strokeStyle = "black";
  context.fillStyle = "black";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(x, y, 9, 0, Math.PI * 2);
  context.stroke();
  const direction = side === "left" ? -1 : 1;
  for (const offset of [-5, 0, 5]) {
    context.beginPath();
    context.moveTo(x + direction * 8, y + offset);
    context.lineTo(x + direction * 19, y + offset);
    context.stroke();
  }
}

function fixture(): { imagePath: string; input: MepRepeatedSymbolDetectionInputV1 } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mep-symbol-detection-"));
  const imagePath = path.join(directory, "symbols.png");
  const canvas = createCanvas(300, 160);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawDevice(context, 40, 42, "left");
  drawDevice(context, 110, 42, "left");
  drawDevice(context, 180, 42, "left");
  drawDevice(context, 250, 42, "right");
  context.font = "18px Arial";
  context.fillStyle = "black";
  context.fillText("23CA", 52, 70);
  context.fillText("43N1", 122, 70);
  context.fillText("19CB", 192, 70);
  context.fillText("STACKED LABELS ONLY", 30, 125);
  fs.writeFileSync(imagePath, canvas.toBuffer("image/png"));
  return {
    imagePath,
    input: {
      schema_version: 1,
      source_image_path: imagePath,
      source_image_sha256: sha256(imagePath),
      source_image_width_px: canvas.width,
      source_image_height_px: canvas.height,
      search_region: { min: { x: 0, y: 0 }, max: { x: 300, y: 100 } },
      ink_grayscale_threshold: 96,
      maximum_candidates: 20,
      templates: [{
        template_id: "left-wall-device",
        role_hint: "electrical_device",
        pixel_bounds: { min: { x: 20, y: 27 }, max: { x: 54, y: 57 } },
        anchor_point: { x: 40, y: 42 },
        variants: ["identity", "flip_x"],
        minimum_score: 0.98,
        minimum_foreground_recall: 0.98,
        minimum_center_separation_px: 24
      }]
    }
  };
}

test("repeated MEP symbol detection finds individual symbols without promoting adjacent labels", async () => {
  const { input } = fixture();
  const first = await detectRepeatedMepSymbols(input);
  const second = await detectRepeatedMepSymbols(input);
  assert.equal(first.schema, "operator.mep_repeated_symbol_detection.v1");
  assert.equal(first.candidates.length, 4);
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.candidates.map((candidate) => candidate.variant), ["identity", "identity", "identity", "flip_x"]);
  assert.deepEqual(first.candidates.map((candidate) => candidate.anchor), [
    { x: 40, y: 42 },
    { x: 110, y: 42 },
    { x: 180, y: 42 },
    { x: 250, y: 42 }
  ]);
  assert.ok(first.candidates.every((candidate) => candidate.role_hint === "electrical_device"));
  assert.ok(first.candidates.every((candidate) => candidate.native_write_allowed === false));
  assert.ok(first.candidates.every((candidate) => candidate.center.y < 60));
  assert.match(first.capability_boundary, /not native family\/type, circuit, host, or connectivity authority/i);
});

test("same-role detections from duplicate templates are globally deduplicated", async () => {
  const { input } = fixture();
  input.templates.push({ ...structuredClone(input.templates[0]!), template_id: "duplicate-left-wall-device" });
  const receipt = await detectRepeatedMepSymbols(input);
  assert.equal(receipt.templates.length, 2);
  assert.equal(receipt.candidates.length, 4);
  assert.equal(new Set(receipt.candidates.map((candidate) => `${candidate.anchor.x},${candidate.anchor.y}`)).size, 4);
});

test("repeated MEP symbol detection fails closed on hash and dimensions", async () => {
  const { input } = fixture();
  await assert.rejects(
    detectRepeatedMepSymbols({ ...input, source_image_sha256: "0".repeat(64) }),
    /source_image_hash_mismatch/
  );
  await assert.rejects(
    detectRepeatedMepSymbols({ ...input, source_image_width_px: 301 }),
    /source_image_dimensions_mismatch/
  );
  await assert.rejects(
    detectRepeatedMepSymbols({
      ...input,
      source_image_width_px: 2000,
      source_image_height_px: 2000,
      search_region: { min: { x: 0, y: 0 }, max: { x: 2000, y: 2000 } }
    }),
    /source_image_dimensions_mismatch/
  );
  await assert.rejects(
    detectRepeatedMepSymbols({
      ...input,
      source_image_width_px: 20000,
      source_image_height_px: 20000,
      search_region: { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } }
    }),
    /source_image_exceeds_50000000_pixels/
  );
  const malformedVariants = structuredClone(input) as Record<string, any>;
  malformedVariants.templates[0].variants = "identity";
  await assert.rejects(
    detectRepeatedMepSymbols(malformedVariants as unknown as MepRepeatedSymbolDetectionInputV1),
    /template_variants_must_have_1_through_4_entries/
  );
  const nullTemplate = structuredClone(input) as Record<string, any>;
  nullTemplate.templates = [null];
  await assert.rejects(
    detectRepeatedMepSymbols(nullTemplate as unknown as MepRepeatedSymbolDetectionInputV1),
    /template_0_must_be_object/
  );
  const unsafeTemplateId = structuredClone(input);
  unsafeTemplateId.templates[0]!.template_id = "C:\\private\\source.png";
  await assert.rejects(
    detectRepeatedMepSymbols(unsafeTemplateId),
    /id_must_be_safe_identifier/
  );
});

test("repeated MEP symbol detection enforces one aggregate request work budget", async () => {
  const { input } = fixture();
  input.templates = Array.from({ length: 24 }, (_, index) => ({
    ...structuredClone(input.templates[0]!),
    template_id: `device-${index}`,
    variants: ["identity", "flip_x", "flip_y", "rotate_180"] as const
  }));
  await assert.rejects(
    detectRepeatedMepSymbols(input),
    /request_work_budget_exceeded/
  );
});

test("a larger matching context disambiguates repeated core geometry without enlarging symbol bounds", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mep-symbol-context-"));
  const imagePath = path.join(directory, "context-symbols.png");
  const canvas = createCanvas(300, 140);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const x of [40, 110, 180, 250]) drawDevice(context, x, 60, "left");
  context.fillStyle = "black";
  for (const x of [40, 110, 180]) context.fillRect(x - 4, 25, 8, 8);
  fs.writeFileSync(imagePath, canvas.toBuffer("image/png"));
  const receipt = await detectRepeatedMepSymbols({
    schema_version: 1,
    source_image_path: imagePath,
    source_image_sha256: sha256(imagePath),
    source_image_width_px: canvas.width,
    source_image_height_px: canvas.height,
    search_region: { min: { x: 0, y: 10 }, max: { x: 300, y: 100 } },
    ink_grayscale_threshold: 96,
    templates: [{
      template_id: "wall-device-with-square-context",
      role_hint: "electrical_device",
      pixel_bounds: { min: { x: 20, y: 45 }, max: { x: 54, y: 75 } },
      context_bounds: { min: { x: 15, y: 20 }, max: { x: 58, y: 80 } },
      anchor_point: { x: 40, y: 60 },
      minimum_score: 0.99,
      minimum_foreground_recall: 0.98,
      minimum_center_separation_px: 30
    }]
  });
  assert.equal(receipt.candidates.length, 3);
  assert.deepEqual(receipt.candidates.map((candidate) => candidate.anchor.x), [40, 110, 180]);
  assert.ok(receipt.candidates.every((candidate) => candidate.pixel_bounds.max.x - candidate.pixel_bounds.min.x === 34));
  assert.equal(receipt.templates[0]!.context_bounds.max.y - receipt.templates[0]!.context_bounds.min.y, 60);
});

test("repeated MEP symbol detection rejects text-only and empty template crops", async () => {
  const { input } = fixture();
  const textOnly = structuredClone(input);
  textOnly.templates[0]!.pixel_bounds = { min: { x: 30, y: 108 }, max: { x: 220, y: 130 } };
  delete textOnly.templates[0]!.anchor_point;
  textOnly.templates[0]!.minimum_score = 1;
  const textReceipt = await detectRepeatedMepSymbols(textOnly);
  assert.ok(textReceipt.templates[0]!.warnings.some((warning) => /ink-dense|tighten/i.test(warning)) || textReceipt.candidates.length <= 1);

  const empty = structuredClone(input);
  empty.templates[0]!.pixel_bounds = { min: { x: 270, y: 100 }, max: { x: 295, y: 140 } };
  delete empty.templates[0]!.anchor_point;
  await assert.rejects(detectRepeatedMepSymbols(empty), /too_few_ink_pixels/);
});
