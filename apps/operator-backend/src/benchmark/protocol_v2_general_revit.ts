import fs from "node:fs";
import path from "node:path";
import { benchmarkDataRoot, sourceControlledRoots } from "./files.js";
import {
  loadGeneralRevitCapabilityCorpus,
  summarizeGeneralRevitCorpusCoverage,
  type GeneralRevitCapabilityCorpus
} from "./general_revit_capability_acceptance.js";
import {
  loadGeneralRevitSampleFixtures,
  type GeneralRevitSampleFixtures
} from "./general_revit_sample_fixtures.js";
import {
  assertExternalHoldoutOutputV2,
  loadExternalHiddenHoldoutV2,
  type ExternalHoldoutManifestV2,
  type ExternalHoldoutDescriptorV2
} from "./protocol_v2_holdout.js";
import type { BenchmarkRunEnvelopeDraftV2 } from "./protocol_v2_types.js";
import { assertReleaseCanaryInvocationV2 } from "./protocol_v2_canary.js";
import {
  loadBenchmarkRunEnvelopeDraftV2,
  protocolLaneFromFlags,
  writeProtocolV2ReportFromFlight
} from "./protocol_v2_runner.js";

export type GeneralRevitProtocolInputsV2 = {
  corpus: GeneralRevitCapabilityCorpus;
  fixtureConfig: GeneralRevitSampleFixtures;
  externalHoldout: { manifest: ExternalHoldoutManifestV2; descriptor: ExternalHoldoutDescriptorV2 } | null;
  externalHoldoutPath: string;
  forbiddenSourceRoots: string[];
};

export function loadGeneralRevitProtocolInputsV2(externalHoldoutPath: string): GeneralRevitProtocolInputsV2 {
  const publicCorpus = loadGeneralRevitCapabilityCorpus();
  const forbiddenSourceRoots = sourceControlledRoots();
  const externalHoldout = externalHoldoutPath
    ? loadExternalHiddenHoldoutV2({ manifestPath: externalHoldoutPath, forbiddenSourceRoots })
    : null;
  if (!externalHoldout) {
    return { corpus: publicCorpus, fixtureConfig: loadGeneralRevitSampleFixtures(publicCorpus.cases), externalHoldout, externalHoldoutPath, forbiddenSourceRoots };
  }
  const corpus: GeneralRevitCapabilityCorpus = {
    ...publicCorpus,
    suite_id: externalHoldout.descriptor.manifest_id,
    purpose: "Authorized external hidden-holdout release evaluation using the public protocol without publishing prompts or answer criteria.",
    corpus_evidence: {
      taxonomy_path: "external-hidden-holdout",
      actionable_comment_total: externalHoldout.manifest.cases.length,
      top_task_type_comment_total: externalHoldout.manifest.cases.length,
      task_types: []
    },
    required_operation_families: [...new Set(externalHoldout.manifest.cases.map((entry) => entry.operation_family))],
    cases: externalHoldout.manifest.cases
  };
  const fixtureConfig: GeneralRevitSampleFixtures = {
    schema: "revit-operator.general-revit-sample-fixtures/v1",
    default_fixture: externalHoldout.manifest.fixtures[0]!.identity,
    fixtures: Object.fromEntries(externalHoldout.manifest.fixtures.map((fixture) => [fixture.identity, {
      discipline: fixture.discipline,
      document_title: fixture.document_title,
      sample_filename: path.resolve(path.dirname(externalHoldoutPath), fixture.path)
    }])),
    case_overrides: Object.fromEntries(externalHoldout.manifest.fixtures.map((fixture) => [fixture.identity, fixture.case_ids]))
  };
  return { corpus, fixtureConfig, externalHoldout, externalHoldoutPath, forbiddenSourceRoots };
}

export function assertGeneralRevitProtocolOutputV2(inputs: GeneralRevitProtocolInputsV2, outputPath: string, protocolV2: boolean): void {
  if (inputs.externalHoldout) assertExternalHoldoutOutputV2(outputPath, inputs.forbiddenSourceRoots);
  if (!protocolV2) return;
  const rawV2Path = path.join(path.dirname(outputPath), "protocol-v2", "raw-report.json");
  if (fs.existsSync(outputPath) || fs.existsSync(rawV2Path)) {
    throw new Error("Benchmark Protocol V2 refuses to overwrite retained raw run evidence; use a new run identity and output path.");
  }
}

