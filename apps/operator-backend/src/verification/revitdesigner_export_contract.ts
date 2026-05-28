export type Point3 = readonly [number, number, number];

export type AffineFrame = {
  topLeftXyz: Point3;
  topRightXyz: Point3;
  bottomLeftXyz: Point3;
  widthPx: number;
  heightPx: number;
};

export type RasterFrameAnalysis = {
  cropAspect: number;
  rasterAspect: number;
  frameAspect: number;
  aspectMismatch: number;
  aspectCorrectionApplied: boolean;
  aspectCorrectionAxis: "x" | "";
  correctedFrame: AffineFrame;
};

export type ProjectedPoint = {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
  insideFrame: boolean;
};

export type RoomResidualSummary = {
  roomNumber: string;
  medianDxPx: number | null;
  medianDyPx: number | null;
  medianAbsDistancePx: number | null;
};

function subtract(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Point3, b: Point3): Point3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Point3, factor: number): Point3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Point3): number {
  return Math.sqrt(dot(a, a));
}

function normalize(a: Point3): Point3 {
  const len = length(a);
  if (!Number.isFinite(len) || len < 1e-9) return [0, 0, 0];
  return scale(a, 1 / len);
}

export function analyzeRasterAffineFrame(frame: AffineFrame): RasterFrameAnalysis {
  const cropXAxis = subtract(frame.topRightXyz, frame.topLeftXyz);
  const cropYAxis = subtract(frame.bottomLeftXyz, frame.topLeftXyz);
  const cropWidth = length(cropXAxis);
  const cropHeight = length(cropYAxis);
  const cropAspect = cropHeight > 1e-9 ? cropWidth / cropHeight : 0;
  const rasterAspect = Math.max(1, frame.widthPx - 1) / Math.max(1, frame.heightPx - 1);

  const result: RasterFrameAnalysis = {
    cropAspect,
    rasterAspect,
    frameAspect: cropAspect,
    aspectMismatch: Math.abs(cropAspect - rasterAspect),
    aspectCorrectionApplied: false,
    aspectCorrectionAxis: "",
    correctedFrame: { ...frame }
  };

  if (!Number.isFinite(cropWidth) || !Number.isFinite(cropHeight) || !Number.isFinite(rasterAspect)) return result;
  if (cropWidth < 1e-9 || cropHeight < 1e-9) return result;

  const correctedWidth = cropHeight * rasterAspect;
  if (!Number.isFinite(correctedWidth) || correctedWidth < 1e-9) return result;

  const deltaWidth = correctedWidth - cropWidth;
  if (Math.abs(deltaWidth) < 1e-9) {
    result.frameAspect = correctedWidth / cropHeight;
    result.aspectMismatch = Math.abs(result.frameAspect - rasterAspect);
    return result;
  }

  const xDirection = normalize(cropXAxis);
  const xOffset = scale(xDirection, deltaWidth * 0.5);
  result.aspectCorrectionApplied = true;
  result.aspectCorrectionAxis = "x";
  result.correctedFrame = {
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    topLeftXyz: subtract(frame.topLeftXyz, xOffset),
    topRightXyz: add(frame.topRightXyz, xOffset),
    bottomLeftXyz: subtract(frame.bottomLeftXyz, xOffset)
  };
  result.frameAspect = correctedWidth / cropHeight;
  result.aspectMismatch = Math.abs(result.frameAspect - rasterAspect);
  return result;
}

export function projectModelPointToImage(point: Point3, frame: AffineFrame): ProjectedPoint | null {
  const xAxis = subtract(frame.topRightXyz, frame.topLeftXyz);
  const yAxis = subtract(frame.bottomLeftXyz, frame.topLeftXyz);
  const xLenSq = dot(xAxis, xAxis);
  const yLenSq = dot(yAxis, yAxis);
  if (xLenSq < 1e-9 || yLenSq < 1e-9) return null;

  const rel = subtract(point, frame.topLeftXyz);
  const normalizedX = dot(rel, xAxis) / xLenSq;
  const normalizedY = dot(rel, yAxis) / yLenSq;
  return {
    normalizedX,
    normalizedY,
    x: normalizedX * Math.max(1, frame.widthPx - 1),
    y: normalizedY * Math.max(1, frame.heightPx - 1),
    insideFrame: normalizedX >= 0 && normalizedX <= 1 && normalizedY >= 0 && normalizedY <= 1
  };
}

export function summarizeRoomDxTrend(roomSummaries: RoomResidualSummary[]) {
  const filtered = roomSummaries
    .map((room) => ({
      roomNumber: Number.parseInt(room.roomNumber, 10),
      dx: room.medianDxPx
    }))
    .filter((room) => Number.isFinite(room.roomNumber) && room.dx !== null && Number.isFinite(room.dx));

  if (filtered.length === 0) {
    return {
      count: 0,
      maxAbsMedianDxPx: 0,
      slopePxPerRoom: 0
    };
  }

  const maxAbsMedianDxPx = Math.max(...filtered.map((room) => Math.abs(room.dx as number)));
  const meanRoom = filtered.reduce((sum, room) => sum + room.roomNumber, 0) / filtered.length;
  const meanDx = filtered.reduce((sum, room) => sum + (room.dx as number), 0) / filtered.length;

  let numerator = 0;
  let denominator = 0;
  for (const room of filtered) {
    const dxRoom = room.roomNumber - meanRoom;
    numerator += dxRoom * ((room.dx as number) - meanDx);
    denominator += dxRoom * dxRoom;
  }

  return {
    count: filtered.length,
    maxAbsMedianDxPx,
    slopePxPerRoom: denominator > 0 ? numerator / denominator : 0
  };
}
