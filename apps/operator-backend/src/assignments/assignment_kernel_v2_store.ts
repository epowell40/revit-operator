import { createHash, randomUUID } from "node:crypto";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  AssignmentJournalV2,
  AssignmentKernelErrorV2,
  canonicalJsonV2,
  type AssignmentEventV2,
  type AssignmentSnapshotV2,
  type AssignmentSpecV2
} from "../domain/assignment-kernel/index.js";
import { getGoal, mutateGoalRecord, type GoalRecord, type GoalStatus } from "../goals/service.js";

export const ASSIGNMENT_KERNEL_JOURNAL_V2_SCHEMA = "revit-operator.assignment-kernel-journal/v2" as const;

export interface AssignmentKernelQuarantinedEventV2 {
  event: AssignmentEventV2;
  reason_code: string;
  reason: string;
  quarantined_at: string;
}

export interface AssignmentKernelJournalRecordV2 {
  schema: typeof ASSIGNMENT_KERNEL_JOURNAL_V2_SCHEMA;
  events: AssignmentEventV2[];
  quarantined_events: AssignmentKernelQuarantinedEventV2[];
}

export interface AssignmentKernelAppendResultV2 {
  goal: GoalRecord;
  snapshot: AssignmentSnapshotV2;
  accepted: boolean;
  quarantined_reason_code: string | null;
}

export type AssignmentKernelEventBodyV2<T> = T extends unknown
  ? Omit<T, "schema" | "event_id" | "assignment_id" | "assignment_version" | "binding" | "occurred_at" | "actor">
  : never;

function emptyJournal(): AssignmentKernelJournalRecordV2 {
  return { schema: ASSIGNMENT_KERNEL_JOURNAL_V2_SCHEMA, events: [], quarantined_events: [] };
}

export function normalizeAssignmentKernelJournalV2(value: unknown): AssignmentKernelJournalRecordV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyJournal();
  const source = value as Partial<AssignmentKernelJournalRecordV2>;
  if (source.schema !== ASSIGNMENT_KERNEL_JOURNAL_V2_SCHEMA) return emptyJournal();
  return {
    schema: ASSIGNMENT_KERNEL_JOURNAL_V2_SCHEMA,
    events: Array.isArray(source.events) ? structuredClone(source.events) : [],
    quarantined_events: Array.isArray(source.quarantined_events) ? structuredClone(source.quarantined_events) : []
  };
}

function terminalStatus(snapshot: AssignmentSnapshotV2): GoalStatus {
  if (snapshot.outcome === "complete" || snapshot.outcome === "verified_noop" || snapshot.outcome === "complete_with_issues") return "complete";
  if (snapshot.outcome === "blocked") return "blocked";
  return "failed";
}

function synchronizeGoalLifecycle(goal: GoalRecord, snapshot: AssignmentSnapshotV2): GoalRecord {
  if (snapshot.terminal) {
    const status = terminalStatus(snapshot);
    return {
      ...goal,
      status,
      current_phase: "settled",
      current_step: null,
      finished_at: snapshot.finished_at ?? null,
      progress_summary: snapshot.terminal_reason ?? `Assignment ${snapshot.outcome}.`,
      blocker: status === "blocked" ? snapshot.terminal_reason ?? "Blocked." : null,
      error: status === "failed" ? snapshot.terminal_reason ?? "Assignment failed." : null
    };
  }
  if (snapshot.outcome === "awaiting_user_input" || snapshot.outcome === "awaiting_user_review") {
    return {
      ...goal,
      status: "paused",
      current_phase: snapshot.outcome,
      current_step: snapshot.outcome === "awaiting_user_input" ? "Awaiting required user input." : "Awaiting bounded user review.",
      finished_at: null,
      blocker: null,
      error: null,
      progress_summary: snapshot.outcome === "awaiting_user_input"
        ? "The Assignment is resumable after authenticated input."
        : "Useful work is retained while bounded review is pending."
    };
  }
  return {
    ...goal,
    status: "active",
    current_phase: snapshot.quiescent ? "planning" : "executing",
    current_step: snapshot.quiescent ? "Evaluate the next unresolved criterion." : "Await canonical operation settlement.",
    finished_at: null,
    blocker: null,
    error: null,
    progress_summary: `${snapshot.in_flight_operation_ids.length} operation(s) in flight; ${Object.keys(snapshot.criteria).length}/${snapshot.spec.criteria.length} criteria evaluated.`
  };
}

function eventDigest(event: AssignmentEventV2): string {
  return createHash("sha256").update(canonicalJsonV2(event), "utf8").digest("hex");
}

export function getAssignmentKernelSnapshotV2(goalId: string): AssignmentSnapshotV2 | null {
  const goal = getGoal(goalId);
  if (!goal) return null;
  const record = normalizeAssignmentKernelJournalV2(goal.assignment_kernel_v2);
  return record.events.length > 0 ? new AssignmentJournalV2(record.events).snapshot() : null;
}

