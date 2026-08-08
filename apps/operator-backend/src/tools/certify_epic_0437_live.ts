import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseToolCertificationCandidates,
  parseToolCertificationEvidence,
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
  const run = validateEpic0437LiveEvidenceRun(repoRoot, runRelative, runSha, level);
  const proofs = parseCertificationProofIndex(json(fs.readFileSync(proofPath, "utf8")));
  const requiredPrior = level === "L3" ? ["L0", "L1", "L2"] : ["L0", "L1", "L2", "L3"];
  const transportInputs = (run.transport_evidence as Array<Record<string, unknown>>).flatMap(item =>
    (item.files as Array<Record<string, unknown>>).map(file => ({ path: String(file.path), sha256: String(file.sha256) }))
  );
  const capabilities = new Map([
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
      inputs: [{ path: runRelative, sha256: runSha }, ...transportInputs],
      result: {
        passed: true,
        evidence_schema: "revit-operator.epic-0437-live-evidence-run.v1",
        run_receipt_path: runRelative,
        run_receipt_sha256: runSha,
        capability
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
