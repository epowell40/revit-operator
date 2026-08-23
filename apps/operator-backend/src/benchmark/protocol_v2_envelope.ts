import { assertSha256, sha256Value } from "./protocol_v2_hash.js";
import {
  BENCHMARK_LANES,
  BENCHMARK_PROTOCOL_V2,
  BENCHMARK_REPORT_V2,
  BENCHMARK_RUN_ENVELOPE_V2_SCHEMA,
  BENCHMARK_RUNNER_V2,
  type BenchmarkRunEnvelopeDraftV2,
  type BenchmarkRunEnvelopeV2
} from "./protocol_v2_types.js";

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Benchmark Protocol V2 requires ${label}.`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const text = required(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp.`);
  return text;
}

function sourceRevision(value: unknown, label: string): string {
  const text = required(value, label);
  if (!/^[a-f0-9]{40}$/i.test(text)) throw new Error(`${label} must be an exact 40-character git revision.`);
  return text;
}

export function validateBenchmarkRunEnvelopeDraftV2(value: BenchmarkRunEnvelopeDraftV2): void {
  if (value.schema !== BENCHMARK_RUN_ENVELOPE_V2_SCHEMA || value.protocol_version !== BENCHMARK_PROTOCOL_V2) {
    throw new Error("Benchmark Protocol V2 run envelope has an unsupported schema or protocol version.");
  }
  if (value.runner_schema_version !== BENCHMARK_RUNNER_V2 || value.report_schema_version !== BENCHMARK_REPORT_V2) {
    throw new Error("Benchmark Protocol V2 runner/report schema versions are incomplete or unsupported.");
  }
  required(value.corpus.version, "corpus version");
  assertSha256(value.corpus.sha256, "corpus.sha256");
  assertSha256(value.corpus.original_case_manifest_sha256, "corpus.original_case_manifest_sha256");
  if (Object.keys(value.corpus.case_hashes).length === 0) throw new Error("Benchmark Protocol V2 requires case hashes.");
  for (const [caseId, hash] of Object.entries(value.corpus.case_hashes)) assertSha256(hash, `case hash ${caseId}`);
  required(value.evaluator_version, "evaluator version");
  required(value.fixture_adapter.version, "fixture adapter version");
  if (value.fixture_adapter.fixtures.length === 0) throw new Error("Benchmark Protocol V2 requires at least one fixture identity.");
  for (const fixture of value.fixture_adapter.fixtures) {
    required(fixture.identity, "fixture RVT identity");
    assertSha256(fixture.rvt_sha256, `fixture ${fixture.identity} RVT hash`);
  }
  required(value.revit_version, "Revit version");
  required(value.installed_release_identity, "installed add-in/package release identity");
  sourceRevision(value.source_revisions.public, "public source revision");
  sourceRevision(value.source_revisions.private, "private source revision");
  assertSha256(value.policy_hashes.tool_registry_sha256, "tool registry policy hash");
  assertSha256(value.policy_hashes.tool_exposure_sha256, "tool exposure policy hash");
  assertSha256(value.policy_hashes.certification_policy_sha256, "certification policy hash");
  assertSha256(value.instruction_bundle_hashes.prompt_sha256, "prompt bundle hash");
  assertSha256(value.instruction_bundle_hashes.skill_sha256, "skill bundle hash");
  assertSha256(value.instruction_bundle_hashes.system_instruction_sha256, "system instruction bundle hash");
  required(value.requested_agent.model, "requested model");
  required(value.requested_agent.reasoning_effort, "requested reasoning effort");
  required(value.authorization_mode, "authorization mode");
  required(value.identity.run_id, "run ID");
  required(value.identity.session_id, "session ID");
  if (!Number.isInteger(value.identity.generation) || value.identity.generation < 1) {
    throw new Error("Benchmark Protocol V2 requires a positive Assignment generation.");
  }
  if (!BENCHMARK_LANES.includes(value.execution_lane)) throw new Error("Benchmark Protocol V2 execution lane is invalid.");
  timestamp(value.started_at, "run start timestamp");
}

export function finalizeBenchmarkRunEnvelopeV2(
  draft: BenchmarkRunEnvelopeDraftV2,
  observedProviderRoutes: BenchmarkRunEnvelopeV2["observed_provider_routes"],
  completedAt: string
): BenchmarkRunEnvelopeV2 {
  validateBenchmarkRunEnvelopeDraftV2(draft);
  timestamp(completedAt, "run completion timestamp");
  if (observedProviderRoutes.length === 0) throw new Error("Benchmark Protocol V2 requires observed provider routes.");
  for (const route of observedProviderRoutes) {
    required(route.route, "observed provider route");
    required(route.model, "observed provider model");
    required(route.reasoning_effort, "observed provider reasoning effort");
    if (!Number.isInteger(route.call_count) || route.call_count < 1) throw new Error("Observed provider call_count must be positive.");
  }
  const unsigned = { ...draft, observed_provider_routes: observedProviderRoutes, completed_at: completedAt };
  return { ...unsigned, envelope_sha256: sha256Value(unsigned) };
}

export function validateBenchmarkRunEnvelopeV2(value: BenchmarkRunEnvelopeV2): void {
  validateBenchmarkRunEnvelopeDraftV2(value);
  timestamp(value.completed_at, "run completion timestamp");
  if (Date.parse(value.completed_at) < Date.parse(value.started_at)) throw new Error("Run completion precedes run start.");
  const { envelope_sha256: recorded, ...unsigned } = value;
  assertSha256(recorded, "envelope_sha256");
  if (sha256Value(unsigned) !== recorded) throw new Error("Benchmark run envelope hash does not match its immutable content.");
  if (!Array.isArray(value.observed_provider_routes) || value.observed_provider_routes.length === 0) {
    throw new Error("Benchmark Protocol V2 requires complete observed provider telemetry.");
  }
  const calls = value.observed_provider_routes.reduce((sum, route) => sum + route.call_count, 0);
  if (calls < 1) throw new Error("Benchmark Protocol V2 provider telemetry has no observed calls.");
}
