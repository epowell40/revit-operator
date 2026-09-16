import crypto from "node:crypto";
import path from "node:path";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Bind the running backend's effective store, not a similarly named file inspected by the runner. */
export function observeGeneralRevitCampaignMemory(health: unknown, flags: RecordValue): RecordValue {
  const response = record(health), backend = record(response.backend), observed = record(backend.tool_contract_memory);
  const declaredPath = flags.tool_contract_memory_path;
  if (flags.tool_contract_memory_policy !== "isolated_campaign_initial_empty_ordered_adaptation"
      || typeof declaredPath !== "string" || !path.isAbsolute(declaredPath))
    throw new Error("benchmark_contract_memory_policy_missing");
  const expectedPath = crypto.createHash("sha256").update(path.resolve(declaredPath)).digest("hex");
  if (response.ok !== true || backend.status !== "ok"
      || observed.schema !== "revit-operator.tool-contract-memory-attestation.v1"
      || observed.store_path_sha256 !== expectedPath || observed.effective_source !== "primary"
      || !digest(observed.primary_sha256) || !digest(observed.effective_sha256))
    throw new Error("benchmark_contract_memory_runtime_unattested");
  return observed;
}

/** A resume must match the last durable state; a fresh campaign must start empty, without fallback memory. */
export function assertGeneralRevitCampaignMemoryStart(health: unknown, flags: RecordValue,
  previous?: unknown, resumed = false): RecordValue {
  const observed = observeGeneralRevitCampaignMemory(health, flags);
  if (resumed) {
    const prior = record(previous);
    if (prior.schema !== observed.schema || prior.store_path_sha256 !== observed.store_path_sha256
        || prior.primary_sha256 !== observed.primary_sha256 || prior.effective_sha256 !== observed.effective_sha256)
      throw new Error("benchmark_contract_memory_checkpoint_mismatch");
  } else {
    const counts = record(observed.counts);
    if (!digest(flags.tool_contract_memory_initial_sha256)
        || observed.primary_sha256 !== flags.tool_contract_memory_initial_sha256
        || observed.initial_empty !== true || observed.backup_present !== false
        || ["pending_failures", "failure_receipts", "corrections", "quarantines"].some(key => counts[key] !== 0))
      throw new Error("benchmark_contract_memory_initial_state_not_empty");
  }
  return observed;
}
