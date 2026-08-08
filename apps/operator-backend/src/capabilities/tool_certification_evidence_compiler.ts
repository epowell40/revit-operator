import fs from "node:fs";
import path from "node:path";
import {
  CERTIFICATION_LEVELS,
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
  inputs: Array<{ path: string; sha256: string }>;
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

export function validateEpic0437LiveEvidenceRun(repoRoot: string, relativeRunPath: string, expectedSha: string, level: "L3" | "L4"): Record<string, unknown> {
  const runPath = resolveInside(repoRoot, relativeFile(relativeRunPath, "EPIC-0437 run path", "artifacts/certification/epic-0437/runs/"));
  const raw = fs.readFileSync(runPath, "utf8");
  if (sha256NormalizedText(raw) !== expectedSha) throw new Error("EPIC-0437 live run receipt hash mismatch");
  const run = object(JSON.parse(raw.replace(/^\uFEFF/, "")), relativeRunPath);
  if (run.schema !== "revit-operator.epic-0437-live-evidence-run.v1" || run.level !== level || run.transport !== (level === "L3" ? "direct_protected_native" : "courier_sidecar")) throw new Error("EPIC-0437 live run identity or transport is invalid");
  const runtime = object(run.runtime, `${relativeRunPath}.runtime`);
  if (runtime.mode !== "development" || runtime.exposure_profile !== "laboratory" || runtime.production_certified !== false) throw new Error("EPIC-0437 live run falsely claims a production-certified lane");
  const document = object(run.document, `${relativeRunPath}.document`);
  if (document.title !== "Snowdon Towers Sample HVAC" || !shaPattern.test(String(document.fingerprint)) || !/^[0-9a-f]{32}$/.test(String(document.session_id)) || document.final_session_id !== document.session_id) throw new Error("EPIC-0437 live run document/session binding is invalid");
  const attestation = object(document.native_attestation, `${relativeRunPath}.document.native_attestation`);
  if (attestation.schema !== "revit-operator.native-execution-attestation-key.v1" || attestation.algorithm !== "RS256" || !shaPattern.test(String(attestation.key_id)) || !/^[A-Za-z0-9_-]{342}$/.test(String(attestation.modulus_base64url)) || attestation.exponent_base64url !== "AQAB") throw new Error("EPIC-0437 live run native attestation is invalid");
  const view = object(run.view, `${relativeRunPath}.view`);
  if (!Number.isSafeInteger(view.id) || !["FloorPlan", "CeilingPlan"].includes(String(view.type))) throw new Error("EPIC-0437 live run requires a supported plan view");
  const observation = object(run.observation, `${relativeRunPath}.observation`);
  if (observation.alias !== "revit_observe_model" || typeof observation.observation_id !== "string" || !Number.isSafeInteger(observation.count) || (observation.count as number) <= 0 || !Number.isSafeInteger(observation.certified_target_count) || (observation.certified_target_count as number) <= 0 || observation.image_attached !== true) throw new Error("EPIC-0437 observation evidence is incomplete");
  const readback = object(run.readback, `${relativeRunPath}.readback`);
  if (readback.alias !== "revit_read_move_targets_certified" || !Number.isSafeInteger(readback.target_count) || (readback.target_count as number) <= 0) throw new Error("EPIC-0437 resolver/readback evidence is incomplete");
  const target = object(readback.selected_target, `${relativeRunPath}.readback.selected_target`);
  if (!Number.isSafeInteger(target.elementId) || target.sourceScopedId !== `host:${target.elementId}` || target.observationId !== readback.observation_id) throw new Error("EPIC-0437 selected target is not exact host observation output");
  const elementId = target.elementId as number;
  const start = finitePoint(target.pointXyz, `${relativeRunPath}.readback.selected_target.pointXyz`);
  const preview = object(run.preview, `${relativeRunPath}.preview`);
  if (preview.alias !== "revit_move_one_certified" || !shaPattern.test(String(preview.request_sha256)) || typeof preview.rollback_readback_observation_id !== "string" || !samePoint(finitePoint(preview.rollback_point, `${relativeRunPath}.preview.rollback_point`), start)) throw new Error("EPIC-0437 rollback readback evidence is invalid");
  validateMoveProjection(preview.result, elementId, start, 0.25, true, `${relativeRunPath}.preview.result`);
  if (level === "L3" && run.apply !== null) throw new Error("EPIC-0437 L3 must not claim a committed move");
  if (level === "L4") {
    const apply = object(run.apply, `${relativeRunPath}.apply`);
    const committed = validateMoveProjection(apply.result, elementId, start, 0.25, false, `${relativeRunPath}.apply.result`);
    if (!samePoint(finitePoint(apply.committed_point, `${relativeRunPath}.apply.committed_point`), committed) || typeof apply.committed_readback_observation_id !== "string") throw new Error("EPIC-0437 committed move readback is invalid");
    const restored = validateMoveProjection(apply.restore_result, elementId, committed, -0.25, false, `${relativeRunPath}.apply.restore_result`);
    if (!samePoint(restored, start) || !samePoint(finitePoint(apply.restored_point, `${relativeRunPath}.apply.restored_point`), start) || typeof apply.restored_readback_observation_id !== "string") throw new Error("EPIC-0437 committed move was not exactly restored");
  }
  if (!Array.isArray(run.transport_evidence) || run.transport_evidence.length < (level === "L3" ? 7 : 11)) throw new Error("EPIC-0437 live run has insufficient transport-bound steps");
  const dispatches = new Set<string>();
  for (const [index, rawTransport] of run.transport_evidence.entries()) {
    const transport = object(rawTransport, `${relativeRunPath}.transport_evidence[${index}]`);
    const dispatch = string(transport.dispatch_id, `${relativeRunPath}.transport_evidence[${index}].dispatch_id`);
    if (dispatch !== transport.correlation_id || dispatches.has(dispatch) || !Array.isArray(transport.files) || transport.files.length !== (level === "L3" ? 1 : 2)) throw new Error("EPIC-0437 transport evidence is replayed or incomplete");
    dispatches.add(dispatch);
    for (const [fileIndex, rawFile] of transport.files.entries()) {
      const file = object(rawFile, `${relativeRunPath}.transport_evidence[${index}].files[${fileIndex}]`);
      const relative = relativeFile(file.path, "EPIC-0437 transport file", "artifacts/certification/epic-0437/runs/");
      const fileRaw = fs.readFileSync(resolveInside(repoRoot, relative), "utf8");
      if (sha256NormalizedText(fileRaw) !== sha(file.sha256, "EPIC-0437 transport file hash")) throw new Error("EPIC-0437 transport evidence hash mismatch");
      const parsed = object(JSON.parse(fileRaw.replace(/^\uFEFF/, "")), relative);
      if (level === "L3" && (parsed.version !== "revit-operator.native-transport.v1" || parsed.algorithm !== "A256CBC-HS512" || parsed.transport_path !== "/revit/operator-transport/v1")) throw new Error("EPIC-0437 L3 did not use protected native transport");
      if (level === "L4" && fileIndex === 0 && (parsed.version !== "revit-operator.revit-tool-job.v1" || parsed.id !== dispatch || parsed.correlation_id !== dispatch)) throw new Error("EPIC-0437 L4 courier job identity is invalid");
      if (level === "L4" && fileIndex === 1 && (parsed.version !== "revit-operator.revit-tool-result.v1" || parsed.id !== dispatch || parsed.correlation_id !== dispatch || parsed.status !== "succeeded" || parsed.outcome_unknown === true)) throw new Error("EPIC-0437 L4 courier result is not a known success");
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
    exact(input, ["path", "sha256"], `${reference.path}.inputs[${index}]`);
    const inputPath = relativeFile(input.path, `${reference.path}.inputs[${index}].path`);
    const expected = sha(input.sha256, `${reference.path}.inputs[${index}].sha256`);
    if (sha256NormalizedText(fs.readFileSync(resolveInside(repoRoot, inputPath), "utf8")) !== expected) throw new Error(`Certification artifact input is stale: ${inputPath}`);
  }
  const result = object(artifact.result, `${reference.path}.result`);
  if (result.passed !== true) throw new Error(`Certification artifact did not prove a pass: ${reference.path}`);
  if (reference.level === "L3" || reference.level === "L4") {
    exact(result, ["passed", "evidence_schema", "run_receipt_path", "run_receipt_sha256", "capability"], `${reference.path}.result`);
    if (result.evidence_schema !== "revit-operator.epic-0437-live-evidence-run.v1") throw new Error(`Certification artifact live schema mismatch: ${reference.path}`);
    const capability = profile.request_hash === EPIC_0437_OBSERVATION_REQUEST ? "observation_readback" : profile.request_hash === EPIC_0437_PREVIEW_REQUEST ? "move_preview" : profile.request_hash === EPIC_0437_APPLY_REQUEST ? "move_apply" : null;
    if (!capability || result.capability !== capability) throw new Error(`Certification artifact capability mismatch: ${reference.path}`);
    validateEpic0437LiveEvidenceRun(repoRoot, String(result.run_receipt_path), sha(result.run_receipt_sha256, `${reference.path}.result.run_receipt_sha256`), reference.level);
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
