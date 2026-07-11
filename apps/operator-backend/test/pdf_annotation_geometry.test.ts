import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPdfAnnotationCoordinateMapper,
  clampPixelBoxToImage,
  extractInkListsPdf,
  extractPdfPointSequence,
  extractPdfVectorPointSequence,
  mapPdfPointsToUnit,
  mapPdfVectorPointsToUnit,
  normalizedRectToPixelBox,
  normalizeInkListsToUnitBoxes,
  normalizePdfMarkupAnnotationToUnitBox,
  normBoxDistance,
  normBoxIntersectionArea,
  tightPdfRectFromPoints,
  testOnlyNormalizePdfRectToUnit,
  unionPdfBoxes
} from "../src/redline/pdf_annotation_geometry.js";

test("PDF geometry normalizes non-zero page origins", () => {
  const normalized = testOnlyNormalizePdfRectToUnit({
    rect: [750.2133333, 59, 1461.5466667, 993.6666667],
    pageView: [-1512.12, -1080, 1512.12, 1080],
    viewportWidth: 3024.24,
    viewportHeight: 2160
  });
  assert.ok(normalized);
  assert.ok((normalized?.minX ?? 0) > 0.70);
  assert.ok((normalized?.maxX ?? 0) > 0.95);
  assert.ok((normalized?.minY ?? 1) < 0.15);
  assert.ok((normalized?.maxY ?? 0) < 0.55);
});

test("PDF geometry prefers the viewport converter when available", () => {
  const mapper = buildPdfAnnotationCoordinateMapper({
    viewport: { width: 200, height: 100, convertToViewportPoint: (x: number, y: number) => [y * 2, x] },
    pageView: [0, 0, 100, 100]
  });
  assert.ok(mapper);
  assert.deepEqual(mapper?.mapPoint(10, 25), { x: 50, y: 10 });
});

test("PDF geometry decodes numeric, typed-array, and object point sequences", () => {
  assert.deepEqual(extractPdfPointSequence([1, 2, 3, 4]), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(extractPdfPointSequence(new Float32Array([5, 6, 7, 8])), [{ x: 5, y: 6 }, { x: 7, y: 8 }]);
  assert.deepEqual(extractPdfPointSequence([{ X: 9, Y: 10 }, { x: 11, y: 12 }]), [{ x: 9, y: 10 }, { x: 11, y: 12 }]);
});

test("PDF geometry preserves individual ink strokes and their normalized bounds", () => {
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport: { width: 1000, height: 1000 }, pageView: [0, 0, 100, 100] });
  assert.ok(mapper);
  const raw = [[10, 10, 30, 40], [60, 20, 90, 50]];
  const strokes = extractInkListsPdf(raw);
  assert.equal(strokes.length, 2);
  const boxes = normalizeInkListsToUnitBoxes(raw, mapper!);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { minX: 0.1, minY: 0.6, maxX: 0.3, maxY: 0.9 });
  assert.deepEqual(unionPdfBoxes(boxes), { minX: 0.1, minY: 0.5, maxX: 0.9, maxY: 0.9 });
});

test("PDF geometry ignores reply-note markers and uses ink before fallback rects", () => {
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport: { width: 100, height: 100 }, pageView: [0, 0, 100, 100] });
  assert.ok(mapper);
  assert.equal(normalizePdfMarkupAnnotationToUnitBox({ annotation: { subtype: "Text", inReplyTo: "parent", rect: [1, 1, 10, 10] }, mapper: mapper! }), null);
  const ink = normalizePdfMarkupAnnotationToUnitBox({
    annotation: { subtype: "Ink", inkLists: [[10, 10, 20, 30]], rect: [0, 0, 100, 100] },
    mapper: mapper!
  });
  assert.deepEqual(ink, { minX: 0.1, minY: 0.7, maxX: 0.2, maxY: 0.9 });
});

