import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {routeConversation,retainedIntakeDecision} from '../src/conversation_intake.js';
import {ModelConversationIntake} from '../src/brains/conversation_intake_model.js';
import {__closeForTests,latestMessageEvent} from '../src/memory/sqlite_store.js';
const req={version:'operator.backend.v1' as const,session_id:'startup',message_id:'startup',user_text:'Count the mechanical sheets.'};
const decision={route:'inspect',answer:null,basis:'needs_tools',requested_effect:'read',entire_request_answered:false,confidence:.99,reason:'A native count is required.',question_kind:'current_model',identity_fields:[],read_evidence:'complete_collection'};
async function fixture(run:(root:string)=>Promise<void>){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-intake-boundary-'));
 const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_BRAIN','OPERATOR_INTAKE_MODEL','OPERATOR_OPENAI_RESPONSE_STORAGE'],before=keys.map(k=>process.env[k]);
 process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_BRAIN='codex';process.env.OPERATOR_INTAKE_MODEL='gpt-6.1-sol';delete process.env.OPERATOR_OPENAI_RESPONSE_STORAGE;__closeForTests();
 try{await run(root);}finally{__closeForTests();keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});fs.rmSync(root,{recursive:true,force:true});}
}
function client(wait?:()=>void,stop?:()=>Promise<void>){let notify:(e:any)=>void=()=>{};return{
 setServerRequestHandler(){},async ensureStarted(){},async startThread(o:any){return{model:o.model,thread:{id:'thread'}}},onNotification(fn:any){notify=fn;return()=>{}},
 async startBoundTurn(){return{turn:{id:'turn'}}},async waitForTurnCompleted(){wait?.();notify({threadId:'thread',method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify(decision)}}});return{status:'completed'}},
 getTurnInstructionBinding(){return{}},acknowledgePersistedTurnInstructionBinding(){},stopAndWait:stop??(async()=>{})};}
