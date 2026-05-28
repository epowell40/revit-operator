import { callRevit } from "../lib/revitClient.js";
import * as fs from "fs";
import * as path from "path";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function getArgs(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}

function parsePoints(): Array<{ xPx: number; yPx: number }> {
  const pointArgs = getArgs("point"); // repeatable: --point "930,410"
  const points: Array<{ xPx: number; yPx: number }> = [];
  for (const p of pointArgs) {
    const parts = p.split(",").map((s) => s.trim());
    if (parts.length >= 2) {
      const xPx = Number(parts[0]);
      const yPx = Number(parts[1]);
      if (!Number.isNaN(xPx) && !Number.isNaN(yPx)) points.push({ xPx, yPx });
    }
  }

  const xArg = getArg("x");
  const yArg = getArg("y");
  if (points.length === 0 && xArg && yArg) points.push({ xPx: Number(xArg), yPx: Number(yArg) });

  return points;
}

async function run() {
  const roomNumber = getArg("room");
  if (!roomNumber) throw new Error("Missing required arg: --room <roomNumber>");

  const imageSize = Number(getArg("imageSize") ?? "3000");
  const preferViewNameContains = getArg("preferViewNameContains");
  const categoriesArg = getArg("categories"); // comma-separated BuiltInCategory tokens, e.g. "OST_Doors,OST_Walls"
  const categories = categoriesArg
    ? categoriesArg.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const workDir = path.resolve(process.cwd(), "../local-work/EPIC-0008_element-selection/smoke_room");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const iterDir = path.join(workDir, stamp);
  fs.mkdirSync(iterDir, { recursive: true });

  const resolved = await callRevit("/revit/resolve-room-plan-view", "POST", {
    roomNumber,
    preferViewNameContains,
    maxCandidates: 10,
  });

  const bboxMinXyz = resolved?.roomBbox?.minXyz;
  const bboxMaxXyz = resolved?.roomBbox?.maxXyz;

  const activate = await callRevit("/revit/activate-view", "POST", {
    viewId: resolved.bestViewId,
    showElementIds: [resolved.roomId],
    bboxMinXyz,
    bboxMaxXyz,
  });

  const frame = await callRevit("/revit/export-view-frame", "POST", {
    viewId: resolved.bestViewId,
    imageSize,
    folder: iterDir,
    includeMapping: true,
  });

  const points = parsePoints();
  if (points.length === 0) points.push({ xPx: Math.floor(frame.widthPx / 2), yPx: Math.floor(frame.heightPx / 2) });

  const picks: any[] = [];
  const pickedElementIds = new Set<number>();

  for (const pt of points) {
    const pick = await callRevit("/revit/pick-at-pixel", "POST", {
      frameId: frame.frameId,
      xPx: pt.xPx,
      yPx: pt.yPx,
      maxCandidates: 10,
      categories,
      preferViewLevel: true,
      preferCategories: categories,
    });
    picks.push({ point: pt, pick });

    const bestId = pick?.best?.elementId;
    if (typeof bestId === "number") pickedElementIds.add(bestId);
  }

  const elementIds = Array.from(pickedElementIds.values());
  let setSel: any = null;
  let highlight: any = null;
  if (elementIds.length > 0) {
    setSel = await callRevit("/revit/set-selection", "POST", { elementIds });
    highlight = await callRevit("/revit/highlight-and-export", "POST", {
      viewId: frame.viewId,
      elementIds,
      imageSize,
      folder: iterDir,
      highlightMode: "temporary_override",
      overrideStyle: { lineWeight: 8, r: 255, g: 0, b: 0 },
    });
  }

  const report = {
    timestamp: stamp,
    imageSize,
    roomNumber,
    resolved,
    activate,
    frame,
    picks,
    selectedElementIds: elementIds,
    setSelection: setSel,
    highlight,
  };

  const reportPath = path.join(iterDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("selection_room_smoke complete");
  console.log(`room:           ${roomNumber}`);
  console.log(`view:           ${resolved.bestViewName} (${resolved.bestViewId})`);
  console.log(`frame image:    ${frame.path}`);
  console.log(`highlight image:${highlight?.path ?? "(none)"}`);
  console.log(`report:         ${reportPath}`);
  console.log(`points:         ${points.map((p) => `(${p.xPx},${p.yPx})`).join(" ")}`);
  console.log(`picked ids:     ${elementIds.join(", ") || "(none)"}`);
}

run().catch((e) => {
  console.error("selection_room_smoke failed", e);
  process.exit(1);
});

