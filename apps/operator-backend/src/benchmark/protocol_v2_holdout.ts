import fs from "node:fs";
import path from "node:path";
import type { GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";
import { sha256File, sha256Value } from "./protocol_v2_hash.js";

export const EXTERNAL_HOLDOUT_MANIFEST_V2 = "revit-operator.external-holdout-manifest/v2" as const;

export type ExternalHoldoutManifestV2 = {
  schema: typeof EXTERNAL_HOLDOUT_MANIFEST_V2;
  manifest_id: string;
  corpus_version: string;
  fixture_adapter_version: string;
  fixtures: Array<{
    identity: string;
    path: string;
    sha256: string;
    discipline: string;
    document_title: string;
    case_ids: string[];
  }>;
  cases: GeneralRevitCapabilityCase[];
};

export type ExternalHoldoutDescriptorV2 = {
  schema: "revit-operator.external-holdout-descriptor/v2";
  manifest_id: string;
  manifest_sha256: string;
  corpus_version: string;
  fixture_adapter_version: string;
  case_count: number;
  case_hashes: Record<string, string>;
  fixture_hashes: Array<{ identity: string; sha256: string }>;
};

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function loadExternalHiddenHoldoutV2(args: {
  manifestPath: string;
  forbiddenSourceRoots: string[];
}): { manifest: ExternalHoldoutManifestV2; descriptor: ExternalHoldoutDescriptorV2 } {
  const manifestPath = path.resolve(args.manifestPath);
  if (args.forbiddenSourceRoots.some((root) => isWithin(manifestPath, root))) {
    throw new Error("Hidden holdout manifests must remain external to public and ordinary private source trees.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExternalHoldoutManifestV2;
  if (manifest.schema !== EXTERNAL_HOLDOUT_MANIFEST_V2 || !manifest.manifest_id?.trim() || !manifest.corpus_version?.trim()) {
    throw new Error("External holdout manifest identity or schema is invalid.");
  }
  if (!manifest.fixture_adapter_version?.trim() || !Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    throw new Error("External holdout manifest requires a fixture adapter version and fixtures.");
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error("External holdout manifest contains no cases.");
  const ids = new Set<string>();
  const fixtureCases = new Set<string>();
  const manifestDir = path.dirname(manifestPath);
  for (const testCase of manifest.cases) {
    if (!testCase.case_id?.trim() || ids.has(testCase.case_id)) throw new Error("External holdout contains missing or duplicate case IDs.");
    ids.add(testCase.case_id);
    if (!testCase.prompt?.trim() || !testCase.probe_prompt?.trim()) throw new Error(`External holdout case ${testCase.case_id} is incomplete.`);
  }
  for (const fixture of manifest.fixtures) {
    const fixturePath = path.resolve(manifestDir, fixture.path);
    if (!fs.existsSync(fixturePath)) throw new Error(`External holdout fixture '${fixture.identity}' is missing.`);
    if (sha256File(fixturePath).toLowerCase() !== fixture.sha256.toLowerCase()) {
      throw new Error(`External holdout fixture '${fixture.identity}' hash does not match.`);
    }
    if (!fixture.discipline?.trim() || !fixture.document_title?.trim()) throw new Error(`External holdout fixture '${fixture.identity}' has incomplete Revit identity.`);
    for (const caseId of fixture.case_ids || []) {
      if (!ids.has(caseId) || fixtureCases.has(caseId)) throw new Error(`External holdout fixture mapping for '${caseId}' is invalid or duplicated.`);
      fixtureCases.add(caseId);
    }
  }
  if (fixtureCases.size !== ids.size) throw new Error("Every external holdout case must map to exactly one fixture.");
  const descriptor: ExternalHoldoutDescriptorV2 = {
    schema: "revit-operator.external-holdout-descriptor/v2",
    manifest_id: manifest.manifest_id,
    manifest_sha256: sha256File(manifestPath),
    corpus_version: manifest.corpus_version,
    fixture_adapter_version: manifest.fixture_adapter_version,
    case_count: manifest.cases.length,
    case_hashes: Object.fromEntries(manifest.cases.map((testCase) => [testCase.case_id, sha256Value(testCase)])),
    fixture_hashes: manifest.fixtures.map((fixture) => ({ identity: fixture.identity, sha256: fixture.sha256 }))
  };
  return { manifest, descriptor };
}

export function assertExternalHoldoutOutputV2(outputPath: string, forbiddenSourceRoots: string[]): void {
  if (forbiddenSourceRoots.some((root) => isWithin(outputPath, root))) {
    throw new Error("Hidden holdout reports and retained raw traces must be written outside source-controlled repository trees.");
  }
}

/** Safe for ordinary logs and reports; never includes prompts, answer criteria, or fixture paths. */
export function redactedExternalHoldoutDescriptorV2(value: ExternalHoldoutDescriptorV2): ExternalHoldoutDescriptorV2 {
  return structuredClone(value);
}
