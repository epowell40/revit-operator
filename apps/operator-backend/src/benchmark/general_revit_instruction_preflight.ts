import { sha256Value } from "./protocol_v2_hash.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function benchmarkInstructionExpectation(draft: {
  identity: { run_id: string };
  instruction_bundle_hashes: { prompt_sha256: string; system_instruction_sha256: string };
}): RecordValue {
  return { envelope_sha256: sha256Value(draft), run_id: draft.identity.run_id,
    prompt_sha256: draft.instruction_bundle_hashes.prompt_sha256,
    system_instruction_sha256: draft.instruction_bundle_hashes.system_instruction_sha256 };
}

export function assertGeneralRevitInstructionRuntime(health: unknown, expected: RecordValue): RecordValue {
  const observed = record(record(record(health).backend).benchmark_instruction_runtime);
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const valid = observed.schema === "revit-operator.benchmark-instruction-runtime/v1"
    && observed.configured === true && observed.status === "configured"
    && typeof observed.backend_instance_id === "string" && /^[a-f0-9-]{36}$/i.test(observed.backend_instance_id)
    && Number.isSafeInteger(observed.process_id) && Number(observed.process_id) > 0
    && typeof expected.run_id === "string" && expected.run_id.length > 0
    && observed.run_id === expected.run_id
    && ["envelope_sha256", "prompt_sha256", "system_instruction_sha256"].every(key => digest(expected[key]) && observed[key] === expected[key]);
  if (!valid) throw new Error("Benchmark instruction runtime is unconfigured, missing, or mismatched; stopped before scored provider work. Launcher instruction declarations are not runtime evidence.");
  return observed;
}

export async function loadCaseInstructionTurns(
  sidecar: string, sessionId: string, startedAt: string,
  request: (base: string, route: string, options: RecordValue, timeoutMs: number) => Promise<RecordValue>
): Promise<{ host_instruction_turns: unknown[]; host_instruction_turns_complete: boolean }> {
  if (!sessionId) return { host_instruction_turns: [], host_instruction_turns_complete: false };
  try {
    const query = new URLSearchParams({ session_id: sessionId, started_at: startedAt });
    const response = await request(sidecar, `/api/codex/instruction-bindings?${query}`, {}, 30_000);
    return { host_instruction_turns: Array.isArray(response.turns) ? response.turns : [],
      host_instruction_turns_complete: response.session_id === sessionId && response.complete === true && Array.isArray(response.turns) };
  } catch { return { host_instruction_turns: [], host_instruction_turns_complete: false }; }
}
