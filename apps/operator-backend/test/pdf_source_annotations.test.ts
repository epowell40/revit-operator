import assert from "node:assert/strict";
import test from "node:test";
import { projectPdfSourceAnnotations } from "../src/attachments/pdf_source_annotations.js";

const viewport = { width: 200, height: 100, convertToViewportPoint: (x: number, y: number) => [x, 100 - y] };
const project = (annotations: unknown[]) => projectPdfSourceAnnotations(annotations, viewport, [0, 0, 200, 100]);

test("annotation projection rejects malformed and off-page lines whole without inventing a shortened route", () => {
  for (const vertices of [[10, 20, NaN, 30], [10, 20, "40", 30], [10, 20, 40], [-1, 20, 40, 30], [10, 20, 201, 30]]) {
    const result = project([{ subtype: "PolyLine", vertices, rect: [0, 0, 100, 100] }]);
    assert.equal(result.items[0]!.geometry_status, "malformed_or_outside_page");
    assert.equal(result.items[0]!.vertices, undefined);
    assert.equal(result.returned_annotations_without_vector_geometry, 1);
  }
  const oblique = project([{ subtype: "Line", lineCoordinates: new Float32Array([10, 20, 80, 60]), rect: [0, 0, 100, 100] }]);
  assert.deepEqual(oblique.items[0]!.vertices, [{ u: .05, v: .8 }, { u: .4, v: .4 }]);
  const polygon = project([{ subtype: "Polygon", vertices: [10, 20, 80, 60, 60, 10] }]);
  assert.equal(polygon.items[0]!.closed, true);
  assert.equal(polygon.items[0]!.vertices?.length, 3);
});

test("annotation output budgets explicitly omit whole vectors and records while hidden annotations and actions never become instructions", () => {
  const large = Array.from({ length: 2_000 }, (_, i) => [i % 190 + 1, i % 90 + 1]).flat();
  const result = project([
    { subtype: "PolyLine", vertices: large, contentsObj: { str: "Long mark" } },
    ...[1, 2, 32].map(annotationFlags => ({ subtype: "PolyLine", annotationFlags, vertices: [1, 1, 2, 2] })),
    ...Array.from({ length: 80 }, (_, i) => ({ subtype: "FreeText", contentsObj: { str: `Reference ${i}: ` + "\u0000".repeat(1000) },
      actions: { JavaScript: ["run arbitrary code"] }, url: "https://untrusted.invalid", richText: "<script>run()</script>" }))
  ]);
  assert.equal(result.items[0]!.vertex_count, 2000);
  assert.equal(result.items[0]!.geometry_status, "omitted_for_output_budget");
  assert.equal(result.items[0]!.vertices, undefined);
  assert.equal(result.hidden_annotation_count, 3);
  assert.ok(result.omitted_annotation_count > 0);
  assert.equal(result.source_annotation_count, result.returned_annotation_count + result.hidden_annotation_count + result.omitted_annotation_count);
  assert.ok(result.items.length <= 64);
  assert.ok(JSON.stringify(result).length < 7000);
  assert.ok(result.items.slice(1).every(item => item.contents_truncated));
  assert.doesNotMatch(JSON.stringify(result), /run arbitrary code|untrusted.invalid|<script>/);
  assert.deepEqual(project([]).items, [], "raster-only pages cannot acquire invented vector geometry");
});