export function assertGeneralRevitEnvelopeBindingV2(
  draft: BenchmarkRunEnvelopeDraftV2,
  inputs: GeneralRevitProtocolInputsV2
): void {
  if (!inputs.externalHoldout) return;
  if (draft.corpus.original_case_manifest_sha256 !== inputs.externalHoldout.descriptor.manifest_sha256) {
    throw new Error("Protocol V2 envelope does not bind the external holdout manifest hash.");
  }
  if (draft.fixture_adapter.version !== inputs.externalHoldout.descriptor.fixture_adapter_version) {
    throw new Error("Protocol V2 envelope does not bind the external holdout fixture adapter version.");
  }
}

export function generalRevitProtocolFixtureRootV2(inputs: GeneralRevitProtocolInputsV2, ordinaryRoot: string): string {
  return inputs.externalHoldout ? path.dirname(path.resolve(inputs.externalHoldoutPath)) : path.resolve(ordinaryRoot);
}

export function generalRevitProtocolCorpusCoverageV2(inputs: GeneralRevitProtocolInputsV2): Record<string, unknown> {
  return inputs.externalHoldout ? {
    external_hidden_holdout: true,
    manifest_id: inputs.externalHoldout.descriptor.manifest_id,
    manifest_sha256: inputs.externalHoldout.descriptor.manifest_sha256,
    case_count: inputs.externalHoldout.descriptor.case_count
  } : summarizeGeneralRevitCorpusCoverage(inputs.corpus);
}

export function generalRevitProtocolManifestPathV2(inputs: GeneralRevitProtocolInputsV2): string {
  return inputs.externalHoldoutPath || path.join(benchmarkDataRoot(), "general-agent", "revit-capability-acceptance.v1.json");
}

export function resolveGeneralRevitProtocolRunV2(args: {
  envelopePath: string;
  releaseCanary: boolean;
  legacyProtocol: boolean;
  proposedRunId: string;
  applyRequested: boolean;
  requestedFixture: string;
  orchestrateFixtures: boolean;
  laneFlag: string;
  inputs: GeneralRevitProtocolInputsV2;
}): { draft: BenchmarkRunEnvelopeDraftV2 | null; runId: string } {
  const draft = args.envelopePath ? loadBenchmarkRunEnvelopeDraftV2(args.envelopePath) : null;
  if (!draft && !args.legacyProtocol) throw new Error("New benchmark runs require --protocol-v2-envelope. Use --legacy-protocol-v1 only to inspect or rescore retained historical V1 flights.");
  if (args.releaseCanary && !draft) throw new Error("Release canary requires a complete Benchmark Protocol V2 envelope draft.");
  if (!draft) return { draft, runId: args.proposedRunId };
  const requestedLane = args.laneFlag || protocolLaneFromFlags({
    apply: args.applyRequested,
    controlled: Boolean(args.requestedFixture || args.orchestrateFixtures),
    ambient: !args.requestedFixture && !args.orchestrateFixtures
  });
  if (draft.execution_lane !== requestedLane) throw new Error("Protocol V2 envelope lane does not match the runner invocation.");
  if ((draft.execution_lane === "committed_apply") !== args.applyRequested) throw new Error("Committed-apply lane and --apply must be selected together.");
  assertGeneralRevitEnvelopeBindingV2(draft, args.inputs);
  return { draft, runId: draft.identity.run_id };
}

export function writeGeneralRevitProtocolReportV2(args: {
  draft: BenchmarkRunEnvelopeDraftV2 | null;
  envelopePath: string;
  legacyReportPath: string;
  corpus: GeneralRevitCapabilityCorpus;
  inputs: GeneralRevitProtocolInputsV2;
  releaseCanary: boolean;
}): string | null {
  if (!args.draft) return null;
  const protocolArtifacts = writeProtocolV2ReportFromFlight({
    draftPath: args.envelopePath,
    legacyReportPath: args.legacyReportPath,
    outputPath: path.join(path.dirname(args.legacyReportPath), "protocol-v2", "raw-report.json"),
    cases: args.corpus.cases,
    corpusValue: args.inputs.externalHoldout?.manifest ?? args.corpus,
    originalManifestPath: generalRevitProtocolManifestPathV2(args.inputs),
    requireCompleteReceipts: true
  });
  if (args.releaseCanary) {
    if (protocolArtifacts.report.cases.length !== 10) throw new Error("Release canary did not retain all ten frozen cases.");
    assertReleaseCanaryInvocationV2({ resume: false, receiptComplete: true });
  }
  return protocolArtifacts.json_path;
}
