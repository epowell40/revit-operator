import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJson, sha256NormalizedText, type JsonValue } from "./tool_certification.js";
import { BUNDLED_TOOL_EXPOSURE_POLICY_HASH, parseTrustedToolExposurePolicy } from "./trusted_tool_exposure_policy.js";

export const EPIC_0437_NATIVE_BUILD_MANIFEST_PATH = "artifacts/certification/epic-0437/native-build-manifest.v2.json";

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
  "apps/revit-bridge-addin",
  "packages/assignment-kernel-v2-contracts",
  "packages/payload-digest-v2",
  "packages/revit-action-effect-v1",
  "packages/text-note-round-trip-v1"
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
const EPIC_0437_TEXT_SOURCE_EXTENSIONS = new Set([".addin", ".cs", ".csproj", ".js", ".json", ".md", ".ps1", ".sln", ".ts"]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

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
  // Source identity must not depend on the host's ICU locale or filesystem.
  return [...inputs].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
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

export type Epic0437HostRuntimeDependency = { path: string; sha256: string; assembly_full_name: string };
export const EPIC_0437_REVIT_HOST_RUNTIME_DEPENDENCIES: Readonly<Record<string, Epic0437HostRuntimeDependency>> = {
  "Microsoft.Bcl.AsyncInterfaces.dll": {
    path: "C:\\Program Files\\Autodesk\\Carbon Insights for Revit 2024\\Microsoft.Bcl.AsyncInterfaces.dll",
    sha256: "sha256:295af2142d9214f3fd84eafe4778dca119be7e0229f14b6ba8d5269c2f1e2e78",
    assembly_full_name: "Microsoft.Bcl.AsyncInterfaces, Version=6.0.0.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"
  },
  "Microsoft.Web.WebView2.Core.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\Microsoft.Web.WebView2.Core.dll",
    sha256: "sha256:f351435147bd9c6f70d9704ca1de3f170234fa9ccc536f1ac736c1c9bd20dcc3",
    assembly_full_name: "Microsoft.Web.WebView2.Core, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"
  },
  "Microsoft.Web.WebView2.WinForms.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\Microsoft.Web.WebView2.WinForms.dll",
    sha256: "sha256:41e75eae9d79b33254fcff4f147f1bc905363b6faf9e94e22a9fcdfbbf398532",
    assembly_full_name: "Microsoft.Web.WebView2.WinForms, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"
  },
  "Microsoft.Web.WebView2.Wpf.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\Microsoft.Web.WebView2.Wpf.dll",
    sha256: "sha256:e0f391bb35f8b954fb8e816a177bdd491c15bb0c1480fa0a6fad0b3224144681",
    assembly_full_name: "Microsoft.Web.WebView2.Wpf, Version=1.0.1343.22, Culture=neutral, PublicKeyToken=2a8ab48044d2601e"
  },
  "System.Buffers.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\System.Buffers.dll",
    sha256: "sha256:c65fff603b283dc966d1a8b730c11d5e5e750e8021bd24640612f6cc3f2c6fb7",
    assembly_full_name: "System.Buffers, Version=4.0.3.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"
  },
  "System.Memory.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\AddIns\\PnIDModeler\\System.Memory.dll",
    sha256: "sha256:8e76318e8b06692abf7dab1169d27d15557f7f0a34d36af6463eff0fe21213c7",
    assembly_full_name: "System.Memory, Version=4.0.1.1, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"
  },
  "System.Numerics.Vectors.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\System.Numerics.Vectors.dll",
    sha256: "sha256:1d3ef8698281e7cf7371d1554afef5872b39f96c26da772210a33da041ba1183",
    assembly_full_name: "System.Numerics.Vectors, Version=4.1.4.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"
  },
  "System.Runtime.CompilerServices.Unsafe.dll": {
    path: "C:\\Program Files\\Autodesk\\Revit 2024\\System.Runtime.CompilerServices.Unsafe.dll",
    sha256: "sha256:66409f670315afe8610f17a4d3a1ee52d72b6a46c544cec97544e8385f90ad74",
    assembly_full_name: "System.Runtime.CompilerServices.Unsafe, Version=4.0.4.1, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"
  },
  "System.Threading.Tasks.Extensions.dll": {
    path: "C:\\Program Files\\Autodesk\\Carbon Insights for Revit 2024\\System.Threading.Tasks.Extensions.dll",
    sha256: "sha256:4f81ffd0dc7204db75afc35ea4291769b07c440592f28894260eea76626a23c6",
    assembly_full_name: "System.Threading.Tasks.Extensions, Version=4.2.0.1, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"
  },
  "System.ValueTuple.dll": {
    path: "C:\\Windows\\Microsoft.Net\\assembly\\GAC_MSIL\\System.ValueTuple\\v4.0_4.0.0.0__cc7b13ffcd2ddd51\\System.ValueTuple.dll",
    sha256: "sha256:62216986c754ad8f0ee68412c42cfc3fc6e025bd908ae1fef1a3a8d528b1495a",
    assembly_full_name: "System.ValueTuple, Version=4.0.0.0, Culture=neutral, PublicKeyToken=cc7b13ffcd2ddd51"
  }
};

export type Epic0437NativeBuildManifest = {
  schema: "revit-operator.epic-0437-native-build-manifest.v2";
  candidate_source_hash: string;
  policy_hash: string;
  source_inputs_hash: string;
  source_inputs: Epic0437SourceInput[];
  configuration: "Release";
  target_framework: "net48";
  binaries: { common: { path: string; sha256: string }; logic: { path: string; sha256: string }; bridge: { path: string; sha256: string } };
  runtime_dependencies: Array<{ name: string; path: string; sha256: string; host: Epic0437HostRuntimeDependency | null }>;
  runtime_dependencies_hash: string;
  built_at_utc: string;
};

