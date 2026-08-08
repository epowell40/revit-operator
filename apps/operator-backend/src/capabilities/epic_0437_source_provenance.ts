import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256NormalizedText, type JsonValue } from "./tool_certification.js";
import { BUNDLED_TOOL_EXPOSURE_POLICY_HASH, parseTrustedToolExposurePolicy } from "./trusted_tool_exposure_policy.js";

export const EPIC_0437_NATIVE_BUILD_MANIFEST_PATH = "artifacts/certification/epic-0437/native-build-manifest.v1.json";

export const EPIC_0437_L2_GATE_CHECKS = [
  "backend_typescript_build",
  "mcp_typescript_build",
  "native_solution_locked_restore",
  "native_tests_locked_restore",
  "native_common_tests_net8",
  "native_common_tests_net48",
  "native_revit_bridge_build_net8",
  "native_revit_bridge_build_net48",
  "backend_certification_transport_adversarial_tests",
  "mcp_observation_family_transport_adversarial_tests",
  "post_generation_evidence_compiler_adversarial_tests"
] as const;

const EPIC_0437_SOURCE_ROOTS = [
  "apps/operator-backend/src",
  "apps/operator-backend/test",
  "apps/mcp-server/src",
  "apps/revit-bridge-addin"
] as const;

const EPIC_0437_SOURCE_ROOT_FILES = [
  "apps/operator-backend/config/tool_certification_candidates.v1.json",
  "apps/operator-backend/package.json",
  "apps/operator-backend/package-lock.json",
  "apps/operator-backend/tsconfig.json",
  "apps/mcp-server/package.json",
  "apps/mcp-server/package-lock.json",
  "apps/mcp-server/tsconfig.json"
] as const;

const IGNORED_SOURCE_DIRECTORIES = new Set([".git", ".vs", "bin", "obj", "node_modules", "dist", "TestResults"]);

function discoverSourceFiles(repoRoot: string, relativeRoot: string): string[] {
  const output: string[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(repoRoot, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`EPIC-0437 source provenance refuses symlinked build input: ${relative}/${entry.name}`);
      const child = `${relative}/${entry.name}`.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRECTORIES.has(entry.name)) visit(child);
      } else if (entry.isFile()) {
        output.push(child);
      }
    }
  };
  visit(relativeRoot);
  return output;
}

export function epic0437SourceInputPaths(repoRoot: string): string[] {
  const inputs = new Set<string>();
  for (const relative of EPIC_0437_SOURCE_ROOT_FILES) {
    if (!fs.existsSync(path.join(repoRoot, relative))) throw new Error(`EPIC-0437 required root build input is missing: ${relative}`);
    inputs.add(relative);
  }
  for (const root of EPIC_0437_SOURCE_ROOTS) {
    for (const relative of discoverSourceFiles(repoRoot, root)) inputs.add(relative);
  }
  return [...inputs].sort((left, right) => left.localeCompare(right));
}

export const EPIC_0437_NATIVE_BINARIES = {
  common: "apps/revit-bridge-addin/RevitBridge.Common/bin/Release/net48/RevitBridge.Common.dll",
  logic: "apps/revit-bridge-addin/RevitBridge.Logic/bin/Release/net48/RevitBridge.Logic.dll",
  bridge: "apps/revit-bridge-addin/RevitBridge/bin/Release/net48/win-x64/RevitBridge.dll"
} as const;

export const EPIC_0437_NATIVE_RUNTIME_DEPENDENCY_NAMES = [
  "Microsoft.Bcl.AsyncInterfaces.dll", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
  "Microsoft.Web.WebView2.Wpf.dll", "RevitBridge.Common.dll", "RevitBridge.dll", "RevitBridge.Logic.dll",
  "System.Buffers.dll", "System.Memory.dll", "System.Numerics.Vectors.dll", "System.Runtime.CompilerServices.Unsafe.dll",
  "System.Security.Cryptography.ProtectedData.dll", "System.Text.Encodings.Web.dll", "System.Text.Json.dll",
  "System.Threading.Tasks.Extensions.dll", "System.ValueTuple.dll", "WebView2Loader.dll"
] as const;
const EPIC_0437_NATIVE_RUNTIME_DIRECTORY = "apps/revit-bridge-addin/RevitBridge/bin/Release/net48/win-x64";

