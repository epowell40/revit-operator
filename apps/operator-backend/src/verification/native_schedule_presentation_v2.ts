import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';

const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const coordinate=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=100000;
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const section=(v:unknown)=>typeof v==='string'?['Header','Body','Summary','Footer'].find(s=>s.toLowerCase()===v.toLowerCase()):undefined;
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const TABLE='method:Autodesk.Revit.DB.TableData.GetSectionData(Autodesk.Revit.DB.SectionType)';
const PANEL_SECTION='method:Autodesk.Revit.DB.Electrical.PanelScheduleView.GetSectionData(Autodesk.Revit.DB.SectionType)';
const TABLE_GETS=['method:Autodesk.Revit.DB.Electrical.PanelScheduleView.GetTableData()','method:Autodesk.Revit.DB.ViewSchedule.GetTableData()'];
const SET_TEXT='method:Autodesk.Revit.DB.TableSectionData.SetCellText(System.Int32,System.Int32,System.String)';
const SET_HEIGHT='method:Autodesk.Revit.DB.TableSectionData.SetRowHeight(System.Int32,System.Double)';
const READ_TEXT='method:Autodesk.Revit.DB.TableView.GetCellText(Autodesk.Revit.DB.SectionType,System.Int32,System.Int32)';
const READ_HEIGHT='method:Autodesk.Revit.DB.TableSectionData.GetRowHeight(System.Int32)';
type Target={kind:'text'|'height';section:string;row:number;column?:number;value?:string|number;stepId:string};
type Handle={kind:'view'|'table'|'section';section?:string};
type Graph={scheduleId:number;contextView:boolean;targets:Target[];operations:Record<string,any>[];handles:Map<string,Handle>};

function contextReceiver(step:unknown){const n=obj(step),identity=obj(n.target_identity);
 return identity.schema==='operator.native_element_receiver.v1'&&identity.active_document===true
  &&positive(identity.element_id)&&typeof identity.unique_id==='string'&&identity.unique_id.length>0
  &&identity.type_name===n.target_type&&['Autodesk.Revit.DB.ViewSchedule','Autodesk.Revit.DB.Electrical.PanelScheduleView'].includes(n.target_type)
  ?{id:identity.element_id,uid:identity.unique_id}:null;
}

/** Complete, declarative SDK graphs only. Never interpret C#, reports, getters
 * of unrelated objects, arbitrary mutations, or a partially recognized graph. */
function graph(input:unknown,editing:boolean,appliedPayload?:unknown):Graph|null {
 const w=obj(input),b=obj(w.body??input),steps=b.operations,handles=new Map<string,Handle>(),ids=new Set<string>(),targets:Target[]=[],keys=new Set<string>();
 if(!Array.isArray(steps)||!steps.length||steps.length>64)return null;
 let scheduleId=0,contextView=false;
 for(const candidate of steps){const s=obj(candidate),args=s.args;
  if(typeof s.id!=='string'||!/^\w{1,64}$/.test(s.id)||ids.has(s.id)||s.op!=='call'||!Array.isArray(args)
   ||Object.keys(s).some(k=>!['id','op','memberId','target','args'].includes(k)))return null;
  ids.add(s.id);
  if(s.target==='view'){
   if(!editing||scheduleId&&!contextView)return null;
   contextView=true;handles.set('view',{kind:'view'});
  }
  const source=handles.get(s.target);
  if(s.memberId===GET){if(scheduleId||contextView||s.target!=='doc'||args.length!==1||!positive(args[0]))return null;
   scheduleId=args[0];handles.set('$'+s.id,{kind:'view'});continue;}
  if(TABLE_GETS.includes(s.memberId)&&source?.kind==='view'&&args.length===0){handles.set('$'+s.id,{kind:'table'});continue;}
  if((s.memberId===TABLE&&source?.kind==='table'||s.memberId===PANEL_SECTION&&source?.kind==='view')&&args.length===1&&section(args[0])){
   handles.set('$'+s.id,{kind:'section',section:section(args[0])});continue;}
  let t:Target|undefined;
  if(editing&&s.memberId===SET_TEXT&&source?.kind==='section'&&args.length===3&&coordinate(args[0])&&coordinate(args[1])&&typeof args[2]==='string'&&args[2].length<=4000)
   t={kind:'text',section:source.section!,row:args[0],column:args[1],value:args[2],stepId:s.id};
  if(editing&&s.memberId===SET_HEIGHT&&source?.kind==='section'&&args.length===2&&coordinate(args[0])&&typeof args[1]==='number'&&Number.isFinite(args[1])&&args[1]>0&&args[1]<=2)
   t={kind:'height',section:source.section!,row:args[0],value:args[1],stepId:s.id};
  if(!editing&&s.memberId===READ_TEXT&&source?.kind==='view'&&args.length===3&&section(args[0])&&coordinate(args[1])&&coordinate(args[2]))
   t={kind:'text',section:section(args[0])!,row:args[1],column:args[2],stepId:s.id};
  if(!editing&&s.memberId===READ_HEIGHT&&source?.kind==='section'&&args.length===1&&coordinate(args[0]))
   t={kind:'height',section:source.section!,row:args[0],stepId:s.id};
  if(!t)return null;const key=JSON.stringify([t.kind,t.section,t.row,t.column]);if(keys.has(key))return null;
  keys.add(key);targets.push(t);
 }
 if((!scheduleId&&!contextView)||!targets.length)return null;
 if(contextView&&appliedPayload!==undefined){
  const receipts=obj(appliedPayload).operations;
  if(!Array.isArray(receipts)||receipts.length!==steps.length)return null;
  let uid:string|undefined;
  for(const [i,s]of steps.entries())if(s.target==='view'){
   const n=obj(receipts[i]),identity=contextReceiver(n);
   if(!identity||n.id!==s.id||n.member_id!==s.memberId||scheduleId&&scheduleId!==identity.id||uid&&uid!==identity.uid)return null;
   scheduleId=identity.id;uid=identity.uid;
  }
  if(!positive(scheduleId))return null;
 }
 if(!editing&&(!Array.isArray(b.returns)||!equal(b.returns,targets.map(t=>'$'+t.stepId))))return null;
 return {scheduleId,contextView,targets,operations:steps,handles};
}

