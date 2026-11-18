import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('the running conversation can show a checked copy while a model response is outstanding', {timeout:10000}, async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'operator-live-copy-'));
 const config=path.join(temp,'client.json');
 await writeFile(config,JSON.stringify({auth_mode:'shared_token'}));
 const env={OPERATOR_DESKTOP_NO_LISTEN:'1',OPERATOR_TOKEN:'synthetic-live-copy-token',
  OPERATOR_WORKSPACE_ROOT:temp,OPERATOR_CLIENT_CONFIG_PATH:config,OPERATOR_BACKEND_URL:'http://127.0.0.1:7007'};
 const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 Object.assign(process.env,env);
 t.after(async()=>{
  for(const [key,value] of Object.entries(prior)){
   if(value===undefined) delete process.env[key];
   else process.env[key]=value;
  }
  await rm(temp,{recursive:true,force:true});
 });
 const desktop=await import('../server.js');
 const session='live-checked-copy',assignment='live-review-assignment';
 const file='Reviewed copy.rvt';
 let pauseNext,releaseNext,providerCalls=0;
 const waitingForModel=new Promise(resolve=>{pauseNext=resolve;});
 const nextResponse=new Promise(resolve=>{releaseNext=resolve;});
 const context={revit:{schema:'revit-operator.context.v1',observed_at_utc:new Date().toISOString(),
  source:{live:true},process_id:123,version:'2024',courier_executor_id:'current',
  document:{title:'Sample',path:'C:/workspace/sample.rvt',projectIdentity:{fingerprint:'sample'},
   activeView:{id:45,name:'M001',type:'DrawingSheet'},selection:[]}}};
 desktop.configureOperatorDesktopTestHooks({computerRunTestHooks:{
  enableSidecarAssignment:true,ensureComputerBackendSession:async()=>session,buildHybridBackendContext:async()=>context,
  resolveSemanticAecTransport:async()=>null,readBackendComputerConfig:async()=>({available:true,model:'gpt-6.1-terra',reasoning_effort:'medium',desktop_native_tools:true}),
  captureScreenshot:async()=>'AAAA',tryFastConfirmedScheduleOpen:async()=>null,tryFastEnlargedPlanPlacementFromPrompt:async()=>null,
  tryFastSheetNameUpdate:async()=>null,tryFastSheetParameterUpdateFromPrompt:async()=>null,tryFastPanelParameterUpdateFromPrompt:async()=>null,
  retainAndProjectFunctionOutput:async(_call,output)=>({model_output:output.native_model_output,evidence_ref:null}),
  readBackendJson:async(route,opts)=>{
   const body=opts?.body?JSON.parse(opts.body):{};
   if(route==='/chat/intake')return {routing_status:'accepted',route:'task'};
   if(route==='/api/agent-goal')return {goal:{id:assignment,work_budget:{requested_effect:'apply'}},
    assignment_run:{kernel_version:2,assignment_id:assignment,run_id:body.assignment_run_id,generation:1}};
   if(route.endsWith('/catalog'))return {schema:'operator.desktop-native-tools.v1',guidance:'Inspect the saved copy.',
    tools:[{type:'function',name:'native__revit_inspect_exported_files',description:'Inspect',parameters:{type:'object'},strict:false}]};
   if(route.endsWith('/desktop-native/call')){
    assert.equal(opts.headers['x-operator-desktop-presentation'],'checked-copy-v1');
    const {assignment_id,session_id,run_id,generation}=body;
    return {schema:'operator.desktop-native-result.v1',result:{success:true,contentItems:[{type:'inputText',text:'Independent file check.'}]},
     checked_copy:{binding:{assignment_id,session_id,run_id,generation},message:{role:'assistant',
      message_id:'saved-checkpoint:'+assignment+':observation',text:'Saved file: '+file}}};
   }
   if(route==='/desktop/computer/result')return {ok:true};
   throw Error('Unexpected live-copy fixture route '+route);
  },
  requestComputerResponse:async body=>{
   providerCalls++;
   if(providerCalls===1)return {id:'first',desktop_message_id:'file-check',output_text:'',output:[
    {type:'function_call',name:'native__revit_inspect_exported_files',call_id:'inspect-file',arguments:'{}'}]};
   pauseNext(body);
   await nextResponse;
   throw Error('End synthetic fixture after the outstanding response was released.');
  }
 }});
 const server=desktop.app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{releaseNext();desktop.configureOperatorDesktopTestHooks();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/computer/run',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({prompt:'Adjust the existing schedule and save a separate file.',message_id:'live-copy-message'})});
 assert.equal(response.status,200,await response.text());
 const state=async suffix=>(await fetch(base+'/api/computer/state'+suffix)).json();
 const body=await Promise.race([waitingForModel,new Promise((_,reject)=>{
  const timeout=setTimeout(()=>reject(Error('The fixture did not reach the finishing request')),5000);timeout.unref();
 })]);
 assert.doesNotMatch(JSON.stringify(body),/Reviewed copy\.rvt|checked_copy/);
 const active=await state('?session_id='+session);
 assert.equal(active.running,true);assert.equal(active.checkedProjectCopy?.message.text,'Saved file: '+file);
 assert.equal(active.checkedProjectCopy?.binding.assignment_id,assignment);
 assert(active.messages.every(message=>!message.text.includes(file)));
 assert.equal((await state('')).checkedProjectCopy,null);
 assert.equal((await state('?session_id=another-session')).checkedProjectCopy,null);
 assert.equal(providerCalls,2);
 releaseNext();
 for(let index=0;index<100;index++) {
  const final=await state('?session_id='+session);
  if(!final.running){assert.equal(final.checkedProjectCopy,null);return;}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('The synthetic run did not settle.');
});
