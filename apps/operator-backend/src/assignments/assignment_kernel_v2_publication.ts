import type { AssignmentSnapshotV2, ProviderCallV2 } from "../domain/assignment-kernel/index.js";
import {
  ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA,
  type AssignmentKernelV2SessionIndex,
  type AssignmentKernelV2SessionIndexEntry
} from "@revitoperator/assignment-kernel-v2-contracts";
import { getAssignmentKernelSnapshotV2, listAssignmentKernelIndexV2 } from "./assignment_kernel_v2_store.js";

export const ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA = "revit-operator.assignment-kernel-publication/v2" as const;
export const ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA = "revit-operator.assignment-provider-ledger/v2" as const;
export const ASSIGNMENT_KERNEL_SESSION_INDEX_V2_SCHEMA = ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA;

export interface AssignmentProviderLedgerPublicationV2 {
  schema: typeof ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA;
  assignment_id: string;
  run_id: string;
  generation: number;
  call_ids: readonly string[];
  calls: Readonly<Record<string, ProviderCallV2>>;
  in_flight_call_ids: readonly string[];
}

export interface AssignmentKernelPublicationV2 {
  schema: typeof ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA;
  assignment_id: string;
  assignment_version: number;
  snapshot: AssignmentSnapshotV2;
  provider_ledger: AssignmentProviderLedgerPublicationV2;
}

export type AssignmentKernelSessionIndexEntryV2 = AssignmentKernelV2SessionIndexEntry;
export type AssignmentKernelSessionIndexV2 = AssignmentKernelV2SessionIndex;

/**
 * V2 publication is a pure, read-only view of the canonical snapshot. It does
 * not consult Goal lifecycle fields, V1 AssignmentProjection, chat response
 * state, or Sidecar transport state.
 */
export function buildAssignmentKernelPublicationV2(snapshot: AssignmentSnapshotV2): AssignmentKernelPublicationV2 {
  const calls = Object.fromEntries(snapshot.provider_call_ids
    .filter((callId) => Boolean(snapshot.provider_calls[callId]))
    .map((callId) => [callId, structuredClone(snapshot.provider_calls[callId]!) ]));
  return {
    schema: ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
    assignment_id: snapshot.current_binding.assignment_id,
    assignment_version: snapshot.assignment_version,
    snapshot: structuredClone(snapshot),
    provider_ledger: {
      schema: ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA,
      assignment_id: snapshot.current_binding.assignment_id,
      run_id: snapshot.current_binding.run_id,
      generation: snapshot.current_binding.generation,
      call_ids: [...snapshot.provider_call_ids],
      calls,
      in_flight_call_ids: [...snapshot.in_flight_provider_call_ids]
    }
  };
}

export function getAssignmentKernelPublicationV2(assignmentId: string): AssignmentKernelPublicationV2 | null {
  const snapshot = getAssignmentKernelSnapshotV2(assignmentId);
  return snapshot ? buildAssignmentKernelPublicationV2(snapshot) : null;
}

/**
 * Lists only lightweight V2 identities. Consumers must follow an entry with
 * the exact-ID publication read above; no Goal/V1 lifecycle data is projected.
 */
export function listAssignmentKernelSessionIndexV2(sessionId: string, limit = 50): AssignmentKernelSessionIndexV2 {
  const boundedSessionId = sessionId.trim().slice(0, 180);
  const assignments = listAssignmentKernelIndexV2(boundedSessionId, limit).map(entry => ({
    assignment_id: entry.assignment_id,
    assignment_version: entry.assignment_version,
    binding: structuredClone(entry.binding),
    outcome: entry.outcome,
    terminal: entry.terminal
  }));
  return { schema: ASSIGNMENT_KERNEL_SESSION_INDEX_V2_SCHEMA, session_id: boundedSessionId, assignments };
}
