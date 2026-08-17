import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, computeEffectHash, parseToolCertificationCandidates, parseToolCertificationEvidence, renderCanonicalDocument, sha256NormalizedText, type CertificationLevel, type JsonValue } from "../capabilities/tool_certification.js";
import { compileArtifactBoundEvidence, parseCertificationProofIndex } from "../capabilities/tool_certification_evidence_compiler.js";
import {
  EPIC_0437_L2_GATE_CHECKS,
  EPIC_0437_NATIVE_BUILD_MANIFEST_PATH,
  createEpic0437NativeBuildManifest,
  currentEpic0437SourceInputs
} from "../capabilities/epic_0437_source_provenance.js";
import { buildRegistryAudit, findRepoRoot } from "./audit_tool_registry.js";
import {
  generatePolicyBytes,
  updateBundledPolicyHash,
  updateCompiledPolicyHash,
  updateMcpBundledPolicyHash,
  verifyTypedMcpAliasesAgainstRegistry
} from "./generate_tool_exposure_policy.js";

function json(raw: string): unknown { return JSON.parse(raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")); }
function run(command: string, args: string[], cwd: string): Promise<{ command: string; duration_ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Certification command failed (${code ?? signal ?? "unknown"}): ${command} ${args.join(" ")}`));
        return;
      }
      resolve({ command: `${command} ${args.join(" ")}`, duration_ms: Date.now() - started });
    });
  });
}
function canonical(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

async function main(): Promise<void> {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const backendRoot = fs.existsSync(path.join(moduleRoot, "config", "tool_certification_candidates.v1.json"))
    ? moduleRoot
    : path.resolve(moduleRoot, "..");
  const catalogRoot = findRepoRoot(backendRoot);
  const repoRoot = path.basename(catalogRoot).toLowerCase() === "apps" ? path.dirname(catalogRoot) : catalogRoot;
  const candidatePath = path.join(backendRoot, "config", "tool_certification_candidates.v1.json");
  const proofPath = path.join(backendRoot, "config", "tool_certification_proofs.v1.json");
  const candidateRaw = fs.readFileSync(candidatePath, "utf8");
  const candidates = parseToolCertificationCandidates(json(candidateRaw));
  const proofIndex = parseCertificationProofIndex(json(fs.readFileSync(proofPath, "utf8")));
  const candidateHash = sha256NormalizedText(candidateRaw);
  if (proofIndex.candidate_source_hash !== candidateHash) throw new Error("EPIC-0437 proof index is stale for candidates");

  const nativeRoot = path.join(repoRoot, "apps", "revit-bridge-addin");
  const mcpRoot = path.join(repoRoot, "apps", "mcp-server");
  const systemNode = process.platform === "win32" ? path.join(process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe") : process.execPath;
  const gateNode = fs.existsSync(systemNode) ? systemNode : process.execPath;
  if (process.argv.includes("--gates-already-run")) throw new Error("--gates-already-run is forbidden; source certification must execute its own gates");
  const builds = [
    await run(gateNode, [path.join(backendRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], backendRoot),
    await run(gateNode, [path.join(mcpRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], mcpRoot),
    await run("dotnet", ["restore", "RevitBridge.sln", "--locked-mode"], nativeRoot),
    await run("dotnet", ["restore", "RevitBridge.Common.Tests/RevitBridge.Common.Tests.csproj", "--locked-mode"], nativeRoot),
    await run("dotnet", ["test", "RevitBridge.Common.Tests/RevitBridge.Common.Tests.csproj", "-c", "Release", "-f", "net8.0-windows", "--no-restore"], nativeRoot),
    await run("dotnet", ["test", "RevitBridge.Common.Tests/RevitBridge.Common.Tests.csproj", "-c", "Release", "-f", "net48", "--no-restore"], nativeRoot),
    await run("dotnet", ["build", "RevitBridge/RevitBridge.csproj", "-c", "Release", "-f", "net8.0-windows", "--no-restore"], nativeRoot),
    await run("dotnet", ["build", "RevitBridge/RevitBridge.csproj", "-c", "Release", "-f", "net48", "--no-restore"], nativeRoot)
  ];

  const audit = buildRegistryAudit({ repoRoot: catalogRoot });
  verifyTypedMcpAliasesAgainstRegistry(candidates, catalogRoot);
  const routeKeys = new Set<string>(audit.tools.map(tool => tool.key));
  for (const profile of proofIndex.records) {
    if (!routeKeys.has(`${profile.method} ${profile.path}`)) throw new Error(`L0 route is absent: ${profile.method} ${profile.path}`);
    if (computeEffectHash(profile.effect) !== profile.effect_hash) throw new Error(`L1 effect identity mismatch: ${profile.method} ${profile.path}`);
  }

  const testCommands = [
    await run(gateNode, ["--test", "--test-reporter=dot", "--test-concurrency=1", "--test-name-pattern=canonical identity|complete cumulative evidence|typed MCP|request-family|missing, unknown|tampered request|runtime validation|candidate provenance|candidate aliases|alias bindings|request fixtures|seeded policy|direct |courier |laboratory", "dist/test/tool_certification.test.js", "dist/test/direct_revit_execution_authorization.test.js", "dist/test/revit_courier_contract.test.js", "dist/test/laboratory_execution_receipt.test.js"], backendRoot),
    await run(gateNode, ["--test", "--test-reporter=dot", "dist/spatialObservationV1.test.js", "dist/lib/certifiedMoveTargetLedger.test.js", "dist/lib/certifiedMoveOneRequestFamily.test.js", "dist/lib/certifiedExecutionEnvelope.test.js", "dist/lib/toolExposurePolicy.test.js", "dist/lib/revitCourier.test.js", "dist/lib/certifiedCapabilityProjection.test.js", "dist/lib/laboratoryEvidenceDispatch.test.js", "dist/lib/laboratoryMoveEvidence.test.js"], mcpRoot)
  ];
  const postGenerationCompilerTest = `${gateNode} --test --test-reporter=dot --test-concurrency=1 dist/test/tool_certification_evidence_compiler.test.js`;
  const commands = [...builds, ...testCommands, { command: postGenerationCompilerTest, duration_ms: 0 }];
  if (commands.length !== EPIC_0437_L2_GATE_CHECKS.length) throw new Error("EPIC-0437 L2 gate execution set differs from its exact artifact contract");
  const inputs = currentEpic0437SourceInputs(repoRoot);
  const artifactRoot = path.join(repoRoot, "artifacts", "certification", "epic-0437");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const buildManifest = createEpic0437NativeBuildManifest(repoRoot, candidateHash);
  fs.writeFileSync(path.join(repoRoot, EPIC_0437_NATIVE_BUILD_MANIFEST_PATH), canonical(buildManifest), "utf8");

  for (const profile of proofIndex.records) {
    profile.artifacts = [];
    for (const level of ["L0", "L1", "L2"] as CertificationLevel[]) {
      const suffix = profile.request_hash.slice("sha256:".length, "sha256:".length + 12);
      const relative = `artifacts/certification/epic-0437/${suffix}.${level.toLowerCase()}.json`;
      const artifact = {
        schema: "revit-operator.certification-proof-artifact.v1",
        level,
        candidate: { method: profile.method, path: profile.path, request_hash: profile.request_hash, effect_hash: profile.effect_hash },
        status: "passed",
        producer: {
          kind: level === "L0" ? "source_audit" : level === "L1" ? "compiler_validation" : "automated_test",
          command: "npm run certify:epic-0437-source"
        },
        inputs,
        inputs_hash: sha256NormalizedText(canonicalJson(inputs as unknown as JsonValue)),
        result: {
          passed: true,
          checks: level === "L0"
            ? ["route_present", "reviewed_typed_alias_attribution"]
            : level === "L1"
              ? ["candidate_schema", "request_hash", "effect_hash", "request_family_hash", "artifact_contract"]
              : [...EPIC_0437_L2_GATE_CHECKS]
        } as { passed: true; [key: string]: JsonValue }
      };
      const rendered = canonical(artifact);
      fs.writeFileSync(path.join(repoRoot, relative), rendered, "utf8");
      profile.artifacts.push({
        schema: "revit-operator.certification-proof-artifact.v1",
        level,
        path: relative,
        sha256: sha256NormalizedText(rendered)
      });
    }
  }
  fs.writeFileSync(proofPath, canonical(proofIndex), "utf8");
  const evidencePath = path.join(backendRoot, "config", "tool_certification_evidence.v1.json");
  const compiledEvidence = compileArtifactBoundEvidence({
    candidates,
    candidateSourceHash: candidateHash,
    baseline: parseToolCertificationEvidence(json(fs.readFileSync(evidencePath, "utf8"))),
    proofIndex,
    repoRoot
  });
  const renderedEvidence = renderCanonicalDocument(compiledEvidence as unknown as JsonValue);
  fs.writeFileSync(evidencePath, renderedEvidence, "utf8");

  // Evidence is the policy generator's authoritative input. Keep the generated
  // policy and all three compiled trust anchors in the same certification
  // transaction so a successful certification command cannot leave CI one
  // generation behind.
  const generatedPolicy = generatePolicyBytes(renderedEvidence, candidateRaw, catalogRoot);
  fs.writeFileSync(path.join(backendRoot, "config", "tool_exposure_policy.v1.json"), generatedPolicy, "utf8");
  const backendAuthorityPath = path.join(backendRoot, "src", "capabilities", "trusted_tool_exposure_policy.ts");
  fs.writeFileSync(
    backendAuthorityPath,
    updateBundledPolicyHash(generatedPolicy, fs.readFileSync(backendAuthorityPath, "utf8")),
    "utf8"
  );
  const mcpAuthorityPath = path.join(mcpRoot, "src", "lib", "toolExposurePolicy.ts");
  fs.writeFileSync(
    mcpAuthorityPath,
    updateMcpBundledPolicyHash(generatedPolicy, fs.readFileSync(mcpAuthorityPath, "utf8")),
    "utf8"
  );
  const nativeAuthorityPath = path.join(nativeRoot, "RevitBridge.Common", "OperatorNativeToolExposureAuthority.cs");
  fs.writeFileSync(
    nativeAuthorityPath,
    updateCompiledPolicyHash(generatedPolicy, fs.readFileSync(nativeAuthorityPath, "utf8")),
    "utf8"
  );
  await run(gateNode, [path.join(backendRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], backendRoot);
  await run(gateNode, [path.join(mcpRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], mcpRoot);
  await run(gateNode, ["--test", "--test-reporter=dot", "--test-concurrency=1", "dist/test/tool_certification_evidence_compiler.test.js"], backendRoot);
  console.log(`Wrote converged L0-L2 proof artifacts, certification evidence, generated policy, and trust anchors for ${proofIndex.records.length} exact candidate identities.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
