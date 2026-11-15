/** Recover only the already submitted message. An exact host-frozen task
 * allowance may outlive the generic HTTP recovery grace; never reset its clock. */
export function delegatedAssignmentRecoveryDeadline(snapshot, binding, fallbackDeadline, now) {
  const current=snapshot?.current_binding;
  if (!current || current.assignment_id!==binding?.assignment_id || current.run_id!==binding?.assignment_run_id
      || Number(current.generation)!==Number(binding?.assignment_generation)
      || current.session_id!==binding?.session_id) throw Error('delegated_recovery_binding_mismatch');
  const policy=snapshot.spec?.execution_policy;
  const started=Date.parse(snapshot.spec?.created_at);
  const limit=policy?.max_wall_clock_ms;
  const product=policy?.mode==='single_actor_review_v1';
  const trusted=product?policy.selected_by==='trusted_runtime_host'
    &&typeof policy.principal_id==='string'&&policy.principal_id.length>0
    &&policy.principal_id===current.principal_id&&policy.principal_id===snapshot.spec.binding?.principal_id
    &&['assignment_id','session_id','run_id','generation','document_fingerprint'].every(k=>snapshot.spec.binding?.[k]===current[k])
    &&limit<=30*60_000
    :policy?.mode==='local_advisory_v1'&&policy.selected_by==='trusted_local_host';
  if (snapshot.outcome!=='active' || snapshot.terminal===true || snapshot.unresolved_unknown_operation_ids?.length
      || !trusted
      || policy.session_id!==current.session_id || policy.document_fingerprint!==current.document_fingerprint
      || !Number.isSafeInteger(limit) || limit<=0 || limit>120*60_000
      || !Number.isFinite(started) || started>now+30_000) return fallbackDeadline;
  return Math.max(fallbackDeadline,started+limit);
}

// The authenticated snapshot, not the outer legacy action list, owns effects.
export function delegatedAssignmentFailureMetadata(snapshot) {
  const unknown = snapshot.unresolved_unknown_operation_ids ?? [];
  const running = snapshot.quiescent !== true || (snapshot.in_flight_operation_ids?.length ?? 0) > 0
    || (snapshot.in_flight_provider_call_ids?.length ?? 0) > 0;
  const operations = Object.values(snapshot.operations ?? {});
  const applied = operations.some(operation => operation.persistent_effect === 'applied');
  const dispatched = operations.some(operation => operation.dispatch_state === 'dispatched');
  return {
    effect_state: unknown.length ? 'unknown' : applied ? 'applied' : dispatched ? 'none' : 'not_dispatched',
    outcome_unknown: unknown.length > 0,
    reconciliation_required: unknown.length > 0,
    backend_work_running: running,
    retryable: !running && !unknown.length && !applied,
    unresolved_unknown_operation_ids: [...unknown]
  };
}
