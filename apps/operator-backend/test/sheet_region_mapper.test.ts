import test from "node:test";
import assert from "node:assert/strict";
import { mapSheetRegions } from "../src/redline/sheet_region_mapper.js";

test("sheet region mapper: maps region to viewport with normalized view hint", () => {
  const r = mapSheetRegions({
    image_width: 1000,
    image_height: 500,
    boxes: [{ x: 120, y: 60, w: 260, h: 180 }],
    sheet_outline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
    viewport_geometry: [
      {
        viewportId: 2001,
        viewId: 3001,
        rotation: "None",
        box: { minU: 1, minV: 1, maxU: 5, maxV: 4 }
      }
    ],
    title_blocks: [{ elementId: 9001, boundingBox: { minU: 0, minV: 0, maxU: 2, maxV: 1 } }]
  });

  assert.equal(r.ok, true);
  assert.equal(r.summary.region_count, 1);
  assert.equal(r.summary.viewport_regions, 1);
  const region = r.regions[0];
  assert.ok(region);
  assert.equal(region.primary_target.kind, "viewport");
  assert.equal(region.primary_target.view_id, 3001);
  assert.ok(region.primary_target.view_hint);
  assert.ok((region.primary_target.view_hint?.normalized_x ?? -1) >= 0);
  assert.ok((region.primary_target.view_hint?.normalized_x ?? 2) <= 1);
  assert.ok((region.primary_target.view_hint?.normalized_y ?? -1) >= 0);
  assert.ok((region.primary_target.view_hint?.normalized_y ?? 2) <= 1);
});

test("sheet region mapper: detects titleblock region when viewport miss", () => {
  const r = mapSheetRegions({
    image_width: 1200,
    image_height: 800,
    boxes: [{ x: 900, y: 650, w: 240, h: 120 }],
    sheet_outline: { minU: 0, minV: 0, maxU: 12, maxV: 8 },
    viewport_geometry: [
      {
        viewportId: 1,
        viewId: 11,
        rotation: "None",
        box: { minU: 1, minV: 2, maxU: 9, maxV: 7 }
      }
    ],
    title_blocks: [{ elementId: 77, boundingBox: { minU: 8.5, minV: 0, maxU: 12, maxV: 1.8 } }]
  });

  assert.equal(r.ok, true);
  assert.equal(r.summary.region_count, 1);
  assert.equal(r.summary.titleblock_regions, 1);
  assert.equal(r.regions[0]?.primary_target.kind, "titleblock");
  assert.equal(r.regions[0]?.primary_target.id, 77);
});

