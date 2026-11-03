import{payloadDigestV2}from'@revitoperator/payload-digest-v2';
import{readAuthoritativeEvidence,readEvidenceRef}from'../evidence/evidence_store.js';
import{sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2}from'../domain/assignment-kernel/index.js';
import{appliedOperationHasVerifiedPostconditionV2,verificationOperationHasVerifiedPostconditionV2}from'../domain/assignment-kernel/outcome.js';
import{checkedEditIsCurrentV2}from'./current_postcondition_v2.js';

type Row=Record<string,any>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const body=(v:unknown)=>row(row(v).body??v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const keys=(v:Row,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=64&&v.every(positive)&&new Set(v).size===v.length;
const sameIds=(a:unknown,b:unknown)=>ids(a)&&ids(b)&&a.length===b.length&&a.every(id=>b.includes(id));
const uid=(v:unknown):v is string=>typeof v==='string'&&v.length>=10&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const ref=(v:unknown)=>typeof v==='string'&&/^\$[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)?v.slice(1):Object.keys(row(v)).length===1&&typeof row(v).$ref==='string'?row(v).$ref:null;
const point=(v:unknown)=>{const p=row(v);return Object.keys(p).length===3&&keys(p,['x','y','z'])&&[p.x,p.y,p.z].every(finite)?p:null;};
const nearPoint=(a:unknown,b:unknown)=>{const p=point(a),q=point(b);return !!p&&!!q&&['x','y','z'].every(k=>Math.abs(p[k]-q[k])<=1e-7);};
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const LINE='method:Autodesk.Revit.DB.Line.CreateBound(Autodesk.Revit.DB.XYZ,Autodesk.Revit.DB.XYZ)';
const NEW='method:Autodesk.Revit.Creation.ItemFactoryBase.NewDetailCurve(Autodesk.Revit.DB.View,Autodesk.Revit.DB.Curve)';
export const DETAIL_LINE_GEOMETRY_SEMANTIC_V2='detail_line.created_geometry';
export function isNativeDetailLineGraphEditV2(v:unknown){return Array.isArray(body(v).operations)&&body(v).operations.some((s:unknown)=>row(s).memberId===NEW);}

/** Complete literal straight-line creation graphs only. No partial recognition,
 * appearance setters, other geometry, expression evaluation or mutation replay. */
export function nativeDetailLineGraphRequestV2(v:unknown){
 const q=row(v),b=body(v),t=row(b.transaction),steps=b.operations;
 if(q.path!==undefined&&q.path!=='/revit/native-api-mutation-ops'||q.method!==undefined&&q.method!=='POST'
  ||!keys(b,['operations','returns','transaction','maxTotalMs','maxOperationMs'])
  ||!Array.isArray(steps)||steps.length<4||steps.length>16||steps.length%2!==0
  ||!keys(t,['mode','name','maxAffectedElements','allowCreate','allowedExistingElementIds'])||t.mode!=='commit'||t.allowCreate!==true
  ||!positive(t.maxAffectedElements)||t.maxAffectedElements>64||!ids(t.allowedExistingElementIds)||t.allowedExistingElementIds.length!==1
  ||t.name!==undefined&&(typeof t.name!=='string'||t.name.length>240)
  ||['maxTotalMs','maxOperationMs'].some(k=>b[k]!==undefined&&(!Number.isInteger(b[k])||b[k]<100||b[k]>10000)))return null;
 const seen=new Map<string,Row>(),geometry=new Map<string,Row>(),created:Row[]=[];let factory:Row|null=null,owner:Row|null=null;
 for(const value of steps){const s=row(value);
  if(!keys(s,['id','op','target','property','memberId','args'])||typeof s.id!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s.id)||seen.has(s.id))return null;
  if(s.op==='get_property'&&s.target==='doc'&&s.property==='Create'&&s.memberId===undefined&&s.args===undefined&&!factory)factory=s;
  else if(s.op==='call'&&s.target==='doc'&&s.memberId===GET&&s.property===undefined&&Array.isArray(s.args)&&s.args.length===1&&positive(s.args[0])&&!owner){owner=s;if(s.args[0]!==t.allowedExistingElementIds[0])return null;}
  else if(s.op==='call'&&s.target===undefined&&s.memberId===LINE&&s.property===undefined&&Array.isArray(s.args)&&s.args.length===2&&s.args.every(point)){
   if(nearPoint(s.args[0],s.args[1]))return null;geometry.set(s.id,s);
  }else if(s.op==='call'&&factory&&owner&&ref(s.target)===factory.id&&s.memberId===NEW&&s.property===undefined&&Array.isArray(s.args)&&s.args.length===2&&ref(s.args[0])===owner.id&&geometry.has(ref(s.args[1])??'')&&seen.has(ref(s.args[1])??''))created.push(s);
  else return null;
  seen.set(s.id,s);
 }
 if(!factory||!owner||!created.length||created.length>t.maxAffectedElements||steps.length!==2+2*created.length||geometry.size!==created.length
  ||[...geometry.keys()].some(id=>created.filter(s=>ref(s.args[1])===id).length!==1)
  ||!Array.isArray(b.returns)||b.returns.length!==created.length||b.returns.some((s:unknown)=>typeof s!=='string')
  ||new Set(b.returns.map((s:string)=>s.replace(/^\$/,''))).size!==created.length
  ||created.some(s=>!b.returns.map((n:string)=>n.replace(/^\$/,'')).includes(s.id)))return null;
 return{viewId:owner.args[0] as number,factory,owner,steps,created,geometry,transaction:t};
}

export function nativeDetailLineCommitV2(input:unknown,payload:unknown){
 const g=nativeDetailLineGraphRequestV2(input),p=row(payload),tx=row(p.transaction);if(!g)return null;
 if(p.version!=='operator.native_api_mutation_ops.v1'||p.ok!==true||p.read_only!==false||p.operation_count!==g.steps.length||p.mutation_operation_count!==g.created.length
  ||!Array.isArray(p.geometry_cleanup_errors)||p.geometry_cleanup_errors.length||!Array.isArray(p.operations)||p.operations.length!==g.steps.length
  ||tx.mode!=='commit'||tx.status!=='committed'||tx.committed!==true||tx.dry_run!==false||tx.pending===true||tx.rolled_back===true
  ||tx.scope_observation!=='dynamic_model_updater_then_failure_preprocessor_at_transaction_boundary'||tx.scope_enforcement!=='failure_processing_allowed_commit'
  ||tx.scope_baseline!=='complete_native_document_ids_before_transaction'||!positive(tx.scope_baseline_element_count)||!positive(tx.scope_observer_executions)
  ||tx.existing_scope_matched!==true||tx.scope_discovery_only!==false||tx.allow_create!==true||tx.max_affected_elements!==g.transaction.maxAffectedElements
  ||!sameIds(tx.allowed_existing_element_ids,[g.viewId])||!sameIds(tx.commit_allowed_existing_element_ids,[g.viewId])
  ||![tx.modified_element_ids,tx.deleted_element_ids,tx.unexpected_existing_element_ids,tx.transient_created_ids].every(v=>Array.isArray(v)&&!v.length))return null;
 for(let i=0;i<g.steps.length;i++){const s=g.steps[i],n=row(p.operations[i]);if(n.id!==s.id||n.op!==s.op||(n.member_id??null)!==(s.memberId??null)||(n.property??null)!==(s.property??null)
  ||n.target_type!==(s.target==='doc'?'Autodesk.Revit.DB.Document':s.memberId===NEW?'Autodesk.Revit.Creation.Document':null))return null;
  if(s.memberId===LINE&&row(n.result_preview).type!=='Autodesk.Revit.DB.Line')return null;
  if(s.id===g.factory.id&&row(n.result_preview).type!=='Autodesk.Revit.Creation.Document')return null;
 }
 const owner=row(p.operations.find((s:Row)=>s.id===g.owner.id)?.result_preview);if(owner.id!==g.viewId||!uid(owner.unique_id)||owner.category!=='Views')return null;
 const targets=g.created.map(s=>{const n=row(p.operations.find((n:Row)=>n.id===s.id)?.result_preview),r=row(p.results)[s.id],line=g.geometry.get(ref(s.args[1])!)!;
  if(!positive(n.id)||!uid(n.unique_id)||n.category!=='Lines'||!r||r.id!==n.id||r.unique_id!==n.unique_id)return null;
  return{id:n.id as number,uniqueId:n.unique_id as string,start:line.args[0],end:line.args[1]};});
 if(targets.some(t=>!t)||!sameIds(tx.added_element_ids,targets.map(t=>t!.id))||tx.affected_element_count!==targets.length
  ||Object.keys(row(p.results)).length!==targets.length)return null;
 return{...g,viewUniqueId:owner.unique_id as string,targets:targets as NonNullable<typeof targets[number]>[],read:{method:'POST',path:'/revit/view-owned-detailing',body:{viewId:g.viewId,limit:5000}}};
}
export function detailLineOwnerReadRequestV2(v:unknown){const q=row(v),b=body(v);return(q.path===undefined||q.path==='/revit/view-owned-detailing')&&(q.method===undefined||q.method==='POST')
 &&keys(b,['viewId','limit'])&&positive(b.viewId)&&(b.limit===undefined||Number.isInteger(b.limit)&&b.limit>0&&b.limit<=5000)?b.viewId as number:null;}
export function nativeDetailLineReadbackMatchesV2(input:unknown,applied:unknown,readInput:unknown,fresh:unknown){
 const c=nativeDetailLineCommitV2(input,applied),p=row(fresh);if(!c||detailLineOwnerReadRequestV2(readInput)!==c.viewId||p.schema!=='revit-operator.view-owned-detailing/v1'||p.scope!=='exact_owner_view'
  ||p.ok===false||p.success===false||p.error||p.viewsComplete!==true||!sameIds(p.requestedViewIds,[c.viewId])||!Array.isArray(p.views)||p.views.length!==1)return false;
 const v=row(p.views[0]),view=row(v.view);if(view.id!==c.viewId||view.uniqueId!==c.viewUniqueId||v.itemsComplete!==true||v.truncated!==false||v.unreadableCount!==0
  ||[v.unclassifiedCount,v.incompleteTextCount,v.incompleteSignatureCount].some(n=>n!==0)
  ||!Array.isArray(v.unreadableElementIds)||v.unreadableElementIds.length||!Array.isArray(v.items)||v.items.length>5000||v.returnedCount!==v.items.length||v.totalOwnedCount!==v.items.length
  ||new Set(v.items.map((i:Row)=>i.elementId)).size!==v.items.length)return false;
 return c.targets.every(t=>{const n=row(v.items.find((i:Row)=>i.elementId===t.id)),curve=row(n.curve);return n.uniqueId===t.uniqueId&&n.ownerViewId===c.viewId&&n.className==='DetailLine'&&n.builtInCategory==='OST_Lines'
  &&n.comparisonExcluded===false&&n.semanticSignatureComplete===true&&curve.kind==='Line'&&nearPoint(curve.start,t.start)&&nearPoint(curve.end,t.end);});
}
function committed(s:AssignmentSnapshotV2,o:OperationV2){const r=o.result;
 if(s.execution_control?.state==='paused'||s.unresolved_unknown_operation_ids.length||s.input_invalidated_operation_ids?.includes(o.operation_id)
  ||o.requested_effect!=='apply'||o.admission_state!=='admitted'||o.dispatch_state!=='dispatched'||o.settlement_state!=='settled'||o.persistent_effect!=='applied'
  ||o.input.path!=='/revit/native-api-mutation-ops'||o.input.method!=='POST'||o.request_identity?.path!==o.input.path||!o.request_identity.request_signature
  ||!r||r.operation_id!==o.operation_id||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'
  ||!r.receipt_id||!r.native_correlation_id||!Number.isFinite(Date.parse(r.completed_at))||r.request_identity?.request_signature!==o.request_identity.request_signature
  ||!sameAssignmentBindingV2(o.binding,s.current_binding)||!sameAssignmentBindingV2(r.binding,o.binding))return null;
 for(const id of o.observation_ids){const n=s.observations[id];if(n?.operation_id!==o.operation_id||n.authority!=='native-host'||n.raw_payload_hash!==r.raw_payload_hash||!sameAssignmentBindingV2(n.binding,o.binding))continue;
  try{const ref=readEvidenceRef(n.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;const p=JSON.parse(readAuthoritativeEvidence(ref,{...o.binding,attempt_id:o.operation_id}).toString('utf8')),c=nativeDetailLineCommitV2(o.input,p);
   if(c&&payloadDigestV2(p).digest===r.raw_payload_hash&&Array.isArray(r.affected_target_identities)&&r.affected_target_identities.length===c.targets.length&&c.targets.every(t=>r.affected_target_identities!.includes('element_id:'+t.id)))return{c,p};
  }catch{/* Missing/changed/foreign evidence never schedules a replay or earns proof. */}
 }return null;
}
export function committedNativeDetailLineReadbackPlanV2(s:AssignmentSnapshotV2,o:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.in_flight_operation_ids.length||o.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(s,o.operation_id))return null;
 return committed(s,o)?.c.read??null;
}
/** Re-read after later work only when the latest exact independent native
 * check succeeded. Scheduling renews no proof and never repeats an edit. */
export function committedNativeDetailLineRefreshPlanV2(s:AssignmentSnapshotV2,o:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.in_flight_operation_ids.length||o.verification_operation_ids.length>64
  ||!appliedOperationHasVerifiedPostconditionV2(s,o.operation_id)||checkedEditIsCurrentV2(s,o.operation_id))return null;
 const c=committed(s,o);if(!c)return null;
 const reads=o.verification_operation_ids.map(id=>s.operations[id]);if(reads.some(r=>!r||!Number.isSafeInteger(r.admitted_assignment_version)))return null;
 const last=reads.sort((a,b)=>b!.admitted_assignment_version!-a!.admitted_assignment_version!)[0];
 if(!last?.result||!verificationOperationHasVerifiedPostconditionV2(s,last.operation_id))return null;
 for(const id of last.observation_ids){const n=s.observations[id];if(n?.operation_id!==last.operation_id||n.authority!=='native-host'||!sameAssignmentBindingV2(n.binding,last.binding)||n.raw_payload_hash!==last.result.raw_payload_hash)continue;
  try{const ref=readEvidenceRef(n.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;const p=JSON.parse(readAuthoritativeEvidence(ref,{...last.binding,attempt_id:last.operation_id}).toString('utf8'));
   if(nativeDetailLinePostconditionSatisfiedV2(s,o,last.result,p))return c.c.read;
  }catch{/* Missing, changed or foreign old read cannot schedule new proof. */}
 }return null;
}
export function nativeDetailLinePostconditionSatisfiedV2(s:AssignmentSnapshotV2,o:OperationV2,r:OperationResultV2,payload:unknown){
 const c=committed(s,o),read=s.operations[r.operation_id];if(!c||!read||read.requested_effect!=='read'||read.purpose!=='verification'||read.verification_of_operation_id!==o.operation_id||read.admission_state!=='admitted'
  ||!['dispatching','dispatched'].includes(read.dispatch_state)||s.input_invalidated_operation_ids?.includes(read.operation_id)||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'
  ||r.persistent_effect!=='none'||r.native_transaction_state!=='not_applicable'||!r.receipt_id||!r.native_correlation_id||!sameAssignmentBindingV2(read.binding,o.binding)||!sameAssignmentBindingV2(r.binding,read.binding)
  ||read.request_identity?.path!=='/revit/view-owned-detailing'||read.input.path!==read.request_identity.path||read.input.method!=='POST'||r.request_identity?.path!==read.input.path||r.request_identity.method!=='POST'
  ||!read.request_identity.request_signature||r.request_identity.request_signature!==read.request_identity.request_signature||payloadDigestV2(payload).digest!==r.raw_payload_hash
  ||![read.opened_at,r.completed_at].every(t=>Number.isFinite(Date.parse(t)))||Date.parse(read.opened_at)<Date.parse(o.result!.completed_at)||Date.parse(r.completed_at)<Date.parse(read.opened_at))return false;
 return nativeDetailLineReadbackMatchesV2(o.input,c.p,read.input,payload);
}
