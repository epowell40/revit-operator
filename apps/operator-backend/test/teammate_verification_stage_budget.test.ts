import test from 'node:test';
import assert from 'node:assert/strict';
import {OPERATOR_BACKEND_CONTRACT_VERSION,type ChatRequest} from '../src/contracts.js';
import {__testOnlyResetTeammateLoopState,beginTeammateLoopOwner,endTeammateLoopOwner,guardTeammateMcpCall,recordTeammateMcpResult,teammateLoopReceiptForOwner} from '../src/teammate_loop_runtime.js';

function setup(){
  __testOnlyResetTeammateLoopState();
  const owner={};
  const request:ChatRequest={version:OPERATOR_BACKEND_CONTRACT_VERSION,session_id:'stage-budget',message_id:'stage-budget',user_text:'Set equipment 42 Manufacturer to ACME, then set equipment 43 Manufacturer to ACME. Apply and independently verify each edit.',context:{revit:{schema:'revit-operator.context.v1',source:{live:true},process_id:42,courier_executor_id:'fixture',document:{title:'Fixture',path:'C:\\models\\fixture.rvt',projectIdentity:{fingerprint:'fixture'}}}}};
  const lease=beginTeammateLoopOwner(owner,request);
  const call=(path:string,body:unknown)=>guardTeammateMcpCall(owner,{tool:'revit_call_tool',arguments:{method:'POST',path,body}});
  const record=(gate:ReturnType<typeof call>,payload:unknown)=>{assert.equal(gate.allowed,true,gate.message);recordTeammateMcpResult(owner,gate,{content:[{type:'text',text:JSON.stringify(payload)}]});};
  const apply=(id:number)=>{const gate=call('/revit/set-parameters',{elementIds:[id],parameters:{Manufacturer:'ACME'},dryRun:false,apply:true});record(gate,{ok:true,elementIds:[id]});return gate;};
  const read=(id:number)=>{const gate=call('/revit/get-parameters',{elementIds:[id],parameterNames:['Manufacturer']});record(gate,{ok:true,items:[{id,parameters:{Manufacturer:'ACME'}}]});return gate;};
  return {owner,lease,call,apply,read};
}

test('a new verified edit stage can take its first read after six earlier verification reads',()=>{
  const t=setup();try{
    t.apply(42);
    for(let i=0;i<5;i++){t.read(100+i);assert.equal(teammateLoopReceiptForOwner(t.owner)?.verified,false);}
    t.read(42);assert.equal(teammateLoopReceiptForOwner(t.owner)?.verified,true);
    const prior=teammateLoopReceiptForOwner(t.owner)!.verification_action_ids;
    t.apply(43);t.read(43);
    const receipt=teammateLoopReceiptForOwner(t.owner)!;
    assert.equal(receipt.verified,true);assert.equal(receipt.apply_attempts,2);
    assert.equal(receipt.verification_action_ids.length,7);
    assert.deepEqual(receipt.verification_action_ids.slice(0,6),prior);
    assert.equal(new Set(receipt.verification_action_ids).size,7);
    assert.equal(t.call('/revit/set-parameters',{elementIds:[42],parameters:{Manufacturer:'ACME'},dryRun:false,apply:true}).allowed,false,'Completed edits cannot be replayed to refresh the budget');
  }finally{endTeammateLoopOwner(t.lease);}
});

test('a subsequent unverified stage still stops at six reads and cannot chain another edit',()=>{
  const t=setup();try{
    t.apply(42);t.read(42);assert.equal(teammateLoopReceiptForOwner(t.owner)?.verified,true);
    t.apply(43);
    for(let i=0;i<6;i++){t.read(200+i);assert.equal(teammateLoopReceiptForOwner(t.owner)?.verified,false);}
    const refused=t.call('/revit/get-parameters',{elementIds:[43],parameterNames:['Manufacturer']});
    assert.equal(refused.allowed,false);assert.match(refused.message??'',/verification attempt budget exhausted/i);
    assert.equal(t.call('/revit/set-parameters',{elementIds:[44],parameters:{Manufacturer:'ACME'},dryRun:false,apply:true}).allowed,false);
    assert.equal(teammateLoopReceiptForOwner(t.owner)?.verification_action_ids.length,7,'Cumulative evidence history is retained');
  }finally{endTeammateLoopOwner(t.lease);}
});
