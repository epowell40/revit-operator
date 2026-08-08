import { constants, createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual } from "node:crypto";
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
import { getOrCreateOperatorToken } from "../operator_token.js";
import { getWorkspaceBaseRoot } from "../workspace.js";
import type { TrustedNativeAttestationBinding } from "../courier/laboratory_execution_receipt.js";
import { EPIC_0437_CANDIDATE_SOURCE_HASH } from "../courier/laboratory_evidence.js";
import {
  EPIC_0437_PROMOTION_AUTHORITY_KEY_ID,
  EPIC_0437_PROMOTION_AUTHORITY_PUBLIC_KEY_PEM,
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
  if (!value.startsWith("artifacts/certification/epic-0437/runs/") || value.includes("\\") || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("--run must be a bounded repository-relative EPIC-0437 run receipt path");
  }
  return value;
}

function trustedPin(value: string, runRelative: string, runSha: string): TrustedNativeAttestationBinding {
  const root = path.resolve(getWorkspaceBaseRoot(), "certification-evidence-trust");
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || !resolved.toLowerCase().startsWith((root + path.sep).toLowerCase()) || path.extname(resolved).toLowerCase() !== ".json") throw new Error("--trust-pin must be an absolute file under the local certification-evidence-trust authority directory");
  const pin = json(fs.readFileSync(resolved, "utf8")) as Record<string, unknown>;
  const fields = ["schema", "evidence_run_id", "candidate_source_hash", "run_receipt_path", "run_receipt_sha256", "document_fingerprint", "document_session_id", "native_attestation", "issued_at_utc", "mac_sha256"];
  if (!pin || typeof pin !== "object" || Array.isArray(pin) || Object.keys(pin).sort().join("\n") !== [...fields].sort().join("\n")
    || pin.schema !== "revit-operator.epic-0437-live-native-trust-pin.v1" || !/^[0-9a-f]{32}$/.test(String(pin.evidence_run_id))
    || pin.candidate_source_hash !== EPIC_0437_CANDIDATE_SOURCE_HASH || pin.run_receipt_path !== runRelative || pin.run_receipt_sha256 !== runSha
    || !/^sha256:[0-9a-f]{64}$/.test(String(pin.document_fingerprint)) || !/^[0-9a-f]{32}$/.test(String(pin.document_session_id))) throw new Error("EPIC-0437 native trust pin identity is invalid");
  const issuedAt = Date.parse(String(pin.issued_at_utc));
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || issuedAt > now + 30_000 || now - issuedAt > 30 * 60_000) throw new Error("EPIC-0437 native trust pin is stale or future-dated");
  const { mac_sha256: mac, ...payload } = pin;
  const trustKey = createHash("sha256").update(`epic-0437-evidence-trust|${getOrCreateOperatorToken()}`, "utf8").digest();
  const expected = `sha256:${createHmac("sha256", trustKey).update(canonicalJson(payload as JsonValue), "utf8").digest("hex")}`;
  if (typeof mac !== "string" || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error("EPIC-0437 native trust pin MAC is invalid");
  const key = pin.native_attestation as Record<string, unknown>;
  if (!key || key.algorithm !== "RS256" || typeof key.key_id !== "string" || typeof key.modulus_base64url !== "string" || key.exponent_base64url !== "AQAB") throw new Error("EPIC-0437 native trust pin key is invalid");
  const derivedKeyId = `sha256:${createHash("sha256").update(canonicalJson({ algorithm: "RS256", exponent_base64url: "AQAB", modulus_base64url: key.modulus_base64url } as JsonValue), "utf8").digest("hex")}`;
  if (key.key_id !== derivedKeyId) throw new Error("EPIC-0437 native trust pin key id is invalid");
  return { algorithm: "RS256", key_id: key.key_id, modulus_base64url: key.modulus_base64url, exponent_base64url: "AQAB" };
}

function authorizePromotion(payload: Epic0437PromotionPayload): Epic0437PromotionAuthorization {
  const privatePath = path.join(getWorkspaceBaseRoot(), "certification-evidence-trust", "epic-0437-promotion-authority.pem");
  const privateKey = createPrivateKey(fs.readFileSync(privatePath));
  const actualPublic = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (actualPublic !== EPIC_0437_PROMOTION_AUTHORITY_PUBLIC_KEY_PEM
    || `sha256:${createHash("sha256").update(actualPublic, "utf8").digest("hex")}` !== EPIC_0437_PROMOTION_AUTHORITY_KEY_ID) {
    throw new Error("Local EPIC-0437 promotion authority does not match the reviewed source-pinned public key");
  }
  const signature = sign("sha256", Buffer.from(canonicalJson(payload as unknown as JsonValue), "utf8"), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  });
  return {
    schema: "revit-operator.epic-0437-promotion-authorization.v1",
    algorithm: "PS256",
    key_id: EPIC_0437_PROMOTION_AUTHORITY_KEY_ID,
    payload,
    signature_base64url: signature.toString("base64url")
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
  const trustPinPath = argument("--trust-pin");
  if (!trustPinPath) throw new Error("--trust-pin is required and must come from the completed protected live runner");
  const liveTrustedKey = trustedPin(trustPinPath, runRelative, runSha);
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

  for (const profile of proofs.records) {
    const capability = capabilities.get(profile.request_hash);
    if (!capability) throw new Error(`Unexpected EPIC-0437 proof identity: ${profile.request_hash}`);
    const observed = profile.artifacts.map(item => item.level);
    if (JSON.stringify(observed) !== JSON.stringify(requiredPrior)) throw new Error(`${profile.request_hash} must have exact cumulative ${requiredPrior.join("-")} evidence before ${level}`);
    const suffix = profile.request_hash.slice("sha256:".length, "sha256:".length + 12);
    const relative = `artifacts/certification/epic-0437/${suffix}.${level.toLowerCase()}.json`;
    const artifact = {
      schema: "revit-operator.certification-proof-artifact.v1",
      level: level as CertificationLevel,
      candidate: { method: profile.method, path: profile.path, request_hash: profile.request_hash, effect_hash: profile.effect_hash },
      status: "passed",
      producer: { kind: level === "L3" ? "live_revit" : "sidecar_workflow", command: `npm run certify:epic-0437-live -- --level ${level} --run ${runRelative}` },
      inputs: [{ path: runRelative, sha256: runSha }, { path: EPIC_0437_NATIVE_BUILD_MANIFEST_PATH, sha256: nativeBuild.sha256 }, ...transportInputs],
      result: {
        passed: true,
        evidence_schema: "revit-operator.epic-0437-live-evidence-run.v2",
        run_receipt_path: runRelative,
        run_receipt_sha256: runSha,
        capability,
        promotion_authorization: authorizePromotion({
          schema: "revit-operator.epic-0437-promotion-payload.v1",
          evidence_run_id: String(run.evidence_run_id),
          level,
          candidate_source_hash: EPIC_0437_CANDIDATE_SOURCE_HASH,
          policy_hash: nativeBuild.manifest.policy_hash,
          native_build_manifest_path: EPIC_0437_NATIVE_BUILD_MANIFEST_PATH,
          native_build_manifest_sha256: nativeBuild.sha256,
          run_receipt_path: runRelative,
          run_receipt_sha256: runSha,
          candidate: { method: profile.method, path: profile.path, request_hash: profile.request_hash, effect_hash: profile.effect_hash },
          capability,
          native_attestation: liveTrustedKey,
          issued_at_utc: new Date().toISOString()
        })
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
