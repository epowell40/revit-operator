import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueLaboratoryEvidenceDispatch } from "../lib/laboratoryEvidenceDispatch.js";
import { verifyStoredLaboratoryExecutionResult, type LaboratoryNativeAttestationBinding } from "../lib/laboratoryMoveEvidence.js";
import { callLaboratoryMoveOneEvidence } from "../lib/laboratoryMoveEvidenceClient.js";
import { callRevit, readRevitDirectLaboratoryEvidenceContext } from "../lib/revitClient.js";
import { readRevitCourierLaboratoryEvidenceContext } from "../lib/revitCourier.js";
import { callNativeTransport } from "../lib/nativeTransport.js";
import { canonicalToolExposureJson, runWithRevitToolAlias } from "../lib/toolExposurePolicy.js";
import { getOperatorToken } from "../lib/workspace.js";
import { observeModelV1, readCertifiedMoveTargetsV1, type SpatialObservationCall } from "../spatialObservationV1.js";

type Point = Readonly<{ x: number; y: number; z: number }>;
type Level = "L3" | "L4";
type TransportKind = "direct" | "courier";
const REVIT_2024_SNOWDON_HVAC_SHA256 = "sha256:585385991b1f8a168881c4bc36546bc90e7bfb427c263d801fe367fa2ebb0fa8";
type Step = {
  name: string; method: "GET" | "POST"; path: string; channel: "typed_mcp"; alias: string; workflow: string;
  request_body: Record<string, unknown> | null; canonical_body_sha256: string;
  dispatch_id: string; correlation_id: string; result_path: string; result_sha256: string;
  courier_job_path: string | null; courier_job_sha256: string | null;
  courier_result_path: string | null; courier_result_sha256: string | null;
};

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function sha(raw: string): string { return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`; }
function shaBytes(raw: Buffer): string { return `sha256:${createHash("sha256").update(raw).digest("hex")}`; }
function normalizedWindowsPath(value: string): string { return path.win32.resolve(value).replace(/[\\/]+$/, "").toLowerCase(); }
function exactPath(repoRoot: string, relative: string): string {
  if (!relative.startsWith("artifacts/certification/epic-0437/runs/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Evidence path is not a bounded EPIC-0437 run path.");
  const resolved = path.resolve(repoRoot, relative);
  if (!resolved.startsWith(path.resolve(repoRoot) + path.sep)) throw new Error("Evidence path escapes the repository.");
  return resolved;
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function writeJsonAtomic(target: string, value: unknown): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const rendered = json(value);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(handle, rendered, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
  return sha(rendered);
}

function recoveryRecords(repoRoot: string): Array<{ path: string; relative: string; state: Record<string, any> }> {
  const runRoot = path.join(repoRoot, "artifacts", "certification", "epic-0437", "runs");
  if (!fs.existsSync(runRoot)) return [];
  return fs.readdirSync(runRoot, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith(".recovery.json"))
    .map(item => {
      const target = path.join(runRoot, item.name);
      try { return { path: target, relative: path.posix.join("artifacts/certification/epic-0437/runs", item.name), state: JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, any> }; }
      catch { throw new Error(`Pending recovery record is unreadable: ${item.name}`); }
    });
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
  const level = argument("--level") as Level | undefined;
  if (level !== "L3" && level !== "L4") throw new Error("--level must be L3 or L4.");
  const transportKind: TransportKind = level === "L3" ? "direct" : "courier";
  if (process.env.REVIT_OPERATOR_MODE !== "development" || process.env.OPERATOR_TOOL_EXPOSURE_PROFILE !== "laboratory"
    || process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY !== "1" || process.env.OPERATOR_REVIT_TRANSPORT !== transportKind) {
    throw new Error(`Live ${level} evidence requires exact protected development/laboratory ${transportKind} transport.`);
  }
  const viewId = Number(argument("--view-id"));
  const targetId = Number(argument("--target-id"));
  const confirmedTargetId = Number(argument("--confirm-disposable-target"));
  if (!Number.isSafeInteger(viewId) || viewId <= 0) throw new Error("--view-id must be a positive Revit view id.");
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || confirmedTargetId !== targetId) throw new Error("An explicit --target-id and equal --confirm-disposable-target are required; automatic target selection is forbidden.");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const outputRelative = argument("--output") ?? `artifacts/certification/epic-0437/runs/${level.toLowerCase()}-${Date.now()}.json`;
  if (!/^artifacts\/certification\/epic-0437\/runs\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(outputRelative)) {
    throw new Error("--output must be one direct, bounded EPIC-0437 runs-root JSON file so recovery discovery is exhaustive.");
  }
  const outputPath = exactPath(repoRoot, outputRelative);
  const disposableArgument = argument("--disposable-model-path");
  if (!disposableArgument || !path.win32.isAbsolute(disposableArgument) || path.win32.extname(disposableArgument).toLowerCase() !== ".rvt") {
    throw new Error("--disposable-model-path must be the exact absolute path of the open disposable RVT copy.");
  }
  const disposableRoot = path.join(process.env.LOCALAPPDATA ?? "", "RevitOperator", "CertificationEvidence", "DisposableModels");
  const disposableModelPath = path.resolve(disposableArgument);
  const disposableRootReal = fs.realpathSync.native(disposableRoot);
  const disposableModelReal = fs.realpathSync.native(disposableModelPath);
  const normalizedDisposableRoot = `${normalizedWindowsPath(disposableRootReal)}\\`;
  const disposableRelative = path.win32.relative(disposableRootReal, disposableModelReal);
  if (!normalizedWindowsPath(disposableModelReal).startsWith(normalizedDisposableRoot)
    || !/^[0-9a-f]{32}\\Snowdon Towers Sample HVAC\.rvt$/i.test(disposableRelative)) {
    throw new Error(`The evidence model must be ${disposableRoot}\\<32-hex-ceremony-id>\\Snowdon Towers Sample HVAC.rvt.`);
  }
  let inspectedDisposablePath = disposableRootReal;
  for (const component of disposableRelative.split(path.win32.sep)) {
    inspectedDisposablePath = path.join(inspectedDisposablePath, component);
    if (fs.lstatSync(inspectedDisposablePath).isSymbolicLink()) throw new Error("Disposable evidence path cannot contain a symlink, junction, or reparse redirect.");
  }
  const disposableStat = fs.lstatSync(disposableModelReal);
  if (!disposableStat.isFile() || disposableStat.isSymbolicLink()) throw new Error("The disposable evidence model must be one regular non-symlink file.");
  const disposableModelSha256Before = shaBytes(fs.readFileSync(disposableModelReal));
  if (disposableModelSha256Before !== REVIT_2024_SNOWDON_HVAC_SHA256) throw new Error("Disposable evidence model is not an exact pristine copy of the installed Revit 2024 Snowdon HVAC sample.");
  const discoveredRecoveryRecords = recoveryRecords(repoRoot);
  const runId = randomBytes(16).toString("hex");
  const workflowPrefix = `epic-0437-${level.toLowerCase()}`;
  const steps: Step[] = [];
  let sequence = 0;

  function store(relative: string, value: unknown): { path: string; sha256: string } {
    const target = exactPath(repoRoot, relative);
    const digest = writeJsonAtomic(target, value);
    return { path: relative, sha256: digest };
  }

  function capture(name: string, method: "GET" | "POST", route: string, alias: string, workflow: string, body: Record<string, unknown> | undefined, result: unknown): void {
    sequence += 1;
    const prefix = path.posix.join(path.posix.dirname(outputRelative), `${String(sequence).padStart(2, "0")}-${name}`);
    const nativeResult = store(`${prefix}.native-result.json`, result);
    if (level === "L3") {
      const context = readRevitDirectLaboratoryEvidenceContext(result);
      steps.push({ name, method, path: route, channel: "typed_mcp", alias, workflow,
        request_body: body ?? null, canonical_body_sha256: sha(body === undefined ? "" : canonicalToolExposureJson(body)),
        dispatch_id: context.dispatchId, correlation_id: context.correlationId,
        result_path: nativeResult.path, result_sha256: nativeResult.sha256,
        courier_job_path: null, courier_job_sha256: null, courier_result_path: null, courier_result_sha256: null });
      return;
    }
    const context = readRevitCourierLaboratoryEvidenceContext(result);
    const job = JSON.parse(fs.readFileSync(context.jobPath, "utf8")) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(job, "turn_token")) throw new Error("Courier evidence job contains a forbidden raw bearer token.");
    const durable = JSON.parse(fs.readFileSync(context.resultPath, "utf8")) as Record<string, unknown>;
    const jobArtifact = store(`${prefix}.courier-job.sanitized.json`, job);
    const resultArtifact = store(`${prefix}.courier-result.json`, durable);
    steps.push({ name, method, path: route, channel: "typed_mcp", alias, workflow,
      request_body: body ?? null, canonical_body_sha256: sha(body === undefined ? "" : canonicalToolExposureJson(body)),
      dispatch_id: context.jobId, correlation_id: context.correlationId,
      result_path: nativeResult.path, result_sha256: nativeResult.sha256,
      courier_job_path: jobArtifact.path, courier_job_sha256: jobArtifact.sha256,
      courier_result_path: resultArtifact.path, courier_result_sha256: resultArtifact.sha256 });
  }

  async function callStep(alias: string, name: string, route: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<any> {
    const workflow = `${workflowPrefix}-${name}`;
    const evidenceDispatch = issueLaboratoryEvidenceDispatch({ evidenceRunId: runId, evidenceStep: name, workflow, transportKind });
    return runWithRevitToolAlias(alias, async () => {
      const result = await callRevit(route, method, body, { channel: "typed_mcp", workflow, laboratoryEvidenceDispatch: evidenceDispatch });
      capture(name, method, route, alias, workflow, body, result);
      return result;
    });
  }

  async function moveStep(name: string, phase: "preview" | "apply", elementId: number, observationId: string, vector: Point,
    previewReceipt?: string, evidenceRunId = runId): Promise<{ result: any; previewReceipt?: string }> {
    const workflow = `${workflowPrefix}-${name}`;
    const evidenceDispatch = issueLaboratoryEvidenceDispatch({ evidenceRunId, evidenceStep: name, workflow, transportKind });
    return runWithRevitToolAlias("revit_move_one_certified", async () => {
      const call = await callLaboratoryMoveOneEvidence<any>({ evidenceDispatch, request: { phase, elementId, observationId, vectorFeet: vector, previewReceipt } });
      const body = { ids: [elementId], mode: "vector", vectorX: vector.x, vectorY: vector.y, vectorZ: vector.z,
        dryRun: phase === "preview", behavior: "allOrNothing", moveTogether: false,
        options: { failOnPinned: true, unpinIfAllowed: false } };
      capture(name, "POST", "/revit/move-elements", "revit_move_one_certified", workflow, body, call.result);
      return call;
    });
  }

  // Establish the native RSA trust root over the independently authenticated
  // protected direct channel before any courier-supplied result is accepted.
  // This call is trust bootstrap only and is deliberately absent from the
  // certification step graph.
  const trustBootstrapResponse = await callNativeTransport({
    operatorToken: getOperatorToken(), method: "GET", path: "/revit/context",
    channel: "typed_mcp", alias: "revit_get_context"
  });
  if (trustBootstrapResponse.statusCode < 200 || trustBootstrapResponse.statusCode >= 300) throw new Error("Protected native trust bootstrap did not return a successful context.");
  const trustBootstrap = JSON.parse(trustBootstrapResponse.bodyJson) as Record<string, any>;
  const bootstrapFingerprintRaw = String(trustBootstrap.document?.projectIdentity?.fingerprint ?? "");
  const bootstrapFingerprint = bootstrapFingerprintRaw.startsWith("sha256:") ? bootstrapFingerprintRaw : `sha256:${bootstrapFingerprintRaw}`;
  const bootstrapSessionId = String(trustBootstrap.document?.sessionId ?? "");
  const bootstrapAttestation = trustBootstrap.document?.nativeExecutionAttestation;
  const trustedNativeAttestation: LaboratoryNativeAttestationBinding = {
    algorithm: bootstrapAttestation?.algorithm,
    key_id: bootstrapAttestation?.key_id,
    modulus_base64url: bootstrapAttestation?.modulus_base64url,
    exponent_base64url: bootstrapAttestation?.exponent_base64url
  };
  if (normalizedWindowsPath(String(trustBootstrap.document?.path ?? "")) !== normalizedWindowsPath(disposableModelReal)) {
    throw new Error("Protected native trust bootstrap is not running against the exact real disposable model path.");
  }

  const terminalRecoveryStates = new Set(["preview_only", "restored", "restored_after_failure"]);
  const pendingRecoveryRecords: typeof discoveredRecoveryRecords = [];
  for (const record of discoveredRecoveryRecords) {
    const saved = record.state;
    if (saved.schema !== "revit-operator.epic-0437-move-recovery.v2" || !/^[0-9a-f]{32}$/.test(String(saved.evidence_run_id))
      || (saved.level !== "L3" && saved.level !== "L4") || saved.source_scoped_id !== `host:${Number(saved.target_id)}`
      || saved.disposable_model_path !== disposableModelReal || saved.disposable_model_sha256 !== disposableModelSha256Before
      || typeof saved.preview_result_sha256 !== "string" || saved.preview_result_sha256 !== sha(canonicalToolExposureJson(saved.preview_result))) {
      throw new Error(`Recovery record ${record.relative} is not sealed to one exact native-signed preview result.`);
    }
    const previewReceipt = verifyStoredLaboratoryExecutionResult(saved.preview_result, trustedNativeAttestation);
    const previewDispatch = previewReceipt.laboratory_evidence as Record<string, unknown> | null;
    const previewProjection = previewReceipt.laboratory_move_evidence as Record<string, unknown> | null;
    const savedStart = point(saved.start, "sealed recovery start");
    const savedVector = point(saved.vector, "sealed recovery vector");
    const previewOutcome = validateMoveResult(saved.preview_result, Number(saved.target_id), savedVector, true);
    const savedFingerprintRaw = String(saved.document_fingerprint ?? "");
    const savedFingerprint = savedFingerprintRaw.startsWith("sha256:") ? savedFingerprintRaw : `sha256:${savedFingerprintRaw}`;
    if (!previewDispatch || !previewProjection
      || previewDispatch.candidate_source_hash !== "sha256:daec4b624b7a0ca07d67fe78bd4f56bf5e5277e7254dfcddf0acc31c344604cc"
      || previewDispatch.evidence_run_id !== saved.evidence_run_id || previewDispatch.evidence_step !== "move-preview"
      || previewDispatch.production_certified !== false || previewReceipt.phase !== "preview"
      || previewReceipt.effect_hash !== "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b"
      || previewReceipt.document_fingerprint !== savedFingerprint || previewReceipt.document_session_id !== saved.document_session_id
      || previewProjection.source_scoped_id !== saved.source_scoped_id || previewProjection.element_id !== saved.target_id
      || !same(previewOutcome.before, savedStart) || !same(previewOutcome.after, plus(savedStart, savedVector))) {
      throw new Error(`Recovery record ${record.relative} fields do not match its exact native-signed preview authority.`);
    }
    if (terminalRecoveryStates.has(String(saved.state))) {
      if (saved.state === "preview_only") {
        if (saved.level !== "L3" || saved.terminal_move_result !== undefined) throw new Error(`Recovery record ${record.relative} has an invalid preview-only terminal proof.`);
        continue;
      }
      if (saved.level !== "L4" || typeof saved.terminal_move_result_sha256 !== "string"
        || saved.terminal_move_result_sha256 !== sha(canonicalToolExposureJson(saved.terminal_move_result))) {
        throw new Error(`Recovery record ${record.relative} is missing its exact signed restoration proof.`);
      }
      const terminalReceipt = verifyStoredLaboratoryExecutionResult(saved.terminal_move_result, trustedNativeAttestation);
      const terminalDispatch = terminalReceipt.laboratory_evidence as Record<string, unknown> | null;
      const terminalProjection = terminalReceipt.laboratory_move_evidence as Record<string, unknown> | null;
      const restored = validateMoveResult(saved.terminal_move_result, Number(saved.target_id), minus(savedVector), false);
      if (!terminalDispatch || !terminalProjection || terminalDispatch.evidence_run_id !== saved.evidence_run_id
        || terminalDispatch.candidate_source_hash !== previewDispatch.candidate_source_hash
        || terminalDispatch.production_certified !== false || terminalReceipt.phase !== "apply"
        || terminalReceipt.effect_hash !== "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b"
        || typeof terminalProjection.preview_lineage_receipt_hash !== "string"
        || terminalReceipt.document_fingerprint !== savedFingerprint || !same(restored.before, plus(savedStart, savedVector)) || !same(restored.after, savedStart)) {
        throw new Error(`Recovery record ${record.relative} terminal state is not proved by an exact native-signed inverse apply.`);
      }
      continue;
    }
    pendingRecoveryRecords.push(record);
  }
  if (pendingRecoveryRecords.length > 1) throw new Error("Multiple authenticated EPIC-0437 recovery records require manual reconciliation; refusing another run.");
  const priorRecovery = pendingRecoveryRecords[0] ?? null;

  // Recovery is a mandatory startup gate. A prior L4 run may have committed
  // even when its transport response was lost or the host crashed. Re-observe
  // the exact saved target before starting any new evidence graph, then either
  // prove it is already at the starting point or restore it with a fresh,
  // one-use inverse preview/apply lineage.
  if (priorRecovery) {
    const state = priorRecovery.state;
    const savedLevel = String(state.level ?? "");
    const savedTargetId = Number(state.target_id);
    const savedViewId = Number(state.view_id);
    if (state.schema !== "revit-operator.epic-0437-move-recovery.v2" || savedLevel !== "L4"
      || level !== "L4" || savedTargetId !== targetId || savedViewId !== viewId
      || state.source_scoped_id !== `host:${targetId}`) {
      throw new Error(`Pending recovery ${priorRecovery.relative} does not match this exact L4 target/view invocation.`);
    }
    const savedStart = point(state.start, "pending recovery start");
    const savedVector = point(state.vector, "pending recovery vector");
    const savedEvidenceRunId = String(state.evidence_run_id ?? "");
    if (!/^[0-9a-f]{32}$/.test(savedEvidenceRunId)) throw new Error("Pending recovery evidence-run identity is invalid.");
    const savedFingerprintRaw = String(state.document_fingerprint ?? "");
    const savedFingerprint = savedFingerprintRaw.startsWith("sha256:") ? savedFingerprintRaw : `sha256:${savedFingerprintRaw}`;
    if (savedFingerprint !== bootstrapFingerprint) throw new Error("Pending recovery belongs to a different active document fingerprint.");

    const updatePriorRecovery = (nextState: string, details: Record<string, unknown> = {}): void => {
      priorRecovery.state = { ...priorRecovery.state, ...details, state: nextState, updated_at_utc: new Date().toISOString() };
      writeJsonAtomic(priorRecovery.path, priorRecovery.state);
    };
    const recoveryReadback = async (name: string): Promise<{ observation: Record<string, any>; point: Point }> => {
      const call: SpatialObservationCall = (route, method, body) => callStep("revit_read_move_targets_certified", name, route, method, body);
      const observed = parseText(await readCertifiedMoveTargetsV1(call) as any);
      const item = (observed.targets as Array<Record<string, any>> | undefined)?.find(value => value.elementId === targetId);
      if (!item || item.sourceScopedId !== `host:${targetId}` || item.pinned !== false
        || item.groupIdReadSucceeded !== true || item.groupId !== null) {
        throw new Error("Pending recovery target is no longer an exact known-safe host LocationPoint target.");
      }
      return { observation: observed, point: point(item.pointXyz, `${name} point`) };
    };

    try {
      const recoveryContext = await callStep("revit_get_context", "recovery-context", "/revit/context", "GET");
      const recoveryFingerprintRaw = String(recoveryContext.document?.projectIdentity?.fingerprint ?? "");
      const recoveryFingerprint = recoveryFingerprintRaw.startsWith("sha256:") ? recoveryFingerprintRaw : `sha256:${recoveryFingerprintRaw}`;
      if (recoveryFingerprint !== savedFingerprint) throw new Error("Pending recovery context changed document fingerprint.");
      if (Number(recoveryContext.document?.activeView?.id) !== savedViewId) {
        throw new Error(`Pending recovery requires Revit view ${savedViewId} to be active before reconciliation.`);
      }
      const current = await recoveryReadback("recovery-readback-current");
      if (same(current.point, savedStart)) {
        updatePriorRecovery("manual_close_without_save_required", { observed_safe_point: current.point, outcome_unknown: false, retryable: false });
        throw new Error(`Recovery target is at its signed starting point, but no signed inverse apply exists. Close/discard this disposable model and archive ${priorRecovery.relative} before another run.`);
      }
      const committed = plus(savedStart, savedVector);
      if (!same(current.point, committed)) {
        updatePriorRecovery("manual_reconciliation_required", { observed_point: current.point, outcome_unknown: true, retryable: false });
        throw new Error("Pending recovery target is at neither the exact starting nor expected committed point; manual reconciliation is required.");
      }
      const inverse = minus(savedVector);
      updatePriorRecovery("restore_dispatching", { committed_point: committed, outcome_unknown: true, retryable: false });
      const previewCall = await moveStep("recovery-restore-preview", "preview", targetId, current.observation.observationId, inverse, undefined, savedEvidenceRunId);
      if (!previewCall.previewReceipt) throw new Error("Pending recovery inverse preview did not issue one-use lineage.");
      const applyCall = await moveStep("recovery-restore-apply", "apply", targetId, current.observation.observationId, inverse,
        previewCall.previewReceipt, savedEvidenceRunId);
      validateMoveResult(applyCall.result, targetId, inverse, false);
      const restored = await recoveryReadback("recovery-readback-restored");
      if (!same(restored.point, savedStart)) throw new Error("Pending recovery inverse apply did not restore the exact starting point.");
      updatePriorRecovery("restored_after_failure", { restored_point: restored.point, outcome_unknown: false, retryable: false,
        terminal_move_result: applyCall.result, terminal_move_result_sha256: sha(canonicalToolExposureJson(applyCall.result)) });
      process.stdout.write(json({ recovered: priorRecovery.relative, state: "restored_after_failure", target_id: targetId }));
      return;
    } catch (error) {
      if (priorRecovery.state.state !== "manual_reconciliation_required") {
        updatePriorRecovery("reconciliation_required", { recovery_error: error instanceof Error ? error.message : String(error), outcome_unknown: true, retryable: false });
      }
      throw error;
    }
  }

  const initialContext = await callStep("revit_get_context", "context-before", "/revit/context", "GET");
  if (!initialContext?.readiness?.document_loaded || initialContext?.readiness?.active_document_name !== "Snowdon Towers Sample HVAC") throw new Error("Live evidence requires the open Snowdon Towers Sample HVAC document.");
  const initialFingerprintRaw = String(initialContext.document?.projectIdentity?.fingerprint ?? "");
  const initialFingerprint = initialFingerprintRaw.startsWith("sha256:") ? initialFingerprintRaw : `sha256:${initialFingerprintRaw}`;
  if (initialFingerprint !== bootstrapFingerprint || initialContext.document?.sessionId !== bootstrapSessionId
    || canonicalToolExposureJson(initialContext.document?.nativeExecutionAttestation) !== canonicalToolExposureJson(bootstrapAttestation)) {
    throw new Error("Courier/direct evidence context does not match the independently authenticated native document/session/key bootstrap.");
  }
  if (Number(initialContext.document?.activeView?.id) !== viewId) {
    throw new Error(`Live evidence requires Revit view ${viewId} to be active before the run; view activation is an operator precondition, not certification evidence.`);
  }
  if (normalizedWindowsPath(String(initialContext.document?.path ?? "")) !== normalizedWindowsPath(disposableModelReal)) {
    throw new Error("The active Revit document is not the exact explicitly supplied disposable model copy.");
  }

  const observationCall: SpatialObservationCall = (route, method, body) => callStep("revit_observe_model", "observation", route, method, body);
  const observationResult = await observeModelV1({}, observationCall);
  const observation = parseText(observationResult as any);
  const observationImage = observationResult.content.find(item => item.type === "image");
  if (!observationImage) throw new Error("Spatial Observation v1 did not return an image artifact.");
  const observationImageBytes = Buffer.from(String(observationImage.data ?? ""), "base64");
  if (!observationImageBytes.length || observationImageBytes.toString("base64") !== observationImage.data) throw new Error("Spatial Observation v1 image payload is not canonical base64.");
  const observationImageSha256 = shaBytes(observationImageBytes);
  if (observation.imageSha256 !== observationImageSha256) throw new Error("Spatial Observation v1 image bytes do not match the native-signed capture digest.");
  const observationImageArtifact = store(path.posix.join(path.posix.dirname(outputRelative), "observation-image.json"), {
    schema: "revit-operator.epic-0437-observation-image.v1",
    mime_type: observationImage.mimeType,
    data_base64: observationImage.data,
    image_sha256: observationImageSha256
  });

  const readback = async (name: string): Promise<Record<string, any>> => {
    const call: SpatialObservationCall = (route, method, body) => callStep("revit_read_move_targets_certified", name, route, method, body);
    return parseText(await readCertifiedMoveTargetsV1(call) as any);
  };
  const initialReadback = await readback("readback-initial");
  const target = (initialReadback.targets as Array<Record<string, any>> | undefined)?.find(item => item.elementId === targetId);
  if (!target || target.sourceScopedId !== `host:${targetId}` || target.pinned !== false || target.groupIdReadSucceeded !== true || target.groupId !== null) {
    throw new Error("Explicit disposable target is not a fresh, unpinned, known-ungrouped host LocationPoint target.");
  }
  const start = point(target.pointXyz, "initial target point");
  const vector: Point = { x: 0.25, y: 0, z: 0 };

  const previewCall = await moveStep("move-preview", "preview", targetId, initialReadback.observationId, vector);
  const preview = validateMoveResult(previewCall.result, targetId, vector, true);
  if (!previewCall.previewReceipt || !same(preview.before, start)) throw new Error("Typed preview did not mint exact native rollback lineage from the fresh target state.");
  const rollbackReadback = await readback("readback-rollback");
  const rollbackTarget = (rollbackReadback.targets as Array<Record<string, any>>).find(item => item.elementId === targetId);
  if (!rollbackTarget || !same(point(rollbackTarget.pointXyz, "rollback readback"), start)) throw new Error("Independent readback did not prove exact rollback.");

  const recoveryRelative = outputRelative.replace(/\.json$/, ".recovery.json");
  const recoveryPath = exactPath(repoRoot, recoveryRelative);
  let recovery: Record<string, unknown> = {
    schema: "revit-operator.epic-0437-move-recovery.v2", evidence_run_id: runId, level,
    document_fingerprint: initialFingerprint,
    document_session_id: initialContext.document?.sessionId, view_id: viewId, target_id: targetId, source_scoped_id: target.sourceScopedId,
    disposable_model_path: disposableModelReal, disposable_model_sha256: disposableModelSha256Before,
    start, vector, preview_result: previewCall.result, preview_result_sha256: sha(canonicalToolExposureJson(previewCall.result)),
    state: level === "L3" ? "preview_only" : "prepared", updated_at_utc: new Date().toISOString()
  };
  let recoverySha = writeJsonAtomic(recoveryPath, recovery);
  let apply: Record<string, unknown> | null = null;
  let restoreRequired = false;

  const currentTargetPoint = async (name: string): Promise<{ observation: Record<string, any>; point: Point }> => {
    const fresh = await readback(name);
    const item = (fresh.targets as Array<Record<string, any>>).find(value => value.elementId === targetId);
    if (!item) throw new Error("Recovery readback lost the exact disposable target.");
    return { observation: fresh, point: point(item.pointXyz, `${name} point`) };
  };
  const saveRecovery = (state: string, details: Record<string, unknown> = {}): void => {
    recovery = { ...recovery, ...details, state, updated_at_utc: new Date().toISOString() };
    recoverySha = writeJsonAtomic(recoveryPath, recovery);
  };
  const saveTerminalRecovery = (state: "restored" | "restored_after_failure", restoredPoint: Point, terminalMoveResult: Record<string, unknown>): void => {
    recovery = {
      schema: "revit-operator.epic-0437-move-recovery.v2", evidence_run_id: runId, level,
      document_fingerprint: initialFingerprint,
      document_session_id: initialContext.document?.sessionId, view_id: viewId, target_id: targetId, source_scoped_id: target.sourceScopedId,
      disposable_model_path: disposableModelReal, disposable_model_sha256: disposableModelSha256Before,
      start, vector, preview_result: previewCall.result, preview_result_sha256: sha(canonicalToolExposureJson(previewCall.result)),
      state, updated_at_utc: new Date().toISOString(), restored_point: restoredPoint,
      terminal_move_result: terminalMoveResult,
      terminal_move_result_sha256: sha(canonicalToolExposureJson(terminalMoveResult))
    };
    recoverySha = writeJsonAtomic(recoveryPath, recovery);
  };

  try {
    if (level === "L4") {
      // Persist intent and assume reconciliation is required before dispatch;
      // a committed mutation may occur even when no response is returned.
      restoreRequired = true;
      saveRecovery("apply_dispatching", { committed_point: plus(start, vector), retryable: false, outcome_unknown: true });
      const applyCall = await moveStep("move-apply", "apply", targetId, initialReadback.observationId, vector, previewCall.previewReceipt);
      const committed = validateMoveResult(applyCall.result, targetId, vector, false);
      if (!same(committed.before, start)) throw new Error("Committed move did not begin at the independently read starting point.");
      saveRecovery("committed", { committed_point: committed.after, apply_result_sha256: sha(canonicalToolExposureJson(applyCall.result)) });
      const committedReadback = await currentTargetPoint("readback-committed");
      if (!same(committedReadback.point, committed.after)) throw new Error("Independent readback did not prove the exact committed displacement.");

      const inverse = minus(vector);
      const restorePreviewCall = await moveStep("restore-preview", "preview", targetId, committedReadback.observation.observationId, inverse);
      const restorePreview = validateMoveResult(restorePreviewCall.result, targetId, inverse, true);
      if (!restorePreviewCall.previewReceipt || !same(restorePreview.before, committed.after)) throw new Error("Inverse restore preview did not begin at the committed point.");
      const stillCommitted = await currentTargetPoint("readback-still-committed");
      if (!same(stillCommitted.point, committed.after)) throw new Error("Inverse preview rollback did not preserve the committed point.");
      const restoreCall = await moveStep("restore-apply", "apply", targetId, committedReadback.observation.observationId, inverse, restorePreviewCall.previewReceipt);
      const restored = validateMoveResult(restoreCall.result, targetId, inverse, false);
      const restoredReadback = await currentTargetPoint("readback-restored");
      if (!same(restored.before, committed.after) || !same(restored.after, start) || !same(restoredReadback.point, start)) throw new Error("Exact inverse restoration was not independently proven.");
      restoreRequired = false;
      saveTerminalRecovery("restored", restoredReadback.point, restoreCall.result);
      apply = {
        result: applyCall.result, committed_point: committedReadback.point,
        committed_readback_observation_id: committedReadback.observation.observationId,
        restore_preview_result: restorePreviewCall.result,
        restore_result: restoreCall.result, restored_point: restoredReadback.point,
        restored_readback_observation_id: restoredReadback.observation.observationId
      };
    }
  } catch (error) {
    saveRecovery("reconciliation_required", { error: error instanceof Error ? error.message : String(error), retryable: false, outcome_unknown: true });
    if (level === "L4") {
      try {
        const reconciled = await currentTargetPoint(`recovery-readback-${sequence + 1}`);
        if (same(reconciled.point, start)) {
          restoreRequired = false;
          saveRecovery("manual_close_without_save_required", { observed_safe_point: reconciled.point, retryable: false, outcome_unknown: false });
        } else if (!same(reconciled.point, plus(start, vector))) {
          throw new Error("Target is at neither the exact starting nor committed point; manual reconciliation is required.");
        } else {
          const inverse = minus(vector);
          const recoveryPreview = await moveStep(`recovery-restore-preview-${sequence + 1}`, "preview", targetId, reconciled.observation.observationId, inverse);
          if (!recoveryPreview.previewReceipt) throw new Error("Recovery restore preview did not issue lineage.");
          const recoveryApply = await moveStep(`recovery-restore-apply-${sequence + 1}`, "apply", targetId, reconciled.observation.observationId, inverse, recoveryPreview.previewReceipt);
          validateMoveResult(recoveryApply.result, targetId, inverse, false);
          const final = await currentTargetPoint(`recovery-readback-restored-${sequence + 1}`);
          if (!same(final.point, start)) throw new Error("Recovery restore readback did not prove the starting point.");
          restoreRequired = false;
          saveTerminalRecovery("restored_after_failure", final.point, recoveryApply.result);
        }
      } catch (recoveryError) {
        saveRecovery("manual_reconciliation_required", { recovery_error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError), retryable: false, outcome_unknown: true });
      }
    }
    throw error;
  }

  const finalContext = await callStep("revit_get_context", "context-after", "/revit/context", "GET");
  const disposableModelSha256After = shaBytes(fs.readFileSync(disposableModelReal));
  const fingerprint = String(initialContext.document?.projectIdentity?.fingerprint ?? "");
  const normalizedFingerprint = fingerprint.startsWith("sha256:") ? fingerprint : `sha256:${fingerprint}`;
  if (initialContext.document?.sessionId !== finalContext.document?.sessionId) throw new Error("Document session changed during live evidence.");
  const expectedNames = level === "L3"
    ? ["context-before", "observation", "readback-initial", "move-preview", "readback-rollback", "context-after"]
    : ["context-before", "observation", "readback-initial", "move-preview", "readback-rollback", "move-apply", "readback-committed", "restore-preview", "readback-still-committed", "restore-apply", "readback-restored", "context-after"];
  if (JSON.stringify(steps.map(step => step.name)) !== JSON.stringify(expectedNames)) throw new Error("Successful live evidence step graph is not exact.");
  const run = {
    schema: "revit-operator.epic-0437-live-evidence-run.v2", evidence_run_id: runId, level,
    transport: level === "L3" ? "direct_protected_native" : "courier_sidecar",
    candidate_source_hash: "sha256:daec4b624b7a0ca07d67fe78bd4f56bf5e5277e7254dfcddf0acc31c344604cc",
    runtime: { mode: "development", exposure_profile: "laboratory", protected_evidence: true, production_certified: false },
    document: { title: initialContext.document.title, path: initialContext.document.path, fingerprint: normalizedFingerprint,
      session_id: initialContext.document.sessionId, final_session_id: finalContext.document?.sessionId,
      native_attestation: bootstrapAttestation, disposable_model_path: disposableModelReal,
      disposable_model_sha256_before: disposableModelSha256Before, disposable_model_sha256_after: disposableModelSha256After },
    view: { id: viewId, name: observation.view?.name ?? observation.viewName, type: observation.view?.type ?? observation.viewType },
    observation: { alias: "revit_observe_model", observation_id: observation.observationId, count: observation.count,
      scanned: observation.scanned, certified_target_count: observation.certifiedTargetCount, image_sha256: observationImageSha256,
      image_artifact_path: observationImageArtifact.path, image_artifact_sha256: observationImageArtifact.sha256 },
    readback: { alias: "revit_read_move_targets_certified", observation_id: initialReadback.observationId,
      target_count: initialReadback.targets.length, selection_basis: "explicit-operator-confirmed-disposable-target", selected_target: target },
    preview: { alias: "revit_move_one_certified", result: previewCall.result,
      rollback_readback_observation_id: rollbackReadback.observationId, rollback_point: start },
    apply, steps,
    recovery: { path: recoveryRelative, sha256: recoverySha, final_state: recovery.state },
    completed_at_utc: new Date().toISOString()
  };
  const outputSha = writeJsonAtomic(outputPath, run);
  process.stdout.write(json({ output: outputRelative, sha256: outputSha, level, element_id: targetId,
    rollback_verified: true, committed_and_restored: apply !== null, recovery_state: recovery.state,
    promotion: "requires detached authorization from the independently trusted hardware/offline signer" }));
}

main().catch(error => { process.stderr.write(`EPIC-0437 live evidence failed: ${String(error)}\n`); process.exitCode = 1; });
