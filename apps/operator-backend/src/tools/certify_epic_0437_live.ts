import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseToolCertificationCandidates,
  parseToolCertificationEvidence,
  canonicalJson,
  sha256NormalizedText,
  type CertificationLevel,
  type JsonValue
} from "../capabilities/tool_certification.js";
import {
  compileArtifactBoundEvidence,
  parseCertificationProofIndex,
  validateEpic0437LiveEvidenceRun
} from "../capabilities/tool_certification_evidence_compiler.js";
import { findRepoRoot } from "./audit_tool_registry.js";
import type { TrustedNativeAttestationBinding } from "../courier/laboratory_execution_receipt.js";
import { EPIC_0437_CANDIDATE_SOURCE_HASH } from "../courier/laboratory_evidence.js";
import {
  parseAndVerifyEpic0437PromotionAuthorization,
  type Epic0437PromotionAuthorization,
  type Epic0437PromotionPayload
} from "../capabilities/epic_0437_promotion_authority.js";
import { EPIC_0437_NATIVE_BUILD_MANIFEST_PATH, validateEpic0437NativeBuildManifest } from "../capabilities/epic_0437_source_provenance.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function json(raw: string): unknown { return JSON.parse(raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")); }
function canonical(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function boundedRunPath(value: string): string {
  if (!/^artifacts\/certification\/epic-0437\/runs\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value)) {
    throw new Error("--run must be one direct, bounded repository-relative EPIC-0437 run receipt JSON path");
  }
  return value;
}

type PromotionAuthorizationBundle = {
  schema: "revit-operator.epic-0437-promotion-authorization-bundle.v1";
  run_receipt_path: string;
  run_receipt_sha256: string;
  authorizations: Epic0437PromotionAuthorization[];
};

function authorizationBundle(value: unknown, runRelative: string, runSha: string): PromotionAuthorizationBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Promotion authorization bundle must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join("\n") !== ["schema", "run_receipt_path", "run_receipt_sha256", "authorizations"].sort().join("\n")
    || raw.schema !== "revit-operator.epic-0437-promotion-authorization-bundle.v1"
    || raw.run_receipt_path !== runRelative || raw.run_receipt_sha256 !== runSha || !Array.isArray(raw.authorizations)
    || raw.authorizations.length !== 3) throw new Error("Promotion authorization bundle identity is not exact");
  return {
    schema: raw.schema,
    run_receipt_path: runRelative,
    run_receipt_sha256: runSha,
    authorizations: raw.authorizations.map(parseAndVerifyEpic0437PromotionAuthorization)
  };
}