test('media45 retained 28419ms setup leaves a full bounded inference window through actual producer and router',t=>fixture(async root=>{
 let now=0;t.mock.method(Date,'now',()=>now);
 const model=new ModelConversationIntake({prepareIsolation:()=>{now=28419;return{cwd:root,codexHome:root,release:()=>{}};},createClient:()=>client(()=>{now=38419;}) as any});
 try{const result=await routeConversation(req,model);assert.equal(result.routing_status,'accepted');assert.equal(retainedIntakeDecision(req)?.route,'inspect');
 const timing=(latestMessageEvent(req.session_id,'conversation.intake',req.message_id) as any).host_timing;
 assert.equal(timing.budget.startup_ms,30000);assert.equal(timing.budget.inference_ms,30000);assert.equal(timing.budget.inference_started_elapsed_ms,28419);
 }finally{await model.close();t.mock.restoreAll();}
}));
test('confirmed provider exit plus EBUSY reclamation does not poison the next isolated intake',()=>fixture(async root=>{
 let creates=0,releases=0,stops=0;
 const model=new ModelConversationIntake({prepareIsolation:()=>{const n=++creates;return{cwd:path.join(root,String(n)),codexHome:root,release:()=>{releases++;if(n===1)throw Object.assign(Error('locked temporary home'),{code:'EBUSY'});}};},createClient:()=>client(undefined,async()=>{stops++;}) as any});
 try{await model.interpret({user_text:req.user_text} as any,new AbortController().signal);await model.close();
 await model.interpret({user_text:req.user_text} as any,new AbortController().signal);await model.close();assert.equal(creates,2);assert.equal(stops,2);assert.equal(releases,2);
 const audit=fs.readFileSync(path.join(root,'logs/operator-backend-audit.jsonl'),'utf8');assert.match(audit,/conversation.intake.cleanup_deferred/);assert.match(audit,/EBUSY/);
 }finally{await model.close().catch(()=>{});}
}));
test('unconfirmed provider exit still prevents isolation deletion and new admission',()=>fixture(async root=>{
 let creates=0,releases=0;const model=new ModelConversationIntake({prepareIsolation:()=>{creates++;return{cwd:root,codexHome:root,release:()=>{releases++;}};},createClient:()=>client(undefined,async()=>{throw Error('exit unconfirmed');}) as any});
 await model.interpret({user_text:req.user_text} as any,new AbortController().signal);
 await assert.rejects(model.close(),/exit unconfirmed/);await assert.rejects(model.interpret({user_text:req.user_text} as any,new AbortController().signal),/exit unconfirmed/);assert.equal(creates,1);assert.equal(releases,0);await model.close().catch(()=>{});
}));
test('startup and inference each expire independently without late acceptance or a second provider attempt',t=>fixture(async root=>{
 let now=0;t.mock.method(Date,'now',()=>now);
 try{for(const slow of ['startup','inference']){
  now=0;let turns=0;const c=client(()=>{now=60001;});const old=c.startBoundTurn;c.startBoundTurn=async()=>{turns++;return old();};
  const model=new ModelConversationIntake({prepareIsolation:()=>{now=slow==='startup'?30001:28419;return{cwd:root,codexHome:root,release:()=>{}};},createClient:()=>c as any});
  try{const r=await routeConversation({...req,message_id:slow},model);assert.equal(r.routing_status,'unavailable');assert.equal(turns,slow==='startup'?0:1);assert.equal(retainedIntakeDecision({...req,message_id:slow}),null);}
  finally{await model.close();}
 }}finally{t.mock.restoreAll();}
}));
test('host inference notification cannot renew correction or override explicit total timeout',t=>fixture(async()=>{
 let now=0;t.mock.method(Date,'now',()=>now);let calls=0;
 const interpreter={startupTimeoutMs:30000,async interpret(_i:any,_s:any,_c:any,_p:any,begin?:()=>void){calls++;now=calls===1?28000:57000;begin?.();if(calls===1){now=50000;return{value:{...decision,confidence:.4}};}now=58001;return{value:decision};}};
 try{assert.equal((await routeConversation(req,interpreter)).routing_status,'unavailable');assert.equal(calls,2);
  now=0;calls=0;assert.equal((await routeConversation({...req,message_id:'explicit'},interpreter,{timeoutMs:30000})).routing_status,'unavailable');assert.equal(calls,1);
 }finally{t.mock.restoreAll();}
}));
test('Pause before inference prevents provider dispatch even with unused startup allowance',()=>fixture(async root=>{
 const controller=new AbortController();let turns=0;const c=client();c.startBoundTurn=async()=>{turns++;return{turn:{id:'turn'}};};
 const model=new ModelConversationIntake({prepareIsolation:()=>{controller.abort(Error('User Pause'));return{cwd:root,codexHome:root,release:()=>{}};},createClient:()=>c as any});
 try{await assert.rejects(routeConversation(req,model,{signal:controller.signal}),/User Pause/);assert.equal(turns,0);assert.equal(retainedIntakeDecision(req),null);}
 finally{await model.close();}
}));
test('ownership violations and failed cleanup-audit persistence remain blocking after confirmed exit',()=>fixture(async root=>{
 for(const failure of ['ownership','audit']){
  let made=0;const model=new ModelConversationIntake({prepareIsolation:()=>{made++;return{cwd:root,codexHome:root,release:()=>{throw failure==='ownership'?Error('codex_isolation_release_owner_changed'):Object.assign(Error('busy'),{code:'EBUSY'});}};},createClient:()=>client() as any});
  await model.interpret({user_text:req.user_text} as any,new AbortController().signal);
  const log=path.join(root,'logs/operator-backend-audit.jsonl');if(failure==='audit')fs.mkdirSync(log);
  await assert.rejects(model.close());await assert.rejects(model.interpret({user_text:req.user_text} as any,new AbortController().signal));assert.equal(made,1);
  await model.close().catch(()=>{});if(failure==='audit')fs.rmdirSync(log);
 }
}));
