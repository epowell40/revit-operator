import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CERTIFICATION_LEVELS,
  canonicalJson,
  computeEffectHash,
  parseToolCertificationEvidence,
  sealEvidenceRecord,
  sha256NormalizedText,
  type CertificationEvidenceArtifact,
  type CertificationLevel,
  type ExposureChannel,
  type JsonValue,
  type ToolCertificationCandidate,
  type ToolCertificationCandidatesFile,
  type ToolCertificationEvidenceFile,
  type ToolVisibility
} from "./tool_certification.js";
import {
  verifyLaboratoryExecutionReceipt,
  type TrustedNativeAttestationBinding
} from "../courier/laboratory_execution_receipt.js";
import { EPIC_0437_CANDIDATE_SOURCE_HASH } from "../courier/laboratory_evidence.js";
import { BUNDLED_TOOL_EXPOSURE_POLICY_HASH, parseTrustedToolExposurePolicy } from "./trusted_tool_exposure_policy.js";
import { parseAndVerifyEpic0437PromotionAuthorization } from "./epic_0437_promotion_authority.js";
import { EPIC_0437_NATIVE_BUILD_MANIFEST_PATH, epic0437SourceInputHash, validateEpic0437NativeBuildManifest } from "./epic_0437_source_provenance.js";

type ProofProfile = {
  method: string;
  path: string;
  request_hash: string;
  effect_hash: string;
  effect: JsonValue;
  requested_channels: ExposureChannel[];
  visibility: ToolVisibility;
  artifacts: CertificationEvidenceArtifact[];
};

export type CertificationProofIndex = {
  schema: "revit-operator.tool-certification-proofs.v1";
  candidate_source_hash: string;
  records: ProofProfile[];
};

type ProofArtifact = {
  schema: "revit-operator.certification-proof-artifact.v1";
  level: CertificationLevel;
  candidate: { method: string; path: string; request_hash: string; effect_hash: string };
  status: "passed";
  producer: { kind: "source_audit" | "compiler_validation" | "automated_test" | "live_revit" | "sidecar_workflow"; command: string };
  inputs: Array<{ path: string; sha256: string; normalization?: "epic-0437-generated-policy-anchor-masked.v1" }>;
  result: { passed: true; [key: string]: JsonValue };
};