export function appendAssignmentKernelEventV2(goalId: string, event: AssignmentEventV2): AssignmentKernelAppendResultV2 {
  let accepted = false;
  let quarantinedReasonCode: string | null = null;
  let acceptedSnapshot: AssignmentSnapshotV2 | null = null;
  const goal = mutateGoalRecord(goalId, current => {
    const record = normalizeAssignmentKernelJournalV2(current.assignment_kernel_v2);
    const existing = [...record.events, ...record.quarantined_events.map(item => item.event)].find(candidate => candidate.event_id === event.event_id);
    if (existing) {
      accepted = record.events.some(candidate => candidate.event_id === event.event_id) && eventDigest(existing) === eventDigest(event);
      const conflictReasonCode = "assignment_event_id_conflict";
      quarantinedReasonCode = accepted ? null : conflictReasonCode;
      acceptedSnapshot = record.events.length > 0 ? new AssignmentJournalV2(record.events).snapshot() : null;
      if (accepted) return current;
      record.quarantined_events.push({
        event: structuredClone(event),
        reason_code: conflictReasonCode,
        reason: "Event identity was reused with different content.",
        quarantined_at: new Date().toISOString()
      });
      return { ...current, assignment_kernel_v2: record };
    }
    try {
      const journal = new AssignmentJournalV2(record.events);
      acceptedSnapshot = journal.append(event);
      record.events.push(structuredClone(event));
      accepted = true;
      return synchronizeGoalLifecycle({ ...current, assignment_kernel_v2: record }, acceptedSnapshot);
    } catch (error) {
      const reasonCode = error instanceof AssignmentKernelErrorV2 ? error.code : "assignment_kernel_event_invalid";
      quarantinedReasonCode = reasonCode;
      record.quarantined_events.push({
        event: structuredClone(event),
        reason_code: reasonCode,
        reason: error instanceof Error ? error.message : String(error),
        quarantined_at: new Date().toISOString()
      });
      acceptedSnapshot = record.events.length > 0 ? new AssignmentJournalV2(record.events).snapshot() : null;
      return { ...current, assignment_kernel_v2: record };
    }
  });
  if (!acceptedSnapshot) throw new Error("assignment_kernel_v2_not_created");
  return { goal, snapshot: acceptedSnapshot, accepted, quarantined_reason_code: quarantinedReasonCode };
}

export function createAssignmentKernelV2(goalId: string, spec: AssignmentSpecV2, actor = "operator-backend"): AssignmentKernelAppendResultV2 {
  if (spec.binding.assignment_id !== goalId) throw new Error("assignment_kernel_spec_goal_mismatch");
  const existing = getAssignmentKernelSnapshotV2(goalId);
  if (existing) return { goal: getGoal(goalId)!, snapshot: existing, accepted: true, quarantined_reason_code: null };
  return appendAssignmentKernelEventV2(goalId, {
    schema: ASSIGNMENT_EVENT_V2_SCHEMA,
    event_id: `assignment-created:${randomUUID()}`,
    assignment_id: goalId,
    assignment_version: 1,
    binding: structuredClone(spec.binding),
    occurred_at: spec.created_at,
    actor,
    event_type: "assignment_created",
    spec: structuredClone(spec)
  });
}

export function appendCurrentAssignmentKernelEventV2(input: Readonly<{
  goal_id: string;
  binding: AssignmentEventV2["binding"];
  event_id: string;
  actor: string;
  occurred_at?: string;
  body: AssignmentKernelEventBodyV2<AssignmentEventV2>;
}>): AssignmentKernelAppendResultV2 {
  let accepted = false;
  let quarantinedReasonCode: string | null = null;
  let acceptedSnapshot: AssignmentSnapshotV2 | null = null;
  const goal = mutateGoalRecord(input.goal_id, current => {
    const record = normalizeAssignmentKernelJournalV2(current.assignment_kernel_v2);
    const journal = new AssignmentJournalV2(record.events);
    const snapshot = record.events.length > 0 ? journal.snapshot() : null;
    if (!snapshot) throw new Error("assignment_kernel_v2_not_created");
    const existing = [...record.events, ...record.quarantined_events.map(item => item.event)]
      .find(event => event.event_id === input.event_id);
    const candidate = {
      schema: ASSIGNMENT_EVENT_V2_SCHEMA,
      event_id: input.event_id,
      assignment_id: input.goal_id,
      assignment_version: existing?.assignment_version ?? snapshot.assignment_version + 1,
      binding: structuredClone(input.binding),
      occurred_at: existing?.occurred_at ?? input.occurred_at ?? new Date().toISOString(),
      actor: input.actor,
      ...input.body
    } as AssignmentEventV2;
    if (existing) {
      accepted = record.events.some(event => event.event_id === input.event_id) && eventDigest(existing) === eventDigest(candidate);
      quarantinedReasonCode = accepted ? null : "assignment_event_id_conflict";
      acceptedSnapshot = snapshot;
      if (accepted) return current;
      const reasonCode = "assignment_event_id_conflict";
      record.quarantined_events.push({
        event: structuredClone(candidate), reason_code: reasonCode,
        reason: "Event identity was reused with different content.", quarantined_at: new Date().toISOString()
      });
      return { ...current, assignment_kernel_v2: record };
    }
    try {
      acceptedSnapshot = journal.append(candidate);
      record.events.push(structuredClone(candidate));
      accepted = true;
      return synchronizeGoalLifecycle({ ...current, assignment_kernel_v2: record }, acceptedSnapshot);
    } catch (error) {
      const reasonCode = error instanceof AssignmentKernelErrorV2 ? error.code : "assignment_kernel_event_invalid";
      quarantinedReasonCode = reasonCode;
      record.quarantined_events.push({
        event: structuredClone(candidate), reason_code: reasonCode,
        reason: error instanceof Error ? error.message : String(error), quarantined_at: new Date().toISOString()
      });
      acceptedSnapshot = snapshot;
      return { ...current, assignment_kernel_v2: record };
    }
  });
  if (!acceptedSnapshot) throw new Error("assignment_kernel_v2_not_created");
  if (!accepted) throw new Error(quarantinedReasonCode ?? "assignment_kernel_v2_event_rejected");
  return { goal, snapshot: acceptedSnapshot, accepted, quarantined_reason_code: quarantinedReasonCode };
}