export function nativeSchedulePresentationRequestV2(input:unknown,appliedPayload?:unknown){const g=graph(input,true,appliedPayload),w=obj(input),b=obj(w.body??input),tx=obj(b.transaction);
 return g&&tx.mode==='commit'&&tx.allowCreate===false&&Array.isArray(tx.allowedExistingElementIds)
  &&tx.allowedExistingElementIds.length>0&&tx.allowedExistingElementIds.length<=64&&tx.allowedExistingElementIds.every(positive)
  &&new Set(tx.allowedExistingElementIds).size===tx.allowedExistingElementIds.length
  &&(positive(g.scheduleId)?tx.allowedExistingElementIds.includes(g.scheduleId):g.contextView)?g:null;
}
export function isNativeSchedulePresentationEditV2(input:unknown):boolean {
 const w=obj(input),operations=obj(w.body??input).operations;
 return Array.isArray(operations)&&operations.some(s=>[SET_TEXT,SET_HEIGHT].includes(obj(s).memberId));
}
export function nativeSchedulePresentationReadTargetsV2(input:unknown):number[]{const g=graph(input,false);return g?[g.scheduleId]:[];}
export function nativeSchedulePresentationObservedTargetsV2(payload:unknown):number[]{const p=obj(payload),steps=p.operations;
 if(p.version!=='operator.native_api_ops.v2'||p.ok!==true||p.read_only!==true||!Array.isArray(steps)||steps.length>64||p.operation_count!==steps.length)return [];
 const lookups=steps.filter(s=>obj(s).op==='call'&&obj(s).member_id===GET&&obj(s).target_type==='Autodesk.Revit.DB.Document');
 const id=obj(obj(lookups[0]).result_preview).id,uid=obj(obj(lookups[0]).result_preview).unique_id;
 return lookups.length===1&&positive(id)&&typeof uid==='string'&&uid.length>0?[id]:[];
}
function readBody(g:Graph,appliedPayload:unknown){const operations:any[]=[{id:'schedule',op:'call',target:'doc',memberId:GET,args:[g.scheduleId]}],returns:string[]=[],sections=new Map<string,string>();
 let tableGetter:string|undefined;
 if(g.targets.some(t=>t.kind==='height')){
  const receipts=obj(appliedPayload).operations;
  if(!Array.isArray(receipts)||receipts.length!==g.operations.length)return null;
  const types=new Set(g.operations.flatMap((s,i)=>g.handles.get(s.target)?.kind==='view'?[obj(receipts[i]).target_type]:[]));
  if(types.size!==1)return null;
  // GetTableData is declared on the two concrete schedule classes, not TableView.
  // Bind the getter to the retained native receiver, never an actor type claim.
  const type=[...types][0];
  tableGetter=type==='Autodesk.Revit.DB.Electrical.PanelScheduleView'?TABLE_GETS[0]:type==='Autodesk.Revit.DB.ViewSchedule'?TABLE_GETS[1]:undefined;
  if(!tableGetter)return null;
 }
 for(const [i,t]of g.targets.entries()){
  if(t.kind==='height'&&!sections.has(t.section)){
   if(!operations.some(o=>o.id==='table'))operations.push({id:'table',op:'call',target:'$schedule',memberId:tableGetter,args:[]});
   const id='section'+sections.size;sections.set(t.section,'$'+id);operations.push({id,op:'call',target:'$table',memberId:TABLE,args:[t.section]});
  }
  const id='read'+i;operations.push({id,op:'call',target:t.kind==='text'?'$schedule':sections.get(t.section),
   memberId:t.kind==='text'?READ_TEXT:READ_HEIGHT,args:t.kind==='text'?[t.section,t.row,t.column]:[t.row]});returns.push('$'+id);
 }
 return operations.length<=64?{operations,returns}:null;
}
function nativeIdentity(g:Graph,p:Record<string,any>,editing:boolean){
 if(p.version!==(editing?'operator.native_api_mutation_ops.v1':'operator.native_api_ops.v2')||p.ok!==true||p.read_only!==!editing
  ||p.operation_count!==g.operations.length||!Array.isArray(p.operations)||p.operations.length!==g.operations.length
  ||!Array.isArray(p.geometry_cleanup_errors)||p.geometry_cleanup_errors.length)return null;
 let uid:string|undefined;
 for(const [i,s]of g.operations.entries()){const n=obj(p.operations[i]),h=g.handles.get(s.target);
  if(n.id!==s.id||n.op!=='call'||n.member_id!==s.memberId)return null;
  if(s.memberId===GET){const v=obj(n.result_preview);if(n.target_type!=='Autodesk.Revit.DB.Document'||v.id!==g.scheduleId||typeof v.unique_id!=='string'||!v.unique_id)return null;uid=v.unique_id;}
  else if(h?.kind==='view'){
   if(!['Autodesk.Revit.DB.ViewSchedule','Autodesk.Revit.DB.Electrical.PanelScheduleView'].includes(n.target_type))return null;
   if(s.target==='view'){const identity=contextReceiver(n);if(!identity||identity.id!==g.scheduleId||uid&&uid!==identity.uid)return null;uid=identity.uid;}
  }
  else if(h?.kind==='table'&&!['Autodesk.Revit.DB.TableData','Autodesk.Revit.DB.Electrical.PanelScheduleData'].includes(n.target_type))return null;
  else if(h?.kind==='section'&&n.target_type!=='Autodesk.Revit.DB.TableSectionData')return null;
 }
 return uid??null;
}
/** Requested text/heights only. This is not a visual, electrical, template-
 * binding, or unrequested-style preservation certification. */
