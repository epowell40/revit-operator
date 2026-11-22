/** A navigation index over an already validated review, not another verdict,
 * work plan, admission rule or completion record. Never infer native absence. */
export function normalizeRepairGuidance(check) {
  if (check.repair === undefined) return null; // Historical reviews remain readable.
  const r=check.repair;
  if (check.status!=='mismatch' || !r || typeof r!=='object' || Array.isArray(r)
    || Object.keys(r).some(k=>!['readiness','blocking_fact'].includes(k))
    || !['clear_visual_fix','needs_information'].includes(r.readiness)
    || typeof r.blocking_fact!=='string' || r.blocking_fact.length>300
    || (r.readiness==='clear_visual_fix' ? r.blocking_fact.trim()!=='' : !r.blocking_fact.trim()))
    throw Error('visual_review_repair_guidance_invalid');
  return {readiness:r.readiness,blocking_fact:r.blocking_fact.trim()};
}

export function reviewRepairFocus(result) {
  if (result?.ok !== true || !['matched','mismatch','uncertain'].includes(result.state)
    || !Array.isArray(result.checks) || result.checks.length > 24) return null;
  const seen = new Set(), groups = {mismatch:[], uncertain:[], matched:[]};
  const ready=[], needsInformation=[], unclassified=[];
  for (const check of result.checks) {
    if (!check || typeof check.id !== 'string' || !check.id.trim() || check.id.length > 80
      || seen.has(check.id) || !Object.hasOwn(groups, check.status)) return null;
    seen.add(check.id); groups[check.status].push(check.id);
    let repair;try{repair=normalizeRepairGuidance(check);}catch{return null;}
    if(check.status==='mismatch') (repair?.readiness==='clear_visual_fix'?ready:repair?.readiness==='needs_information'?needsInformation:unclassified).push(check.id);
  }
  return {
    repair_check_ids:groups.mismatch, clarify_check_ids:groups.uncertain,
    ready_check_ids:ready, needs_information_check_ids:needsInformation, unclassified_check_ids:unclassified,
    reuse_unchanged_check_ids:groups.matched,
    ...(result.code_review?{selected_code_status:result.code_review.status}:{}),
    scope:'Review check IDs, not native elements. Readiness describes visual interpretation only, not native identity, feasibility or permission. Selected scope only; unshown checks remain retrievable. No repair or task completion certified.',
    next_action:ready.length||needsInformation.length
      ?'Start with ready_check_ids using the paired images; confirm native target and feasibility, then batch, read back and save the useful repair. For needs_information_check_ids resolve only the named fact with one focused check; if still ambiguous, retain the gap for user input and continue independent ready work. Unclassified findings need interpretation, not automatic edits. Do not repeat a survey or re-review unchanged findings.'
      :groups.mismatch.length
      ?'Batch clear repairs from paired images and existing locators; confirm absence/host, read back and save the useful repair. Resolve only a named fact blocking repair; otherwise return checked work with exact gaps.'
      :groups.uncertain.length
      ?'Resolve uncertainty with one discriminating current read or reference crop when available; otherwise return the checked partial and specific missing fact. Do not invent a design choice or rebuild matching work.'
      :result.code_review && result.code_review.status!=='matched'
      ?'Resolve the selected code review finding from its retained source and actual native outcomes. Matching visual checks do not settle code uncertainty or an unrelated effect; do not replay an uncertain write.'
      :'Reuse these unchanged checks. Finish uncovered native/save/file requirements and return the result; matched visible checks alone do not complete the task.'
  };
}
