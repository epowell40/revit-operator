import { validCategoryGraphicsScopeV1, type CategoryGraphicsScopeV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import type { ScopeNativeReadV1 } from './tag_scope_readback_v1.js';
import { categoryScopeNativeReadsV1 } from './category_scope_native_reads_v1.js';

const unique=(x:readonly unknown[])=>new Set(x).size===x.length;
const fail=(reason:string):never=>{throw Error('category_graphics_scope_'+reason);};

/** Derive candidates from an exhaustive native view census, then join every
 * category read by native view/category/template identity. Actor counts and
 * selected view IDs cannot narrow the result. Hash/binding/freshness admission
 * is provided by checkWorkPlanScopeV1, before this decoder sees the bytes. */
export function checkCategoryGraphicsScopeV1(scope:CategoryGraphicsScopeV1,reads:readonly ScopeNativeReadV1[]) {
  if(!validCategoryGraphicsScopeV1(scope)||!reads.length||reads.length>128||!unique(reads.map(r=>r.operation_id)))fail('request_invalid');
  const {inventory:p,candidates,observations}=categoryScopeNativeReadsV1(scope,reads);
  const matched:number[]=[],excluded:number[]=[],failed:number[]=[];
  const controlling=new Map<number,{hidden:boolean,halftone:boolean}>();
  const proof=candidates.map((v:any)=>{
    const observed=observations.get(v.id);if(!observed)fail('candidate_read_missing');
    const {category,controlling_view_id,operation_id}=observed!;
    const state={hidden:category.hidden,halftone:category.halftone},prior=controlling.get(controlling_view_id);
    if(prior&&(prior.hidden!==state.hidden||prior.halftone!==state.halftone))fail('controlling_state_conflict');
    controlling.set(controlling_view_id,state);
    if(category.hidden)excluded.push(v.id);else {matched.push(v.id);if(category.halftone!==scope.halftone)failed.push(v.id);}
    return {view_id:v.id,view_name:v.name,controlling_view_id,operation_id,...state};
  });
  if(!matched.length)fail('empty_visible_set');
  return {schema:'revit-operator.category-graphics-scope/v1' as const,scope_is_assistant_interpretation:true as const,
    inventory_count:p.views.length,candidate_count:candidates.length,matched_count:matched.length,excluded_count:excluded.length,
    satisfied_count:matched.length-failed.length,failed_target_ids:failed,matched_target_ids:matched,excluded_target_ids:excluded,
    declared_scope_satisfied:failed.length===0,view_proofs:proof,
    notice:'Stored controlling category properties checked across the declared native view domain. Hidden views are excluded, not certified unchanged. Effective linked/filtered graphics, source interpretation and visual appearance require separate evidence.'};
}
