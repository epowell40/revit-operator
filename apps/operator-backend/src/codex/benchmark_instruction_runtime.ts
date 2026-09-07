import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { sha256Value } from "../canonical_json_hash.js";

const backendInstanceId = randomUUID();
export type BenchmarkInstructionRuntime = Readonly<{
  schema: "revit-operator.benchmark-instruction-runtime/v1";
  configured: boolean;
  backend_instance_id: string;
  process_id: number;
  status: "configured" | "unset" | "invalid";
  envelope_sha256?: string;
  run_id?: string;
  prompt_sha256?: string;
  system_instruction_sha256?: string;
}>;

/** Hash-only observation of host configuration, never a caller-selected path. */
export function benchmarkInstructionRuntime(env: NodeJS.ProcessEnv = process.env): BenchmarkInstructionRuntime {
  const base = { schema: "revit-operator.benchmark-instruction-runtime/v1" as const,
    backend_instance_id: backendInstanceId, process_id: process.pid };
  const file = env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH;
  if (!file) return Object.freeze({ ...base, configured: false, status: "unset" });
  try {
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    const hashes = envelope.instruction_bundle_hashes;
    if (envelope.schema !== "revit-operator.benchmark-run-envelope/v2"
      || typeof envelope.identity?.run_id !== "string" || !envelope.identity.run_id.trim()
      || !/^[a-f0-9]{64}$/.test(hashes?.prompt_sha256)
      || !/^[a-f0-9]{64}$/.test(hashes?.system_instruction_sha256)) throw new Error("Invalid envelope");
    return Object.freeze({ ...base, configured: true, status: "configured",
      envelope_sha256: sha256Value(envelope), run_id: envelope.identity.run_id,
      prompt_sha256: hashes.prompt_sha256, system_instruction_sha256: hashes.system_instruction_sha256 });
  } catch { return Object.freeze({ ...base, configured: false, status: "invalid" }); }
}