export function nativeSchedulePresentationMatchesV2(input:unknown,appliedPayload:unknown,readInput:unknown,freshPayload:unknown):boolean{
 const g=nativeSchedulePresentationRequestV2(input,appliedPayload),freshGraph=graph(readInput,false),a=obj(appliedPayload),f=obj(freshPayload);
 if(!g||!freshGraph||!equal(obj(readInput).body??readInput,readBody(g,a)))return false;
 const tx=obj(a.transaction),wanted=obj(obj(input).body??input),declared=obj(wanted.transaction).allowedExistingElementIds;
 if(tx.mode!=='commit'||tx.status!=='committed'||tx.committed!==true||tx.dry_run!==false||tx.pending===true||tx.rolled_back===true||tx.existing_scope_matched!==true||tx.scope_discovery_only!==false
  ||tx.scope_baseline!=='complete_native_document_ids_before_transaction'||!positive(tx.scope_baseline_element_count)||!positive(tx.scope_observer_executions)
  ||!Array.isArray(tx.added_element_ids)||tx.added_element_ids.length||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.length
  ||!Array.isArray(tx.unexpected_existing_element_ids)||tx.unexpected_existing_element_ids.length
  ||!Array.isArray(tx.modified_element_ids)||!tx.modified_element_ids.includes(g.scheduleId)||tx.modified_element_ids.some((id:unknown)=>!positive(id)||!declared.includes(id))
  ||new Set(tx.modified_element_ids).size!==tx.modified_element_ids.length
  ||!equal(tx.allowed_existing_element_ids,declared)||!equal(tx.commit_allowed_existing_element_ids,declared)
  ||a.mutation_operation_count!==g.targets.length)return false;
 const uid=nativeIdentity(g,a,true);if(!uid||nativeIdentity(freshGraph,f,false)!==uid)return false;
 const results=obj(f.results);
 return g.targets.every((t,i)=>{const n=obj(f.operations.find((s:any)=>s.id==='read'+i)),v=results['read'+i];
  return t.kind==='text'?typeof v==='string'&&v===t.value&&n.result_preview===v:
   typeof v==='number'&&Number.isFinite(v)&&typeof t.value==='number'&&Math.abs(v-t.value)<=1e-9&&n.result_preview===v;
 });
}
function retained(op:OperationV2,snapshot:AssignmentSnapshotV2){for(const id of op.observation_ids){const o=snapshot.observations[id];
 if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
 try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
  const payload=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));
  if(payloadDigestV2(payload).digest===op.result?.raw_payload_hash)return payload;
 }catch{/* Missing or corrupt receipt stays unverified, never replay its write. */}
 }return null;}
