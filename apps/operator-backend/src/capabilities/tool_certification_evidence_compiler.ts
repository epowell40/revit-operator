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