export type Epic0437NativeBuildManifest = {
  schema: "revit-operator.epic-0437-native-build-manifest.v1";
  candidate_source_hash: string;
  policy_hash: string;
  source_inputs_hash: string;
  source_inputs: Epic0437SourceInput[];
  configuration: "Release";
  target_framework: "net48";
  binaries: { common: { path: string; sha256: string }; logic: { path: string; sha256: string }; bridge: { path: string; sha256: string } };
  runtime_dependencies: Array<{ name: string; path: string; sha256: string }>;
  runtime_dependencies_hash: string;
  built_at_utc: string;
};

export type Epic0437SourceInput = { path: string; sha256: string; normalization?: "epic-0437-generated-policy-anchor-masked.v1" };

const MASKED_POLICY_ANCHOR_SOURCES = new Set<string>([
  "apps/operator-backend/src/capabilities/trusted_tool_exposure_policy.ts",
  "apps/mcp-server/src/lib/toolExposurePolicy.ts",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorNativeToolExposureAuthority.cs"
]);

function sha256Bytes(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

export function epic0437SourceInputHash(repoRoot: string, relative: string, normalization?: Epic0437SourceInput["normalization"]): string {
  const absolute = path.join(repoRoot, relative);
  if (normalization === undefined) return sha256Bytes(absolute);
  let source = fs.readFileSync(absolute, "utf8");
  if (normalization !== undefined) {
    if (normalization !== "epic-0437-generated-policy-anchor-masked.v1" || !MASKED_POLICY_ANCHOR_SOURCES.has(relative)) throw new Error(`Unsupported EPIC-0437 source normalization: ${relative}`);
    let replacements = 0;
    source = source.replace(/((?:BUNDLED_TOOL_EXPOSURE_POLICY_HASH|BUNDLED_POLICY_HASH|CompiledPolicyHash)\s*=\s*)"sha256:[0-9a-f]{64}"/g, (_match, prefix: string) => {
      replacements += 1;
      return `${prefix}"sha256:<generated-policy-anchor>"`;
    });
    if (replacements !== 1) throw new Error(`EPIC-0437 generated policy anchor mask did not match exactly once: ${relative}`);
  }
  return sha256NormalizedText(source);
}

export function currentEpic0437SourceInputs(repoRoot: string): Epic0437SourceInput[] {
  return epic0437SourceInputPaths(repoRoot).map(relative => {
    const normalization = MASKED_POLICY_ANCHOR_SOURCES.has(relative) ? "epic-0437-generated-policy-anchor-masked.v1" as const : undefined;
    return { path: relative, sha256: epic0437SourceInputHash(repoRoot, relative, normalization), ...(normalization ? { normalization } : {}) };
  });
}

export function createEpic0437NativeBuildManifest(repoRoot: string, candidateSourceHash: string): Epic0437NativeBuildManifest {
  const sourceInputs = currentEpic0437SourceInputs(repoRoot);
  const policy = parseTrustedToolExposurePolicy(JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/operator-backend/config/tool_exposure_policy.v1.json"), "utf8")));
  if (policy.policy_hash !== BUNDLED_TOOL_EXPOSURE_POLICY_HASH) throw new Error("EPIC-0437 build manifest policy is not the current bundled trust anchor");
  const binary = (relative: string) => ({ path: relative, sha256: sha256Bytes(path.join(repoRoot, relative)) });
  const runtimeDependencies = EPIC_0437_NATIVE_RUNTIME_DEPENDENCY_NAMES.map(name => {
    const relative = `${EPIC_0437_NATIVE_RUNTIME_DIRECTORY}/${name}`;
    return { name, ...binary(relative) };
  });
  return {
    schema: "revit-operator.epic-0437-native-build-manifest.v1",
    candidate_source_hash: candidateSourceHash,
    policy_hash: policy.policy_hash,
    source_inputs_hash: sha256NormalizedText(canonicalJson(sourceInputs as JsonValue)),
    source_inputs: sourceInputs,
    configuration: "Release",
    target_framework: "net48",
    binaries: {
      common: binary(EPIC_0437_NATIVE_BINARIES.common),
      logic: binary(EPIC_0437_NATIVE_BINARIES.logic),
      bridge: binary(EPIC_0437_NATIVE_BINARIES.bridge)
    },
    runtime_dependencies: runtimeDependencies,
    runtime_dependencies_hash: sha256NormalizedText(canonicalJson(runtimeDependencies as JsonValue)),
    built_at_utc: new Date().toISOString()
  };
}

export function validateEpic0437NativeBuildManifest(repoRoot: string, expectedCandidateSourceHash: string): { manifest: Epic0437NativeBuildManifest; sha256: string } {
  const manifestFile = path.join(repoRoot, EPIC_0437_NATIVE_BUILD_MANIFEST_PATH);
  const raw = fs.readFileSync(manifestFile, "utf8");
  const manifest = JSON.parse(raw.replace(/^\uFEFF/, "")) as Epic0437NativeBuildManifest;
  const exact = (value: Record<string, unknown>, keys: readonly string[], location: string) => {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${location} keys are not exact`);
  };
  exact(manifest as unknown as Record<string, unknown>, ["schema", "candidate_source_hash", "policy_hash", "source_inputs_hash", "source_inputs", "configuration", "target_framework", "binaries", "runtime_dependencies", "runtime_dependencies_hash", "built_at_utc"], "EPIC-0437 native build manifest");
  if (manifest.schema !== "revit-operator.epic-0437-native-build-manifest.v1" || manifest.candidate_source_hash !== expectedCandidateSourceHash
    || manifest.configuration !== "Release" || manifest.target_framework !== "net48" || !Number.isFinite(Date.parse(manifest.built_at_utc))) throw new Error("EPIC-0437 native build manifest identity is stale or invalid");
  const currentInputs = currentEpic0437SourceInputs(repoRoot);
  if (canonicalJson(manifest.source_inputs as unknown as JsonValue) !== canonicalJson(currentInputs as unknown as JsonValue)
    || manifest.source_inputs_hash !== sha256NormalizedText(canonicalJson(currentInputs as unknown as JsonValue))) throw new Error("EPIC-0437 native build manifest source inputs are stale");
  const policy = parseTrustedToolExposurePolicy(JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/operator-backend/config/tool_exposure_policy.v1.json"), "utf8")));
  if (manifest.policy_hash !== policy.policy_hash || policy.policy_hash !== BUNDLED_TOOL_EXPOSURE_POLICY_HASH) throw new Error("EPIC-0437 native build manifest policy is stale");
  exact(manifest.binaries as unknown as Record<string, unknown>, ["common", "logic", "bridge"], "EPIC-0437 native build manifest binaries");
  for (const key of ["common", "logic", "bridge"] as const) {
    const binding = manifest.binaries[key];
    exact(binding as unknown as Record<string, unknown>, ["path", "sha256"], `EPIC-0437 native build manifest ${key}`);
    if (binding.path !== EPIC_0437_NATIVE_BINARIES[key] || binding.sha256 !== sha256Bytes(path.join(repoRoot, binding.path))) throw new Error(`EPIC-0437 native ${key} build identity is stale`);
  }
  if (!Array.isArray(manifest.runtime_dependencies) || manifest.runtime_dependencies.length !== EPIC_0437_NATIVE_RUNTIME_DEPENDENCY_NAMES.length) throw new Error("EPIC-0437 native runtime dependency closure is incomplete");
  const currentRuntimeDependencies = EPIC_0437_NATIVE_RUNTIME_DEPENDENCY_NAMES.map((name, index) => {
    const dependency = manifest.runtime_dependencies[index];
    exact(dependency as unknown as Record<string, unknown>, ["name", "path", "sha256"], `EPIC-0437 runtime dependency ${name}`);
    const relative = `${EPIC_0437_NATIVE_RUNTIME_DIRECTORY}/${name}`;
    if (dependency.name !== name || dependency.path !== relative || dependency.sha256 !== sha256Bytes(path.join(repoRoot, relative))) throw new Error(`EPIC-0437 runtime dependency is stale: ${name}`);
    return dependency;
  });
  if (manifest.runtime_dependencies_hash !== sha256NormalizedText(canonicalJson(currentRuntimeDependencies as JsonValue))) throw new Error("EPIC-0437 runtime dependency closure hash is stale");
  return { manifest, sha256: sha256NormalizedText(raw) };
}