function main(): void {
  const level = argument("--level");
  if (level !== "L3" && level !== "L4") throw new Error("--level must be L3 or L4");
  const runRelative = boundedRunPath(argument("--run") ?? "");
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const catalogRoot = findRepoRoot(backendRoot);
  const repoRoot = path.basename(catalogRoot).toLowerCase() === "apps" ? path.dirname(catalogRoot) : catalogRoot;
  const candidatePath = path.join(backendRoot, "config", "tool_certification_candidates.v1.json");
  const evidencePath = path.join(backendRoot, "config", "tool_certification_evidence.v1.json");
  const proofPath = path.join(backendRoot, "config", "tool_certification_proofs.v1.json");
  const candidateRaw = fs.readFileSync(candidatePath, "utf8");
  const runRaw = fs.readFileSync(path.join(repoRoot, runRelative), "utf8");
  const runSha = sha256NormalizedText(runRaw);
  const authorizationBundlePath = argument("--authorization-bundle");
  if (!authorizationBundlePath) throw new Error("--authorization-bundle is required; the certifier has no signing key, trust-pin shortcut, or signing API");
  const bundle = authorizationBundle(json(fs.readFileSync(path.resolve(authorizationBundlePath), "utf8")), runRelative, runSha);
  const nativeBindings = new Map(bundle.authorizations.map(item => [canonicalJson(item.payload.native_attestation as unknown as JsonValue), item.payload.native_attestation]));
  if (nativeBindings.size !== 1) throw new Error("Detached promotion authorizations do not bind one exact independently approved native runtime key");
  const liveTrustedKey = [...nativeBindings.values()][0] as TrustedNativeAttestationBinding;
  const run = validateEpic0437LiveEvidenceRun(repoRoot, runRelative, runSha, level, liveTrustedKey);
  const nativeBuild = validateEpic0437NativeBuildManifest(repoRoot, EPIC_0437_CANDIDATE_SOURCE_HASH);
  const proofs = parseCertificationProofIndex(json(fs.readFileSync(proofPath, "utf8")));
  const requiredPrior = level === "L3" ? ["L0", "L1", "L2"] : ["L0", "L1", "L2", "L3"];
  const transportInputs = (run.steps as Array<Record<string, unknown>>).flatMap(item => {
    const values = [
      { path: item.result_path, sha256: item.result_sha256 },
      { path: item.courier_job_path, sha256: item.courier_job_sha256 },
      { path: item.courier_result_path, sha256: item.courier_result_sha256 }
    ];
    return values.filter(value => typeof value.path === "string" && typeof value.sha256 === "string") as Array<{ path: string; sha256: string }>;
  });
  const recovery = run.recovery as Record<string, unknown>;
  transportInputs.push({ path: String(recovery.path), sha256: String(recovery.sha256) });
  const observation = run.observation as Record<string, unknown>;
  transportInputs.push({ path: String(observation.image_artifact_path), sha256: String(observation.image_artifact_sha256) });
  const capabilities = new Map<string, "observation_readback" | "move_preview" | "move_apply">([
    ["sha256:5d7a88495a5d3d5c40115c62892c4e34a5ee59fcff74b4c7e1f6ff9307478045", "observation_readback"],
    ["sha256:c2dbe12c7df5ca552f102135d7b61c3568c707d66821d180af929698a50c18ea", "move_preview"],
    ["sha256:3fdfdce0e4792c8dff28d4532ac48ad01243a9c1d6289a257e2b59972b29091d", "move_apply"]
  ]);

  const profiles = proofs.records.map(profile => {
    const capability = capabilities.get(profile.request_hash);
    if (!capability) throw new Error(`Unexpected EPIC-0437 proof identity: ${profile.request_hash}`);
    const observed = profile.artifacts.map(item => item.level);
    if (JSON.stringify(observed) !== JSON.stringify(requiredPrior)) throw new Error(`${profile.request_hash} must have exact cumulative ${requiredPrior.join("-")} evidence before ${level}`);
    return { profile, capability };
  });
  const payload = (entry: typeof profiles[number], issuedAtUtc: string): Epic0437PromotionPayload => ({
    schema: "revit-operator.epic-0437-promotion-payload.v1",
    evidence_run_id: String(run.evidence_run_id),
    level,
    candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
    policy_hash: nativeBuild.manifest.policy_hash,
    native_build_manifest_path: EPIC_0437_NATIVE_BUILD_MANIFEST_PATH,
    native_build_manifest_sha256: nativeBuild.sha256,
    run_receipt_path: runRelative,
    run_receipt_sha256: runSha,
    candidate: { method: entry.profile.method, path: entry.profile.path, request_hash: entry.profile.request_hash, effect_hash: entry.profile.effect_hash },
    capability: entry.capability,
    native_attestation: liveTrustedKey,
    issued_at_utc: issuedAtUtc
  });
  const authorizations = new Map(bundle.authorizations.map(item => [item.payload.capability, item]));
  if (authorizations.size !== 3) throw new Error("Promotion authorization bundle must contain one exact authorization for each capability");

  for (const entry of profiles) {
    const { profile, capability } = entry;
    const authorization = authorizations.get(capability);
    if (!authorization || canonicalJson(authorization.payload as unknown as JsonValue) !== canonicalJson(payload(entry, authorization.payload.issued_at_utc) as unknown as JsonValue)) {
      throw new Error(`Detached promotion authorization does not bind the exact validated ${capability} payload`);
    }
    const issuedAt = Date.parse(authorization.payload.issued_at_utc);
    if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 30_000 || Date.now() - issuedAt > 4 * 60 * 60_000) {
      throw new Error(`Detached promotion authorization for ${capability} is stale or future-dated`);
    }
    const suffix = profile.request_hash.slice("sha256:".length, "sha256:".length + 12);
    const relative = `artifacts/certification/epic-0437/${suffix}.${level.toLowerCase()}.json`;
    const artifactInputs = [{ path: runRelative, sha256: runSha }, { path: EPIC_0437_NATIVE_BUILD_MANIFEST_PATH, sha256: nativeBuild.sha256 }, ...transportInputs];
    const artifact = {
      schema: "revit-operator.certification-proof-artifact.v1",
      level: level as CertificationLevel,
      candidate: { method: profile.method, path: profile.path, request_hash: profile.request_hash, effect_hash: profile.effect_hash },
      status: "passed",
      producer: { kind: level === "L3" ? "live_revit" : "sidecar_workflow", command: `npm run certify:epic-0437-live -- --level ${level} --run ${runRelative} --authorization-bundle <detached-reviewed-bundle>` },
      inputs: artifactInputs,
      inputs_hash: sha256NormalizedText(canonicalJson(artifactInputs as unknown as JsonValue)),
      result: {
        passed: true,
        evidence_schema: "revit-operator.epic-0437-live-evidence-run.v2",
        run_receipt_path: runRelative,
        run_receipt_sha256: runSha,
        capability,
        promotion_authorization: authorization
      } as { passed: true; [key: string]: JsonValue }
    };
    const rendered = canonical(artifact);
    fs.writeFileSync(path.join(repoRoot, relative), rendered, "utf8");
    profile.artifacts.push({ schema: "revit-operator.certification-proof-artifact.v1", level: level as CertificationLevel, path: relative, sha256: sha256NormalizedText(rendered) });
  }

  compileArtifactBoundEvidence({
    candidates: parseToolCertificationCandidates(json(candidateRaw)),
    candidateSourceHash: sha256NormalizedText(candidateRaw),
    baseline: parseToolCertificationEvidence(json(fs.readFileSync(evidencePath, "utf8"))),
    proofIndex: proofs,
    repoRoot
  });
  fs.writeFileSync(proofPath, canonical(proofs), "utf8");
  console.log(`Bound ${level} evidence for ${proofs.records.length} exact EPIC-0437 capability identities to ${runRelative}.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