test("PDF geometry uses strict vector vertices over corrupted negative-MediaBox rect sentinels", () => {
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport: { width: 3024.24, height: 2160 }, pageView: [-1512.12, -1080, 1512.12, 1080] });
  assert.ok(mapper);
  const vertices = [-700, -520, -410, -55];
  assert.deepEqual(extractPdfVectorPointSequence("PolyLine", vertices), [{ x: -700, y: -520 }, { x: -410, y: -55 }]);
  assert.deepEqual(tightPdfRectFromPoints(extractPdfVectorPointSequence("PolyLine", vertices)), [-700, -520, -410, -55]);
  const box = normalizePdfMarkupAnnotationToUnitBox({ annotation: { subtype: "PolyLine", rect: [-700, -520, Number.MIN_VALUE, Number.MIN_VALUE], vertices }, mapper: mapper! });
  assert.ok(box); assert.ok(Math.abs(box!.minX - 0.2685368886) < 1e-8); assert.ok(Math.abs(box!.maxX - 0.3644287490) < 1e-8); assert.ok(Math.abs(box!.minY - 0.525462963) < 1e-8); assert.ok(Math.abs(box!.maxY - 0.740740741) < 1e-8);
});

test("PDF vector geometry enforces subtype minimums, positive-coordinate bounds, and raw-rect fallback", () => {
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport: { width: 100, height: 100 }, pageView: [0, 0, 100, 100] });
  assert.ok(mapper);
  assert.equal(extractPdfVectorPointSequence("Line", [10, 20]).length, 0);
  assert.deepEqual(extractPdfVectorPointSequence("Line", [10, 20, 30, 40]), [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  assert.equal(extractPdfVectorPointSequence("Polygon", [10, 10, 20, 20]).length, 0);
  assert.deepEqual(mapPdfVectorPointsToUnit(extractPdfVectorPointSequence("Polygon", [10, 10, 30, 30, 20, 50]), mapper!), [{ x: 0.1, y: 0.9 }, { x: 0.3, y: 0.7 }, { x: 0.2, y: 0.5 }]);
  assert.deepEqual(normalizePdfMarkupAnnotationToUnitBox({ annotation: { subtype: "Polygon", rect: [0, 0, 100, 100], vertices: [10, 10, 30, 30, 20, 50] }, mapper: mapper! }), { minX: 0.1, minY: 0.5, maxX: 0.3, maxY: 0.9 });
  assert.deepEqual(normalizePdfMarkupAnnotationToUnitBox({ annotation: { subtype: "PolyLine", rect: [10, 20, 30, 40], vertices: [10, 20, 30] }, mapper: mapper! }), { minX: 0.1, minY: 0.6, maxX: 0.3, maxY: 0.8 });
  assert.equal(extractPdfVectorPointSequence("PolyLine", [10, 20, Number.NaN, 30]).length, 0);
});

test("PDF geometry converts normalized boxes to bounded pixel regions", () => {
  const pixels = normalizedRectToPixelBox({ norm: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 }, imageWidth: 1000, imageHeight: 500, minMarginPx: 10 });
  assert.deepEqual(pixels, { x: 76, y: 76, w: 248, h: 148, area: 36704 });
  assert.deepEqual(clampPixelBoxToImage({ x: -5, y: 90, w: 30, h: 30 }, 100, 100), { x: 0, y: 90, w: 25, h: 10, area: 250 });
});

test("PDF normalized box math reports overlap and center distance", () => {
  const first = { minX: 0, minY: 0, maxX: 0.4, maxY: 0.4 };
  const second = { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 };
  assert.ok(Math.abs(normBoxIntersectionArea(first, second) - 0.04) < 1e-9);
  assert.ok(Math.abs(normBoxDistance(first, second) - Math.hypot(0.2, 0.2)) < 1e-9);
  const mapper = buildPdfAnnotationCoordinateMapper({ viewport: { width: 100, height: 100 }, pageView: [0, 0, 100, 100] });
  assert.deepEqual(mapPdfPointsToUnit([{ x: -50, y: 150 }, { x: 50, y: 50 }], mapper!), [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }]);
});
