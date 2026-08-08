import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolCertificationCandidates, parseToolCertificationEvidence, renderCanonicalDocument, sha256NormalizedText } from "../capabilities/tool_certification.js";
import { compileArtifactBoundEvidence, parseCertificationProofIndex } from "../capabilities/tool_certification_evidence_compiler.js";
import { findRepoRoot } from "./audit_tool_registry.js";

function json(raw: string): unknown { return JSON.parse(raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")); }
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

function run(): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const catalogRoot = findRepoRoot(backendRoot);
  const repoRoot = path.basename(catalogRoot).toLowerCase() === "apps" ? path.dirname(catalogRoot) : catalogRoot;
  const candidatePath = path.resolve(argument("--candidates") ?? path.join(backendRoot, "config", "tool_certification_candidates.v1.json"));
  const evidencePath = path.resolve(argument("--evidence") ?? path.join(backendRoot, "config", "tool_certification_evidence.v1.json"));
  const proofPath = path.resolve(argument("--proofs") ?? path.join(backendRoot, "config", "tool_certification_proofs.v1.json"));
  const candidateRaw = fs.readFileSync(candidatePath, "utf8");
  const compiled = compileArtifactBoundEvidence({
    candidates: parseToolCertificationCandidates(json(candidateRaw)),
    candidateSourceHash: sha256NormalizedText(candidateRaw),
    baseline: parseToolCertificationEvidence(json(fs.readFileSync(evidencePath, "utf8"))),
    proofIndex: parseCertificationProofIndex(json(fs.readFileSync(proofPath, "utf8"))),
    repoRoot
  });
  const rendered = renderCanonicalDocument(compiled as unknown as import("../capabilities/tool_certification.js").JsonValue);
  if (process.argv.includes("--check")) {
    const current = fs.readFileSync(evidencePath, "utf8").replace(/\r\n?/g, "\n");
    if (current !== rendered) throw new Error(`Certification evidence is stale: ${evidencePath}`);
    console.log(`Artifact-bound certification evidence is current: ${evidencePath}`);
    return;
  }
  fs.writeFileSync(evidencePath, rendered, "utf8");
  console.log(`Wrote artifact-bound certification evidence: ${evidencePath}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) run();
