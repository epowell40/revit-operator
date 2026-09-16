import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeEvidence, retrieveEvidence } from "../src/evidence/evidence_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, recordTeammateMcpResult, __testOnlyResetTeammateLoopState } from "../src/teammate_loop_runtime.js";
import { newTeammateLoopAttemptBudget, registerTeammateLoopAttempt, gateTeammateLoopAttempt, recordTeammateEvidenceResult } from "../src/teammate_loop_attempt_budget.js";

test("distinct successful retained-evidence pages can continue beyond eight reads without granting model-edit verification",()=>{
 const previous=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-evidence-pages-"));
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetTeammateLoopState();
 const owner={},scope={session_id:"paging",assignment_id:"assignment",run_id:"run",attempt_id:"read",generation:1};
 const lease=beginTeammateLoopOwner(owner,{version:"operator.backend.v1",session_id:"paging",message_id:"pages",user_text:"Inspect the retained inventory evidence without reconnecting to Revit.",context:{}});
 try{
  const stored=storeEvidence({scope,source:"native-inventory",trust_level:"authoritative_native",raw:{items:Array.from({length:12},(_,id)=>({id}))}});
  for(let start=0;start<12;start++){
   const args={evidenceId:stored.ref.evidence_id,sessionId:scope.session_id,assignmentId:scope.assignment_id,runId:scope.run_id,generation:1,purpose:"Review the next inventory row",itemRange:{path:"items",start,count:1},maxBytes:1024};
   const gate=guardTeammateMcpCall(owner,{tool:"operator_retrieve_evidence",arguments:args});
   assert.equal(gate.allowed,true,`distinct successful page ${start}`);
   const result=retrieveEvidence({scope,evidence_id:stored.ref.evidence_id,purpose:args.purpose,item_range:args.itemRange,max_bytes:1024});
   assert.deepEqual(result.selection,[{id:start}]);
   recordTeammateMcpResult(owner,gate,{content:[{type:"text",text:JSON.stringify({ok:true,result})}]});
   assert.equal(guardTeammateMcpCall(owner,{tool:"operator_retrieve_evidence",arguments:args}).allowed,false,"same page cannot be replayed");
  }
 }finally{endTeammateLoopOwner(lease);__closeForTests();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test("evidence paging and native calls share the total attempt ceiling",()=>{
 const budget=newTeammateLoopAttemptBudget();
 for(let n=0;n<64;n++){
  const effect=n%2===0?"evidence_read":"read";
  assert.equal(gateTeammateLoopAttempt(budget,effect,String(n)),null);
  registerTeammateLoopAttempt(budget,effect,String(n));
 }
 assert.equal(gateTeammateLoopAttempt(budget,"evidence_read","next"),"total_revit_call_attempt_budget_exhausted");
 assert.equal(gateTeammateLoopAttempt(budget,"read","next"),"total_revit_call_attempt_budget_exhausted");
 assert.equal(gateTeammateLoopAttempt(budget,"interaction","clarify"),null);
});

test("host-settled failed reads stop at eight and duplicate result delivery cannot spend the failure budget twice",()=>{
 const previous=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-evidence-failed-pages-"));
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetTeammateLoopState();
 const owner={},lease=beginTeammateLoopOwner(owner,{version:"operator.backend.v1",session_id:"failed-paging",message_id:"pages",user_text:"Inspect the retained evidence.",context:{}});
 try{
  for(let start=0;start<8;start++){
   const gate=guardTeammateMcpCall(owner,{tool:"operator_retrieve_evidence",arguments:{evidenceId:`ev1_${"a".repeat(32)}`,sessionId:"failed-paging",purpose:"Read next row",itemRange:{path:"items",start,count:1}}});
   assert.equal(gate.allowed,true,`attempt ${start}`);
   const result={isError:true,content:[{type:"text",text:"Evidence not available in this scope."}]};
   recordTeammateMcpResult(owner,gate,result);
   recordTeammateMcpResult(owner,gate,result);
  }
  const blocked=guardTeammateMcpCall(owner,{tool:"operator_retrieve_evidence",arguments:{evidenceId:`ev1_${"a".repeat(32)}`,sessionId:"failed-paging",purpose:"Read next row",itemRange:{path:"items",start:8,count:1}}});
  assert.equal(blocked.allowed,false);
  assert.match(JSON.stringify(blocked),/evidence_retrieval_attempt_budget_exhausted/);
 }finally{endTeammateLoopOwner(lease);__closeForTests();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test("failed evidence remains cumulatively bounded even when interleaved with successful pages",()=>{
 const budget=newTeammateLoopAttemptBudget();
 for(let i=0;i<8;i++){
  assert.equal(gateTeammateLoopAttempt(budget,"evidence_read",`failed-${i}`),null);
  registerTeammateLoopAttempt(budget,"evidence_read",`failed-${i}`);recordTeammateEvidenceResult(budget,false);
  recordTeammateEvidenceResult(budget,true);
 }
 assert.equal(gateTeammateLoopAttempt(budget,"evidence_read","different-again"),"evidence_retrieval_attempt_budget_exhausted");
 assert.equal(gateTeammateLoopAttempt(budget,"read","native-read"),null);
 assert.equal(gateTeammateLoopAttempt(budget,"interaction","clarify"),null);
});
