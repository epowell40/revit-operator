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

const STANDALONE_EXECUTOR_ATTRIBUTIONS = new Map([
  [
    "POST /revit/certified/sheets/count",
    {
      executor_id: "revit-operator.safe-read-host.v1",
      route_id: "safe_read.sheet_count.v1",
      transport: "direct_loopback",
      typed_mcp_aliases: ["revit_count_sheets_certified"]
    }
  ]
] as const);

// These wrappers intentionally compose a broader primitive behind a narrower
// reviewed contract, so source-text route attribution is neither complete nor
// safe. Certification may use only these exact aliases for these routes.
const REVIEWED_TYPED_MCP_ROUTE_ATTRIBUTIONS = new Map<string, readonly string[]>([
  ["POST /revit/export-visible-elements", ["revit_observe_model", "revit_read_move_targets_certified"]],
  ["POST /revit/move-elements", ["revit_move_one_certified"]]
]);

const COMPILED_POLICY_HASH_PATTERN =
  /public\s+const\s+string\s+CompiledPolicyHash\s*=\s*"(sha256:[0-9a-f]{64})"\s*;/g;

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
    if (candidate.execution_surface) {
      const attribution = STANDALONE_EXECUTOR_ATTRIBUTIONS.get(key as "POST /revit/certified/sheets/count");
      if (!attribution) {
        throw new Error(`Certification standalone executor attribution is not recognized: ${key}`);
      }
      if (audited) {
        throw new Error(`Certification standalone executor route must be absent from the generic registry audit: ${key}`);
      }
      const received = {
        executor_id: candidate.execution_surface.executor_id,
        route_id: candidate.execution_surface.route_id,
        transport: candidate.execution_surface.transport,
        typed_mcp_aliases: candidate.typed_mcp_aliases
      };
      if (JSON.stringify(received) !== JSON.stringify(attribution)) {
        throw new Error(
          `Certification standalone executor attribution does not match the reviewed binding for ${key}: `
          + `expected ${JSON.stringify(attribution)}, received ${JSON.stringify(received)}`
        );
      }
      continue;
    }
    if (!audited) throw new Error(`Certification candidate route is absent from registry audit: ${key}`);
    const expected = [...(REVIEWED_TYPED_MCP_ROUTE_ATTRIBUTIONS.get(key) ?? audited.mcp.typed_tools)].sort();
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

export function extractCompiledPolicyHash(csharpSource: string): string {
  const matches = [...csharpSource.matchAll(COMPILED_POLICY_HASH_PATTERN)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error("C# native policy authority must contain exactly one literal CompiledPolicyHash trust anchor");
  }
  return matches[0][1];
}

export function verifyGeneratedPolicyMatchesCompiledAnchor(
  generatedPolicy: string,
  csharpAuthoritySource: string
): void {
  const parsed = parseJsonDocument(generatedPolicy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Generated tool exposure policy must be a JSON object");
  }
  const policyHash = (parsed as Record<string, unknown>).policy_hash;
  if (typeof policyHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(policyHash)) {
    throw new Error("Generated tool exposure policy hash is invalid");
  }
  const compiledPolicyHash = extractCompiledPolicyHash(csharpAuthoritySource);
  if (policyHash !== compiledPolicyHash) {
    throw new Error(
      `C# native policy trust anchor is stale: generated ${policyHash}, compiled ${compiledPolicyHash}`
    );
  }
}

