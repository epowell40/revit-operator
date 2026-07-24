import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  extractPlanTracesFromPixels,
  sha256PlanTracePixelBuffer
} from "../src/existing_conditions/plan_trace_extraction.js";

function fixture() {
  const canvas = createCanvas(160, 80);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#000000";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(15, 20);
  context.lineTo(70, 20);
  context.moveTo(90, 60);
  context.lineTo(145, 60);
  context.stroke();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = { width: canvas.width, height: canvas.height, data: image.data };
  return {
    pixels,
    input: {
      schema_version: 1 as const,
      source_image_sha256: "a".repeat(64),
      source_pixel_sha256: sha256PlanTracePixelBuffer(pixels),
      monochrome_ink: { maximum_luminance: 180, maximum_chroma: 20 },
      minimum_component_pixels: 10,
      simplify_tolerance_px: 1
    }
  };
}

test("host-trusted seed retains only the connected monochrome trace component", () => {
  const { pixels, input } = fixture();
  const unscoped = extractPlanTracesFromPixels(pixels, input);
  assert.equal(unscoped.components.length, 2);
  const scoped = extractPlanTracesFromPixels(pixels, {
    ...input,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_px: [{ x: 40, y: 20 }],
      seed_basis: "host_trusted_route_seed",
      seed_evidence_sha256: "b".repeat(64),
      seed_radius_px: 4
    }
  });
  assert.equal(scoped.components.length, 1);
  assert.equal(scoped.all_retained_component_count, 2);
  assert.equal(scoped.network_scope?.selected_component_count, 1);
  assert.equal(scoped.network_scope?.excluded_component_count, 1);
  assert.ok(scoped.components[0]!.bounds_px.max.y < 30);
  assert.match(scoped.usage_constraints.join(" "), /host-trusted, SHA-256-bound source seeds/i);
});

test("network-scoped trace extraction rejects unbound and out-of-scope seeds", () => {
  const { pixels, input } = fixture();
  assert.throws(() => extractPlanTracesFromPixels(pixels, {
    ...input,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_px: [{ x: 40, y: 20 }],
      seed_basis: "host_trusted_source_mark",
      seed_evidence_sha256: "not-a-hash"
    }
  }), /seed_evidence_sha256_must_be_sha256/);
  assert.throws(() => extractPlanTracesFromPixels(pixels, {
    ...input,
    scope_polygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 40 }, { x: 0, y: 40 }],
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_px: [{ x: 120, y: 60 }],
      seed_basis: "host_trusted_source_mark",
      seed_evidence_sha256: "c".repeat(64)
    }
  }), /seed_outside_scope_polygon/);
  assert.throws(() => extractPlanTracesFromPixels(pixels, {
    ...input,
    network_scope: {
      mode: "seeded_connected_components",
      seed_points_px: [{ x: 80, y: 40 }],
      seed_basis: "host_trusted_route_seed",
      seed_evidence_sha256: "d".repeat(64),
      seed_radius_px: 2
    }
  }), /seed_reaches_no_component/);
});
