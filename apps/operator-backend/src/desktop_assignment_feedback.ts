import {sameAssignmentBindingV2,type AssignmentSnapshotV2} from './domain/assignment-kernel/index.js';
import {codexAssignmentEvidenceContextV2} from './brains/codex_assignment_evidence.js';
import {assignmentWorkBudgetStatusV2} from './assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from './assignments/assignment_kernel_v2_progress.js';
import {draftingConstructionProgressV2} from './domain/assignment-kernel/progress/native_work_progress.js';
import {projectDraftingFrontier,DRAFTING_COVERAGE_SWEEP_ADVICE} from './assignments/drafting_frontier.js';

/** The same host-derived native feedback used by the backend worker, carried to
 * the bound outer desktop worker. Caller prose cannot supply or certify it. */
export function desktopAssignmentFeedbackInputV2(input:unknown,snapshot:AssignmentSnapshotV2,previousResponseId?:string):unknown[]{
 if(!Array.isArray(input)&&typeof input!=='string')throw new Error('desktop_assignment_input_invalid');
 const feedback=codexAssignmentEvidenceContextV2(snapshot,undefined,
   assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,new Date().toISOString()));
 const construction=draftingConstructionProgressV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2.max_no_progress_epochs);
 const frontier=projectDraftingFrontier(snapshot);
 const nextAction=(snapshot.work_plan?.items??[]).flatMap(item=>(item.location_history??[])
   .filter(location=>location.drafting?.next_action).map(location=>({item_id:item.item_id,at:location.recorded_at,next_action:location.drafting!.next_action})))
   .sort((a,b)=>b.at.localeCompare(a.at))[0];
 const text=JSON.stringify({schema:'operator.desktop-assignment-feedback.v1',
   assignment_version:snapshot.assignment_version,binding:snapshot.current_binding,
   native_feedback:recentObservationIndex(JSON.parse(feedback),snapshot,previousResponseId),construction_progress:construction,
   ...(frontier?{drafting_frontier:frontier}:{}),
   ...(construction&&construction.state!=='working'&&nextAction?{recorded_next_action:nextAction}:{})});
 const previous=typeof input==='string'?[{role:'user',content:input}]:input;
 return [...previous,{role:'user',content:[{type:'input_text',text:'HOST CURRENT CHECK FEEDBACK. '
   +'Inspect supported discrepancies and correct/recheck against current user intent. Unavailable proof is not a reason to replay an uncertain change. '
   +'These records and images do not by themselves certify whole-task or visual success. '
   +(construction&&construction.state!=='working'
     ?'You have used '+construction.calls_since_construction+' calls without new construction or independently checked target progress. Change approach now: '
       +(snapshot.spec.execution_policy?.progress_allowance?.mode==='observed_native_work_v1'
         ?'This is pacing advice, not an admission refusal. A missing specialized postcondition is not a barrier to independent authorized construction in this advisory task. Use the supported native physical readback already recorded, finish any uncovered current check, correct a supported discrepancy and continue independent authorized construction. Do not repeat reads solely to turn an unsupported semantic check into a recognized postcondition. Existing native admission, Pause, unknown effects, resource limits and actual tool refusals still govern execution; retain any precise unresolved scope honestly. '
         :construction.distinct_model_commits>0&&construction.independently_checked_targets===0
         ?'finish the focused independent check of existing edits before constructing more. '
         :'use the gathered reference/model facts to resolve one useful discrepancy, then read back and check it. ')
       +'If a specific fact is still missing, obtain that bounded fact or state the exact blocker; do not repeat whole-sheet discovery, unchanged visual review or archive retrieval. Saving the unchanged model earns no construction credit. '
     :'')+(frontier?.state==='coverage_sweep_due'?DRAFTING_COVERAGE_SWEEP_ADVICE+' ':'')+'\n'+text}]}];
}

/** Discovery pointers are a partial index, not currentness/verification facts.
 * On an accounted continuation, index only observations since that predecessor
 * was admitted. Keep every current check, discrepancy, inspection candidate and
 * budget field byte-for-byte. Native tool outputs and durable evidence are not
 * clipped, and no conversation or canonical history is rewritten. */
function recentObservationIndex(index:any,snapshot:AssignmentSnapshotV2,responseId?:string){
 if(!responseId||snapshot.execution_control?.state==='paused'||snapshot.provider_usage_hold
   ||snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_provider_call_ids.length||snapshot.in_flight_operation_ids.length
   ||!Array.isArray(index.observations)||!index.observations.length)return index;
 const matches=Object.values(snapshot.provider_calls).filter(call=>call.upstream_receipt?.call_id===responseId);
 if(matches.length!==1)return index;
 const call=matches[0]!;
 if(call.state!=='completed'||call.success!==true||!call.usage||typeof call.usage.total_tokens!=='number'||!Number.isSafeInteger(call.usage.total_tokens)
   ||call.usage.total_tokens<0||!call.usage_received_at||call.upstream_receipt?.route!=='desktop_computer'
   ||!sameAssignmentBindingV2(call.binding,snapshot.current_binding))return index;
 const cutoff=Date.parse(call.admitted_at),completed=Date.parse(call.completed_at??'');
 if(!Number.isFinite(cutoff)||!Number.isFinite(completed)||completed<cutoff)return index;
 // Ambiguous/malformed timestamps retain the complete existing index. Equal
 // timestamps stay visible; clock granularity must not omit a new pointer.
 const times=index.observations.map((row:any)=>Date.parse(snapshot.observations[row.observation_id]?.observed_at??''));
 if(times.some((time:number)=>!Number.isFinite(time)))return index;
 const observations=index.observations.filter((_row:any,i:number)=>times[i]>=cutoff);
 const suppressed=index.observations.length-observations.length;
 if(!suppressed)return index;
 return {...index,observations,omitted:index.omitted+suppressed,observation_index_window:{
   after_provider_response_id:responseId,observed_since:call.admitted_at,older_index_rows_omitted:suppressed,complete:false,
   usage:'Recent discovery pointers only. Older evidence remains in the conversation and retained store; retrieve it by its evidence ID when needed. Omission proves neither absence, staleness nor completion. Current verification, pending checks, inspection candidates and budget below remain independent of this index window.'}};
}