export function updateCompiledPolicyHash(generatedPolicy: string, csharpAuthoritySource: string): string {
  const parsed = parseJsonDocument(generatedPolicy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Generated tool exposure policy must be a JSON object");
  const policyHash = (parsed as Record<string, unknown>).policy_hash;
  if (typeof policyHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(policyHash)) throw new Error("Generated tool exposure policy hash is invalid");
  extractCompiledPolicyHash(csharpAuthoritySource);
  return csharpAuthoritySource.replace(
    /public const string CompiledPolicyHash = "sha256:[0-9a-f]{64}";/,
    `public const string CompiledPolicyHash = "${policyHash}";`
  );
}

export function updateBundledPolicyHash(generatedPolicy: string, trustedPolicySource: string): string {
  const parsed = parseJsonDocument(generatedPolicy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Generated tool exposure policy must be a JSON object");
  const policyHash = (parsed as Record<string, unknown>).policy_hash;
  if (typeof policyHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(policyHash)) throw new Error("Generated tool exposure policy hash is invalid");
  const pattern = /export const BUNDLED_TOOL_EXPOSURE_POLICY_HASH = "sha256:[0-9a-f]{64}";/g;
  if ([...trustedPolicySource.matchAll(pattern)].length !== 1) throw new Error("Backend policy authority must contain exactly one literal bundled trust anchor");
  return trustedPolicySource.replace(pattern, `export const BUNDLED_TOOL_EXPOSURE_POLICY_HASH = "${policyHash}";`);
}

export function updateMcpBundledPolicyHash(generatedPolicy: string, mcpPolicySource: string): string {
  const parsed = parseJsonDocument(generatedPolicy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Generated tool exposure policy must be a JSON object");
  const policyHash = (parsed as Record<string, unknown>).policy_hash;
  if (typeof policyHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(policyHash)) throw new Error("Generated tool exposure policy hash is invalid");
  const pattern = /const BUNDLED_POLICY_HASH = "sha256:[0-9a-f]{64}";/g;
  if ([...mcpPolicySource.matchAll(pattern)].length !== 1) throw new Error("MCP policy authority must contain exactly one literal bundled trust anchor");
  return mcpPolicySource.replace(pattern, `const BUNDLED_POLICY_HASH = "${policyHash}";`);
}

function csharpAuthorityPath(repoRoot: string): string {
  const appsLayout = path.join(
    repoRoot,
    "apps",
    "revit-bridge-addin",
    "RevitBridge.Common",
    "OperatorNativeToolExposureAuthority.cs"
  );
  return fs.existsSync(appsLayout)
    ? appsLayout
    : path.join(
        repoRoot,
        "revit-bridge-addin",
        "RevitBridge.Common",
        "OperatorNativeToolExposureAuthority.cs"
      );
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
    const repoRoot = findRepoRoot(backendRoot);
    verifyGeneratedPolicyMatchesCompiledAnchor(
      generated,
      fs.readFileSync(csharpAuthorityPath(repoRoot), "utf8")
    );
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
  if (process.argv.includes("--update-native-anchor")) {
    const trustedAuthorityPath = path.join(backendRoot, "src", "capabilities", "trusted_tool_exposure_policy.ts");
    const trustedSource = fs.readFileSync(trustedAuthorityPath, "utf8");
    fs.writeFileSync(trustedAuthorityPath, updateBundledPolicyHash(generated, trustedSource), "utf8");
    const catalogRoot = findRepoRoot(backendRoot);
    const mcpAuthorityPath = fs.existsSync(path.join(catalogRoot, "apps", "mcp-server"))
      ? path.join(catalogRoot, "apps", "mcp-server", "src", "lib", "toolExposurePolicy.ts")
      : path.join(catalogRoot, "mcp-server", "src", "lib", "toolExposurePolicy.ts");
    const mcpSource = fs.readFileSync(mcpAuthorityPath, "utf8");
    fs.writeFileSync(mcpAuthorityPath, updateMcpBundledPolicyHash(generated, mcpSource), "utf8");
    const authorityPath = csharpAuthorityPath(catalogRoot);
    const source = fs.readFileSync(authorityPath, "utf8");
    fs.writeFileSync(authorityPath, updateCompiledPolicyHash(generated, source), "utf8");
    console.log(`Updated exact backend/MCP/native policy trust anchors: ${trustedAuthorityPath}; ${mcpAuthorityPath}; ${authorityPath}`);
  }
  console.log(`Wrote tool exposure policy: ${outputPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
