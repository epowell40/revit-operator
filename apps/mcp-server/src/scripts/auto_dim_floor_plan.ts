import { runAutoDimFloorPlan } from "../skills/autoDimFloorPlanRunner.js";
import * as path from "path";
import { execFileSync } from "child_process";

type Args = {
  sourceViewName?: string;
  sourceViewId?: number;
  targetViewName?: string;
  imageSize?: number;
  cols?: number;
  rows?: number;
  preset?: "architect" | "coverage";
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const take = () => {
      i++;
      return next;
    };
    if (a === "--source" && next) out.sourceViewName = take();
    else if (a === "--viewId" && next) out.sourceViewId = Number(take());
    else if (a === "--target" && next) out.targetViewName = take();
    else if (a === "--imageSize" && next) out.imageSize = Number(take());
    else if (a === "--cols" && next) out.cols = Number(take());
    else if (a === "--rows" && next) out.rows = Number(take());
    else if (a === "--preset" && next) out.preset = take() as any;
  }
  return out;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const imageSize = Number.isFinite(args.imageSize) ? (args.imageSize as number) : 6000;
  const cols = Number.isFinite(args.cols) ? (args.cols as number) : 3;
  const rows = Number.isFinite(args.rows) ? (args.rows as number) : 3;
  const preset = args.preset === "coverage" ? "coverage" : "architect";
  const report = await runAutoDimFloorPlan({
    sourceViewName: args.sourceViewName,
    sourceViewId: args.sourceViewId,
    targetViewName: args.targetViewName,
    overwriteTarget: true,
    captureImages: true,
    imageSize,
    passes: 1,
    options: {
      preset,
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
    },
  });
  const iterDir = report.outputDir;
  const reportPath = path.join(iterDir, "report.json");

  // Tile for quick review (baseline vs after)
  try {
    const psScript = path.resolve(process.cwd(), "src/scripts/tile_images.ps1");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        psScript,
        "-iterDir",
        iterDir,
        "-aiViewName",
        report.targetView,
        "-humanViewName",
        report.sourceView,
        "-cols",
        String(cols),
        "-rows",
        String(rows),
        "-padding",
        "0",
      ],
      { stdio: "inherit" }
    );
  } catch (e) {
    console.warn("Failed to tile images for auditing.", e);
  }

  console.log("---------------------------------------------------");
  console.log("AUTO-DIM COMPLETE");
  console.log(`Report: ${reportPath}`);
  console.log(`Baseline: ${report.baselineImage}`);
  console.log(`After:    ${report.afterImage}`);
  console.log("---------------------------------------------------");
}

run().catch((e) => {
  console.error("auto_dim_floor_plan failed:", e);
  process.exit(1);
});
