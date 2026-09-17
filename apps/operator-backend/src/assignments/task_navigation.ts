import { getGoalStoragePath, listGoalCandidatesForSessions } from "../goals/service.js";
import { createContentVerifiedProjection } from "../goals/content_verified_projection.js";
import { getSessionOwner, listConversationNavigation } from "../memory/sqlite_store.js";
import { getRequestAssignmentPrincipalId, getRequestContext, isSessionIdBoundToPrincipal, requestMatchesAssignmentPrincipalId } from "../request_context.js";
import { reduceAssignmentEventsV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

export type TaskNavigationState = "working" | "pausing" | "paused" | "needs_input" | "ready" | "complete" | "failed" | "unknown" | "loading";
export type TaskNavigationEntry = {
  task_id: string; session_id: string; assignment_id: string | null; title: string;
  state: TaskNavigationState; updated_at: string; summary: string;
};

function taskState(snapshot: AssignmentSnapshotV2): TaskNavigationState {
  if (snapshot.unresolved_unknown_operation_ids.length) return "unknown";
  if (snapshot.execution_control?.state === "paused") return snapshot.quiescent ? "paused" : "pausing";
  if (!snapshot.quiescent) return "working";
  if (["awaiting_user_input", "awaiting_user_review"].includes(snapshot.outcome)) return "needs_input";
  if (["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome)) return "complete";
  if (["failed", "blocked"].includes(snapshot.outcome)) return "failed";
  return "ready";
}

const rank = (state: TaskNavigationState) => state === "working" || state === "pausing" ? 0
  : ["paused", "needs_input", "ready", "unknown"].includes(state) ? 1 : 2;

type NavigationProjection = { invalid: true } | { invalid: false; binding: AssignmentSnapshotV2["current_binding"];
  state: TaskNavigationState; title: string; updated_at: string };
// Keep only the small, validated navigation projection. Re-reading and hashing
// canonical bytes still detects same-size and timestamp-preserving rewrites.
const navigationProjection = createContentVerifiedProjection<NavigationProjection | null>(value => {
  const record = value as any, journal = record?.assignment_kernel_v2;
  if (!journal || journal.schema !== "revit-operator.assignment-kernel-journal/v2" || !Array.isArray(journal.events) || !journal.events.length) return null;
  try {
    const snapshot = reduceAssignmentEventsV2(journal.events);
    return { invalid: false, binding: snapshot.current_binding, state: taskState(snapshot),
      title: snapshot.spec.source_user_request.replace(/\s+/g," ").trim().slice(0,180) || "Task",
      updated_at: snapshot.finished_at || snapshot.execution_control?.changed_at || record.updated_at || snapshot.spec.created_at };
  } catch { return { invalid: true }; }
}, { maxEntries: 2048, maxProjectionBytes: 4 * 1024 * 1024 });

export function ownedNavigationSession(sessionId: string): boolean {
  const context = getRequestContext();
  if (!getRequestAssignmentPrincipalId(context)) return false;
  if (!context?.principal) return context?.operator_backend_auth?.mode === "shared_token";
  const principal = context.principal;
  if (!isSessionIdBoundToPrincipal(sessionId, principal)) return false;
  const owner = getSessionOwner(sessionId);
  return !owner || owner.owner_user_id === principal.user_id
    && owner.owner_license_id === (principal.tenant_id || principal.license_id);
}

/** The list navigates conversations; all controls must reread the exact binding.
 * A cached Goal or index can discover a journal but cannot declare its status. */
type NavigationPage = { schema: "revit-operator.task-navigation/v1"; tasks: TaskNavigationEntry[]; loading: boolean };
function* navigationSteps(limit = 100): Generator<NavigationPage | undefined, NavigationPage> {
  if (!getRequestAssignmentPrincipalId()) throw new Error("Task navigation requires an authenticated principal.");
  const allowed = new Map<string, boolean>();
  const owns = (id: string) => {
    if (!allowed.has(id)) allowed.set(id, ownedNavigationSession(id));
    return allowed.get(id)!;
  };
  const conversations = listConversationNavigation(owns, 200);
  const titles = new Map(conversations.map(row => [row.session_id, row.title]));
  const entries = new Map<string, TaskNavigationEntry>();
  const page = (loading: boolean): NavigationPage => {
    const rows = [...entries.values(), ...conversations.filter(row => !entries.has(row.session_id)).map(conversation => ({
      task_id: `session:${conversation.session_id}`, ...conversation, assignment_id: null,
      state: loading ? "loading" as const : "complete" as const, summary: loading ? "Loading saved status." : "Open the conversation."
    }))];
    return { schema: "revit-operator.task-navigation/v1", loading,
      tasks: rows.sort((a,b) => rank(a.state) - rank(b.state) || Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, Math.max(1, Math.min(200, Math.trunc(limit) || 100))) };
  };
  yield page(true);
  let processed = 0;
  for (const goal of listGoalCandidatesForSessions(owns)) {
    yield ++processed % 10 === 0 ? page(true) : undefined;
    const filePath = getGoalStoragePath(goal.id);
    const projection = filePath ? navigationProjection.read(filePath) : null;
    if (!projection) continue;
    if (!projection.invalid && (!owns(projection.binding.session_id)
      || !requestMatchesAssignmentPrincipalId(projection.binding.principal_id, undefined, projection.binding.session_id))) continue;
    const sessionId = projection.invalid ? goal.related_session_id! : projection.binding.session_id;
    const state = projection.invalid ? "unknown" : projection.state;
    const entry: TaskNavigationEntry = {
      task_id: `session:${sessionId}`, session_id: sessionId, assignment_id: projection.invalid ? goal.id : projection.binding.assignment_id,
      title: titles.get(sessionId) || (projection.invalid ? "Saved task needs checking" : projection.title),
      state, updated_at: projection.invalid ? goal.updated_at : projection.updated_at,
      summary: state === "working" ? "Work is in progress." : state === "pausing" ? "Finishing the current operation."
        : state === "paused" ? "Work is saved. Resume when ready." : state === "needs_input" ? "Your input or review is needed."
        : state === "unknown" ? "A result needs checking before continuing." : state === "ready" ? "Saved work is ready to continue."
        : state === "failed" ? "Open the conversation to review what remains." : "Open the conversation to see the result."
    };
    const previous = entries.get(sessionId);
    if (!previous || rank(state) < rank(previous.state)
      || rank(state) === rank(previous.state) && Date.parse(entry.updated_at) > Date.parse(previous.updated_at)) entries.set(sessionId, entry);
  }
  return page(false);
}

export function listTaskNavigation(limit = 100) {
  const steps = navigationSteps(limit); let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
export async function listTaskNavigationAsync(limit = 100, onProgress?: (page: NavigationPage) => boolean) {
  const steps = navigationSteps(limit); let next = steps.next();
  while (!next.done) {
    if (next.value && onProgress?.(next.value) === false) return next.value;
    await new Promise<void>(resolve => setImmediate(resolve)); next = steps.next();
  }
  return next.value;
}
