import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';

async function until<T>(read:()=>Promise<T>,accept:(v:T)=>boolean):Promise<T>{
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,15));}
  throw Error('HTTP provider-turn fixture timed out');
}
const listen=(server:http.Server)=>new Promise<number>(r=>server.listen(0,'127.0.0.1',()=>r((server.address() as {port:number}).port)));

for(const exhausted of [false,true])test(`HTTP disconnect retains predecessor accounting and cancels queued steering (${exhausted?'budget exhausted':'live successor'})`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-outer-http-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
  const goal=createGoal({title:'Read model facts',objective:'Report current model facts.',acceptance_criteria:['Report facts.'],status:'active',related_session_id:'outer-http',created_by:'local:shared-token',work_budget:{requested_effect:'read'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'outer-http-run'});
  let calls=0,release!:()=>void;
  const received:any[]=[],pending:Promise<unknown>[]=[],controllers:AbortController[]=[];
  const provider=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(Buffer.from(c)));req.on('end',()=>{
    const n=++calls;received.push(JSON.parse(Buffer.concat(chunks).toString()));
    const finish=()=>{if(res.writableEnded)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'http-'+n,model:'gpt-6.1-sol',
      output:[{type:'message',content:[{type:'output_text',text:n===1?'OLD BRANCH MUST NOT EXECUTE':'Latest steering response'}]}],usage:{input_tokens:exhausted?4_000_000:10,output_tokens:1,total_tokens:exhausted?4_000_001:11}}));};
    if(n===1)release=finish;else finish();
  });});
  const providerPort=await listen(provider),probe=http.createServer(),port=await listen(probe);await new Promise<void>(r=>probe.close(()=>r()));
  const token='synthetic-outer-http-token',base='http://127.0.0.1:'+port,headers={'content-type':'application/json','x-operator-token':token};
  const child=spawn(process.execPath,['dist/src/index.js'],{env:{...process.env,OPERATOR_BACKEND_PORT:String(port),OPERATOR_AUTH_MODE:'shared_token',OPERATOR_TOKEN:token,
    OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'rule',OPERATOR_HOSTED_ENABLED:'0',OPERATOR_MEMORY_AUTO_TURN_NOTES:'0',
    OPERATOR_OPENAI_API_KEY:'synthetic-key',OPERATOR_OPENAI_BASE_URL:'http://127.0.0.1:'+providerPort},stdio:'ignore'});
  t.after(async()=>{
    controllers.forEach(c=>c.abort());release?.();await Promise.allSettled(pending);
    if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}
    await new Promise<void>(r=>provider.close(()=>r()));
    if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    __testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  });
  await until(async()=>{try{return(await fetch(base+'/health',{headers})).ok;}catch{return false;}},v=>v);
  const envelope={session_id:binding.session_id,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation};
  const result=async(message_id:string,telemetry_only=false)=>{
    const response=await fetch(base+'/desktop/computer/result',{method:'POST',headers,body:JSON.stringify({...envelope,message_id,telemetry_only})});
    assert.equal(response.status,200);return await response.json() as any;
  };
  const send=(message_id:string,input:string)=>{
    const abort=new AbortController();controllers.push(abort);
    const promise=fetch(base+'/desktop/computer/respond',{method:'POST',headers,signal:abort.signal,body:JSON.stringify({...envelope,message_id,model:'gpt-6.1-sol',input})});
    pending.push(promise);void promise.catch(()=>{});return {abort,promise};
  };
  const first=send('original','Original investigation');
  await until(async()=>calls,v=>v===1);first.abort.abort();await assert.rejects(first.promise,/abort/i);
  const middle=send('cancelled','Obsolete steering');
  await until(()=>result('cancelled'),v=>v.status==='pending');
  middle.abort.abort();await assert.rejects(middle.promise,/abort/i);
  const cancelled=await until(()=>result('cancelled'),v=>v.status==='error');
  assert.match(cancelled.failure.error,/cancelled/);assert.equal(calls,1);
  const latest=send('latest','Wrap up now with retained evidence');
  await until(()=>result('latest'),v=>v.status==='pending');assert.equal(calls,1);
  assert.equal((await result('original',true)).status,'pending','Disconnected dispatched provider is still genuinely live');
  release();
  const response=await latest.promise;const payload:any=await response.json();
  if(exhausted){
    assert.equal(response.status,500);assert.deepEqual(payload.admission,{decision:'blocked',reason:'token_budget_exhausted'});
    assert.equal(calls,1,'Predecessor usage stops exhausted successor before dispatch');
  }else{
    assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.response.id,'http-2');
    assert.equal(calls,2,'No old branch or cancelled queued provider is replayed');
  }
  const accounting=await until(()=>result('original',true),v=>v.status==='complete');
  assert.equal(accounting.response,undefined);assert.equal(accounting.telemetry.output,undefined);
  assert.equal(accounting.telemetry.model_call_receipt.tokens.total_tokens,exhausted?4_000_001:11);
  assert.deepEqual(accounting.telemetry.provider_response_usage.raw_response_ids,['http-1']);
  const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
  if(!exhausted){const feedback=JSON.parse(received[1].input.at(-1).content[0].text.split('\n').at(-1));assert.equal(feedback.assignment_version,snapshot.assignment_version-4);}
  assert.equal(snapshot.terminal,exhausted,'Only a drained, host-derived budget stop terminalizes this task');
  assert.equal(snapshot.outcome,exhausted?'blocked':'active');
  if(exhausted)assert.equal(snapshot.terminal_reason,'token_budget_exhausted','HTTP steering preserves the canonical admission reason');
  assert.equal(snapshot.in_flight_provider_call_ids.length,0);
  assert.deepEqual(Object.values(snapshot.provider_calls).map(c=>c.usage?.total_tokens),exhausted?[4_000_001]:[11,11]);
  assert.equal((await result('cancelled')).status,'error');
  const duplicate=await fetch(base+'/desktop/computer/respond',{method:'POST',headers,body:JSON.stringify({...envelope,message_id:'original',model:'gpt-6.1-sol',input:'Original investigation'})});
  assert.notEqual(duplicate.status,200);assert.equal(calls,exhausted?1:2);
  __testOnlyResetGoalListCache();
  const durable=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(durable.terminal,exhausted);assert.equal(durable.outcome,snapshot.outcome);
  assert.equal(durable.terminal_reason,snapshot.terminal_reason,'Duplicate HTTP delivery cannot replace the retained stop');
  assert.equal(durable.in_flight_provider_call_ids.length,0);
  assert.equal((await fetch(base+'/desktop/computer/result',{method:'POST',body:JSON.stringify({...envelope,message_id:'original'})})).status,401);
});
