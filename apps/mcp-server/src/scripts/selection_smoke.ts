import { callRevit } from "../lib/revitClient.js";
import * as fs from "fs";
import * as path from "path";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

async function run() {
  const imageSize = Number(getArg("imageSize") ?? "3000");
  const xArg = getArg("x");
  const yArg = getArg("y");

  const workDir = path.resolve(process.cwd(), "../local-work/EPIC-0008_element-selection/smoke");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const iterDir = path.join(workDir, stamp);
  fs.mkdirSync(iterDir, { recursive: true });

  const frame = await callRevit("/revit/export-view-frame", "POST", { imageSize, folder: iterDir, includeMapping: true });
  const xPx = xArg ? Number(xArg) : Math.floor(frame.widthPx / 2);
  const yPx = yArg ? Number(yArg) : Math.floor(frame.heightPx / 2);

  const pick = await callRevit("/revit/pick-at-pixel", "POST", { frameId: frame.frameId, xPx, yPx, maxCandidates: 10 });

  let highlight: any = null;
  let setSel: any = null;
  const bestId = pick?.best?.elementId;
  if (typeof bestId === "number") {
    setSel = await callRevit("/revit/set-selection", "POST", { elementIds: [bestId] });
    highlight = await callRevit("/revit/highlight-and-export", "POST", {
      viewId: frame.viewId,
      elementIds: [bestId],
      imageSize,
      folder: iterDir,
      highlightMode: "temporary_override",
      overrideStyle: { lineWeight: 8, r: 255, g: 0, b: 0 },
    });
  }

  const report = {
    timestamp: stamp,
    imageSize,
    frame,
    pick,
    setSelection: setSel,
    highlight,
  };

  const reportPath = path.join(iterDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("selection_smoke complete");
  console.log(`frame image:     ${frame.path}`);
  console.log(`highlight image: ${highlight?.path ?? "(none)"}`);
  console.log(`report:          ${reportPath}`);
  console.log(`picked pixel:    (${xPx}, ${yPx})`);
}

run().catch((e) => {
  console.error("selection_smoke failed", e);
  process.exit(1);
});