const levelProducer: Record<CertificationLevel, ProofArtifact["producer"]["kind"]> = {
  L0: "source_audit", L1: "compiler_validation", L2: "automated_test", L3: "live_revit", L4: "sidecar_workflow", L5: "sidecar_workflow"
};
const shaPattern = /^sha256:[0-9a-f]{64}$/;

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${location} keys are not exact`);
}
function string(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")) throw new Error(`${location} must be a nonempty NFC string`);
  return value;
}
function sha(value: unknown, location: string): string {
  const parsed = string(value, location);
  if (!shaPattern.test(parsed)) throw new Error(`${location} must be sha256:<64 lowercase hex>`);
  return parsed;
}
function relativeFile(value: unknown, location: string, prefix?: string): string {
  const parsed = string(value, location);
  if (parsed.includes("\\") || parsed.startsWith("/") || /^[A-Za-z]:/.test(parsed)
    || parsed.split("/").some(part => !part || part === "." || part === "..")
    || (prefix && !parsed.startsWith(prefix))) throw new Error(`${location} is not a bounded repository-relative path`);
  return parsed;
}
function resolveInside(repoRoot: string, relative: string): string {
  const resolved = path.resolve(repoRoot, relative);
  const prefix = path.resolve(repoRoot) + path.sep;
  if (!resolved.startsWith(prefix)) throw new Error(`Certification proof path escapes repository root: ${relative}`);
  return resolved;
}
function identity(value: Pick<ProofProfile, "method" | "path" | "request_hash" | "effect_hash">): string {
  return `${value.method}\n${value.path}\n${value.request_hash}\n${value.effect_hash}`;
}

const EPIC_0437_OBSERVATION_REQUEST = "sha256:5d7a88495a5d3d5c40115c62892c4e34a5ee59fcff74b4c7e1f6ff9307478045";
const EPIC_0437_PREVIEW_REQUEST = "sha256:c2dbe12c7df5ca552f102135d7b61c3568c707d66821d180af929698a50c18ea";
const EPIC_0437_APPLY_REQUEST = "sha256:3fdfdce0e4792c8dff28d4532ac48ad01243a9c1d6289a257e2b59972b29091d";

function finitePoint(value: unknown, location: string): { x: number; y: number; z: number } {
  const point = object(value, location);
  exact(point, ["x", "y", "z"], location);
  if (![point.x, point.y, point.z].every(item => typeof item === "number" && Number.isFinite(item))) throw new Error(`${location} is not a finite XYZ point`);
  return point as { x: number; y: number; z: number };
}
function locationPoint(value: unknown, location: string): { x: number; y: number; z: number } {
  const snapshot = object(value, location);
  if (snapshot.kind !== "LocationPoint" || !Array.isArray(snapshot.pointXyz) || snapshot.pointXyz.length !== 3 || !snapshot.pointXyz.every(item => typeof item === "number" && Number.isFinite(item))) throw new Error(`${location} is not an exact LocationPoint snapshot`);
  return { x: snapshot.pointXyz[0] as number, y: snapshot.pointXyz[1] as number, z: snapshot.pointXyz[2] as number };
}
function samePoint(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): boolean {
  return Math.abs(left.x - right.x) <= 1e-9 && Math.abs(left.y - right.y) <= 1e-9 && Math.abs(left.z - right.z) <= 1e-9;
}
function validateMoveProjection(value: unknown, elementId: number, before: { x: number; y: number; z: number }, vectorX: number, rolledBack: boolean, location: string): { x: number; y: number; z: number } {
  const result = object(value, location);
  if (result.rolledBack !== rolledBack || result.movedTogether !== false || !Array.isArray(result.movedIds) || result.movedIds.length !== 1 || result.movedIds[0] !== elementId || !Array.isArray(result.skipped) || result.skipped.length !== 0 || !Array.isArray(result.snapshots) || result.snapshots.length !== 1) throw new Error(`${location} does not prove one exact target outcome`);
  const snapshot = object(result.snapshots[0], `${location}.snapshots[0]`);
  if (snapshot.id !== elementId || !samePoint(locationPoint(snapshot.before, `${location}.before`), before)) throw new Error(`${location} starting target state is not exact`);
  const after = locationPoint(snapshot.after, `${location}.after`);
  if (!samePoint(after, { x: before.x + vectorX, y: before.y, z: before.z })) throw new Error(`${location} displacement is not exact`);
  return after;
}

export function validateEpic0437LiveEvidenceRun(
  repoRoot: string,
  relativeRunPath: string,
  expectedSha: string,
  level: "L3" | "L4",
  trustedNativeAttestation?: TrustedNativeAttestationBinding
): Record<string, unknown> {
  if (!trustedNativeAttestation) throw new Error("EPIC-0437 live evidence requires an independently authenticated live-process key pin");
  const runPath = resolveInside(repoRoot, relativeFile(relativeRunPath, "EPIC-0437 run path", "artifacts/certification/epic-0437/runs/"));
  const raw = fs.readFileSync(runPath, "utf8");
  if (sha256NormalizedText(raw) !== expectedSha) throw new Error("EPIC-0437 live run receipt hash mismatch");
  const run = object(JSON.parse(raw.replace(/^\uFEFF/, "")), relativeRunPath);
  exact(run, ["schema", "evidence_run_id", "level", "transport", "candidate_source_hash", "runtime", "document", "view", "observation", "readback", "preview", "apply", "steps", "recovery", "completed_at_utc"], relativeRunPath);
  if (run.schema !== "revit-operator.epic-0437-live-evidence-run.v2" || run.candidate_source_hash !== EPIC_0437_CANDIDATE_SOURCE_HASH
    || !/^[0-9a-f]{32}$/.test(String(run.evidence_run_id)) || run.level !== level
    || run.transport !== (level === "L3" ? "direct_protected_native" : "courier_sidecar")) throw new Error("EPIC-0437 live run identity, source, or transport is invalid");
  const runtime = object(run.runtime, `${relativeRunPath}.runtime`);
  exact(runtime, ["mode", "exposure_profile", "protected_evidence", "production_certified"], `${relativeRunPath}.runtime`);
  if (runtime.mode !== "development" || runtime.exposure_profile !== "laboratory" || runtime.protected_evidence !== true || runtime.production_certified !== false) throw new Error("EPIC-0437 live run falsely claims a production-certified lane");
  const document = object(run.document, `${relativeRunPath}.document`);
  exact(document, ["title", "path", "fingerprint", "session_id", "final_session_id", "native_attestation"], `${relativeRunPath}.document`);
  if (document.title !== "Snowdon Towers Sample HVAC" || !shaPattern.test(String(document.fingerprint)) || !/^[0-9a-f]{32}$/.test(String(document.session_id)) || document.final_session_id !== document.session_id) throw new Error("EPIC-0437 live run document/session binding is invalid");
  const attestation = object(document.native_attestation, `${relativeRunPath}.document.native_attestation`);
  if (attestation.schema !== "revit-operator.native-execution-attestation-key.v1" || attestation.algorithm !== trustedNativeAttestation.algorithm
    || attestation.key_id !== trustedNativeAttestation.key_id || attestation.modulus_base64url !== trustedNativeAttestation.modulus_base64url
    || attestation.exponent_base64url !== trustedNativeAttestation.exponent_base64url) throw new Error("EPIC-0437 live run native attestation is not the independently trusted live process key");
  const view = object(run.view, `${relativeRunPath}.view`);
  exact(view, ["id", "name", "type"], `${relativeRunPath}.view`);
  if (!Number.isSafeInteger(view.id) || !["FloorPlan", "CeilingPlan"].includes(String(view.type))) throw new Error("EPIC-0437 live run requires a supported plan view");
  const observation = object(run.observation, `${relativeRunPath}.observation`);
  exact(observation, ["alias", "observation_id", "count", "scanned", "certified_target_count", "image_sha256", "image_artifact_path", "image_artifact_sha256"], `${relativeRunPath}.observation`);
  if (observation.alias !== "revit_observe_model" || typeof observation.observation_id !== "string" || !Number.isSafeInteger(observation.count) || (observation.count as number) <= 0 || !Number.isSafeInteger(observation.certified_target_count) || (observation.certified_target_count as number) <= 0 || !shaPattern.test(String(observation.image_sha256))) throw new Error("EPIC-0437 observation evidence is incomplete");
  const imageRelative = relativeFile(observation.image_artifact_path, "EPIC-0437 observation image artifact", "artifacts/certification/epic-0437/runs/");
  const imageArtifactRaw = fs.readFileSync(resolveInside(repoRoot, imageRelative), "utf8");
  if (sha256NormalizedText(imageArtifactRaw) !== sha(observation.image_artifact_sha256, "EPIC-0437 observation image artifact hash")) throw new Error("EPIC-0437 observation image artifact hash mismatch");
  const imageArtifact = object(JSON.parse(imageArtifactRaw), "EPIC-0437 observation image artifact");
  exact(imageArtifact, ["schema", "mime_type", "data_base64", "image_sha256"], "EPIC-0437 observation image artifact");
  if (imageArtifact.schema !== "revit-operator.epic-0437-observation-image.v1"
    || (imageArtifact.mime_type !== "image/png" && imageArtifact.mime_type !== "image/jpeg")
    || typeof imageArtifact.data_base64 !== "string") throw new Error("EPIC-0437 observation image artifact is malformed");
  const imageBytes = Buffer.from(imageArtifact.data_base64, "base64");
  const imageDigest = `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`;
  if (!imageBytes.length || imageBytes.toString("base64") !== imageArtifact.data_base64
    || imageArtifact.image_sha256 !== imageDigest || observation.image_sha256 !== imageDigest) throw new Error("EPIC-0437 observation image bytes are not exact");
  const readback = object(run.readback, `${relativeRunPath}.readback`);
  exact(readback, ["alias", "observation_id", "target_count", "selection_basis", "selected_target"], `${relativeRunPath}.readback`);
  if (readback.alias !== "revit_read_move_targets_certified" || !Number.isSafeInteger(readback.target_count) || (readback.target_count as number) <= 0) throw new Error("EPIC-0437 resolver/readback evidence is incomplete");
  const target = object(readback.selected_target, `${relativeRunPath}.readback.selected_target`);
  exact(target, ["observationId", "sourceScopedId", "elementId", "pointXyz", "pinned", "groupIdReadSucceeded", "groupId", "category", "familyName", "typeName"], `${relativeRunPath}.readback.selected_target`);
  if (readback.selection_basis !== "explicit-operator-confirmed-disposable-target" || !Number.isSafeInteger(target.elementId)
    || target.sourceScopedId !== `host:${target.elementId}` || target.observationId !== readback.observation_id
    || target.pinned !== false || target.groupIdReadSucceeded !== true || target.groupId !== null) throw new Error("EPIC-0437 selected target is not an explicit known-safe host observation output");
  const elementId = target.elementId as number;
  const start = finitePoint(target.pointXyz, `${relativeRunPath}.readback.selected_target.pointXyz`);
  const preview = object(run.preview, `${relativeRunPath}.preview`);
  exact(preview, ["alias", "result", "rollback_readback_observation_id", "rollback_point"], `${relativeRunPath}.preview`);
  if (preview.alias !== "revit_move_one_certified" || typeof preview.rollback_readback_observation_id !== "string" || !samePoint(finitePoint(preview.rollback_point, `${relativeRunPath}.preview.rollback_point`), start)) throw new Error("EPIC-0437 rollback readback evidence is invalid");
  validateMoveProjection(preview.result, elementId, start, 0.25, true, `${relativeRunPath}.preview.result`);
  if (level === "L3" && run.apply !== null) throw new Error("EPIC-0437 L3 must not claim a committed move");
  if (level === "L4") {
    const apply = object(run.apply, `${relativeRunPath}.apply`);
    exact(apply, ["result", "committed_point", "committed_readback_observation_id", "restore_preview_result", "restore_result", "restored_point", "restored_readback_observation_id"], `${relativeRunPath}.apply`);
    const committed = validateMoveProjection(apply.result, elementId, start, 0.25, false, `${relativeRunPath}.apply.result`);
    if (!samePoint(finitePoint(apply.committed_point, `${relativeRunPath}.apply.committed_point`), committed) || typeof apply.committed_readback_observation_id !== "string") throw new Error("EPIC-0437 committed move readback is invalid");
    validateMoveProjection(apply.restore_preview_result, elementId, committed, -0.25, true, `${relativeRunPath}.apply.restore_preview_result`);
    const restored = validateMoveProjection(apply.restore_result, elementId, committed, -0.25, false, `${relativeRunPath}.apply.restore_result`);
    if (!samePoint(restored, start) || !samePoint(finitePoint(apply.restored_point, `${relativeRunPath}.apply.restored_point`), start) || typeof apply.restored_readback_observation_id !== "string") throw new Error("EPIC-0437 committed move was not exactly restored");
  }
  const recovery = object(run.recovery, `${relativeRunPath}.recovery`);
  exact(recovery, ["path", "sha256", "final_state"], `${relativeRunPath}.recovery`);
  const expectedRecovery = level === "L3" ? "preview_only" : "restored";
  if (recovery.final_state !== expectedRecovery) throw new Error("EPIC-0437 live run did not finish in the exact safe recovery state");
  const recoveryRelative = relativeFile(recovery.path, "EPIC-0437 recovery path", "artifacts/certification/epic-0437/runs/");
  const recoveryRaw = fs.readFileSync(resolveInside(repoRoot, recoveryRelative), "utf8");
  if (sha256NormalizedText(recoveryRaw) !== sha(recovery.sha256, "EPIC-0437 recovery hash")) throw new Error("EPIC-0437 recovery state hash mismatch");
  const recoveryState = object(JSON.parse(recoveryRaw), "EPIC-0437 recovery state");
  if (recoveryState.evidence_run_id !== run.evidence_run_id || recoveryState.state !== expectedRecovery || recoveryState.target_id !== elementId) throw new Error("EPIC-0437 recovery state does not bind the exact safe terminal run");

  const expectedSteps = level === "L3"
    ? ["context-before", "activate-view", "observation", "readback-initial", "move-preview", "readback-rollback", "context-after"]
    : ["context-before", "activate-view", "observation", "readback-initial", "move-preview", "readback-rollback", "move-apply", "readback-committed", "restore-preview", "readback-still-committed", "restore-apply", "readback-restored", "context-after"];
  if (!Array.isArray(run.steps) || JSON.stringify(run.steps.map((value: unknown) => object(value, "EPIC-0437 step").name)) !== JSON.stringify(expectedSteps)) throw new Error("EPIC-0437 live run step graph is not exact");
  const dispatches = new Set<string>();
  const signedResults = new Map<string, Record<string, unknown>>();
  const signedReceipts = new Map<string, Record<string, unknown>>();
  const currentPolicy = parseTrustedToolExposurePolicy(JSON.parse(fs.readFileSync(
    path.join(repoRoot, "apps/operator-backend/config/tool_exposure_policy.v1.json"), "utf8")));
  if (currentPolicy.policy_hash !== BUNDLED_TOOL_EXPOSURE_POLICY_HASH) throw new Error("EPIC-0437 evidence policy is not the current bundled trust anchor");
  const trustedBuild = validateEpic0437NativeBuildManifest(repoRoot, EPIC_0437_CANDIDATE_SOURCE_HASH);
  const expectedNativeBuild = {
    native_common_assembly_sha256: trustedBuild.manifest.binaries.common.sha256,
    native_logic_assembly_sha256: trustedBuild.manifest.binaries.logic.sha256,
    native_bridge_assembly_sha256: trustedBuild.manifest.binaries.bridge.sha256
  };
  const observationBody = { imageSize: 2200, limit: 500, includeMapping: true, includeGeometry: true };
  const moveBody = (vectorX: number, dryRun: boolean) => ({ ids: [elementId], mode: "vector", vectorX, vectorY: 0, vectorZ: 0,
    dryRun, behavior: "allOrNothing", moveTogether: false, options: { failOnPinned: true, unpinIfAllowed: false } });
  const expectedStep = (name: string): { method: string; path: string; alias: string; phase: string; effectHash?: string; body?: JsonValue } => {
    if (name === "context-before" || name === "context-after") return { method: "GET", path: "/revit/context", alias: "revit_get_context", phase: "read" };
    if (name === "activate-view") return { method: "POST", path: "/revit/activate-view", alias: "revit_activate_view", phase: "apply", body: { viewId: view.id as number, zoomToFit: true } };
    if (name === "observation" || name.startsWith("readback-")) return { method: "POST", path: "/revit/export-visible-elements",
      alias: name === "observation" ? "revit_observe_model" : "revit_read_move_targets_certified", phase: "read",
      effectHash: "sha256:0f19ae675c51b10854e3977070ad34e4898a004c4a724058f933c17233f37bf8", body: observationBody };
    if (name === "move-preview") return { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified", phase: "preview",
      effectHash: "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b", body: moveBody(0.25, true) };
    if (name === "move-apply") return { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified", phase: "apply",
      effectHash: "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b", body: moveBody(0.25, false) };
    if (name === "restore-preview") return { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified", phase: "preview",
      effectHash: "sha256:4b9d9a0b4beb537b1db23b84aa3a2319497c0250fcc55ede2d87107d06ae428b", body: moveBody(-0.25, true) };
    if (name === "restore-apply") return { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified", phase: "apply",
      effectHash: "sha256:4da2bf877ae0747d17dec5123defd1912193bd2b9c59b57f7dd8d4aa7b7e1e7b", body: moveBody(-0.25, false) };
    throw new Error(`Unexpected EPIC-0437 evidence step: ${name}`);
  };
  let observedKey: TrustedNativeAttestationBinding | null = null;
  for (const [index, rawTransport] of run.steps.entries()) {
    const transport = object(rawTransport, `${relativeRunPath}.steps[${index}]`);
    exact(transport, ["name", "method", "path", "channel", "alias", "workflow", "request_body", "canonical_body_sha256", "dispatch_id", "correlation_id", "result_path", "result_sha256", "courier_job_path", "courier_job_sha256", "courier_result_path", "courier_result_sha256"], `${relativeRunPath}.steps[${index}]`);
    const name = string(transport.name, `${relativeRunPath}.steps[${index}].name`);
    const expected = expectedStep(name);
    const bodyMatches = expected.body === undefined
      ? transport.request_body === null
      : transport.request_body !== null && canonicalJson(transport.request_body as JsonValue) === canonicalJson(expected.body);
    if (transport.method !== expected.method || transport.path !== expected.path || transport.alias !== expected.alias
      || transport.channel !== "typed_mcp" || transport.workflow !== `epic-0437-${level.toLowerCase()}-${name}` || !bodyMatches) {
      throw new Error(`EPIC-0437 step ${name} changed its exact method/path/body/channel/alias/workflow identity`);
    }
    const dispatch = string(transport.dispatch_id, `${relativeRunPath}.steps[${index}].dispatch_id`);
    if (dispatch !== transport.correlation_id || dispatches.has(dispatch)) throw new Error("EPIC-0437 transport evidence is replayed or incomplete");
    dispatches.add(dispatch);
    const resultRelative = relativeFile(transport.result_path, "EPIC-0437 signed result", "artifacts/certification/epic-0437/runs/");
    const resultRaw = fs.readFileSync(resolveInside(repoRoot, resultRelative), "utf8");
    if (sha256NormalizedText(resultRaw) !== sha(transport.result_sha256, "EPIC-0437 signed result hash")) throw new Error("EPIC-0437 signed result artifact hash mismatch");
    const requestBody = transport.request_body === null ? undefined : transport.request_body;
    const expectedBodyHash = sha(transport.canonical_body_sha256, "EPIC-0437 canonical body hash");
    if (expectedBodyHash !== sha256NormalizedText(requestBody === undefined ? "" : canonicalJson(requestBody as JsonValue))) throw new Error("EPIC-0437 step canonical body digest is invalid");
    const verified = verifyLaboratoryExecutionReceipt(JSON.parse(resultRaw), {
      trustedNativeAttestation,
      method: string(transport.method, "EPIC-0437 step method"),
      path: string(transport.path, "EPIC-0437 step path"),
      channel: "typed_mcp",
      alias: string(transport.alias, "EPIC-0437 step alias"),
      ...(requestBody === undefined ? { bodyJson: "" } : { body: requestBody })
    });
    if (verified.receipt.canonical_body_sha256 !== expectedBodyHash || verified.receipt.dispatch_id !== dispatch
      || verified.receipt.document_fingerprint !== document.fingerprint || verified.receipt.document_session_id !== document.session_id
      || verified.receipt.native_common_assembly_sha256 !== expectedNativeBuild.native_common_assembly_sha256
      || verified.receipt.native_logic_assembly_sha256 !== expectedNativeBuild.native_logic_assembly_sha256
      || verified.receipt.native_bridge_assembly_sha256 !== expectedNativeBuild.native_bridge_assembly_sha256
      || verified.evidence.evidence_run_id !== run.evidence_run_id || verified.evidence.evidence_step !== name
      || verified.evidence.workflow !== transport.workflow || verified.evidence.channel !== transport.channel || verified.evidence.alias !== transport.alias
      || verified.evidence.transport_kind !== (level === "L3" ? "direct" : "courier")) throw new Error("EPIC-0437 signed receipt does not bind the exact step/request/document/transport identity");
    if (verified.receipt.phase !== expected.phase || (expected.effectHash && verified.receipt.effect_hash !== expected.effectHash)) throw new Error(`EPIC-0437 step ${name} signed the wrong phase or effect`);
    const stepPolicyRecord = currentPolicy.records.find(record => record.policy_record_hash === verified.evidence.policy_record_hash);
    if (verified.evidence.policy_hash !== currentPolicy.policy_hash || !stepPolicyRecord
      || stepPolicyRecord.evidence_record_hash !== verified.evidence.evidence_record_hash
      || stepPolicyRecord.effect_hash !== verified.evidence.effect_hash
      || stepPolicyRecord.effect_hash !== verified.receipt.effect_hash
      || stepPolicyRecord.method !== expected.method || stepPolicyRecord.path !== expected.path
      || !stepPolicyRecord.typed_mcp_aliases.includes(String(transport.alias))) {
      throw new Error(`EPIC-0437 step ${name} is stale or not bound to one exact current policy/effect/alias record`);
    }
    const isMove = expected.path === "/revit/move-elements";
    if (isMove !== (verified.receipt.laboratory_move_evidence !== null)) throw new Error(`EPIC-0437 step ${name} has the wrong typed-family evidence projection`);
    if (isMove) {
      const projection = object(verified.receipt.laboratory_move_evidence, `EPIC-0437 ${name} move projection`);
      exact(projection, [
        "admission_hash", "run_nonce", "request_family_id", "request_family_hash", "request_instance_hash", "admission_session_id",
        "phase", "effect_id", "effect_hash", "policy_hash", "policy_record_hash", "evidence_record_hash",
        "outbound_body_sha256", "document_fingerprint", "document_session_id", "source_scoped_id", "element_id",
        "observation_id", "observation_binding_hash", "native_attestation_key_id", "native_attestation_modulus_base64url",
        "native_attestation_exponent_base64url", "channel", "alias", "preview_lineage_receipt_hash"
      ], `EPIC-0437 ${name} move projection`);
      if (projection.request_family_id !== "revit-operator.certified-move-one.request-family.v1"
        || projection.request_family_hash !== "sha256:24906494c42d86326cfba2c4b76318e8172f83f9cb65cd8aa0c84f7e1281e0de"
        || projection.phase !== expected.phase || projection.effect_hash !== expected.effectHash
        || stepPolicyRecord.effect_hash !== projection.effect_hash
        || projection.policy_hash !== verified.evidence.policy_hash
        || projection.policy_record_hash !== verified.evidence.policy_record_hash
        || projection.evidence_record_hash !== verified.evidence.evidence_record_hash
        || projection.document_fingerprint !== document.fingerprint || projection.document_session_id !== document.session_id
        || projection.source_scoped_id !== `host:${elementId}` || projection.element_id !== elementId
        || projection.native_attestation_key_id !== trustedNativeAttestation.key_id
        || projection.native_attestation_modulus_base64url !== trustedNativeAttestation.modulus_base64url
        || projection.native_attestation_exponent_base64url !== trustedNativeAttestation.exponent_base64url
        || projection.channel !== "typed_mcp" || projection.alias !== "revit_move_one_certified"
        || (expected.phase === "preview" ? projection.preview_lineage_receipt_hash !== null : !shaPattern.test(String(projection.preview_lineage_receipt_hash)))) {
        throw new Error(`EPIC-0437 step ${name} does not prove the exact typed request-family/target/lineage identity`);
      }
      const expectedBody = expected.body as JsonValue;
      const outboundBodyHash = `sha256:${createHash("sha256").update(canonicalJson(expectedBody), "utf8").digest("hex")}`;
      const observationBindingHash = `sha256:${createHash("sha256").update([
        projection.observation_id, document.fingerprint, document.session_id, `host:${elementId}`, String(elementId), trustedNativeAttestation.key_id
      ].join("\n"), "utf8").digest("hex")}`;
      const previousName = name === "move-apply" ? "move-preview" : name === "restore-apply" ? "restore-preview" : null;
      const previousReceipt = previousName ? signedReceipts.get(previousName) : undefined;
      const previousReceiptJson = previousReceipt ? canonicalJson(previousReceipt as JsonValue) : null;
      const previousReceiptHash = previousReceiptJson ? `sha256:${createHash("sha256").update(previousReceiptJson, "utf8").digest("hex")}` : null;
      const previousProjection = previousReceipt ? object(previousReceipt.laboratory_move_evidence, `EPIC-0437 ${previousName} projection`) : null;
      if ((expected.phase === "apply" && (!previousReceipt || !previousProjection
          || projection.preview_lineage_receipt_hash !== previousReceiptHash))
        || (expected.phase === "preview" && previousReceipt !== undefined)) {
        throw new Error(`EPIC-0437 step ${name} does not consume the immediately preceding exact signed preview receipt`);
      }
      const request = {
        phase: expected.phase,
        documentFingerprint: document.fingerprint,
        documentSessionId: document.session_id,
        sourceScopedId: `host:${elementId}`,
        elementId,
        observationId: projection.observation_id,
        observationBindingHash,
        nativeAttestationKeyId: trustedNativeAttestation.key_id,
        nativeAttestationModulusBase64Url: trustedNativeAttestation.modulus_base64url,
        nativeAttestationExponentBase64Url: trustedNativeAttestation.exponent_base64url,
        vectorFeet: { x: Number((expected.body as Record<string, unknown>).vectorX), y: 0, z: 0 },
        ...(previousProjection ? {
          previewInstanceHash: previousProjection.request_instance_hash,
          previewReceiptHash: previousReceiptHash
        } : {})
      };
      const requestInstanceHash = `sha256:${createHash("sha256").update(canonicalJson({
        familyHash: projection.request_family_hash,
        admissionSessionId: projection.admission_session_id,
        request,
        outboundBody: expectedBody
      } as JsonValue), "utf8").digest("hex")}`;
      if (projection.outbound_body_sha256 !== outboundBodyHash || projection.observation_binding_hash !== observationBindingHash
        || projection.request_instance_hash !== requestInstanceHash || !/^[0-9a-f]{64}$/.test(String(projection.run_nonce))) {
        throw new Error(`EPIC-0437 step ${name} exact request instance/body/observation hash is invalid`);
      }
      const admissionPayload = {
        schema: "revit-operator.laboratory-move-evidence-admission.v1",
        candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
        policy_hash: projection.policy_hash,
        policy_record_hash: projection.policy_record_hash,
        evidence_record_hash: projection.evidence_record_hash,
        production_certified: false,
        evidence_run_id: run.evidence_run_id,
        run_nonce: projection.run_nonce,
        request_family_id: projection.request_family_id,
        request_family_hash: projection.request_family_hash,
        request_instance_hash: projection.request_instance_hash,
        admission_session_id: projection.admission_session_id,
        phase: projection.phase,
        effect_id: projection.effect_id,
        effect_hash: projection.effect_hash,
        method: "POST",
        path: "/revit/move-elements",
        outbound_body_sha256: projection.outbound_body_sha256,
        document_fingerprint: projection.document_fingerprint,
        document_session_id: projection.document_session_id,
        source_scoped_id: projection.source_scoped_id,
        element_id: projection.element_id,
        observation_id: projection.observation_id,
        observation_binding_hash: projection.observation_binding_hash,
        native_attestation_key_id: projection.native_attestation_key_id,
        native_attestation_modulus_base64url: projection.native_attestation_modulus_base64url,
        native_attestation_exponent_base64url: projection.native_attestation_exponent_base64url,
        channel: projection.channel,
        alias: projection.alias,
        preview_lineage: previousProjection ? {
          schema: "revit-operator.laboratory-move-preview-lineage.v1",
          preview_request_instance_hash: previousProjection.request_instance_hash,
          preview_execution_receipt_sha256: previousReceiptHash,
          preview_execution_receipt_json: previousReceiptJson
        } : null
      };
      const admissionHash = `sha256:${createHash("sha256").update(canonicalJson(admissionPayload as JsonValue), "utf8").digest("hex")}`;
      if (projection.admission_hash !== admissionHash) throw new Error(`EPIC-0437 step ${name} exact laboratory admission hash is invalid`);
    }
    signedResults.set(name, verified.result);
    signedReceipts.set(name, verified.receipt);
    observedKey ??= verified.key;
    if (JSON.stringify(observedKey) !== JSON.stringify(verified.key)) throw new Error("EPIC-0437 live process attestation key changed during the run");
    if (level === "L4") {
      const jobRelative = relativeFile(transport.courier_job_path, "EPIC-0437 courier job", "artifacts/certification/epic-0437/runs/");
      const durableRelative = relativeFile(transport.courier_result_path, "EPIC-0437 courier result", "artifacts/certification/epic-0437/runs/");
      const jobRaw = fs.readFileSync(resolveInside(repoRoot, jobRelative), "utf8");
      const durableRaw = fs.readFileSync(resolveInside(repoRoot, durableRelative), "utf8");
      if (sha256NormalizedText(jobRaw) !== sha(transport.courier_job_sha256, "EPIC-0437 courier job hash")
        || sha256NormalizedText(durableRaw) !== sha(transport.courier_result_sha256, "EPIC-0437 courier result hash")) throw new Error("EPIC-0437 courier artifact hash mismatch");
      const job = object(JSON.parse(jobRaw), "EPIC-0437 courier job");
      const durable = object(JSON.parse(durableRaw), "EPIC-0437 courier result");
      if (Object.prototype.hasOwnProperty.call(job, "turn_token") || job.version !== "revit-operator.revit-tool-job.v1"
        || job.id !== dispatch || job.correlation_id !== dispatch || job.laboratory_evidence === undefined
        || durable.version !== "revit-operator.revit-tool-result.v1" || durable.id !== dispatch || durable.correlation_id !== dispatch
        || durable.status !== "succeeded" || durable.outcome_unknown === true
        || JSON.stringify(durable.result) !== JSON.stringify(JSON.parse(resultRaw))) throw new Error("EPIC-0437 courier job/result is not exact token-free signed terminal evidence");
    } else if (transport.courier_job_path !== null || transport.courier_result_path !== null) {
      throw new Error("EPIC-0437 direct evidence cannot carry courier artifacts");
    }
  }
  const sameResult = (left: unknown, right: unknown) => canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
  if (!sameResult(signedResults.get("move-preview"), preview.result)) throw new Error("EPIC-0437 preview summary is not the signed native preview result");
  const observationNative = signedResults.get("observation")!;
  const initialNative = signedResults.get("readback-initial")!;
  if ((observationNative.frameId ?? observationNative.frame_id) !== observation.observation_id
    || observationNative.count !== observation.count || observationNative.scanned !== observation.scanned
    || observationNative.imageSha256 !== observation.image_sha256
    || (initialNative.frameId ?? initialNative.frame_id) !== readback.observation_id) throw new Error("EPIC-0437 observation/readback summary is not bound to the signed native results");
  const nativeTargetPoint = (name: string): { x: number; y: number; z: number } => {
    const native = signedResults.get(name)!;
    if (!Array.isArray(native.items)) throw new Error(`EPIC-0437 ${name} signed result has no native items`);
    const item = native.items.map((value, index) => object(value, `EPIC-0437 ${name}.items[${index}]`))
      .find(value => (value.elementId ?? value.element_id ?? value.id) === elementId);
    if (!item || (item.sourceScopedId ?? item.source_scoped_id) !== `host:${elementId}` || item.pinned !== false
      || item.groupIdReadSucceeded !== true || item.groupId !== null) throw new Error(`EPIC-0437 ${name} does not sign the exact known-safe target state`);
    const orientation = object(item.orientation, `EPIC-0437 ${name} target orientation`);
    if ((orientation.locationKind ?? orientation.location_kind) !== "point") throw new Error(`EPIC-0437 ${name} target is not point-located`);
    return finitePoint(orientation.locationPoint ?? orientation.location_point, `EPIC-0437 ${name} target point`);
  };
  if (!samePoint(nativeTargetPoint("readback-initial"), start)
    || !samePoint(nativeTargetPoint("readback-rollback"), start)
    || (signedResults.get("readback-rollback")!.frameId ?? signedResults.get("readback-rollback")!.frame_id) !== preview.rollback_readback_observation_id) {
    throw new Error("EPIC-0437 rollback readback summary is not the exact signed native target state");
  }
  if (level === "L4") {
    const apply = object(run.apply, `${relativeRunPath}.apply`);
    if (!sameResult(signedResults.get("move-apply"), apply.result)
      || !sameResult(signedResults.get("restore-preview"), apply.restore_preview_result)
      || !sameResult(signedResults.get("restore-apply"), apply.restore_result)) throw new Error("EPIC-0437 apply/restore summary is not the exact signed native result graph");
    const committedPoint = finitePoint(apply.committed_point, `${relativeRunPath}.apply.committed_point`);
    const restoredPoint = finitePoint(apply.restored_point, `${relativeRunPath}.apply.restored_point`);
    if (!samePoint(nativeTargetPoint("readback-committed"), committedPoint)
      || !samePoint(nativeTargetPoint("readback-still-committed"), committedPoint)
      || !samePoint(nativeTargetPoint("readback-restored"), restoredPoint)
      || (signedResults.get("readback-committed")!.frameId ?? signedResults.get("readback-committed")!.frame_id) !== apply.committed_readback_observation_id
      || (signedResults.get("readback-restored")!.frameId ?? signedResults.get("readback-restored")!.frame_id) !== apply.restored_readback_observation_id) {
      throw new Error("EPIC-0437 apply/restore readback summaries are not the exact signed native target states");
    }
  }
  return run;
}

export function parseCertificationProofIndex(value: unknown): CertificationProofIndex {
  const root = object(value, "proof index");
  exact(root, ["schema", "candidate_source_hash", "records"], "proof index");
  if (root.schema !== "revit-operator.tool-certification-proofs.v1") throw new Error("proof index schema is invalid");
  const candidateSourceHash = sha(root.candidate_source_hash, "proof index candidate_source_hash");
  if (!Array.isArray(root.records)) throw new Error("proof index records must be an array");
  const seen = new Set<string>();
  const records = root.records.map((raw, index) => {
    const location = `proof index records[${index}]`;
    const record = object(raw, location);
    exact(record, ["method", "path", "request_hash", "effect_hash", "effect", "requested_channels", "visibility", "artifacts"], location);
    const method = string(record.method, `${location}.method`);
    const toolPath = string(record.path, `${location}.path`);
    const requestHash = sha(record.request_hash, `${location}.request_hash`);
    const effectHash = sha(record.effect_hash, `${location}.effect_hash`);
    if (!Array.isArray(record.requested_channels) || !record.requested_channels.every(channel => ["search", "generic_call", "typed_mcp", "deterministic_workflow"].includes(String(channel)))) throw new Error(`${location}.requested_channels is invalid`);
    if (record.visibility !== "candidate" && record.visibility !== "workflow_only") throw new Error(`${location}.visibility is invalid`);
    if (!Array.isArray(record.artifacts)) throw new Error(`${location}.artifacts must be an array`);
    const artifacts = record.artifacts.map((rawArtifact, artifactIndex) => {
      const artifactLocation = `${location}.artifacts[${artifactIndex}]`;
      const artifact = object(rawArtifact, artifactLocation);
      exact(artifact, ["schema", "level", "path", "sha256"], artifactLocation);
      if (artifact.schema !== "revit-operator.certification-proof-artifact.v1" || !CERTIFICATION_LEVELS.includes(artifact.level as CertificationLevel)) throw new Error(`${artifactLocation} schema or level is invalid`);
      return {
        schema: artifact.schema,
        level: artifact.level,
        path: relativeFile(artifact.path, `${artifactLocation}.path`, "artifacts/certification/"),
        sha256: sha(artifact.sha256, `${artifactLocation}.sha256`)
      } as CertificationEvidenceArtifact;
    });
    const parsed = { method, path: toolPath, request_hash: requestHash, effect_hash: effectHash, effect: record.effect as JsonValue, requested_channels: record.requested_channels as ExposureChannel[], visibility: record.visibility, artifacts } as ProofProfile;
    const key = identity(parsed);
    if (seen.has(key)) throw new Error(`Duplicate proof index identity: ${key}`);
    seen.add(key);
    return parsed;
  });
  return { schema: root.schema, candidate_source_hash: candidateSourceHash, records };
}

function validateArtifact(repoRoot: string, reference: CertificationEvidenceArtifact, profile: ProofProfile): void {
  const artifactPath = resolveInside(repoRoot, reference.path);
  const raw = fs.readFileSync(artifactPath, "utf8");
  if (sha256NormalizedText(raw) !== reference.sha256) throw new Error(`Certification artifact hash mismatch: ${reference.path}`);
  const artifact = object(JSON.parse(raw.replace(/^\uFEFF/, "")), reference.path);
  exact(artifact, ["schema", "level", "candidate", "status", "producer", "inputs", "result"], reference.path);
  if (artifact.schema !== reference.schema || artifact.level !== reference.level || artifact.status !== "passed") throw new Error(`Certification artifact state mismatch: ${reference.path}`);
  const candidate = object(artifact.candidate, `${reference.path}.candidate`);
  exact(candidate, ["method", "path", "request_hash", "effect_hash"], `${reference.path}.candidate`);
  if (identity(candidate as ProofProfile) !== identity(profile)) throw new Error(`Certification artifact candidate mismatch: ${reference.path}`);
  const producer = object(artifact.producer, `${reference.path}.producer`);
  exact(producer, ["kind", "command"], `${reference.path}.producer`);
  if (producer.kind !== levelProducer[reference.level] || !string(producer.command, `${reference.path}.producer.command`)) throw new Error(`Certification artifact producer mismatch: ${reference.path}`);
  if (!Array.isArray(artifact.inputs) || artifact.inputs.length === 0) throw new Error(`Certification artifact has no bound inputs: ${reference.path}`);
  for (const [index, rawInput] of artifact.inputs.entries()) {
    const input = object(rawInput, `${reference.path}.inputs[${index}]`);
    const normalization = input.normalization;
    exact(input, normalization === undefined ? ["path", "sha256"] : ["path", "sha256", "normalization"], `${reference.path}.inputs[${index}]`);
    const inputPath = relativeFile(input.path, `${reference.path}.inputs[${index}].path`);
    const expected = sha(input.sha256, `${reference.path}.inputs[${index}].sha256`);
    const actual = normalization === undefined
      ? sha256NormalizedText(fs.readFileSync(resolveInside(repoRoot, inputPath), "utf8"))
      : epic0437SourceInputHash(repoRoot, inputPath, string(normalization, `${reference.path}.inputs[${index}].normalization`) as "epic-0437-generated-policy-anchor-masked.v1");
    if (actual !== expected) throw new Error(`Certification artifact input is stale: ${inputPath}`);
  }
  const result = object(artifact.result, `${reference.path}.result`);
  if (result.passed !== true) throw new Error(`Certification artifact did not prove a pass: ${reference.path}`);
  if (reference.level === "L3" || reference.level === "L4") {
    exact(result, ["passed", "evidence_schema", "run_receipt_path", "run_receipt_sha256", "capability", "promotion_authorization"], `${reference.path}.result`);
    if (result.evidence_schema !== "revit-operator.epic-0437-live-evidence-run.v2") throw new Error(`Certification artifact live schema mismatch: ${reference.path}`);
    const capability = profile.request_hash === EPIC_0437_OBSERVATION_REQUEST ? "observation_readback" : profile.request_hash === EPIC_0437_PREVIEW_REQUEST ? "move_preview" : profile.request_hash === EPIC_0437_APPLY_REQUEST ? "move_apply" : null;
    if (!capability || result.capability !== capability) throw new Error(`Certification artifact capability mismatch: ${reference.path}`);
    const authorization = parseAndVerifyEpic0437PromotionAuthorization(result.promotion_authorization);
    const build = validateEpic0437NativeBuildManifest(repoRoot, EPIC_0437_CANDIDATE_SOURCE_HASH);
    const payload = authorization.payload;
    if (payload.level !== reference.level || payload.evidence_run_id.length !== 32
      || payload.candidate_source_hash !== EPIC_0437_CANDIDATE_SOURCE_HASH || payload.policy_hash !== BUNDLED_TOOL_EXPOSURE_POLICY_HASH
      || payload.native_build_manifest_path !== EPIC_0437_NATIVE_BUILD_MANIFEST_PATH || payload.native_build_manifest_sha256 !== build.sha256
      || payload.run_receipt_path !== result.run_receipt_path || payload.run_receipt_sha256 !== result.run_receipt_sha256
      || identity(payload.candidate as ProofProfile) !== identity(profile) || payload.capability !== capability) {
      throw new Error(`Certification artifact promotion authorization does not bind the exact current candidate/run/policy/build: ${reference.path}`);
    }
    const run = validateEpic0437LiveEvidenceRun(
      repoRoot,
      String(result.run_receipt_path),
      sha(result.run_receipt_sha256, `${reference.path}.result.run_receipt_sha256`),
      reference.level,
      payload.native_attestation
    );
    if (run.evidence_run_id !== payload.evidence_run_id || Date.parse(payload.issued_at_utc) < Date.parse(String(run.completed_at_utc))
      || Date.parse(payload.issued_at_utc) > Date.now() + 30_000) throw new Error(`Certification artifact promotion time/run identity is invalid: ${reference.path}`);
  }
}

export function compileArtifactBoundEvidence(input: {
  candidates: ToolCertificationCandidatesFile;
  candidateSourceHash: string;
  baseline: ToolCertificationEvidenceFile;
  proofIndex: CertificationProofIndex;
  repoRoot: string;
}): ToolCertificationEvidenceFile {
  if (input.proofIndex.candidate_source_hash !== input.candidateSourceHash) throw new Error("Certification proof index is stale for the candidate source");
  const baselineByIdentity = new Map(input.baseline.records.map(record => [identity(record), record]));
  const proofsByIdentity = new Map(input.proofIndex.records.map(record => [identity(record), record]));
  const records = input.candidates.candidates.map(candidate => {
    if (!candidate.evidence_contract) {
      const existing = baselineByIdentity.get(identity(candidate));
      if (!existing) throw new Error(`Baseline evidence is missing for ${identity(candidate)}`);
      return existing;
    }
    const profile = proofsByIdentity.get(identity(candidate));
    if (!profile) throw new Error(`Artifact-bound proof profile is missing for ${identity(candidate)}`);
    if (computeEffectHash(profile.effect) !== candidate.effect_hash) throw new Error(`Proof profile effect hash mismatch for ${identity(candidate)}`);
    const levels = profile.artifacts.map(artifact => artifact.level);
    const expectedPrefix = CERTIFICATION_LEVELS.slice(0, levels.length);
    if (JSON.stringify(levels) !== JSON.stringify(expectedPrefix)) throw new Error(`Certification artifacts are not cumulative for ${identity(candidate)}`);
    profile.artifacts.forEach(reference => validateArtifact(input.repoRoot, reference, profile));
    return sealEvidenceRecord({
      method: candidate.method,
      path: candidate.path,
      typed_mcp_aliases: candidate.typed_mcp_aliases,
      request: candidate.request,
      effect: profile.effect,
      requested_channels: profile.requested_channels,
      visibility: profile.visibility,
      evidence_contract: candidate.evidence_contract,
      ...(candidate.request_family ? { request_family: candidate.request_family } : {}),
      ...(candidate.execution_surface ? { execution_surface: candidate.execution_surface } : {}),
      evidence: {
        levels,
        state: levels.length ? "verified" : "unknown",
        provenance: "config/tool_certification_candidates.v1.json",
        artifacts: profile.artifacts
      }
    });
  });
  const compiled = {
    schema: "revit-operator.tool-certification-evidence.v1",
    hash_algorithm: "sha256",
    provenance: { source: "config/tool_certification_candidates.v1.json", source_hash: input.candidateSourceHash },
    records
  } as ToolCertificationEvidenceFile;
  return parseToolCertificationEvidence(compiled);
}
