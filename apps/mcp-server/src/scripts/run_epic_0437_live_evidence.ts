import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callRevit, readRevitDirectLaboratoryEvidenceContext } from "../lib/revitClient.js";
import { readRevitCourierLaboratoryEvidenceContext } from "../lib/revitCourier.js";
import { canonicalToolExposureJson, runWithRevitToolAlias } from "../lib/toolExposurePolicy.js";
import { observeModelV1, readCertifiedMoveTargetsV1, type SpatialObservationCall } from "../spatialObservationV1.js";

type Point = Readonly<{ x: number; y: number; z: number }>;
type TransportEvidence = Readonly<{ step: string; kind: string; dispatch_id: string; correlation_id: string; files: Array<{ path: string; sha256: string }> }>;

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function sha(raw: string): string { return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`; }
function exactPath(repoRoot: string, relative: string): string {
  if (!relative.startsWith("artifacts/certification/epic-0437/runs/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("--output must be a bounded EPIC-0437 run receipt path.");
  const resolved = path.resolve(repoRoot, relative);
  if (!resolved.startsWith(path.resolve(repoRoot) + path.sep)) throw new Error("Live evidence output escapes the repository.");
  return resolved;
}
function point(value: unknown, name: string): Point {
  const raw = value as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![raw.x, raw.y, raw.z].every(v => typeof v === "number" && Number.isFinite(v))) throw new Error(`${name} is not a finite XYZ point.`);
  return { x: raw.x as number, y: raw.y as number, z: raw.z as number };
}
function snapshotPoint(value: unknown, name: string): Point {
  const raw = value as Record<string, unknown>;
  if (!raw || raw.kind !== "LocationPoint" || !Array.isArray(raw.pointXyz) || raw.pointXyz.length !== 3 || !raw.pointXyz.every(v => typeof v === "number" && Number.isFinite(v))) throw new Error(`${name} is not an exact LocationPoint snapshot.`);
  return { x: raw.pointXyz[0] as number, y: raw.pointXyz[1] as number, z: raw.pointXyz[2] as number };
}
function same(left: Point, right: Point, tolerance = 1e-9): boolean { return Math.abs(left.x - right.x) <= tolerance && Math.abs(left.y - right.y) <= tolerance && Math.abs(left.z - right.z) <= tolerance; }
function plus(left: Point, right: Point): Point { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function minus(value: Point): Point { return { x: -value.x, y: -value.y, z: -value.z }; }
function parseText(result: { content: Array<{ type: string; text?: string }> }): Record<string, any> {
  const text = result.content.find(item => item.type === "text")?.text;
  if (!text) throw new Error("Typed observation result omitted structured text.");
  return JSON.parse(text) as Record<string, any>;
}
function moveBody(elementId: number, vector: Point, dryRun: boolean): Record<string, unknown> {
  return { ids: [elementId], mode: "vector", vectorX: vector.x, vectorY: vector.y, vectorZ: vector.z, dryRun, behavior: "allOrNothing", moveTogether: false, options: { failOnPinned: true, unpinIfAllowed: false } };
}
function validateMoveResult(value: unknown, elementId: number, vector: Point, rolledBack: boolean): { before: Point; after: Point } {
  const result = value as Record<string, any>;
  if (!result || result.rolledBack !== rolledBack || result.movedTogether !== false || !Array.isArray(result.movedIds) || result.movedIds.length !== 1 || result.movedIds[0] !== elementId || !Array.isArray(result.skipped) || result.skipped.length !== 0 || !Array.isArray(result.snapshots) || result.snapshots.length !== 1) throw new Error("Move result did not prove one exact successful target outcome.");
  const snapshot = result.snapshots[0] as Record<string, unknown>;
  if (snapshot.id !== elementId) throw new Error("Move snapshot target changed.");
  const before = snapshotPoint(snapshot.before, "move before");
  const after = snapshotPoint(snapshot.after, "move after");
  if (!same(after, plus(before, vector))) throw new Error("Move snapshot does not equal the exact requested displacement.");
  return { before, after };
}

async function main(): Promise<void> {
  const level = argument("--level");
  if (level !== "L3" && level !== "L4") throw new Error("--level must be L3 or L4.");
  const expectedTransport = level === "L3" ? "direct" : "courier";
  if (process.env.REVIT_OPERATOR_MODE !== "development" || process.env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory" || process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1" || process.env.OPERATOR_REVIT_TRANSPORT !== expectedTransport) throw new Error(`Live ${level} evidence requires exact development/laboratory protected ${expectedTransport} transport.`);
  const viewId = Number(argument("--view-id"));
  if (!Number.isSafeInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive Revit view id.");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const outputRelative = argument("--output") ?? `artifacts/certification/epic-0437/runs/${level.toLowerCase()}-${Date.now()}.json`;
  const outputPath = exactPath(repoRoot, outputRelative);
  const runDir = path.dirname(outputPath);
  fs.mkdirSync(runDir, { recursive: true });
  const transportEvidence: TransportEvidence[] = [];
  let sequence = 0;

  const capture = (step: string, result: unknown): void => {
    sequence += 1;
    if (level === "L3") {
      const context = readRevitDirectLaboratoryEvidenceContext(result);
      const relative = path.posix.join(path.posix.dirname(outputRelative), `${String(sequence).padStart(2, "0")}-${step}.native-transport.json`);
      const target = exactPath(repoRoot, relative);
      fs.copyFileSync(context.receiptPath, target);
      const raw = fs.readFileSync(target, "utf8");
      if (sha(raw) !== context.receiptSha256) throw new Error("Protected direct transport receipt changed during evidence capture.");
      transportEvidence.push({ step, kind: context.transportKind, dispatch_id: context.dispatchId, correlation_id: context.correlationId, files: [{ path: relative, sha256: sha(raw) }] });
      return;
    }
    const context = readRevitCourierLaboratoryEvidenceContext(result);
    const files: Array<{ path: string; sha256: string }> = [];
    for (const [suffix, source, expected] of [["job", context.jobPath, context.jobSha256], ["result", context.resultPath, context.resultSha256]] as const) {
      const relative = path.posix.join(path.posix.dirname(outputRelative), `${String(sequence).padStart(2, "0")}-${step}.${suffix}.json`);
      const target = exactPath(repoRoot, relative);
      fs.copyFileSync(source, target);
      const raw = fs.readFileSync(target, "utf8");
      if (sha(raw) !== expected) throw new Error(`Courier ${suffix} receipt changed during evidence capture.`);
      files.push({ path: relative, sha256: sha(raw) });
    }
    transportEvidence.push({ step, kind: "courier_sidecar", dispatch_id: context.jobId, correlation_id: context.correlationId, files });
  };
  const callStep = async (alias: string, step: string, route: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<any> => runWithRevitToolAlias(alias, async () => {
    const result = await callRevit(route, method, body, { workflow: `epic-0437-${level.toLowerCase()}-${step}` });
    capture(step, result);
    return result;
  });

  const initialContext = await callStep("revit_get_context", "context-before", "/revit/context", "GET");
  if (!initialContext?.readiness?.document_loaded || initialContext?.readiness?.active_document_name !== "Snowdon Towers Sample HVAC") throw new Error("Live evidence requires the open Snowdon Towers Sample HVAC document.");
  await callStep("revit_activate_view", "activate-view", "/revit/activate-view", "POST", { viewId, zoomToFit: true });

  const observationCall: SpatialObservationCall = async (route, method, body) => await callStep("revit_observe_model", "observation", route, method, body);
  const observationResult = await observeModelV1({}, observationCall);
  const observation = parseText(observationResult as any);
  const readbackCall: SpatialObservationCall = async (route, method, body) => await callStep("revit_read_move_targets_certified", `readback-${sequence + 1}`, route, method, body);
  const initialReadback = parseText(await readCertifiedMoveTargetsV1(readbackCall) as any);
  if (!Array.isArray(initialReadback.targets) || initialReadback.targets.length === 0) throw new Error("Fresh resolver/readback returned no independently safe point-located host target.");
  const target = initialReadback.targets[0] as Record<string, any>;
  const elementId = target.elementId as number;
  const start = point(target.pointXyz, "initial target point");
  const vector: Point = { x: 0.25, y: 0, z: 0 };

  const previewRequest = moveBody(elementId, vector, true);
  const previewResult = await callStep("revit_move_one_certified", "move-preview", "/revit/move-elements", "POST", previewRequest);
  const preview = validateMoveResult(previewResult, elementId, vector, true);
  if (!same(preview.before, start)) throw new Error("Preview began from a target state different from fresh readback.");
  const rollbackReadback = parseText(await readCertifiedMoveTargetsV1(readbackCall) as any);
  const rollbackTarget = (rollbackReadback.targets as Array<Record<string, any>>).find(item => item.elementId === elementId);
  if (!rollbackTarget || !same(point(rollbackTarget.pointXyz, "rollback readback"), start)) throw new Error("Independent fresh readback did not prove exact rollback.");

  let apply: Record<string, unknown> | null = null;
  if (level === "L4") {
    const applyRequest = moveBody(elementId, vector, false);
    const applyResult = await callStep("revit_move_one_certified", "move-apply", "/revit/move-elements", "POST", applyRequest);
    const committed = validateMoveResult(applyResult, elementId, vector, false);
    const committedReadback = parseText(await readCertifiedMoveTargetsV1(readbackCall) as any);
    const committedTarget = (committedReadback.targets as Array<Record<string, any>>).find(item => item.elementId === elementId);
    const committedPoint = committedTarget ? point(committedTarget.pointXyz, "committed readback") : null;
    if (!committedPoint || !same(committedPoint, plus(start, vector))) throw new Error("Fresh readback did not prove the exact committed displacement.");
    const restoreVector = minus(vector);
    const restoreRequest = moveBody(elementId, restoreVector, false);
    const restoreResult = await callStep("revit_move_one_certified", "move-restore", "/revit/move-elements", "POST", restoreRequest);
    const restored = validateMoveResult(restoreResult, elementId, restoreVector, false);
    if (!same(restored.before, committedPoint)) throw new Error("Restore did not begin at the independently read committed location.");
    const restoredReadback = parseText(await readCertifiedMoveTargetsV1(readbackCall) as any);
    const restoredTarget = (restoredReadback.targets as Array<Record<string, any>>).find(item => item.elementId === elementId);
    const restoredPoint = restoredTarget ? point(restoredTarget.pointXyz, "restored readback") : null;
    if (!restoredPoint || !same(restoredPoint, start)) throw new Error("Fresh readback did not prove exact restoration.");
    apply = {
      request_sha256: sha(canonicalToolExposureJson(applyRequest)), result: applyResult,
      committed_point: committedPoint, committed_readback_observation_id: committedReadback.observationId,
      restore_request_sha256: sha(canonicalToolExposureJson(restoreRequest)), restore_result: restoreResult,
      restored_point: restoredPoint, restored_readback_observation_id: restoredReadback.observationId
    };
  }

  const finalContext = await callStep("revit_get_context", "context-after", "/revit/context", "GET");
  const fingerprint = String(initialContext.document?.projectIdentity?.fingerprint ?? "");
  const normalizedFingerprint = fingerprint.startsWith("sha256:") ? fingerprint : `sha256:${fingerprint}`;
  const run = {
    schema: "revit-operator.epic-0437-live-evidence-run.v1",
    level,
    transport: level === "L3" ? "direct_protected_native" : "courier_sidecar",
    runtime: { mode: "development", exposure_profile: "laboratory", production_certified: false },
    document: {
      title: initialContext.document.title, path: initialContext.document.path,
      fingerprint: normalizedFingerprint, session_id: initialContext.document.sessionId,
      native_attestation: initialContext.document.nativeExecutionAttestation,
      final_session_id: finalContext.document?.sessionId
    },
    view: { id: viewId, name: observation.view?.name ?? observation.viewName, type: observation.view?.type ?? observation.viewType },
    observation: {
      alias: "revit_observe_model", observation_id: observation.observationId, count: observation.count,
      scanned: observation.scanned, certified_target_count: observation.certifiedTargetCount,
      image_attached: observationResult.content.some(item => item.type === "image")
    },
    readback: {
      alias: "revit_read_move_targets_certified", observation_id: initialReadback.observationId,
      target_count: initialReadback.targets.length, selected_target: target
    },
    preview: {
      alias: "revit_move_one_certified", request_sha256: sha(canonicalToolExposureJson(previewRequest)),
      result: previewResult, rollback_readback_observation_id: rollbackReadback.observationId, rollback_point: start
    },
    apply,
    transport_evidence: transportEvidence,
    completed_at_utc: new Date().toISOString()
  };
  if (run.document.session_id !== run.document.final_session_id || observation.document?.documentSessionId !== run.document.session_id || initialReadback.document?.documentSessionId !== run.document.session_id) throw new Error("Document session changed during live evidence.");
  fs.writeFileSync(outputPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ output: outputRelative, sha256: sha(fs.readFileSync(outputPath, "utf8")), level, element_id: elementId, rollback_verified: true, committed_and_restored: apply !== null }, null, 2) + "\n");
}

main().catch(error => { process.stderr.write(`EPIC-0437 live evidence failed: ${String(error)}\n`); process.exitCode = 1; });
