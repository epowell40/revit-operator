import fs from "node:fs";
import path from "node:path";
import {
  analyzeRasterAffineFrame,
  projectModelPointToImage,
  summarizeRoomDxTrend,
  type AffineFrame,
  type RoomResidualSummary
} from "../verification/revitdesigner_export_contract.js";

type ViewFrameRecord = {
  view_id: number;
  width_px: number;
  height_px: number;
  metadata?: {
    mapping?: {
      topLeftXyz?: [number, number, number];
      topRightXyz?: [number, number, number];
      bottomLeftXyz?: [number, number, number];
    };
  };
};

type ViewRecord = {
  view_id?: number;
  metadata?: {
    export_items?: Array<{
      sourceScopedId?: string;
      anchor?: {
        image?: { x?: number; y?: number; normalizedX?: number; normalizedY?: number; insideFrame?: boolean };
        model?: { x?: number; y?: number; z?: number };
      };
      associatedSpatial?: { number?: string | null } | null;
      space?: { number?: string | null } | null;
      room?: { number?: string | null } | null;
      category?: string | null;
    }>;
  };
};

type RoomReviewFile = {
  room_reviews?: Array<{
    room_number?: string;
    residual_summary?: {
      median_dx_px?: number;
      median_dy_px?: number;
      median_abs_distance_px?: number;
    } | null;
  }>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const defaults = {
    datasetRoot: "C:\\Users\\User\\source\\repos\\RevitDesigner\\artifacts\\l4_cluster_dataset",
    bundleRoot: "C:\\Users\\User\\source\\repos\\RevitDesigner\\artifacts\\space403_bundle_live",
    viewId: 1363433
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--dataset-root" && value) defaults.datasetRoot = value;
    if (arg === "--bundle-root" && value) defaults.bundleRoot = value;
    if (arg === "--view-id" && value) defaults.viewId = Number.parseInt(value, 10);
  }

  return defaults;
}

function buildAffineFrame(record: ViewFrameRecord): AffineFrame {
  const mapping = record.metadata?.mapping;
  if (!mapping?.topLeftXyz || !mapping.topRightXyz || !mapping.bottomLeftXyz) {
    throw new Error(`view ${record.view_id} is missing affine mapping corners`);
  }

  return {
    widthPx: record.width_px,
    heightPx: record.height_px,
    topLeftXyz: mapping.topLeftXyz,
    topRightXyz: mapping.topRightXyz,
    bottomLeftXyz: mapping.bottomLeftXyz
  };
}

function summarizeRepresentativeAnchor(viewRecord: ViewRecord, correctedFrame: AffineFrame) {
  const items = viewRecord.metadata?.export_items ?? [];
  const representative = items.find((item) =>
    item.associatedSpatial?.number === "403" &&
    item.anchor?.model &&
    item.anchor?.image &&
    item.category === "Mechanical Equipment"
  ) ?? items.find((item) =>
    (item.associatedSpatial?.number === "403" || item.space?.number === "403" || item.room?.number === "403") &&
    item.anchor?.model &&
    item.anchor?.image
  );

  if (!representative?.anchor?.model || !representative.anchor.image) return null;

  const corrected = projectModelPointToImage(
    [representative.anchor.model.x ?? 0, representative.anchor.model.y ?? 0, representative.anchor.model.z ?? 0],
    correctedFrame
  );
  if (!corrected) return null;

  return {
    sourceScopedId: representative.sourceScopedId ?? null,
    roomNumber: representative.associatedSpatial?.number ?? representative.space?.number ?? representative.room?.number ?? null,
    staleAnchorImage: representative.anchor.image,
    correctedAnchorImage: corrected,
    deltaXPx: corrected.x - (representative.anchor.image.x ?? 0),
    deltaYPx: corrected.y - (representative.anchor.image.y ?? 0)
  };
}

function summarizeRoomResiduals(roomReviews: RoomReviewFile) {
  const residuals: RoomResidualSummary[] = (roomReviews.room_reviews ?? []).map((room) => ({
    roomNumber: room.room_number ?? "",
    medianDxPx: room.residual_summary?.median_dx_px ?? null,
    medianDyPx: room.residual_summary?.median_dy_px ?? null,
    medianAbsDistancePx: room.residual_summary?.median_abs_distance_px ?? null
  }));

  return {
    rooms: residuals,
    dxTrend: summarizeRoomDxTrend(residuals)
  };
}

function main() {
  const { datasetRoot, bundleRoot, viewId } = parseArgs();
  const viewFramesPath = path.join(bundleRoot, "view_frames.json");
  const viewsPath = path.join(bundleRoot, "views.json");
  const roomReviewsPath = path.join(datasetRoot, "reports", "root_cause_check", "m104_room_reviews.json");

  const viewFrames = readJson<ViewFrameRecord[]>(viewFramesPath);
  const viewFrame = viewFrames.find((record) => record.view_id === viewId);
  if (!viewFrame) throw new Error(`view ${viewId} not found in ${viewFramesPath}`);

  const frame = buildAffineFrame(viewFrame);
  const analysis = analyzeRasterAffineFrame(frame);
  const views = readJson<ViewRecord[]>(viewsPath);
  const viewRecord = views.find((record) => record.view_id === viewId);
  const representativeAnchor = viewRecord
    ? summarizeRepresentativeAnchor(viewRecord, analysis.correctedFrame)
    : null;

  const roomReviews = readJson<RoomReviewFile>(roomReviewsPath);
  const residuals = summarizeRoomResiduals(roomReviews);

  const output = {
    datasetRoot,
    bundleRoot,
    viewId,
    rawFrameAspect: analysis.cropAspect,
    rasterAspect: analysis.rasterAspect,
    correctedFrameAspect: analysis.frameAspect,
    rawAspectMismatch: Math.abs(analysis.cropAspect - analysis.rasterAspect),
    rawAspectMismatchRatio: analysis.rasterAspect > 1e-9
      ? Math.abs(analysis.cropAspect - analysis.rasterAspect) / analysis.rasterAspect
      : 0,
    correctedAspectMismatch: analysis.aspectMismatch,
    aspectCorrectionApplied: analysis.aspectCorrectionApplied,
    aspectCorrectionAxis: analysis.aspectCorrectionAxis || null,
    representativeAnchor,
    roomResiduals: residuals.rooms,
    roomDxTrend: residuals.dxTrend
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
