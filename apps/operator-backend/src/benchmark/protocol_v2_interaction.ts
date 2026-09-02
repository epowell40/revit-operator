import fs from "node:fs";
import path from "node:path";

export const BENCHMARK_INTERACTION_MANIFEST_V1 = "revit-operator.benchmark-interaction-manifest/v1" as const;

export type BenchmarkInteractionCaseV1 = {
  source_case_id: string;
  transformation_id: string;
  transformation_version: string;
  clarification_response: {
    candidate_visible_user_text: string;
    supplied_values: Record<string, string | number | boolean | null>;
  };
  direct_variant?: {
    candidate_visible_user_text: string;
    transformation_id: string;
    transformation_version: string;
  };
  evaluator_oracle: {
    protected_identity: string;
    sha256: string;
    required_result_variable_ids: string[];
  };
};

export type BenchmarkInteractionManifestV1 = {
  schema: typeof BENCHMARK_INTERACTION_MANIFEST_V1;
  manifest_id: string;
  cases: BenchmarkInteractionCaseV1[];
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, name: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`Benchmark interaction manifest requires ${name}.`);
  return result;
}

function version(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(result)) throw new Error(`Benchmark interaction manifest has invalid ${name}.`);
  return result;
}

function sha256(value: unknown, name: string): string {
  const result = text(value, name).replace(/^sha256:/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Benchmark interaction manifest requires a SHA-256 ${name}.`);
  return result;
}

function suppliedValues(value: unknown): Record<string, string | number | boolean | null> {
  const row = object(value);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(row)) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(key)) throw new Error("Benchmark clarification supplied-value keys must be bounded identifiers.");
    if (/(?:authorization|x-operator-token|api[_-]?key|password|secret|credential|bearer|jwt|token)/i.test(key)) {
      throw new Error("Benchmark clarification supplied values may not contain credentials or secret fields.");
    }
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new Error("Benchmark clarification supplied values must be bounded JSON scalars.");
    }
    if (typeof item === "string" && item.length > 4_096) {
      throw new Error("Benchmark clarification supplied values may not contain oversized strings.");
    }
    result[key] = item as string | number | boolean | null;
  }
  if (Object.keys(result).length === 0) throw new Error("Benchmark clarification requires at least one candidate-visible supplied value.");
  return result;
}

function identifiers(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Benchmark interaction manifest requires ${name} to be an array.`);
  const result = value.map((item, index) => version(item, `${name}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`Benchmark interaction manifest requires unique ${name}.`);
  return result;
}

function normalizeCase(value: unknown): BenchmarkInteractionCaseV1 {
  const row = object(value);
  const response = object(row.clarification_response);
  const oracle = object(row.evaluator_oracle);
  const direct = object(row.direct_variant);
  const values = suppliedValues(response.supplied_values);
  const requiredResultVariableIds = identifiers(
    oracle.required_result_variable_ids,
    "evaluator_oracle.required_result_variable_ids"
  );
  for (const variableId of requiredResultVariableIds) {
    if (!Object.prototype.hasOwnProperty.call(values, variableId) || values[variableId] === null) {
      throw new Error(`Benchmark interaction result assertion references missing supplied value '${variableId}'.`);
    }
  }
  return {
    source_case_id: version(row.source_case_id, "source_case_id"),
    transformation_id: version(row.transformation_id, "transformation_id"),
    transformation_version: version(row.transformation_version, "transformation_version"),
    clarification_response: {
      candidate_visible_user_text: text(response.candidate_visible_user_text, "clarification_response.candidate_visible_user_text"),
      supplied_values: values
    },
    ...(Object.keys(direct).length > 0 ? { direct_variant: {
      candidate_visible_user_text: text(direct.candidate_visible_user_text, "direct_variant.candidate_visible_user_text"),
      transformation_id: version(direct.transformation_id, "direct_variant.transformation_id"),
      transformation_version: version(direct.transformation_version, "direct_variant.transformation_version")
    } } : {}),
    evaluator_oracle: {
      protected_identity: version(oracle.protected_identity, "evaluator_oracle.protected_identity"),
      sha256: sha256(oracle.sha256, "evaluator_oracle.sha256"),
      required_result_variable_ids: requiredResultVariableIds
    }
  };
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Candidate-visible values explicitly named by the evaluator must survive the final handoff. */
export function benchmarkInteractionResultPatternsV1(interaction: BenchmarkInteractionCaseV1): string[] {
  return interaction.evaluator_oracle.required_result_variable_ids.map(variableId => {
    const value = interaction.clarification_response.supplied_values[variableId];
    if (typeof value !== "string") return escapePattern(String(value));
    const canonicalLines = value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "").split("\n");
    return canonicalLines.map(line => escapePattern(line)).join("\\s+");
  });
}

export function parseBenchmarkInteractionManifestV1(value: unknown): BenchmarkInteractionManifestV1 {
  const row = object(value);
  if (row.schema !== BENCHMARK_INTERACTION_MANIFEST_V1) throw new Error(`Benchmark interaction manifest schema must be ${BENCHMARK_INTERACTION_MANIFEST_V1}.`);
  const cases = Array.isArray(row.cases) ? row.cases.map(normalizeCase) : [];
  if (cases.length === 0) throw new Error("Benchmark interaction manifest requires at least one case.");
  const ids = cases.map(entry => entry.source_case_id);
  if (new Set(ids).size !== ids.length) throw new Error("Benchmark interaction manifest source case IDs must be unique.");
  return { schema: BENCHMARK_INTERACTION_MANIFEST_V1, manifest_id: version(row.manifest_id, "manifest_id"), cases };
}

export function loadBenchmarkInteractionManifestV1(filePath: string): BenchmarkInteractionManifestV1 {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  return parseBenchmarkInteractionManifestV1(parsed);
}

export function benchmarkInteractionCaseV1(
  manifest: BenchmarkInteractionManifestV1 | null,
  sourceCaseId: string
): BenchmarkInteractionCaseV1 | null {
  return manifest?.cases.find(entry => entry.source_case_id === sourceCaseId) ?? null;
}

export function benchmarkInteractionTraceV1(args: {
  interaction: BenchmarkInteractionCaseV1;
  directVariant: boolean;
  firstMessageId: string;
  firstPrompt: string;
  firstAssistant: string;
  finalMessageId: string;
  finalAssistant: string;
  clarificationId: string;
}): Record<string, unknown> {
  const direct = args.interaction.direct_variant;
  return {
    transformation_id: args.directVariant ? direct!.transformation_id : args.interaction.transformation_id,
    transformation_version: args.directVariant ? direct!.transformation_version : args.interaction.transformation_version,
    evaluator_oracle_sha256: args.interaction.evaluator_oracle.sha256,
    evaluator_oracle_identity: args.interaction.evaluator_oracle.protected_identity,
    turns: args.directVariant ? [
      { turn_id: args.finalMessageId, sequence: 1, role: "user", candidate_visible_input: args.firstPrompt },
      { turn_id: `${args.finalMessageId}:assistant`, sequence: 2, role: "assistant", content: args.finalAssistant }
    ] : [
      { turn_id: args.firstMessageId, sequence: 1, role: "user", candidate_visible_input: args.firstPrompt },
      { turn_id: `${args.firstMessageId}:assistant`, sequence: 2, role: "assistant", content: args.firstAssistant,
        clarification_id: args.clarificationId || null, assignment_outcome: args.clarificationId ? "awaiting_user_input" : "unknown" },
      ...(args.clarificationId ? [
        { turn_id: args.finalMessageId, sequence: 3, role: "user", candidate_visible_input: args.interaction.clarification_response.candidate_visible_user_text, clarification_id: args.clarificationId },
        { turn_id: `${args.finalMessageId}:assistant`, sequence: 4, role: "assistant", content: args.finalAssistant, clarification_id: args.clarificationId }
      ] : [])
    ]
  };
}
