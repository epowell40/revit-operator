// Inputs must come from fresh authorized native context reads, never actor prose.
// This explains observed changes; it does not establish causality or correctness.
const id = n => Number.isSafeInteger(n) && n > 0;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 200;
function valid(s) {
  if (!s || s.schema !== 'operator.native_document_changes.v1' || s.authority !== 'observed_changes_only'
    || !id(s.processId) || !text(s.epoch) || !text(s.documentSessionId)
    || !Number.isSafeInteger(s.throughSequence) || s.throughSequence < 0
    || !id(s.retainedFromSequence) || s.retainedFromSequence > s.throughSequence + 1
    || s.maxEvents !== 16 || s.maxIdsPerEvent !== 64 || !Array.isArray(s.events) || s.events.length > 16) return false;
  let previous = s.retainedFromSequence - 1;
  return s.events.every(e => {
    if (!e || !id(e.sequence) || e.sequence <= previous || e.sequence > s.throughSequence
      || e.documentSessionId !== s.documentSessionId && e.documentSessionId !== null
      || typeof e.complete !== 'boolean' || !Number.isFinite(Date.parse(e.observedAtUtc))
      || typeof e.operation !== 'string' || e.operation.length > 80
      || !Array.isArray(e.transactionNames) || e.transactionNames.length > 4
      || e.transactionNames.some(n => typeof n !== 'string' || n.length > 120)
      || typeof e.transactionNamesTruncated !== 'boolean'
      || !['addedIds','modifiedIds','deletedIds'].every(k => Array.isArray(e[k]) && e[k].every(id) && new Set(e[k]).size === e[k].length)
      || e.addedIds.length + e.modifiedIds.length + e.deletedIds.length > 64
      || e.complete && (e.documentSessionId === null || e.unavailableReason !== null)
      || !e.complete && !text(e.unavailableReason)) return false;
    previous = e.sequence; return true;
  });
}

export function nativeChangeObservationCursor(binding, observation) {
  if (!binding || !text(binding.assignment_id ?? binding.goal_id) || !text(binding.session_id) || !text(binding.run_id)
    || !id(binding.generation) || !valid(observation)) return null;
  return { binding: { assignment_id: binding.assignment_id ?? binding.goal_id, session_id: binding.session_id,
    run_id: binding.run_id, generation: binding.generation, principal_id: binding.principal_id ?? null,
    document_fingerprint: binding.document_fingerprint ?? null }, observation: structuredClone(observation) };
}
export function nativeChangeObservationFromContext(context) {
  const s = context?.nativeChangeObservations;
  return valid(s) && s.processId === context.process_id && s.documentSessionId === context.document?.sessionId ? s : null;
}
export function sameNativeChangeCursorBinding(cursor, binding) {
  return Boolean(cursor && binding && cursor.binding.assignment_id === (binding.assignment_id ?? binding.goal_id)
    && cursor.binding.session_id === binding.session_id && cursor.binding.run_id === binding.run_id && cursor.binding.generation === binding.generation
    && cursor.binding.principal_id === (binding.principal_id ?? null) && cursor.binding.document_fingerprint === (binding.document_fingerprint ?? null));
}

export function compareNativeChangeObservations(before, after) {
  const result = (state, extra = {}) => ({ schema: 'operator.native_change_feedback.v1', state,
    authority: 'observed_changes_only', postcondition_verified: false, actor_attribution: 'not_established',
    needs_fresh_target_readback: true,
    guidance: 'Inspect changed targets with fresh native attributes and relevant visuals. Compare with the intended result, correct a confirmed mismatch within scope, then recheck. Do not repeat an uncertain write or treat this change list as completion proof.', ...extra });
  if (!valid(after)) return result('observation_unavailable');
  if (!valid(before)) return result('baseline_unavailable', { through_sequence: after.throughSequence });
  if (before.processId !== after.processId || before.epoch !== after.epoch || before.documentSessionId !== after.documentSessionId)
    return result('identity_changed', { reason: 'process_or_document_session_changed_including_save_as' });
  if (after.throughSequence < before.throughSequence) return result('observation_unavailable', { reason: 'sequence_regressed' });
  if (after.retainedFromSequence > before.throughSequence + 1) return result('interval_incomplete', { reason: 'retention_window_exceeded' });
  const events = after.events.filter(e => e.sequence > before.throughSequence);
  const failed = events.some(e => !e.complete);
  const sets = Object.fromEntries(['addedIds','modifiedIds','deletedIds'].map(k => [k, [...new Set(events.flatMap(e => e[k]))].sort((a,b) => a-b)]));
  const all = [...new Set(Object.values(sets).flat())].sort((a,b) => a-b);
  const clipped = all.length > 256;
  return result(failed || clipped ? 'interval_incomplete' : all.length ? 'changes_observed' : 'no_native_changes_observed', {
    from_sequence_exclusive: before.throughSequence, through_sequence: after.throughSequence,
    event_count: events.length, change_ids_complete: !failed && !clipped,
    changed_element_ids: all.slice(0,256), ...(clipped ? { omitted_changed_element_count: all.length - 256 } : {}),
    transaction_names: [...new Set(events.flatMap(e => e.transactionNames))].slice(0,8),
    ...(failed ? { reason: 'native_capture_failed_or_change_ids_truncated' } : {}),
    observation_limits: 'No-change observations do not prove a UI command succeeded. Concurrent human/add-in edits are not attributed to this actor. SaveAs changes session identity and must be reconciled explicitly.'
  });
}

// The interval comes from the host dispatcher, never parsed tool arguments or
// caller output. Keep feedback visible when the raw artifact needs projection.
export function nativeChangeFeedbackModelOutput(modelOutput, interval, evidenceId) {
  if (!interval || typeof modelOutput?.output !== 'string' || !text(evidenceId)) throw new Error('native_change_feedback_projection_input_invalid');
  const envelope = JSON.parse(modelOutput.output);
  if (envelope.schema !== 'revit-operator.model-evidence-envelope.v1' || !Array.isArray(envelope.evidence_projections)
    || !envelope.evidence_projections.some(p => p.evidence_id === evidenceId)) throw new Error('native_change_feedback_artifact_binding_missing');
  const feedback = compareNativeChangeObservations(interval.before, nativeChangeObservationFromContext(interval.context));
  const output = JSON.stringify({...envelope, native_change_feedback: {...feedback, source_evidence_id: evidenceId}});
  if (new TextEncoder().encode(output).byteLength > 32768) throw new Error('native_change_feedback_model_budget_exceeded');
  return {...modelOutput, output};
}
