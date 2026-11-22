/** A navigation index over an already validated review, not another verdict,
 * work plan, admission rule or completion record. Never infer native absence. */
export function reviewRepairFocus(result) {
  if (result?.ok !== true || !['matched','mismatch','uncertain'].includes(result.state)
    || !Array.isArray(result.checks) || result.checks.length > 24) return null;
  const seen = new Set(), groups = {mismatch:[], uncertain:[], matched:[]};
  for (const check of result.checks) {
    if (!check || typeof check.id !== 'string' || !check.id.trim() || check.id.length > 80
      || seen.has(check.id) || !Object.hasOwn(groups, check.status)) return null;
    seen.add(check.id); groups[check.status].push(check.id);
  }
  return {
    repair_check_ids:groups.mismatch, clarify_check_ids:groups.uncertain,
    reuse_unchanged_check_ids:groups.matched,
    ...(result.code_review?{selected_code_status:result.code_review.status}:{}),
    scope:'Review check IDs, not native elements. Selected scope only; unshown checks remain retrievable. No repair or task completion certified.',
    next_action:groups.mismatch.length
      ?'Batch clear repairs from paired images and existing locators; confirm absence/host, read back and save the useful repair. Resolve only a named fact blocking repair; otherwise return checked work with exact gaps.'
      :groups.uncertain.length
      ?'Resolve uncertainty with one discriminating current read or reference crop when available; otherwise return the checked partial and specific missing fact. Do not invent a design choice or rebuild matching work.'
      :result.code_review && result.code_review.status!=='matched'
      ?'Resolve the selected code review finding from its retained source and actual native outcomes. Matching visual checks do not settle code uncertainty or an unrelated effect; do not replay an uncertain write.'
      :'Reuse these unchanged checks. Finish uncovered native/save/file requirements and return the result; matched visible checks alone do not complete the task.'
  };
}