function committed(snapshot:AssignmentSnapshotV2,op:OperationV2){const r=op.result,payload=obj(retained(op,snapshot)),g=nativeSchedulePresentationRequestV2(op.input,payload);
 if(!g||snapshot.unresolved_unknown_operation_ids.length||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
  ||!sameAssignmentBindingV2(op.binding,snapshot.current_binding)||op.request_identity?.path!=='/revit/native-api-mutation-ops'
  ||op.input.path!==op.request_identity.path||op.input.method!=='POST'||op.requested_effect!=='apply'||op.admission_state!=='admitted'
  ||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
  ||!r||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.native_transaction_state!=='committed'||r.persistent_effect!=='applied'
  ||!sameAssignmentBindingV2(r.binding,op.binding)||r.operation_id!==op.operation_id||r.request_identity?.request_signature!==op.request_identity.request_signature
  ||!r.receipt_id||!r.native_correlation_id||!Number.isFinite(Date.parse(r.completed_at))||!r.affected_target_identities?.includes('element_id:'+g.scheduleId))return null;
 if(Object.values(snapshot.operations).some(other=>other.operation_id!==op.operation_id&&other.requested_effect==='apply'
  &&(other.dispatch_state==='dispatched'&&other.settlement_state!=='settled'||other.persistent_effect!=='none'&&other.result&&Date.parse(other.result.completed_at)>=Date.parse(r.completed_at))))return null;
 const tx=obj(payload.transaction);
 if(!nativeIdentity(g,payload,true)||!Array.isArray(tx.modified_element_ids)
  ||!equal([...tx.modified_element_ids].map(id=>'element_id:'+id).sort(),[...r.affected_target_identities].sort()))return null;
 return {g,payload};
}
export function committedNativeSchedulePresentationReadbackPlanV2(snapshot:AssignmentSnapshotV2,op:OperationV2){const c=committed(snapshot,op);
 if(!c||snapshot.terminal||snapshot.outcome!=='active'||snapshot.completion_proposal||snapshot.execution_control?.state==='paused'
  ||op.verification_operation_ids.length||appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id))return null;
 const body=readBody(c.g,c.payload);return body?{method:'POST',path:'/revit/native-api-ops',body}:null;
}
export function nativeSchedulePresentationPostconditionSatisfiedV2(snapshot:AssignmentSnapshotV2,op:OperationV2,r:OperationResultV2,payload:unknown){
 const c=committed(snapshot,op),read=snapshot.operations[r.operation_id];
 if(!c||!read||r.authority!=='native-host'||r.status!=='succeeded'||r.dispatch_state!=='dispatched'||r.persistent_effect!=='none'||r.native_transaction_state!=='not_applicable'
  ||!sameAssignmentBindingV2(r.binding,snapshot.current_binding)||!sameAssignmentBindingV2(read.binding,r.binding)||read.requested_effect!=='read'||read.admission_state!=='admitted'
  ||!['dispatching','dispatched'].includes(read.dispatch_state)||r.request_identity?.path!=='/revit/native-api-ops'||r.request_identity.method!=='POST'
  ||read.input.path!==r.request_identity.path||read.input.method!=='POST'||r.request_identity.request_signature!==read.request_identity?.request_signature
  ||!r.receipt_id||!r.native_correlation_id||!Number.isFinite(Date.parse(r.completed_at))||!Number.isFinite(Date.parse(read.opened_at))
  ||Date.parse(read.opened_at)<Date.parse(op.result!.completed_at)||Date.parse(r.completed_at)<Date.parse(read.opened_at)
  ||payloadDigestV2(payload).digest!==r.raw_payload_hash)return false;
 return nativeSchedulePresentationMatchesV2(op.input,c.payload,read.input,payload);
}
