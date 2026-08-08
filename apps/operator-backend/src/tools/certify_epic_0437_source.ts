import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeEffectHash, parseToolCertificationCandidates, sha256NormalizedText, type CertificationLevel, type JsonValue } from "../capabilities/tool_certification.js";
import { parseCertificationProofIndex } from "../capabilities/tool_certification_evidence_compiler.js";
import { buildRegistryAudit, findRepoRoot } from "./audit_tool_registry.js";
import { verifyTypedMcpAliasesAgainstRegistry } from "./generate_tool_exposure_policy.js";

const SOURCE_INPUTS = [
  "apps/operator-backend/config/tool_certification_candidates.v1.json",
  "apps/operator-backend/package.json",
  "apps/operator-backend/src/capabilities/tool_certification.ts",
  "apps/operator-backend/src/capabilities/tool_certification_evidence_compiler.ts",
  "apps/operator-backend/src/tools/certify_epic_0437_live.ts",
  "apps/operator-backend/src/tools/generate_tool_exposure_policy.ts",
  "apps/operator-backend/src/capabilities/direct_revit_execution_authorization.ts",
  "apps/operator-backend/src/courier/revit_tool_job_certification.ts",
  "apps/operator-backend/src/courier/revit_tool_jobs.ts",
  "apps/mcp-server/src/server.ts",
  "apps/mcp-server/package.json",
  "apps/mcp-server/src/spatialObservationV1.ts",
  "apps/mcp-server/src/lib/certifiedMoveTargetLedger.ts",
  "apps/mcp-server/src/lib/certifiedMoveOneRequestFamily.ts",
  "apps/mcp-server/src/lib/certifiedCapabilityProjection.ts",
  "apps/mcp-server/src/lib/revitClient.ts",
  "apps/mcp-server/src/lib/revitCourier.ts",
  "apps/mcp-server/src/lib/nativeTransport.ts",
  "apps/mcp-server/src/scripts/run_epic_0437_live_evidence.ts",
  "apps/revit-bridge-addin/RevitBridge/App.cs",
  "apps/revit-bridge-addin/RevitBridge/Server/RevitHttpServer.cs",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorCertifiedRequestFamilyAdmission.cs",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorCertifiedMovePreviewAuthority.cs",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorNativeExecutionAttestationAuthority.cs",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorNativeToolExposureAuthority.cs",
  "apps/revit-bridge-addin/RevitBridge.Logic/Handlers/Selection/ExportVisibleElementsHandler.cs"
] as const;

function json(raw: string): unknown { return JSON.parse(raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")); }
function run(command: string, args: string[], cwd: string): { command: string; duration_ms: number } {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Certification command failed (${result.status ?? result.signal ?? result.error?.message ?? "unknown"}): ${command} ${args.join(" ")}`);
  }
  return { command: `${command} ${args.join(" ")}`, duration_ms: Date.now() - started };
}
function canonical(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function main(): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const catalogRoot = findRepoRoot(backendRoot);
  const repoRoot = path.basename(catalogRoot).toLowerCase() === "apps" ? path.dirname(catalogRoot) : catalogRoot;
  const candidatePath = path.join(backendRoot, "config", "tool_certification_candidates.v1.json");
  const proofPath = path.join(backendRoot, "config", "tool_certification_proofs.v1.json");
  const candidateRaw = fs.readFileSync(candidatePath, "utf8");
  const candidates = parseToolCertificationCandidates(json(candidateRaw));
  const proofIndex = parseCertificationProofIndex(json(fs.readFileSync(proofPath, "utf8")));
  const candidateHash = sha256NormalizedText(candidateRaw);
  if (proofIndex.candidate_source_hash !== candidateHash) throw new Error("EPIC-0437 proof index is stale for candidates");

  const audit = buildRegistryAudit({ repoRoot: catalogRoot });
  verifyTypedMcpAliasesAgainstRegistry(candidates, catalogRoot);
  const routeKeys = new Set<string>(audit.tools.map(tool => tool.key));
  for (const profile of proofIndex.records) {
    if (!routeKeys.has(`${profile.method} ${profile.path}`)) throw new Error(`L0 route is absent: ${profile.method} ${profile.path}`);
    if (computeEffectHash(profile.effect) !== profile.effect_hash) throw new Error(`L1 effect identity mismatch: ${profile.method} ${profile.path}`);
  }

  const commands = [
    run(process.execPath, ["--test", "--test-reporter=dot", "--test-concurrency=1", "--test-name-pattern=canonical identity|cumulative evidence|typed MCP|request-family|missing, unknown|tampered request|runtime validation|candidate provenance|candidate aliases|alias bindings|request fixtures|seeded policy|direct |courier ", "dist/test/tool_certification.test.js", "dist/test/direct_revit_execution_authorization.test.js", "dist/test/revit_courier_contract.test.js"], backendRoot),
    run(process.execPath, ["--test", "--test-reporter=dot", "dist/spatialObservationV1.test.js", "dist/lib/certifiedMoveTargetLedger.test.js", "dist/lib/certifiedMoveOneRequestFamily.test.js", "dist/lib/certifiedExecutionEnvelope.test.js", "dist/lib/toolExposurePolicy.test.js", "dist/lib/revitCourier.test.js", "dist/lib/certifiedCapabilityProjection.test.js"], path.join(repoRoot, "apps", "mcp-server"))
  ];
  const inputs = SOURCE_INPUTS.map(relative => ({
    path: relative,
    sha256: sha256NormalizedText(fs.readFileSync(path.join(repoRoot, relative), "utf8"))
  }));
  const artifactRoot = path.join(repoRoot, "artifacts", "certification", "epic-0437");
  fs.mkdirSync(artifactRoot, { recursive: true });

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
        result: {
          passed: true,
          checks: level === "L0"
            ? ["route_present", "reviewed_typed_alias_attribution"]
            : level === "L1"
              ? ["candidate_schema", "request_hash", "effect_hash", "request_family_hash", "artifact_contract"]
              : commands
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
  console.log(`Wrote L0-L2 proof artifacts for ${proofIndex.records.length} exact candidate identities.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
