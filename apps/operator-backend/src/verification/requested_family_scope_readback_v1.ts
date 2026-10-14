import { randomUUID } from 'node:crypto';
import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { AssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import type { WorkPlanScopeRequestV1 } from '../domain/assignment-kernel/work_plan_scope.js';
import { validFamilyStaticTextScopeV1 } from '../domain/assignment-kernel/work_plan_family_scope.js';
import { checkWorkPlanScopeV1 } from '../assignments/work_plan_scope_check.js';
import { readCurrentNativeScopeEvidenceV1 } from '../assignments/work_plan_scope_native_evidence.js';
import { familyStaticTextScopeInventoryV1 } from './family_static_text_scope_v1.js';
import { canonicalJsonV2 } from '../domain/assignment-kernel/index.js';

export type ScopeReadPlanV1={method:'POST';path:'/revit/find-elements'|'/revit/inspect-family-content';body:Record<string,unknown>};
type Dependencies={current:()=>AssignmentSnapshotV2|null;read:(plan:ScopeReadPlanV1,id:string)=>Promise<unknown>;refresh:(ids:readonly string[])=>Promise<unknown>};
const jsonBody=(input:any)=>typeof input?.body==='string'?JSON.parse(input.body):input?.body;
const edits=(s:AssignmentSnapshotV2)=>JSON.stringify(Object.values(s.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect!=='none')
 .map(o=>[o.operation_id,o.settlement_state,o.result?.completed_at??o.opened_at]).sort());
const needsReads=(reason:string)=>['scope_check_no_current_native_reads','scope_check_current_native_reads_required',
 'family_static_text_scope_one_inventory_required','family_static_text_scope_inventory_incomplete',
 'family_static_text_scope_candidate_read_missing','family_static_text_scope_family_read_incomplete'].includes(reason);

/** One bounded host-owned collection pass. All native calls use the ordinary
 * dispatcher; this helper neither writes models nor manufactures observations.
 * It only runs for requested host reference selection, never overrides explicit
 * actor references or an available (even unsatisfied) native check. */
export async function collectRequestedFamilyScopeReadbacksV1(binding:AssignmentBindingV2,request:WorkPlanScopeRequestV1,deps:Dependencies) {
 const initial=deps.current();
 if(!initial||!validFamilyStaticTextScopeV1(request.scope)||request.read_selection!=='current_native_reads_v1')return null;
 const editStamp=edits(initial),scope=request.scope,referenceIds:string[]=[];
 const guard=()=>{
  const s=deps.current();
  if(!s||!sameAssignmentBindingV2(s.current_binding,binding)||s.terminal||s.outcome!=='active'||s.completion_proposal
    ||s.execution_control?.state==='paused'||s.unresolved_unknown_operation_ids.length||s.in_flight_operation_ids.length
    ||edits(s)!==editStamp)throw Error('host_scope_readback_binding_or_state_changed');
  const latest=[...(s.work_plan_scope_requests??[])].reverse().find(r=>r.item_id===request.item_id);
  if(!latest||latest.requested_at!==request.requested_at||JSON.stringify(latest.scope)!==JSON.stringify(scope))throw Error('host_scope_readback_request_changed');
  return s;
 };
 const current=guard(),checked=checkWorkPlanScopeV1(current,request);
 if(checked.available||!needsReads(checked.reason))return null;
 const collect=async(plan:ScopeReadPlanV1)=>{
  const before=guard(),prior=new Set(Object.keys(before.operations));
  const response=await deps.read(plan,'host-scope-readback:'+randomUUID());
  const after=guard();
  if(!response||typeof response!=='object'||(response as any).success!==true)throw Error('host_scope_readback_native_call_unavailable');
  const candidates=Object.values(after.operations).filter(o=>!prior.has(o.operation_id)&&o.input?.method===plan.method&&o.input.path===plan.path
    &&canonicalJsonV2(jsonBody(o.input))===canonicalJsonV2(plan.body));
  if(candidates.length!==1)throw Error('host_scope_readback_native_reference_ambiguous');
  const id=candidates[0]!.operation_id;
  const {reads}=readCurrentNativeScopeEvidenceV1(after,{...request,operation_ids:[id],requested_at:new Date().toISOString()});
  referenceIds.push(id);return reads[0]!;
 };
 const inventory=await collect({method:'POST',path:'/revit/find-elements',body:{category:scope.category,limit:5000,includeGeometry:false}});
 const native=familyStaticTextScopeInventoryV1(scope,inventory);
 if(native.types.size>127)throw Error('host_scope_readback_type_reference_limit');
 const samples=[...native.types.keys()].sort((a,b)=>a-b).map(typeId=>
  Math.min(...[...native.instances.values()].filter(x=>x.typeId===typeId).map(x=>x.elementId)));
 for(const id of samples)await collect({method:'POST',path:'/revit/inspect-family-content',body:{elementId:id,maxElements:2000,includeParameters:false,includeOtherElements:false}});
 // Refresh via the same authenticated work-plan control path after all reads.
 // These exact references include the complete census and every derived type.
 guard();const result=await deps.refresh(referenceIds);
 return {result,read_operation_ids:referenceIds,notice:'Host collected complete native category/type readbacks through normal admission. Scope truth is recomputed from retained bytes; source interpretation and visual/layout review remain separate.'};
}
