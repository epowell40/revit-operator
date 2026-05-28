import * as fs from "fs";
import * as path from "path";
import { RunBundle } from "../lib/RunBundle.js";
import { callRevit } from "../lib/revitClient.js";

export type RunFireAlarmLayoutArgs = {
  runConfigPath: string;
  deviceMappingsPath?: string;
  levelName?: string;
  viewId?: number;
  runId?: string;
  dryRun?: boolean;
  createVisualizer?: boolean;
  captureImage?: boolean;
  imageSize?: number;
  writeWorkIteration?: boolean;
};

function safeName(s: string) {
  return String(s).replace(/[\\/:*?"<>|]/g, "_");
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
  rows.push(
    toCsvRow([
      "roomId",
      "roomNumber",
      "roomName",
      "areaFt2",
      "levelName",
      "inferredClass",
      "classReasonCode",
      "notifyDecision",
      "notifyReasonCode",
    ])
  );
  for (const a of report?.assumptions ?? []) {
    rows.push(
      toCsvRow([
        a.roomId,
        a.roomNumber,
        a.roomName,
        a.areaFt2,
        a.levelName,
        a.inferredClass,
        a.classReasonCode,
        a.notifyDecision,
        a.notifyReasonCode,
      ])
    );
  }
  return rows.join("\n") + "\n";
}

function resolveExistingFile(p?: string) {
  if (!p) return null;
  const full = path.resolve(p);
  return fs.existsSync(full) ? full : null;
}

function resolveMappingsPathForSnapshot(runConfigPath: string, explicit?: string) {
  const explicitFull = resolveExistingFile(explicit);
  if (explicitFull) return explicitFull;

  try {
    const raw = fs.readFileSync(runConfigPath, "utf8");
    const cfg = JSON.parse(raw);
    const rel = cfg?.deviceMappingsPath;
    if (!rel || typeof rel !== "string") return null;
    const full = path.resolve(path.dirname(runConfigPath), rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

function ensureWorkIterationDir(skillName: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Keep generated iterations in local scratch (gitignored), not in tracked docs.
  const epicRoot = path.resolve(process.cwd(), "../local-work/fire-alarm-device-layout");
  const iterationsRoot = path.join(epicRoot, "iterations");
  const dir = path.join(iterationsRoot, `${timestamp}_${safeName(skillName)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runFireAlarmLayout(args: RunFireAlarmLayoutArgs) {
  const runConfigPath = resolveExistingFile(args.runConfigPath);
  if (!runConfigPath) throw new Error(`runConfigPath not found: ${args.runConfigPath}`);

  const dryRun = args.dryRun ?? false;
  const createVisualizer = args.createVisualizer ?? true;
  const captureImage = args.captureImage ?? true;
  const imageSize = Number.isFinite(args.imageSize) ? (args.imageSize as number) : 2600;
  const writeWorkIteration = args.writeWorkIteration ?? true;

  const bundle = new RunBundle("fire_alarm_layout", {
    ...args,
    runConfigPath,
    dryRun,
    createVisualizer,
    captureImage,
    imageSize,
    writeWorkIteration,
  });
  await bundle.init();

  const iterDir = writeWorkIteration ? ensureWorkIterationDir("fire_alarm_layout") : null;

  const payload = {
    runConfigPath,
    deviceMappingsPath: args.deviceMappingsPath,
    levelName: args.levelName,
    viewId: args.viewId,
    runId: args.runId,
    dryRun,
    createVisualizer,
  };

  try {
    const cfgBuf = fs.readFileSync(runConfigPath);
    await bundle.saveArtifact("run_config.snapshot.json", cfgBuf);
    if (iterDir) fs.writeFileSync(path.join(iterDir, "run_config.snapshot.json"), cfgBuf);

    const mappingsPath = resolveMappingsPathForSnapshot(runConfigPath, args.deviceMappingsPath);
    if (mappingsPath) {
      const mapBuf = fs.readFileSync(mappingsPath);
      await bundle.saveArtifact("device_mappings.snapshot.json", mapBuf);
      if (iterDir) fs.writeFileSync(path.join(iterDir, "device_mappings.snapshot.json"), mapBuf);
    }

    bundle.log("Calling /revit/fire-alarm-layout", payload);
    const report = await callRevit<any>("/revit/fire-alarm-layout", "POST", payload);

    const reportJson = JSON.stringify(report, null, 2);
    await bundle.saveArtifact("fire_alarm_layout_report.json", reportJson);
    if (iterDir) fs.writeFileSync(path.join(iterDir, "fire_alarm_layout_report.json"), reportJson);

    const assumptionsCsv = toAssumptionsCsv(report);
    await bundle.saveArtifact("assumptions.csv", assumptionsCsv);
    if (iterDir) fs.writeFileSync(path.join(iterDir, "assumptions.csv"), assumptionsCsv);

    let capture: any = null;
    const viewId = Number(report?.viewId);
    if (captureImage && Number.isFinite(viewId) && !dryRun) {
      const folder = iterDir ?? bundle.artifactsPath;
      bundle.log("Capturing view image", { viewId, imageSize, folder });
      capture = await callRevit<any>("/revit/export-image", "POST", {
        viewId,
        imageSize,
        folder,
      });
      await bundle.saveArtifact("capture.json", JSON.stringify(capture, null, 2));
      if (iterDir) fs.writeFileSync(path.join(iterDir, "capture.json"), JSON.stringify(capture, null, 2));
    }

    const summary = {
      runId: report?.runId,
      levelName: report?.levelName,
      viewId: report?.viewId,
      dryRun: report?.dryRun,
      placedCount: Array.isArray(report?.placed) ? report.placed.length : 0,
      assumptionsCount: Array.isArray(report?.assumptions) ? report.assumptions.length : 0,
      uncoveredMarkersCreated: report?.uncoveredMarkersCreated ?? 0,
      warnings: report?.warnings ?? [],
      errors: report?.errors ?? [],
      workDir: iterDir,
      runBundleDir: bundle.dirPath,
      capturePath: capture?.path,
    };

    const summaryMd =
      `# Fire Alarm Layout Run\n\n` +
      `- Status: success\n` +
      `- RunId: ${summary.runId ?? ""}\n` +
      `- Level: ${summary.levelName ?? ""}\n` +
      `- ViewId: ${summary.viewId ?? ""}\n` +
      `- DryRun: ${summary.dryRun}\n` +
      `- Placed: ${summary.placedCount}\n` +
      `- Uncovered markers: ${summary.uncoveredMarkersCreated}\n` +
      `- Work dir: ${summary.workDir ?? ""}\n` +
      `- Run bundle: ${summary.runBundleDir}\n` +
      `- Capture: ${summary.capturePath ?? ""}\n`;

    await bundle.saveArtifact("summary.md", summaryMd);
    if (iterDir) fs.writeFileSync(path.join(iterDir, "summary.md"), summaryMd);

    await bundle.complete({ ok: true, summary });
    return { summary };
  } catch (e) {
    await bundle.fail(e);
    throw e;
  }
}

