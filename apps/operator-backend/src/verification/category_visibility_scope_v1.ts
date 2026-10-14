import { validCategoryVisibilityScopeV1,type CategoryVisibilityScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';
import { categoryScopeNativeReadsV1 } from './category_scope_native_reads_v1.js';

/** Independent stored-state equivalence also applies when no model edit was needed. */
export function checkCategoryVisibilityScopeV1(scope:CategoryVisibilityScopeV1,reads:readonly ScopeNativeReadV1[]) {
 if(!validCategoryVisibilityScopeV1(scope))throw Error('category_visibility_scope_request_invalid');
 const {inventory,candidates,observations}=categoryScopeNativeReadsV1(scope,reads);
 const failed:number[]=[],controlling=new Map<number,boolean>();
 const proof=candidates.map((v:any)=>{
  const observed=observations.get(v.id);if(!observed)throw Error('category_visibility_scope_candidate_read_missing');
  const {category,controlling_view_id,operation_id}=observed!;
  if(controlling.has(controlling_view_id)&&controlling.get(controlling_view_id)!==category.hidden)
   throw Error('category_visibility_scope_controlling_state_conflict');
  controlling.set(controlling_view_id,category.hidden);
  if(category.hidden!==scope.hidden)failed.push(v.id);
  return {view_id:v.id,view_name:v.name,controlling_view_id,operation_id,hidden:category.hidden};
 });
 return {schema:'revit-operator.category-visibility-scope/v1' as const,scope_is_assistant_interpretation:true as const,
  inventory_count:inventory.views.length,candidate_count:candidates.length,matched_count:candidates.length,excluded_count:0,
  satisfied_count:candidates.length-failed.length,failed_target_ids:failed,matched_target_ids:candidates.map((v:any)=>v.id),excluded_target_ids:[] as number[],
  declared_scope_satisfied:failed.length===0,view_proofs:proof,
  ...(scope.sheet_ids?{native_sheet_ids:[...scope.sheet_ids]}:{}),
  notice:'Stored controlling category visibility checked for every model view in the declared native domain, including already-correct states. Sheet domains come from complete native placement inventories. Source interpretation, effective linked/filtered appearance and unrelated-state preservation require separate evidence.'};
}
