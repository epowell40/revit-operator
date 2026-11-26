import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {continueNewDocument,inspectNewDocumentResume} from '../new_document_handoff.mjs';
import {savedComputerBinding,savedComputerConversation,browserComputerMessages,selectComputerConversationForInput} from '../saved_computer_assignment.mjs';

const parent={assignment_id:'parent',session_id:'chat',run_id:'parent-run',generation:1};
const child={assignment_id:'child',session_id:'chat',run_id:'child-run',generation:1,document_fingerprint:'new'};
const raw={process_id:42,document:{title:'Project1',path:'',sessionId:'new-session',projectIdentity:{fingerprint:'new'}}};
test('Resume inspects protected native context and requires the host to confirm its exact identity',async()=>{
 const result={schema:'operator.new-document-resume.v1',parent_binding:parent,target:{process_id:42,session_id:'new-session',fingerprint:'new'}};
 const options={binding:parent,readContext:async()=>({ok:true,data:raw}),request:async(route,args)=>{
  assert.equal(route,'/api/assignments/v2/document-resume-context');assert.deepEqual(JSON.parse(args.body),{...parent,native_context:raw});return result;
 }};
 assert.equal((await inspectNewDocumentResume(options)).fingerprint,'new');
 for(const patch of [{parent_binding:{...parent,generation:2}},{target:{...result.target,fingerprint:'other'}},
   {target:{...result.target,process_id:43}},{target:{...result.target,session_id:'other'}}])
  await assert.rejects(inspectNewDocumentResume({...options,request:async()=>({...result,...patch})}));
 await assert.rejects(inspectNewDocumentResume({...options,request:async()=>{throw Error('Paused');}}),/Paused/);
});
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

test('a resumed parent replaces its hidden saved context with the confirmed child context at handoff',()=>{
 const goal={objective:'Make a new project',work_budget:{}},snapshot={current_binding:parent,spec:{source_user_request:goal.objective},operations:{}};
 const computerState={messages:savedComputerConversation(goal,snapshot,{session_id:'chat',messages:[{role:'user',text:goal.objective}]})};
 const phase={assignment:{session_id:'chat',goal_id:'child',run_id:child.run_id,generation:1,kernel_version:2},goal,snapshot:{...snapshot,current_binding:child},message:'The new project already exists.'};
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const start=source.indexOf('computerState.sidecarAssignment=phase.assignment;'),end=source.indexOf('computerState.lastResponseId=null;',start);
 assert(start>0&&end>start);
 runInNewContext(source.slice(start,end),{computerState,phase,savedComputerConversation,browserComputerMessages});
 assert.equal(browserComputerMessages(computerState.messages).length,1);
 assert.equal(selectComputerConversationForInput(computerState.messages,12,child).length,2);
 assert.throws(()=>selectComputerConversationForInput(computerState.messages,12,parent),/binding changed/);
 const functionText=name=>{const a=source.indexOf(`function ${name}(`);assert(a>=0);return source.slice(a,source.indexOf('\n}\n',a)+2);};
 const build=runInNewContext(functionText('browserComputerAssignmentBinding')+'\n'+functionText('buildComputerInput')+';buildComputerInput',
  {computerState,MAX_CONVERSATION_MESSAGES:12,selectComputerConversationForInput,savedComputerBinding,
   toComputerInputMessage:(message,options)=>({message,options})});
 const input=build('screen');
 assert.equal(input.length,2);assert.match(input[0].message.text,/new project already exists/);
 assert.equal(input[1].message.text,goal.objective);assert.equal(input[1].options.includeCurrentScreen,true);
});
