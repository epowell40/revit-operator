import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateToolExposurePolicy,
  parseToolCertificationCandidates,
  parseToolCertificationEvidence,
  renderCanonicalDocument,
  sha256NormalizedText,
  verifyCertificationCandidates
} from "../capabilities/tool_certification.js";

function parseJsonDocument(raw: string): unknown {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return JSON.parse(normalized) as unknown;
}

export function generatePolicyBytes(rawEvidence: string, rawCandidates: string): string {
  const evidence = parseToolCertificationEvidence(parseJsonDocument(rawEvidence));
  const candidates = parseToolCertificationCandidates(parseJsonDocument(rawCandidates));
  verifyCertificationCandidates(evidence, candidates, sha256NormalizedText(rawCandidates));
  return renderCanonicalDocument(generateToolExposurePolicy(evidence) as unknown as import("../capabilities/tool_certification.js").JsonValue);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli(): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const inputPath = path.resolve(argument("--input") ?? path.join(backendRoot, "config", "tool_certification_evidence.v1.json"));
  const outputPath = path.resolve(argument("--output") ?? path.join(backendRoot, "config", "tool_exposure_policy.v1.json"));
  const rawEvidence = fs.readFileSync(inputPath, "utf8");
  const evidence = parseToolCertificationEvidence(parseJsonDocument(rawEvidence));
  const candidatePath = path.resolve(backendRoot, evidence.provenance.source);
  const relativeCandidatePath = path.relative(backendRoot, candidatePath);
  if (relativeCandidatePath.startsWith("..") || path.isAbsolute(relativeCandidatePath)) {
    throw new Error(`Certification provenance escapes backend root: ${evidence.provenance.source}`);
  }
  const generated = generatePolicyBytes(rawEvidence, fs.readFileSync(candidatePath, "utf8"));

  if (process.argv.includes("--check")) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/\r\n?/g, "\n") : "";
    if (current !== generated) {
      console.error(`Tool exposure policy is stale: ${outputPath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Tool exposure policy is deterministic and current: ${outputPath}`);
    return;
  }

  if (process.argv.includes("--stdout")) {
    process.stdout.write(generated);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated, "utf8");
  console.log(`Wrote tool exposure policy: ${outputPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
