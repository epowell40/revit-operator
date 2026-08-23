import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { benchmarkDataRoot, readJsonFile } from "./files.js";

const CONTRACTS: Record<string, string> = {
  run_envelope_draft: "benchmark_run_envelope_draft.v2.schema.json",
  run_envelope: "benchmark_run_envelope.v2.schema.json",
  case_result: "benchmark_case_result.v2.schema.json",
  raw_report: "benchmark_raw_report.v2.schema.json",
  rescore: "benchmark_rescore.v2.schema.json",
  external_holdout: "benchmark_external_holdout.v2.schema.json",
  finalization_failure: "benchmark_finalization_failure.v2.schema.json"
};

export type BenchmarkProtocolV2Contract = keyof typeof CONTRACTS;

export function validateBenchmarkProtocolV2Contract(contract: BenchmarkProtocolV2Contract, value: unknown): void {
  const fileName = CONTRACTS[contract];
  const schema = readJsonFile<Record<string, unknown>>(path.join(benchmarkDataRoot(), "contracts", fileName));
  const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, validateFormats: false, allowUnionTypes: true }).compile(schema);
  if (!validate(value)) {
    const details = (validate.errors || []).map((entry) => `${entry.instancePath || "/"} ${entry.message || "invalid"}`).join("; ");
    throw new Error(`Benchmark Protocol V2 ${contract} contract failed: ${details}`);
  }
}
