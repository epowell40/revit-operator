import assert from "node:assert/strict";
import test from "node:test";
import { observeRenderedColor } from "../src/attachments/rendered_color_observation.js";

test("gray, colored and transparent pixels remain distinct from semantic verification", () => {
  const gray = observeRenderedColor(new Uint8ClampedArray([0,0,0,255,128,128,128,255,255,255,255,255]),3,1);
  assert.equal(gray.chromatic_pixel_count,0);
  assert.equal(gray.observation,"no_color_detected_at_render_resolution");
  const mixed=observeRenderedColor(new Uint8ClampedArray([255,0,0,255,255,0,0,0,128,130,131,255]),3,1);
  assert.equal(mixed.chromatic_pixel_count,1);
  assert.equal(mixed.maximum_channel_difference,255);
  assert.match(mixed.limitation,/unrendered pages/);
  assert.throws(()=>observeRenderedColor(new Uint8ClampedArray(4),2,1),/exact RGBA/);
});
