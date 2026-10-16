const bindingKeys = ['assignment_id', 'session_id', 'run_id', 'generation'];
const sameBinding = (a, b) => bindingKeys.every(key => a?.[key] === b?.[key]);
const canonical = view => view?._sourceKind === 'assignment_kernel_v2'
  && Number.isSafeInteger(view._assignmentVersion) && view._assignmentVersion > 0;

/** Navigation only: open this exact saved task, then load its authoritative
 * publication and use ordinary controls. Selecting history never resumes it. */
export function savedAssignmentNavigationTargetV2(view, currentSessionId) {
  const binding = view?._bindingV2;
  if (!canonical(view) || !binding || !currentSessionId || binding.session_id !== currentSessionId
      || !bindingKeys.slice(0, 3).every(key => typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 240)
      || !Number.isSafeInteger(binding.generation) || binding.generation < 0
      || view._sourceRecordId !== binding.assignment_id || view.id !== `goal:${binding.assignment_id}`) return null;
  return { session_id: binding.session_id, assignment_id: binding.assignment_id };
}

/** Keep the opened task addressable even beyond the history page, without
 * hiding other saved tasks in its conversation. All views come from the
 * host's owner-checked canonical publication endpoints; this never executes. */
export async function readSavedAssignmentHistoryV2(readJson, sessionId, assignmentId) {
  if (![sessionId, assignmentId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 240))
    throw new Error('A saved task and conversation are required.');
  const session = encodeURIComponent(sessionId);
  const [exact, history] = await Promise.all([
    readJson(`/api/assignment-workspace/v2/task?session_id=${session}&assignment_id=${encodeURIComponent(assignmentId)}`),
    readJson(`/api/assignment-workspace/v2?session_id=${session}&limit=30`)
  ]);
  const target = exact?.assignment;
  if (savedAssignmentNavigationTargetV2(target, sessionId)?.assignment_id !== assignmentId
      || history?.session_id !== sessionId || !Array.isArray(history.assignments) || history.assignments.length > 30)
    throw new Error('The saved task history does not match this conversation.');
  const views = new Map([[target.id, target]]);
  for (const view of history.assignments) {
    if (!savedAssignmentNavigationTargetV2(view, sessionId)) throw new Error('Invalid saved task history.');
    const prior = views.get(view.id);
    if (prior && !sameBinding(prior._bindingV2, view._bindingV2)) throw new Error('Saved task generation changed.');
    if (!prior || view._assignmentVersion > prior._assignmentVersion) views.set(view.id, view);
  }
  return { assignments: [...views.values()] };
}

/** A save's exact acknowledgment owns continuation. Background polling does not. */
export async function acknowledgeAssignmentMutationV2(readJson, projectPublication, backendPath, body) {
  const result = await readJson(backendPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (result?.ok !== true || !result.assignment_snapshot_v2) throw new Error('Canonical task mutation did not return an acknowledgment.');
  const acknowledged = result.assignment_snapshot_v2;
  if (!sameBinding(acknowledged.current_binding, body) || !Number.isSafeInteger(acknowledged.assignment_version)
      || acknowledged.assignment_version < 1) throw new Error('Canonical task acknowledgment binding mismatch.');
  try {
    const response = await readJson(`/api/assignments/v2/${encodeURIComponent(body.assignment_id)}`, { method: 'GET' });
    // The caller's projector must validate the complete shared publication contract.
    const assignment = projectPublication(response.assignment_kernel_v2);
    if (!canonical(assignment) || !sameBinding(assignment._bindingV2, body)
        || assignment._assignmentVersion < acknowledged.assignment_version) throw new Error('Refreshed task does not match the acknowledged version.');
    return { ok: true, idempotent: result.idempotent === true, assignment };
  } catch {
    // The mutation already committed. Never claim save failed or invite a duplicate.
    return { ok: true, idempotent: result.idempotent === true,
      refresh_error: 'Saved, but the current task could not be refreshed. Reconnect before continuing.' };
  }
}

/** Keep the control's original authoritative fences and attach an exact refreshed
 * view. A cancelled/superseded background poll cannot own Resume continuation. */
export async function acknowledgeAssignmentControlV2(readJson, projectPublication, backendPath, body) {
  let acknowledged;
  const refreshed = await acknowledgeAssignmentMutationV2(async (path, options) => {
    const response = await readJson(path, options);
    if (options.method === 'POST') acknowledged = response;
    return response;
  }, projectPublication, backendPath, body);
  return { ...acknowledged, ...refreshed };
}

/** Preserve a newer verified display version when a status response arrives late. */
export function retainNewerAssignmentViewsV2(incoming, retained) {
  const previous = new Map(retained.filter(canonical).map(view => [view.id, view]));
  return incoming.map(view => {
    const prior = previous.get(view.id);
    return canonical(view) && prior && prior._bindingV2?.assignment_id === view._bindingV2?.assignment_id
      && prior._bindingV2?.session_id === view._bindingV2?.session_id
      && prior._assignmentVersion > view._assignmentVersion ? prior : view;
  });
}

/** Caller must separately fence selected task, history navigation and streaming. */
export function acceptAssignmentMutationViewV2(state, result, binding) {
  const view = result?.assignment;
  if (result?.ok !== true || !canonical(view) || !sameBinding(view._bindingV2, binding)
      || state.sessionId !== binding.session_id) return null;
  const previous = state.goals.find(item => item.id === view.id);
  if (!previous || !sameBinding(previous._bindingV2, binding)
      || (canonical(previous) && previous._assignmentVersion > view._assignmentVersion)) return null;
  // Polls started before this acknowledgment cannot overwrite or remove its view.
  state.goalsSyncRequestId = (state.goalsSyncRequestId || 0) + 1;
  state.goals = state.goals.map(item => item.id === view.id ? view : item);
  return view;
}
