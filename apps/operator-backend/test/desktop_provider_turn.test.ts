import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import test from 'node:test';
import {relayBoundDesktopComputerResponse,desktopComputerErrorResponse} from '../src/desktop_computer.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';

test('steered outer request waits for the original relay and its canonical usage before dispatch',async()=>{
  const prior=Object.fromEntries(['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'].map(k=>[k,process.env[k]]));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-turn-'));
  let started!:()=>void,release!:()=>void,requests=0;
  const entered=new Promise<void>(r=>started=r);
  const received:any[]=[];
  const server=http.createServer((req,res)=>{
    const chunks:Buffer[]=[];req.on('data',c=>chunks.push(Buffer.from(c)));req.on('end',()=>{
      requests++;received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const n=requests;
      const finish=()=>{if(res.writableEnded)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'outer-'+n,status:'completed',model:'gpt-6.1-sol',output:[],usage:{input_tokens:100,output_tokens:2,total_tokens:102}}));};
      if(n===1){release=finish;started();}else finish();
    });
  });
  const pending:Promise<unknown>[]=[];
  try{
    process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-key';
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;
    __testOnlyResetGoalListCache();
    const goal=createGoal({title:'Review sources',objective:'Read current model facts and report limitations.',acceptance_criteria:['Report verified facts.'],status:'active',related_session_id:'outer-turn',created_by:'test-principal',work_budget:{requested_effect:'read'}});
    const binding={...createAssignmentKernelForGoalV2({goal,run_id:'outer-run'}),kernelVersion:2 as const};
    const first=relayBoundDesktopComputerResponse({model:'gpt-6.1-sol',input:'Original investigation',message_id:'first'},binding);pending.push(first);
    await entered;
    let successorError:unknown;
    const second=relayBoundDesktopComputerResponse({model:'gpt-6.1-sol',input:'Wrap up now; preserve all evidence.',message_id:'steering'},binding);
    pending.push(second);void second.catch(e=>{successorError=e;});
    await new Promise(r=>setTimeout(r,25));
    assert.equal(successorError,undefined,'283: a live predecessor must not turn ordinary steering into await_provider runtime failure');
    assert.equal(requests,1,'No successor network dispatch while the original is live');
    release();await Promise.all([first,second]);
    assert.equal(requests,2);
    const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
    assert.equal(snapshot.in_flight_provider_call_ids.length,0);assert.equal(snapshot.outcome,'active');
    assert.deepEqual(Object.values(snapshot.provider_calls).map(c=>c.usage?.total_tokens),[102,102]);
    assert.match(JSON.stringify(received[1].input),/Wrap up now/);
    const feedback=JSON.parse(received[1].input.at(-1).content[0].text.split('\n').at(-1));
    assert.equal(feedback.assignment_version,snapshot.assignment_version-4,
      'Feedback contains predecessor settlement, before the four successor provider events');
  }finally{
    release?.();await Promise.allSettled(pending);
    await new Promise<void>(r=>server.close(()=>r()));
    for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    __testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
});

for(const mode of ['cancel','pause','stale','budget','independent'] as const){
  test(`outer relay rechecks ${mode} after waiting without replaying predecessor`,async()=>{
    const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'];
    const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-turn-neighbor-'));
    let entered!:()=>void,release!:()=>void,calls=0;
    const started=new Promise<void>(r=>entered=r),pending:Promise<unknown>[]=[];
    const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
      const n=++calls;const finish=()=>{if(res.writableEnded)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'n-'+n,model:'gpt-6.1-sol',output:[],
        usage:{input_tokens:mode==='budget'?4_000_000:10,output_tokens:1,total_tokens:mode==='budget'?4_000_001:11}}));};
      if(n===1){release=finish;entered();}else finish();
    });});
    try{
      Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,OPERATOR_OPENAI_API_KEY:'synthetic-key'});
      await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;
      __testOnlyResetGoalListCache();
      const create=(session:string)=>{const goal=createGoal({title:'Read facts',objective:'Inspect current facts.',acceptance_criteria:['Report facts.'],status:'active',related_session_id:session,created_by:'test-principal',work_budget:{requested_effect:'read'}});
        return {...createAssignmentKernelForGoalV2({goal,run_id:session+'-run'}),kernelVersion:2 as const};};
      const binding=create('first'),abort=new AbortController(),body={model:'gpt-6.1-sol',input:'Inspect current facts.'};
      const first=relayBoundDesktopComputerResponse({...body,message_id:'first'},binding);pending.push(first);await started;
      const secondBinding=mode==='independent'?create('independent'):mode==='stale'?{...binding,generation:99}:binding;
      const second=relayBoundDesktopComputerResponse({...body,message_id:'steering'},secondBinding,{signal:abort.signal});pending.push(second);
      // Attach rejection observation before any asynchronous turn can reject.
      const observed=second.then(value=>({value,error:null as unknown}),error=>({value:null,error}));
      if(mode==='cancel'){
        abort.abort();assert.match(String((await observed).error),/cancelled/);
        const third=relayBoundDesktopComputerResponse({...body,message_id:'latest-steering'},binding);pending.push(third);
        await new Promise(r=>setTimeout(r,20));assert.equal(calls,1,'Cancelled middle waiter cannot release its predecessor');
        release();await Promise.all([first,third]);assert.equal(calls,2);
      }else if(mode==='independent'){
        assert.equal((await observed).error,null);assert.equal(calls,2,'Different assignment does not wait for unrelated upstream');
        release();await first;
      }else{
        if(mode==='pause')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
        release();await first;
        const error=(await observed).error;
        assert.match(String(error),mode==='stale'?/binding_stale/:/admission_denied/);
        if(mode==='budget')assert.deepEqual(desktopComputerErrorResponse(error).admission,{decision:'blocked',reason:'token_budget_exhausted'},
          '282 controller reason must survive the outer boundary; no blanket retry or budget increase');
        assert.equal(calls,1,'No queued network call after stale binding, pause or exhausted budget');
      }
      assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.in_flight_provider_call_ids.length,0);
    }finally{
      release?.();await Promise.allSettled(pending);await new Promise<void>(r=>server.close(()=>r()));
      for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
      __testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
    }
  });
}
