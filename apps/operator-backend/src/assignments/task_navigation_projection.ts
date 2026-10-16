import { createContentVerifiedProjection } from "../goals/content_verified_projection.js";
import { reduceAssignmentEventsV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import type { TaskNavigationState } from "./task_navigation.js";

export type NavigationProjection = { invalid: true } | { invalid: false; binding: AssignmentSnapshotV2["current_binding"];
  state: TaskNavigationState; title: string; updated_at: string };

function taskState(snapshot: AssignmentSnapshotV2): TaskNavigationState {
  if (snapshot.unresolved_unknown_operation_ids.length) return "unknown";
  if (snapshot.execution_control?.state === "paused") return snapshot.quiescent ? "paused" : "pausing";
  if (!snapshot.terminal && snapshot.provider_usage_hold && snapshot.quiescent
      && (["blocked", "failed"].includes(snapshot.outcome) || snapshot.progress_blocker
        || snapshot.provider_budget_exhausted || snapshot.execution_failure_ids.length)) return "failed";
  if (!snapshot.terminal && snapshot.provider_usage_hold) return snapshot.quiescent ? "waiting_for_usage" : "stopping_after_usage_limit";
  if (!snapshot.quiescent) return "working";
  if (["awaiting_user_input", "awaiting_user_review"].includes(snapshot.outcome)) return "needs_input";
  if (["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome)) return "complete";
  if (["failed", "blocked"].includes(snapshot.outcome)) return "failed";
  return "ready";
}

// Same canonical reduction and byte validation in synchronous callers and the
// async reader. Retain only small projections, never complete old journals.
const projection = createContentVerifiedProjection<NavigationProjection | null>(value => {
  const record = value as any, journal = record?.assignment_kernel_v2;
  if (!journal || journal.schema !== "revit-operator.assignment-kernel-journal/v2" || !Array.isArray(journal.events) || !journal.events.length) return null;
  try {
    const snapshot = reduceAssignmentEventsV2(journal.events);
    return { invalid: false, binding: snapshot.current_binding, state: taskState(snapshot),
      title: snapshot.spec.source_user_request.replace(/\s+/g," ").trim().slice(0,180) || "Task",
      updated_at: [snapshot.finished_at, snapshot.execution_control?.changed_at, snapshot.provider_usage_hold?.recorded_at, record.updated_at, snapshot.spec.created_at]
        .filter((value): value is string => typeof value === "string").sort().at(-1)! };
  } catch { return { invalid: true }; }
}, { maxEntries: 2048, maxProjectionBytes: 4 * 1024 * 1024 });

export const readNavigationProjection = projection.read;