export function epic0437RuntimeDependencyReceiptMatchesManifest(
  manifest: Epic0437NativeBuildManifest,
  actual: Array<Record<string, unknown>>
): boolean {
  return actual.length === manifest.runtime_dependencies.length
    && actual.every((value, index) => {
      const expected = manifest.runtime_dependencies[index];
      if (value.name !== expected.name || typeof value.path !== "string") return false;
      if (value.origin === "deployed_addin") {
        return path.win32.basename(value.path) === expected.name && value.sha256 === expected.sha256;
      }
      return value.origin === "revit_host" && expected.host !== null
        && path.win32.normalize(value.path).toLowerCase() === path.win32.normalize(expected.host.path).toLowerCase()
        && value.sha256 === expected.host.sha256;
    });
}

export type Epic0437SourceInput = { path: string; sha256: string; normalization?: "epic-0437-generated-policy-anchor-masked.v1" };

const MASKED_POLICY_ANCHOR_SOURCES = new Set<string>([
  "apps/operator-backend/src/capabilities/trusted_tool_exposure_policy.ts",
  "apps/mcp-server/src/lib/toolExposurePolicy.ts",
  "apps/revit-bridge-addin/RevitBridge.Common/OperatorNativeToolExposureAuthority.cs"
]);

function sha256Bytes(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function readEpic0437SourceText(absolute: string, relative: string): string {
  if (!EPIC_0437_TEXT_SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    throw new Error(`EPIC-0437 source provenance refuses an unsupported non-text build input: ${relative}`);
  }
  let source: string;
  try {
    source = STRICT_UTF8.decode(fs.readFileSync(absolute));
  } catch {
    throw new Error(`EPIC-0437 source provenance refuses malformed UTF-8: ${relative}`);
  }
  if (source.includes("\0")) throw new Error(`EPIC-0437 source provenance refuses NUL/binary text: ${relative}`);
  return source;
}

export function epic0437SourceInputHash(repoRoot: string, relative: string, normalization?: Epic0437SourceInput["normalization"]): string {
  const absolute = path.join(repoRoot, relative);
  // Every enumerated source/build input is UTF-8 text. Git may materialize the
  // same reviewed text as LF or CRLF, so bind its normalized text identity.
  if (normalization === undefined) return sha256NormalizedText(readEpic0437SourceText(absolute, relative));
  let source = readEpic0437SourceText(absolute, relative);
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

export function createEpic0437NativeBuildManifest(
  repoRoot: string,
  candidateSourceHash: string,
  expectedPolicyHash: string
): Epic0437NativeBuildManifest {
  const sourceInputs = currentEpic0437SourceInputs(repoRoot);
  const policy = parseTrustedToolExposurePolicy(JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/operator-backend/config/tool_exposure_policy.v1.json"), "utf8")));
  if (policy.policy_hash !== expectedPolicyHash) throw new Error("EPIC-0437 build manifest policy is not the generated certification policy");
  const binary = (relative: string) => ({ path: relative, sha256: sha256Bytes(path.join(repoRoot, relative)) });
  const runtimeDependencies = EPIC_0437_NATIVE_RUNTIME_DEPENDENCY_NAMES.map(name => {
    const relative = `${EPIC_0437_NATIVE_RUNTIME_DIRECTORY}/${name}`;
    const host = EPIC_0437_REVIT_HOST_RUNTIME_DEPENDENCIES[name] ?? null;
    if (host !== null && (!fs.existsSync(host.path) || sha256Bytes(host.path) !== host.sha256)) {
      throw new Error(`EPIC-0437 reviewed Revit host runtime dependency is absent or changed: ${name}`);
    }
    return { name, ...binary(relative), host };
  });
  return {
    schema: "revit-operator.epic-0437-native-build-manifest.v2",
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
  if (manifest.schema !== "revit-operator.epic-0437-native-build-manifest.v2" || manifest.candidate_source_hash !== expectedCandidateSourceHash
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
    exact(dependency as unknown as Record<string, unknown>, ["name", "path", "sha256", "host"], `EPIC-0437 runtime dependency ${name}`);
    const relative = `${EPIC_0437_NATIVE_RUNTIME_DIRECTORY}/${name}`;
    if (dependency.name !== name || dependency.path !== relative || dependency.sha256 !== sha256Bytes(path.join(repoRoot, relative))) throw new Error(`EPIC-0437 runtime dependency is stale: ${name}`);
    const expectedHost = EPIC_0437_REVIT_HOST_RUNTIME_DEPENDENCIES[name] ?? null;
    if (expectedHost !== null) exact(dependency.host as unknown as Record<string, unknown>, ["path", "sha256", "assembly_full_name"], `EPIC-0437 host runtime dependency ${name}`);
    if (canonicalJson(dependency.host as unknown as JsonValue) !== canonicalJson(expectedHost as unknown as JsonValue)) throw new Error(`EPIC-0437 host runtime dependency authority is stale: ${name}`);
    return dependency;
  });
  if (manifest.runtime_dependencies_hash !== sha256NormalizedText(canonicalJson(currentRuntimeDependencies as JsonValue))) throw new Error("EPIC-0437 runtime dependency closure hash is stale");
  return { manifest, sha256: sha256NormalizedText(raw) };
}
