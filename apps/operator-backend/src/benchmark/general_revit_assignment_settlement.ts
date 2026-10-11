import { assertGeneralRevitCaseSettled } from "./general_revit_export_isolation.js";
import { BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA } from "./assignment_kernel_v2_collection.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};

// The computer loop can become idle before its canonical assignment finishes
// timeout cleanup. Poll only that exact assignment; never retry the task or
// reconcile unknown effects here. The original attempt/error remains intact.
export async function waitForGeneralRevitAssignmentSettlement(input: {
  initial: RecordValue; sessionId: string;
  read: (remainingMs: number) => Promise<RecordValue>;
  timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<{ bundle: RecordValue; receipt: RecordValue }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(), deadline = started + Math.min(60_000, Math.max(0, input.timeoutMs ?? 30_000));
  let bundle = input.initial, polls = 0, stop = "unsettled", lastVersion = -1;
  const observations: RecordValue[] = [];
  let expectedIdentity: string | null = null;
  for (;;) {
    const pubs = bundle.assignments;
    const pub = Array.isArray(pubs) && pubs.length === 1 ? record(pubs[0]) : {};
    const s = record(pub.snapshot), binding = record(s.current_binding);
    const ids = bundle.assignment_ids;
    const identityValues = [pub.assignment_id, binding.assignment_id, binding.run_id, binding.generation,
      binding.session_id, binding.principal_id, binding.document_fingerprint];
    const identity = JSON.stringify(identityValues);
    if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA
      || !Array.isArray(bundle.failures) || bundle.failures.length !== 0
      || !Array.isArray(ids) || ids.length !== 1 || ids[0] !== pub.assignment_id
      || identityValues.some(v => v === undefined || v === null || v === "")
      || binding.assignment_id !== pub.assignment_id || binding.session_id !== input.sessionId
      || !Number.isSafeInteger(pub.assignment_version) || pub.assignment_version !== s.assignment_version
      || Number(pub.assignment_version) < lastVersion || (expectedIdentity !== null && identity !== expectedIdentity)) {
      stop = "identity_or_publication_invalid"; break;
    }
    expectedIdentity = identity; lastVersion = Number(pub.assignment_version);
    observations.push({ assignment_version: lastVersion, outcome: s.outcome, terminal: s.terminal, quiescent: s.quiescent,
      in_flight_operation_ids: s.in_flight_operation_ids, in_flight_provider_call_ids: s.in_flight_provider_call_ids,
      unresolved_unknown_operation_ids: s.unresolved_unknown_operation_ids, elapsed_ms: now() - started });
    if (!Array.isArray(s.unresolved_unknown_operation_ids) || s.unresolved_unknown_operation_ids.length) {
      stop = "unknown_effect_or_missing_settlement"; break;
    }
    try {
      assertGeneralRevitCaseSettled({ context_supplied: { session_id: input.sessionId },
        tool_results: { durable_assignment_kernel_v2: bundle } });
      stop = "settled"; break;
    } catch { /* Retain the failed check and await authoritative cleanup only. */ }
    if (now() >= deadline) { stop = "deadline"; break; }
    await sleep(Math.min(Math.max(1, input.pollMs ?? 500), deadline - now()));
    if (now() >= deadline) { stop = "deadline"; break; }
    polls++;
    try { bundle = await input.read(deadline - now()); }
    catch (error) { stop = "read_failed"; observations.push({ error: String(error) }); break; }
  }
  // A changed/malformed identity must not become eligible for export cleanup.
  if (stop === "identity_or_publication_invalid" || stop === "read_failed") bundle = input.initial;
  return { bundle, receipt: { stop_reason: stop, poll_count: polls, elapsed_ms: now() - started,
    initial_bundle: polls ? input.initial : null, observations } };
}
