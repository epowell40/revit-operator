import * as fs from "fs";
import * as path from "path";
import { callRevit } from "../lib/revitClient.js";
import { applyAutoDimension, planAutoDimension } from "./autoDimension.js";

export type AutoDimOptions = Parameters<typeof planAutoDimension>[1];

export type RunAutoDimFloorPlanArgs = {
  sourceViewName?: string;
  sourceViewId?: number;
  targetViewName?: string;
  overwriteTarget?: boolean;
  imageSize?: number;
  captureImages?: boolean;
  passes?: number;
  options?: AutoDimOptions;
  outputDir?: string;
};

function safeName(s: string) {
  return String(s).replace(/[\\/:*?"<>|]/g, "_");
}

export async function computeExistingWallCoverage(viewId: number) {
  const LIMIT = 100000;
  const walls = (await callRevit("/revit/query", "POST", { category: "OST_Walls", viewId, limit: LIMIT })) as any[];
  const dims = (await callRevit("/revit/analyze-dimensions", "POST", { viewId })) as any[];

  const lineLen = (g: any) => {
    if (!g?.p1 || !g?.p2) return 0;
    const dx = Number(g.p2.x) - Number(g.p1.x);
    const dy = Number(g.p2.y) - Number(g.p1.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const validWalls = (walls || []).filter((w) => w?.geometry);
  const COVER_WALL_MIN_LEN = 4.0;
  const coverWalls = validWalls.filter((w) => lineLen(w.geometry) >= COVER_WALL_MIN_LEN);
  const wallIdSet = new Set<number>(validWalls.map((w) => Number(w.id)).filter(Number.isFinite));
  const coverWallIdSet = new Set<number>(coverWalls.map((w) => Number(w.id)).filter(Number.isFinite));

  const coveredWalls = new Set<number>();
  const coveredCoverWalls = new Set<number>();
  for (const d of dims ?? []) {
    for (const r of d?.references ?? []) {
      const id = Number(r?.elementId);
      if (!Number.isFinite(id)) continue;
      if (wallIdSet.has(id)) coveredWalls.add(id);
      if (coverWallIdSet.has(id)) coveredCoverWalls.add(id);
    }
  }

  return {
    viewId,
    counts: {
      walls: wallIdSet.size,
      coverWalls: coverWallIdSet.size,
      coveredWalls: coveredWalls.size,
      wallCoverage: coveredWalls.size / Math.max(1, wallIdSet.size),
      coveredCoverWalls: coveredCoverWalls.size,
      coverWallCoverage: coveredCoverWalls.size / Math.max(1, coverWallIdSet.size),
      dimensions: Array.isArray(dims) ? dims.length : 0,
    },
  };
}

export async function runAutoDimFloorPlan(args: RunAutoDimFloorPlanArgs) {
  const overwriteTarget = args.overwriteTarget ?? true;
  const captureImages = args.captureImages ?? true;
  const imageSize = Number.isFinite(args.imageSize) ? (args.imageSize as number) : 6000;
  const passes = Math.max(1, Math.min(6, Number.isFinite(args.passes) ? (args.passes as number) : 1));
  const opts: AutoDimOptions = args.options ?? {
    preset: "architect",
    respectExistingDimensions: true,
    globalsMode: "ifEmpty",
    roomMode: "bbox",
    includeCorridors: true,
    corridorSampleCount: 3,
    includeAdjacent: false,
    includeDenseSlices: true,
    includeTileSlices: false,
    includeWallRepair: true,
    enforceRoomConstraints: false,
    roomMaxGroups: 20,
    targetWallCoverage: 0.8,
    maxDimensions: 120,
  };

  const views = (await callRevit("/revit/views", "GET")) as any[];
  if (!Array.isArray(views)) throw new Error("Failed to list views");

  const source =
    Number.isFinite(args.sourceViewId) ?
      views.find((v) => Number(v.id) === Number(args.sourceViewId)) :
      views.find((v) => v.name === args.sourceViewName);

  if (!source) {
    throw new Error(`Source view not found. Provide sourceViewName or sourceViewId.`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultTarget = `AI_AUTODIM_${safeName(String(source.name)).slice(0, 64)}_${timestamp}`;
  const targetName = args.targetViewName ?? defaultTarget;

  const baseOut =
    args.outputDir ??
    path.resolve(process.cwd(), "../local-work/EPIC-0004_auto-dimensioning/iterations");
  const iterDir = path.resolve(baseOut, `floorplan_${timestamp}`);
  fs.mkdirSync(iterDir, { recursive: true });

  // Delete existing target if present
  if (overwriteTarget) {
    const existing = views.find((v) => v.name === targetName);
    if (existing) {
      try {
        await callRevit("/revit/delete", "POST", { ids: [existing.id], apply: true });
      } catch {
        // ignore
      }
    }
  }

  // Duplicate to a clean slate
  const dup = (await callRevit("/revit/duplicate-view", "POST", {
    viewId: source.id,
    newName: targetName,
    withDetailing: false,
  })) as any;
  const targetViewId = Number(dup?.viewId);
  if (!Number.isFinite(targetViewId)) throw new Error(`Duplicate failed: ${JSON.stringify(dup)}`);

  const beforeCoverage = await computeExistingWallCoverage(targetViewId);
  fs.writeFileSync(path.join(iterDir, "coverage_before.json"), JSON.stringify(beforeCoverage, null, 2));

  let baselineImage: any = null;
  let afterImage: any = null;
  if (captureImages) {
    baselineImage = await callRevit("/revit/export-image", "POST", {
      viewId: source.id,
      imageSize,
      folder: iterDir,
    });
  }

  const passResults: any[] = [];
  for (let pass = 1; pass <= passes; pass++) {
    const cov = pass === 1 ? beforeCoverage : await computeExistingWallCoverage(targetViewId);
    const covPct = cov?.counts?.coverWallCoverage ?? 0;
    if (pass > 1 && Number.isFinite(covPct) && covPct >= 0.965) break;

    const proposals = await planAutoDimension(targetViewId, opts);
    fs.writeFileSync(path.join(iterDir, `proposals_pass${pass}.json`), JSON.stringify(proposals, null, 2));

    if (proposals.length === 0) {
      passResults.push({ pass, planned: 0, applied: 0 });
      break;
    }

    const applyRes = await applyAutoDimension(targetViewId, proposals);
    fs.writeFileSync(path.join(iterDir, `apply_result_pass${pass}.json`), JSON.stringify(applyRes, null, 2));
    passResults.push({ pass, planned: proposals.length, applyRes });

    // If we made no progress (all errors), stop early.
    const successes = Array.isArray(applyRes?.results) ? applyRes.results.filter((r: any) => r?.success === true).length : 0;
    if (successes === 0) break;
  }

  const afterCoverage = await computeExistingWallCoverage(targetViewId);
  fs.writeFileSync(path.join(iterDir, "coverage_after.json"), JSON.stringify(afterCoverage, null, 2));

  if (captureImages) {
    afterImage = await callRevit("/revit/export-image", "POST", {
      viewId: targetViewId,
      imageSize,
      folder: iterDir,
    });
  }

  const report = {
    timestamp,
    outputDir: iterDir,
    sourceView: source.name,
    sourceViewId: source.id,
    targetView: targetName,
    targetViewId,
    options: opts,
    passesRequested: passes,
    passResults,
    baselineImage: baselineImage?.path,
    afterImage: afterImage?.path,
    beforeCoverage,
    afterCoverage,
  };
  const reportPath = path.join(iterDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return report;
}
