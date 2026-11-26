import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {continueNewDocument} from '../new_document_handoff.mjs';

const parent={assignment_id:'parent',session_id:'chat',run_id:'parent-run',generation:1};
const child={assignment_id:'child',session_id:'chat',run_id:'child-run',generation:1,document_fingerprint:'new'};
const raw={process_id:42,document:{title:'Project1',path:'',sessionId:'new-session',projectIdentity:{fingerprint:'new'}}};
function setup() {
  const call={type:'function_call',name:'native__continue_in_new_revit_model',call_id:'call',arguments:'{}'};
  const result={schema:'operator.new-document-handoff.v1',parent_binding:parent,message:'Continue in Project1',
    goal:{id:'child',title:'New project',objective:'Create a new project',work_budget:{revit_process_id:42,document_session_id:'new-session'}},
    publication:{snapshot:{current_binding:child,spec:{document_parent_binding:parent}}}};
  const sent=[];
  return {result,sent,options:{assignment:{...parent,goal_id:parent.assignment_id},response:{id:'response',desktop_message_id:'message',output:[call]},call,
    readContext:async()=>({ok:true,data:raw}),request:async(route,options)=>{sent.push({route,body:JSON.parse(options.body)});return result;},
    validatePublication:(p,b)=>{assert.equal(b,child);return p;}}};
}
test('handoff obtains identity from the host, preserves chat and validates the returned new document',async()=>{
  const f=setup(),phase=await continueNewDocument(f.options);
  assert.equal(phase.assignment.session_id,'chat');assert.equal(phase.assignment.goal_id,'child');
  assert.deepEqual(f.sent,[{route:'/api/assignments/v2/document-handoff',body:{...parent,message_id:'message',response_id:'response',call_id:'call',native_context:raw}}]);
});
test('model-supplied identity, batched edits and unavailable native context never request a handoff',async()=>{
  for(const change of [f=>{f.options.call.arguments='{"document":"other"}';},f=>{f.options.response.output.push({...f.options.call,call_id:'edit'});},
    f=>{f.options.readContext=async()=>({ok:false});}]) {
    const f=setup();change(f);await assert.rejects(continueNewDocument(f.options));assert.equal(f.sent.length,0);
  }
});
test('wrong session, parent, process, document and rejected publication cannot activate a child',async()=>{
  for(const change of [f=>{f.result.parent_binding={...parent,run_id:'other'};},
    f=>{f.result.publication.snapshot.current_binding={...child,session_id:'other'};},
    f=>{f.result.goal.work_budget.revit_process_id=43;},f=>{f.result.goal.work_budget.document_session_id='other';},
    f=>{f.result.publication.snapshot.spec.document_parent_binding={...parent,assignment_id:'other'};},
    f=>{f.options.validatePublication=()=>{throw Error('invalid publication');};}]) {
    const f=setup();change(f);await assert.rejects(continueNewDocument(f.options));
  }
});
test('changing the active model for the next request keeps chat history but clears old provider continuation',()=>{
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const start=server.indexOf('function bindHybridContextToBackendSession('),fn=server.slice(start,server.indexOf('\n}\n',start)+2);
  const computerState={backendSessionId:'chat',hybridContextSignature:'old',lastResponseId:'old-response',restoreProviderContext:true,sidecarAssignment:{goal_id:'parent'}};
  const bind=runInNewContext(fn+';bindHybridContextToBackendSession',{computerState,computeHybridBackendContextSignature:()=> 'new',addComputerEvent:()=>{},summarizeHybridBackendContext:()=> 'Project1'});
  assert.throws(()=>bind({}),/document or executor changed/);
  assert.equal(computerState.hybridContextSignature,'old');
  bind({},{beforeAssignmentAdmission:true});
  assert.equal(computerState.backendSessionId,'chat');assert.equal(computerState.lastResponseId,null);assert.equal(computerState.restoreProviderContext,false);
});
