import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {desktopDraftingLocationOutput} from '../src/assignments/desktop_drafting_location_output.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {retrieveEvidence} from '../src/evidence/evidence_store.js';
const files=[new URL('./fixtures/verified-annotation-feedback-516.json',import.meta.url),new URL('../../test/fixtures/verified-annotation-feedback-516.json',import.meta.url)];
function setup(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drafting-location-ack-')),old=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=dir;
 t.after(()=>{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 const file=files.find(f=>fs.existsSync(f));assert(file);const s:any=JSON.parse(fs.readFileSync(file,'utf8'));
 s.terminal=false;s.outcome='active';s.execution_control={state:'running'};s.assignment_version=900;
 s.unresolved_unknown_operation_ids=[];s.pending_input_variable_ids=[];s.pending_review_ids=[];s.operations={};
 delete s.provider_usage_hold;delete s.completion_proposal;
 const record:any={status:'candidate',reason:'Compared source branch',recorded_at:new Date().toISOString(),binding:{...s.current_binding},verified:false,
  source:{attachment_id:'source',filename:'plan.pdf',sha256:'a'.repeat(64),page:1,page_count:1,region:{min_u:.1,min_v:.2,max_u:.3,max_v:.4}},
  native:{document_fingerprint:s.current_binding.document_fingerprint,view_id:100,view_name:'Test plan'},
  drafting:{pass:'annotations',stage:'attempted',element_ids:[10],read_operation_ids:[],remaining:'Add missing size label',next_action:'Add associative size tag'}};
 s.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[...Array.from({length:12},(_,i)=>({item_id:'other_'+i,operation_ids:[]})),{item_id:'area_east',operation_ids:[],location_history:[record]}]};
 const scope=Object.fromEntries(['session_id','assignment_id','run_id','generation'].map(k=>[k,s.current_binding[k]])) as any;
 const result={success:true,contentItems:[{type:'inputText' as const,text:JSON.stringify({work_plan:{scope:'retained complete status'},large:'x'.repeat(14000)})}]};
 const input={tool:'operator_manage_work_plan',arguments:{action:'locate',itemId:'area_east',locationHint:{drafting:structuredClone(record.drafting)}},snapshot:s,beforeVersion:899,scope,callId:'call_ack'};
 return {s,record,result,input,scope};
}
test('selected later area/pass stays literal and bounded while exact original output remains retrievable',t=>{
 const {s,result,input,scope}=setup(t),before=JSON.stringify(s);const p=desktopDraftingLocationOutput(result,input)!;assert(p);
 const text=(p.contentItems[0] as any).text,ack=JSON.parse(text);
 assert.equal(ack.item_id,'area_east');assert.equal(ack.location_hint.drafting.pass,'annotations');assert.equal(ack.location_hint.drafting.stage,'attempted');
 assert.equal(ack.location_hint.drafting.next_action,'Add associative size tag');assert.equal(ack.whole_task_verified,false);
 assert(Buffer.byteLength(text)<4096);assert(Buffer.byteLength(text)<Buffer.byteLength(JSON.stringify(result))/2);
 assert.deepEqual(boundDesktopNativeOutput(p,scope,input.callId),p,'Consumer must deliver the ack without another generic projection');
 const retained=retrieveEvidence({scope,evidence_id:ack.retained_output.evidence_id,fields:['contentItems'],max_bytes:16384,purpose:'Read original work-plan context'});
 assert.deepEqual((retained.selection as any).contentItems,result.contentItems);
 assert.throws(()=>retrieveEvidence({scope:{...scope,generation:2},evidence_id:ack.retained_output.evidence_id,fields:['contentItems'],max_bytes:16384,purpose:'Stale generation'}));
 assert.equal(JSON.stringify(s),before);
});
test('checked pass remains scoped and does not requeue its old next action',t=>{
 const {input,record}=setup(t);record.drafting.stage='checked';input.arguments.locationHint.drafting=structuredClone(record.drafting);
 const ack=JSON.parse((desktopDraftingLocationOutput({success:true,contentItems:[{type:'inputText',text:'original'}]},input)!.contentItems[0] as any).text);
 assert.equal(ack.location_hint.verified,false);assert.equal(ack.location_hint.drafting.stage,'checked');
 assert.equal(ack.location_hint.drafting.next_action,undefined);assert.equal(ack.location_hint.drafting_passes[0].host_certified,undefined);
});
test('errors, other actions/tools, unchanged version, mismatched record, foreign binding and held states preserve original output path',t=>{
 const {result,input}=setup(t);
 const mutations=[(i:any)=>i.tool='revit_call_tool',(i:any)=>i.arguments.action='status',(i:any)=>i.beforeVersion=900,
  (i:any)=>i.arguments.itemId='missing',(i:any)=>i.arguments.locationHint.drafting.stage='drafted',
  (i:any)=>i.scope.generation++,(i:any)=>i.snapshot.terminal=true,(i:any)=>i.snapshot.outcome='awaiting_user_review',
  (i:any)=>i.snapshot.execution_control.state='paused',(i:any)=>i.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (i:any)=>i.snapshot.pending_input_variable_ids=['input'],(i:any)=>i.snapshot.pending_review_ids=['review'],
  (i:any)=>i.snapshot.provider_usage_hold=true,(i:any)=>i.snapshot.work_plan.items.at(-1).location_history[0].binding.generation++];
 for(const mutate of mutations){const i=structuredClone(input);mutate(i);assert.equal(desktopDraftingLocationOutput(result,i),null);}
 assert.equal(desktopDraftingLocationOutput({...result,success:false},input),null);
 assert.equal(desktopDraftingLocationOutput({success:true,contentItems:[{type:'inputImage',imageUrl:'data:image/png;base64,eA=='}]},input),null);
});
test('an oversized area is not clipped into a compact acknowledgement',t=>{
 const {input,result,record}=setup(t);record.drafting.remaining='long '.repeat(5000);input.arguments.locationHint.drafting=structuredClone(record.drafting);
 assert.equal(desktopDraftingLocationOutput(result,input),null);
});
