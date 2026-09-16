const bindingKeys = ['assignment_id', 'session_id', 'run_id', 'generation'];
const sameBinding = (a, b) => bindingKeys.every(key => a?.[key] === b?.[key]);
const canonical = view => view?._sourceKind === 'assignment_kernel_v2'
  && Number.isSafeInteger(view._assignmentVersion) && view._assignmentVersion > 0;

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
