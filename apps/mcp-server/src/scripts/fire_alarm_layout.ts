import { callRevit } from "../lib/revitClient.js";
import { RunBundle } from "../lib/RunBundle.js";

function getArg(name: string) {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function toCsvRow(values: (string | number | boolean | null | undefined)[]) {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return values.map(esc).join(",");
}

function toAssumptionsCsv(report: any) {
  const rows: string[] = [];
  rows.push(toCsvRow([
    "roomId",
    "roomNumber",
    "roomName",
    "areaFt2",
    "levelName",
    "inferredClass",
    "classReasonCode",
    "notifyDecision",
    "notifyReasonCode",
  ]));
  for (const a of report?.assumptions ?? []) {
    rows.push(toCsvRow([
      a.roomId,
      a.roomNumber,
      a.roomName,
      a.areaFt2,
      a.levelName,
      a.inferredClass,
      a.classReasonCode,
      a.notifyDecision,
      a.notifyReasonCode,
    ]));
  }
  return rows.join("\n") + "\n";
}

async function main() {
  const runConfigPath = getArg("config");
  if (!runConfigPath) {
    console.error("Usage: npx tsx src/scripts/fire_alarm_layout.ts --config <path> [--level <name>] [--viewId <id>] [--dryRun] [--noVisualizer] [--noCapture] [--imageSize <px>]");
    process.exit(2);
  }

  const levelName = getArg("level");
  const viewIdRaw = getArg("viewId");
  const viewId = viewIdRaw ? Number(viewIdRaw) : undefined;
  const dryRun = hasFlag("dryRun");
  const createVisualizer = !hasFlag("noVisualizer");
  const captureImage = !hasFlag("noCapture");
  const imageSizeRaw = getArg("imageSize");
  const imageSize = imageSizeRaw ? Number(imageSizeRaw) : 2600;

  const bundle = new RunBundle("fire_alarm_layout", { runConfigPath, levelName, viewId, dryRun, createVisualizer, captureImage, imageSize });
  await bundle.init();

  try {
    const payload = { runConfigPath, levelName, viewId, dryRun, createVisualizer };
    bundle.log("Calling /revit/fire-alarm-layout", payload);

    const result = await callRevit<any>("/revit/fire-alarm-layout", "POST", payload);
    await bundle.saveArtifact("fire_alarm_layout_report.json", JSON.stringify(result, null, 2));
    await bundle.saveArtifact("assumptions.csv", toAssumptionsCsv(result));

    let capture: any = null;
    const reportViewId = Number(result?.viewId);
    if (captureImage && Number.isFinite(reportViewId) && !dryRun) {
      bundle.log("Capturing view image", { viewId: reportViewId, imageSize });
      capture = await callRevit<any>("/revit/export-image", "POST", { viewId: reportViewId, imageSize, folder: bundle.artifactsPath });
      await bundle.saveArtifact("capture.json", JSON.stringify(capture, null, 2));
    }

    const summaryMd =
      `# Fire Alarm Layout Run\n\n` +
      `- RunId: ${result?.runId ?? ""}\n` +
      `- Level: ${result?.levelName ?? ""}\n` +
      `- ViewId: ${result?.viewId ?? ""}\n` +
      `- DryRun: ${result?.dryRun ?? false}\n` +
      `- Placed: ${Array.isArray(result?.placed) ? result.placed.length : 0}\n` +
      `- Uncovered markers: ${result?.uncoveredMarkersCreated ?? 0}\n` +
      `- Capture: ${capture?.path ?? ""}\n`;
    await bundle.saveArtifact("summary.md", summaryMd);
    await bundle.complete({ ok: true, result });

    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    await bundle.fail(e);
    throw e;
  }
}

main();

