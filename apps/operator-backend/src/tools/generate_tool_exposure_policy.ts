import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateToolExposurePolicy,
  parseToolCertificationCandidates,
  parseToolCertificationEvidence,
  renderCanonicalDocument,
  sha256NormalizedText,
  verifyCertificationCandidates,
  type ToolCertificationCandidatesFile
} from "../capabilities/tool_certification.js";
import { buildRegistryAudit, findRepoRoot } from "./audit_tool_registry.js";

function parseJsonDocument(raw: string): unknown {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return JSON.parse(normalized) as unknown;
}

function routeKey(method: string, toolPath: string): string {
  return `${method} ${toolPath}`;
}

export function verifyTypedMcpAliasesAgainstRegistry(
  candidates: ToolCertificationCandidatesFile,
  repoRoot: string
): void {
  const audit = buildRegistryAudit({ repoRoot });
  const auditByKey = new Map<string, (typeof audit.tools)[number]>(
    audit.tools.map(tool => [tool.key, tool])
  );
  for (const candidate of candidates.candidates) {
    const key = routeKey(candidate.method, candidate.path);
    const audited = auditByKey.get(key);
    if (!audited) throw new Error(`Certification candidate route is absent from registry audit: ${key}`);
    const expected = [...audited.mcp.typed_tools].sort();
    if (JSON.stringify(candidate.typed_mcp_aliases) !== JSON.stringify(expected)) {
      throw new Error(
        `Certification typed MCP aliases do not match exact registry attribution for ${key}: `
        + `expected ${JSON.stringify(expected)}, received ${JSON.stringify(candidate.typed_mcp_aliases)}`
      );
    }
  }
}

export function generatePolicyBytes(rawEvidence: string, rawCandidates: string, repoRoot?: string): string {
  const evidence = parseToolCertificationEvidence(parseJsonDocument(rawEvidence));
  const candidates = parseToolCertificationCandidates(parseJsonDocument(rawCandidates));
  verifyCertificationCandidates(evidence, candidates, sha256NormalizedText(rawCandidates));
  verifyTypedMcpAliasesAgainstRegistry(candidates, repoRoot ?? findRepoRoot(process.cwd()));
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
  const generated = generatePolicyBytes(rawEvidence, fs.readFileSync(candidatePath, "utf8"), findRepoRoot(backendRoot));

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
