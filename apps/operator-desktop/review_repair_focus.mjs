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
    scope:'Selected review checks only; IDs refer to checks, not native elements. Unshown checks remain retrievable. No native absence, repair or whole-task completion is established.',
    next_action:groups.mismatch.length
      ?'Resolve a supported mismatch using the delivered image pair and existing locators. Check its requested properties/connections, then save the useful repair with the existing authorized save tool. Batch independent clear fixes. For a missing symbol or tag, establish its intended modeled target before adding it. Investigate only a named fact that changes the repair; do not restart neighboring-system or family discovery. If that fact remains unavailable, retain this exact gap and continue another actionable check, or return the checked partial with the gap.'
      :groups.uncertain.length
      ?'Resolve uncertainty with one discriminating current read or reference crop when available; otherwise return the checked partial and specific missing fact. Do not invent a design choice or rebuild matching work.'
      :result.code_review && result.code_review.status!=='matched'
      ?'Resolve the selected code review finding from its retained source and actual native outcomes. Matching visual checks do not settle code uncertainty or an unrelated effect; do not replay an uncertain write.'
      :'Reuse these unchanged checks. Finish uncovered native/save/file requirements and return the result; matched visible checks alone do not complete the task.'
  };
}
