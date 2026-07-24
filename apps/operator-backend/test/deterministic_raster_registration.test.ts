import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { alignRasterCropDeterministically } from "../src/redline/deterministic_raster_registration.js";
import { applyDeterministicRasterRegistrationToAlignment } from "../src/redline/view_alignment.js";

function sourceDrawing(): Canvas {
  const canvas = createCanvas(320, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#111";
  context.lineWidth = 3;
  context.strokeRect(15, 20, 285, 195);
  context.beginPath();
  context.moveTo(85, 20);
  context.lineTo(85, 150);
  context.lineTo(190, 150);
  context.lineTo(190, 215);
  context.moveTo(15, 82);
  context.lineTo(265, 82);
  context.moveTo(245, 82);
  context.lineTo(245, 215);
  context.stroke();
  context.strokeStyle = "#1874d1";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(40, 112);
  context.lineTo(270, 112);
  context.lineTo(270, 172);
  context.stroke();
  context.fillStyle = "#111";
  context.font = "18px sans-serif";
  context.fillText("1900", 130, 60);
  return canvas;
}

test("deterministic raster registration finds an embedded axis-aligned plan crop", async () => {
  const source = sourceDrawing();
  const target = createCanvas(800, 500);
  const context = target.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, target.width, target.height);
  context.strokeStyle = "#aaa";
  context.lineWidth = 2;
  context.strokeRect(20, 20, 740, 440);
  context.beginPath();
  context.moveTo(520, 20);
  context.lineTo(520, 460);
  context.stroke();
  const expected = { x: 118, y: 176, scale: 0.72 };
  context.drawImage(
    source,
    expected.x,
    expected.y,
    source.width * expected.scale,
    source.height * expected.scale
  );

  const result = await alignRasterCropDeterministically({
    source_image_data_url: source.toDataURL("image/png"),
    target_image_data_url: target.toDataURL("image/png"),
    maximum_working_dimension: 800
  });

  assert.equal(result.matched, true);
  assert.ok(result.crop);
  assert.ok(Math.abs(result.crop.min_u - expected.x / target.width) < 0.025);
  assert.ok(Math.abs(result.crop.min_v - expected.y / target.height) < 0.025);
  assert.ok(
    Math.abs(
      result.crop.max_u -
      (expected.x + source.width * expected.scale) / target.width
    ) < 0.03
  );
  assert.ok(
    Math.abs(
      result.crop.max_v -
      (expected.y + source.height * expected.scale) / target.height
    ) < 0.03
  );
});

test("deterministic raster registration abstains on unrelated sparse geometry", async () => {
  const source = sourceDrawing();
  const target = createCanvas(800, 500);
  const context = target.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, target.width, target.height);
  context.strokeStyle = "#111";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(40, 40);
  context.lineTo(760, 460);
  context.moveTo(760, 40);
  context.lineTo(40, 460);
  context.stroke();

  const result = await alignRasterCropDeterministically({
    source_image_data_url: source.toDataURL("image/png"),
    target_image_data_url: target.toDataURL("image/png"),
    maximum_working_dimension: 800
  });

  assert.equal(result.matched, false);
});

test("accepted deterministic crop reprojects provider semantic controls", () => {
  const alignment = applyDeterministicRasterRegistrationToAlignment(
    {
      ok: true,
      matched: true,
      confidence: 0.91,
      analysis: "Provider identified two exterior controls.",
      crop: { min_u: 0.2, min_v: 0.2, max_u: 0.8, max_v: 0.8 },
      registration_controls: [
        {
          kind: "exterior_corner",
          source_normalized_x: 0.1,
          source_normalized_y: 0.25,
          view_normalized_x: 0.7,
          view_normalized_y: 0.7,
          score: 0.9,
          label: "northwest corner"
        },
        {
          kind: "exterior_wall",
          source_normalized_x: 0.9,
          source_normalized_y: 0.75,
          view_normalized_x: 0.8,
          view_normalized_y: 0.8,
          score: 0.88,
          label: "east wall"
        }
      ],
      source_room_labels: [],
      marks: []
    },
    {
      matched: true,
      confidence: 0.8,
      crop: { min_u: 0.1, min_v: 0.5, max_u: 0.3, max_v: 0.9 },
      scale: 0.45,
      translation_px: { x: 220, y: 400 },
      source_edge_support_ratio: 0.76,
      edge_density_consistency: 0.93,
      column_profile_correlation: 0.25,
      row_profile_correlation: 0.39,
      runner_up_score_margin: 0.02,
      source_edge_sample_count: 4000,
      working_dimensions: {
        source_width_px: 400,
        source_height_px: 300,
        target_width_px: 900,
        target_height_px: 320,
        working_scale: 0.4
      }
    }
  );

  assert.deepEqual(alignment.crop, {
    min_u: 0.1,
    min_v: 0.5,
    max_u: 0.3,
    max_v: 0.9
  });
  assert.equal(alignment.confidence, 0.8);
  assert.ok(Math.abs((alignment.registration_controls[0]?.view_normalized_x ?? 0) - 0.12) < 1e-12);
  assert.ok(Math.abs((alignment.registration_controls[0]?.view_normalized_y ?? 0) - 0.6) < 1e-12);
  assert.ok(Math.abs((alignment.registration_controls[1]?.view_normalized_x ?? 0) - 0.28) < 1e-12);
  assert.ok(Math.abs((alignment.registration_controls[1]?.view_normalized_y ?? 0) - 0.8) < 1e-12);
  assert.match(alignment.analysis, /Deterministic raster registration accepted/);
});
