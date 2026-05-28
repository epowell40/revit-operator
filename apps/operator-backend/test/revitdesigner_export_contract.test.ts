import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRasterAffineFrame,
  projectModelPointToImage,
  summarizeRoomDxTrend,
  type AffineFrame,
  type RoomResidualSummary
} from "../src/verification/revitdesigner_export_contract.js";

const snowdonL4RawFrame: AffineFrame = {
  widthPx: 2200,
  heightPx: 1223,
  topLeftXyz: [-115.33193516109374, 71.48585540021631, -467.8833333333333],
  topRightXyz: [88.8521438567533, 71.48585540021631, -467.8833333333333],
  bottomLeftXyz: [-115.33193516109374, -47.01832591228737, -467.8833333333333]
};

test("Snowdon L4 raw crop-box frame is corrected to the exported raster aspect", () => {
  const analysis = analyzeRasterAffineFrame(snowdonL4RawFrame);

  assert.equal(analysis.aspectCorrectionApplied, true);
  assert.equal(analysis.aspectCorrectionAxis, "x");
  assert.ok(analysis.aspectMismatch < 1e-12);
  assert.ok(analysis.rasterAspect - analysis.cropAspect > 0.04);
  assert.ok(analysis.correctedFrame.topLeftXyz[0] < snowdonL4RawFrame.topLeftXyz[0]);
  assert.ok(analysis.correctedFrame.topRightXyz[0] > snowdonL4RawFrame.topRightXyz[0]);

  const correctedProjection = projectModelPointToImage(
    [-37.447916666666714, -5.745138178349237, 42.32152230971508],
    analysis.correctedFrame
  );
  assert.ok(correctedProjection);
  assert.equal(correctedProjection?.insideFrame, true);
  assert.ok((correctedProjection?.x ?? 0) > 849);
  assert.ok((correctedProjection?.x ?? 0) < 851);
  assert.ok((correctedProjection?.y ?? 0) > 796);
  assert.ok((correctedProjection?.y ?? 0) < 797);
});

test("Snowdon M104 room residuals do not show systematic X drift across rooms 403-407", () => {
  const roomResiduals: RoomResidualSummary[] = [
    { roomNumber: "403", medianDxPx: -0.06515637685515685, medianDyPx: -0.021923137433532247, medianAbsDistancePx: 5.5699363772277115 },
    { roomNumber: "404", medianDxPx: -0.3776873777411538, medianDyPx: -0.025207104082937803, medianAbsDistancePx: 6.1871297051346055 },
    { roomNumber: "405", medianDxPx: null, medianDyPx: null, medianAbsDistancePx: null },
    { roomNumber: "406", medianDxPx: 0.025166986956037363, medianDyPx: -3.443148183469475, medianAbsDistancePx: 6.646581091534944 },
    { roomNumber: "407", medianDxPx: -0.19246212165080578, medianDyPx: -0.2927323486273963, medianAbsDistancePx: 2.6367655655632003 }
  ];

  const summary = summarizeRoomDxTrend(roomResiduals);
  assert.equal(summary.count, 4);
  assert.ok(summary.maxAbsMedianDxPx < 0.4);
  assert.ok(Math.abs(summary.slopePxPerRoom) < 0.1);
});
