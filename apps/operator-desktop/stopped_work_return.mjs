/** Presentation only, after the existing bound Work Return fetch. An outer
 * exception must not hide retained questions or turn them into user answers. */
function boundCanonicalReturn(settlement, assignment) {
  const value = settlement?.work_return;
  if (settlement?.kernel_version !== 2 || assignment?.kernel_version !== 2
      || !assignment.goal_id || !assignment.run_id || !Number.isSafeInteger(assignment.generation) || assignment.generation < 1
      || value?.assignment_id !== assignment.goal_id || value.run_id !== assignment.run_id
      || value.generation !== assignment.generation || !['complete','verified_noop','complete_with_issues','blocked','failed'].includes(value.status)
      || !Array.isArray(value.deviations_or_open_items)) return null;
  return value;
}

/** Optional canonical projection returned by the same authenticated Work Return
 * read. It is not late provider text, completion authority or a new effect. */
export function canonicalWorkReturnResultMessage(settlement, assignment) {
  const value=boundCanonicalReturn(settlement,assignment),p=settlement?.terminal_result_presentation,r=p?.terminal_result_v2,b=p?.binding;
  if(!value||!assignment.session_id||!value.work_return_id||!value.work_return_hash
    ||p?.work_return_id!==value.work_return_id||p?.work_return_hash!==value.work_return_hash
    ||b?.assignment_id!==assignment.goal_id||b?.run_id!==assignment.run_id||b?.generation!==assignment.generation||b?.session_id!==assignment.session_id
    ||r?.schema!=='revit-operator.terminal-result/v2'||r.assignment_id!==assignment.goal_id||r.outcome!==value.status
    ||!Number.isSafeInteger(r.terminal_snapshot_version)||r.terminal_snapshot_version<1
    ||typeof r.result_summary!=='string'||!r.result_summary.trim()||new TextEncoder().encode(r.result_summary).length>24000
    ||!Array.isArray(r.supporting_observation_ids)||!r.supporting_observation_ids.every(x=>typeof x==='string')
    ||!Array.isArray(r.evidence_refs)||!r.evidence_refs.every(x=>typeof x==='string')||!Array.isArray(r.warnings))return null;
  return r.result_summary;
}

export function stoppedWorkReturnResultMessage(settlement, assignment) {
  return ['blocked','failed'].includes(settlement?.work_return?.status)?canonicalWorkReturnResultMessage(settlement,assignment):null;
}

export function stoppedWorkReturnMessage(settlement, assignment) {
  const value=boundCanonicalReturn(settlement,assignment);if(!value||!['blocked','failed'].includes(value.status))return null;
  const nativeSummary=stoppedWorkReturnResultMessage(settlement,assignment);
  const items = value.deviations_or_open_items.filter(item => typeof item === 'string' && item.trim());
  if (!items.length) return nativeSummary;
  const shown = []; let bytes = 0;
  for (const item of items.slice(0, 12)) {
    const length = new TextEncoder().encode(item).length;
    if (bytes + length > 24000) break;
    shown.push(item); bytes += length;
  }
  if (!shown.length) return nativeSummary;
  const followups='The task stopped before completion. Saved follow-ups and unfinished work are retained below. These are not verified results or supplied answers. '
    + 'Internal tool follow-ups remain Operator work; only actual engineering decisions need your answer.\n\n'
    + '## Details\n\n### Saved follow-ups and open work\n\n'
    + shown.map(item => '- ' + item.replace(/\r?\n/g, '\n  ')).join('\n')
    + (shown.length < items.length ? `\n\n${items.length - shown.length} more open items remain in Tasks.` : '');
  return [nativeSummary,followups].filter(Boolean).join('\n\n');
}
