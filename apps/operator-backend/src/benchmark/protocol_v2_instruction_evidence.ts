import { sha256Value } from "./protocol_v2_hash.js";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import { directKernelPublicationsV2 } from "./protocol_v2_kernel.js";
import type { BenchmarkRunEnvelopeDraftV2 } from "./protocol_v2_types.js";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(row) : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Host acknowledgement only: this does not attest to provider-injected instructions or skills. */
export function assertProtocolV2InstructionEvidence(
  draft: BenchmarkRunEnvelopeDraftV2, traces: readonly Row[]
): void {
  const envelopeHash = sha256Value(draft);
  const instances = new Map<string, number>();
  for (const trace of traces) {
    const fail = (reason: string): never => {
      throw new Error(`Benchmark Protocol V2 instruction_coverage_unqualified for ${text(trace.case_id) || "unknown"}: ${reason}.`);
    };
    const events = rows(trace.host_instruction_turns);
    const receipts = rows(trace.model_call_receipts);
    const publications = directKernelPublicationsV2(trace.tool_results);
    const legacyAssignments = rows(row(row(trace.tool_results).durable_assignment_projection).assignments);
    if (publications.length === 0 && legacyAssignments.some(assignment =>
      row(assignment.assignment_snapshot_v2).schema === ASSIGNMENT_SNAPSHOT_V2_SCHEMA)) {
      fail("canonical_provider_publication_missing");
    }
    const calls = publications.flatMap(publication => {
      const ledger = row(publication.provider_ledger);
      const byId = row(ledger.calls);
      return Array.isArray(ledger.call_ids) ? ledger.call_ids.map(id => row(byId[String(id)])) : [];
    });
    if (events.length === 0 && receipts.length === 0 && calls.length === 0) continue;
    if (trace.host_instruction_turns_complete !== true || !Array.isArray(trace.host_instruction_turns)) {
      fail("instruction_event_collection_incomplete");
    }
    const session = text(row(trace.context_supplied).session_id);
    if (!session) fail("case_session_missing");
    const byTurn = new Map<string, Row>();
    for (const event of events) {
      const turn = text(event.turn_id);
      if (text(event.session_id) !== session || !turn || !text(event.thread_id) || !text(event.message_id)) {
        fail("instruction_turn_identity_invalid");
      }
      if (byTurn.has(turn)) fail("instruction_turn_identity_duplicate");
      byTurn.set(turn, event);
      const binding = row(event.host_instruction_binding);
      if (binding.schema !== "revit-operator.host-supplied-instructions/v1"
          || binding.source !== "host_supplied_acknowledged") fail("host_instruction_acknowledgement_missing");
      const runtime = row(binding.benchmark_runtime);
      if (runtime.schema !== "revit-operator.benchmark-instruction-runtime/v1" || runtime.configured !== true) {
        fail("runtime_instruction_binding_missing");
      }
      if (runtime.envelope_sha256 !== envelopeHash || runtime.run_id !== draft.identity.run_id) {
        fail("runtime_envelope_binding_mismatch");
      }
      for (const key of ["prompt_sha256", "system_instruction_sha256"] as const) {
        if (binding[key] !== draft.instruction_bundle_hashes[key] || runtime[key] !== binding[key]) {
          fail(`runtime_${key}_mismatch`);
        }
      }
      const instance = text(runtime.backend_instance_id);
      const pid = runtime.process_id;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(instance)
          || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) fail("runtime_process_identity_invalid");
      if (instances.has(instance) && instances.get(instance) !== pid) fail("runtime_process_identity_conflict");
      instances.set(instance, pid as number);
    }
    const join = (identity: Row, turnValue: unknown, sessionValue?: unknown): void => {
      const turn = text(turnValue);
      const event = byTurn.get(turn);
      if (!turn || !event) {
        // A compaction with a distinct turn needs its own lifecycle evidence; another turn cannot attest to it.
        fail("instruction_turn_binding_missing (including any separately billed compaction turn)");
      }
      if (sessionValue !== undefined && text(sessionValue) !== session) fail("provider_session_binding_mismatch");
      for (const field of ["message_id", "thread_id"] as const) {
        if (identity[field] !== undefined && text(identity[field]) !== text(event![field])) fail(`provider_${field}_mismatch`);
      }
    };
    for (const call of calls) {
      const binding = row(call.binding);
      if (!text(binding.session_id)) fail("canonical_provider_session_missing");
      join(call, call.controller_turn_id, binding.session_id);
    }
    const canonicalById = new Map(calls.map(call => [text(call.call_id), call]));
    for (const receipt of receipts) {
      const canonical = canonicalById.get(text(receipt.call_id) || text(receipt.response_id));
      if (canonical && text(receipt.turn_id) !== text(canonical.controller_turn_id)) {
        fail("provider_call_turn_binding_mismatch");
      }
      join(receipt, receipt.turn_id, receipt.session_id);
    }
  }
}
