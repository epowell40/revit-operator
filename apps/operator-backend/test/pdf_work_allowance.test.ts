import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPdfWorkAllowance, preparePdfWorkAllowance } from "../src/assignments/pdf_work_allowance.js";
import { selectLocalAdvisoryPolicy } from "../src/assignments/local_advisory_policy.js";
import { validLocalAdvisoryPolicyV1 } from "../src/domain/assignment-kernel/execution_policy.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { createGoal, getCurrentGoalForSession, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { startExternalAssignmentRun } from "../src/assignments/external_assignment_start.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { routeConversation } from "../src/conversation_intake.js";
import { prepareAssignmentTurnWithAttachments } from "../src/assignments/turn_preparation.js";

function markedPdf(counts:number[]):Buffer{
 const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",""];
 const pages:number[]=[];
 for(const count of counts){
  const page=objects.length+1;pages.push(page);objects.push("");const refs:number[]=[];
  for(let i=0;i<count;i++){refs.push(objects.length+1);objects.push(`<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (Comment ${i}) /F 4 >>`);}
  // Links and hidden comments must not buy work allowance.
  refs.push(objects.length+1);objects.push('<< /Type /Annot /Subtype /Link /Rect [10 10 20 20] /Contents (Navigation) >>');
  refs.push(objects.length+1);objects.push('<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (Hidden) /F 2 >>');
  objects[page-1]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Annots [${refs.map(n=>`${n} 0 R`).join(' ')}] >>`;
 }
 objects[1]=`<< /Type /Pages /Kids [${pages.map(n=>`${n} 0 R`).join(' ')}] /Count ${pages.length} >>`;
 let text='%PDF-1.4\n';const offsets=[0];
 objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${value}\nendobj\n`;});
 const start=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
 return Buffer.from(text+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

test("actual PDF comments allocate a base per marked sheet and per additional five comments",async()=>{
 const source=await inspectPdfWorkAllowance(markedPdf([0,1,5,6,11]));
 assert.deepEqual(source.sheets,[{page:2,comments:1,units:1},{page:3,comments:5,units:1},{page:4,comments:6,units:2},{page:5,comments:11,units:3}]);
 assert.equal(source.page_count,5);
});

test("creation uses authenticated exact uploads, ignores caller allowance hints, and keeps old policies fixed",async t=>{
 const prior={...process.env},root=fs.mkdtempSync(path.join(os.tmpdir(),'pdf-allowance-'));
 Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',
  OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_LOCAL_PDF_WORK_ALLOWANCE:'marked_pdf_sheets_v1',OPERATOR_LOCAL_PROGRESS_ALLOWANCE:'verified_native_changes_v1'});
 __closeForTests();__testOnlyResetGoalListCache();
 t.after(()=>{__closeForTests();__testOnlyResetGoalListCache();for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});});
 const context={operator_backend_auth:createOperatorBackendAuth('shared_token','fixture')};
 await runWithRequestContext(context,async()=>{
  const attachment=storeAttachmentUpload({session_id:'owner',filename:'marks.pdf',data_base64:markedPdf([1,6]).toString('base64')});
  const source='Pick up these redlines; let me know if you have questions.';
  const input={session_id:'owner',objective:source,start_assignment_run:true,work_budget:{source_user_request:source,requested_effect:'apply',attachment_ids:[attachment.id,attachment.id],source_work_allowance:{units:1000}}};
  const receipt=(await preparePdfWorkAllowance(input))!;assert.equal(receipt.units,3);assert.equal(receipt.sources.length,1);
  const binding={assignment_id:'assignment',run_id:'run',generation:1,session_id:'owner',principal_id:'local',document_fingerprint:'document'};
  const policy=selectLocalAdvisoryPolicy(binding,process.env,context,'apply',receipt)!;
  assert.equal(policy.max_provider_calls,192);assert.equal(policy.max_total_tokens,24_000_000);
  assert.equal(policy.max_operations,768);assert.equal(policy.max_wall_clock_ms,60*60_000);
  const spec:any={binding,requested_effect:'apply',execution_policy:policy};assert.equal(validLocalAdvisoryPolicyV1(spec),true);
  const goal=createGoal({title:'Marked sheets',objective:source,acceptance_criteria:['Requested edits'],status:'active',related_session_id:'owner',created_by:'fixture',
    work_budget:{source_user_request:source,requested_effect:'apply',document_fingerprint:'document',source_work_allowance:{units:1000}}});
  const run=startExternalAssignmentRun({goal,sessionId:'owner',actor:'fixture',source_work_allowance:receipt});
  const saved=getAssignmentKernelSnapshotV2(run.assignmentId)!;
  assert.equal(saved.spec.source_user_request,source,'short user request is retained without developer task answers');
  assert.deepEqual(saved.spec.execution_policy!.source_work_allowance,receipt);
  assert.equal(saved.spec.execution_policy!.max_total_tokens,24_000_000);
  __testOnlyResetGoalListCache();assert.deepEqual(getAssignmentKernelSnapshotV2(run.assignmentId)!.spec,saved.spec);
  const before=JSON.stringify(policy);process.env.OPERATOR_LOCAL_PDF_WORK_ALLOWANCE='';
  assert.equal(await preparePdfWorkAllowance(input),undefined);assert.equal(JSON.stringify(policy),before);
  process.env.OPERATOR_LOCAL_PDF_WORK_ALLOWANCE='marked_pdf_sheets_v1';
  await assert.rejects(preparePdfWorkAllowance({...input,session_id:'foreign'}),/not_registered/);
  assert.equal(await preparePdfWorkAllowance({...input,work_budget:{...input.work_budget,requested_effect:'read'}}),undefined);
  fs.appendFileSync(path.join(root,attachment.relative_path),'changed');
  await assert.rejects(preparePdfWorkAllowance(input),/source_changed/);
  const forged=structuredClone(spec);forged.execution_policy.source_work_allowance.units=4;assert.equal(validLocalAdvisoryPolicyV1(forged),false);
  const repeatedPage=structuredClone(spec);repeatedPage.execution_policy.source_work_allowance.sources[0].sheets.push({...repeatedPage.execution_policy.source_work_allowance.sources[0].sheets[0]});
  repeatedPage.execution_policy.source_work_allowance.units+=1;assert.equal(validLocalAdvisoryPolicyV1(repeatedPage),false);
  const repeatedSource=structuredClone(spec);repeatedSource.execution_policy.source_work_allowance.sources.push(structuredClone(repeatedSource.execution_policy.source_work_allowance.sources[0]));
  repeatedSource.execution_policy.source_work_allowance.units*=2;assert.equal(validLocalAdvisoryPolicyV1(repeatedSource),false);
  const read=structuredClone(spec);read.requested_effect='read';assert.equal(validLocalAdvisoryPolicyV1(read),false);
  assert.equal(selectLocalAdvisoryPolicy(binding,process.env,context,'apply')!.source_work_allowance,undefined);
 });
});

test("ordinary chat derives marked-sheet allowance from a short request and registered attachment before creation",async t=>{
 const prior={...process.env},root=fs.mkdtempSync(path.join(os.tmpdir(),'chat-pdf-allowance-'));
 Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',
  OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_LOCAL_PDF_WORK_ALLOWANCE:'marked_pdf_sheets_v1',OPERATOR_LOCAL_PROGRESS_ALLOWANCE:'verified_native_changes_v1'});
 __closeForTests();__testOnlyResetGoalListCache();
 t.after(()=>{__closeForTests();__testOnlyResetGoalListCache();for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','chat-test')},async()=>{
  async function intake(sessionId:string,userText:string,effect:'apply'|'read'|'preview',attachments:any[]) {
   const messageId='original';
   const response=await routeConversation({version:'operator.backend.v1',session_id:sessionId,message_id:messageId,user_text:userText,user_attachments:attachments},
    {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:effect==='read'?'read':'change',
     entire_request_answered:false,confidence:0.99,reason:'Interpret the complete user request and inspect attached marks.',question_kind:effect==='read'?'current_model':'action',
     identity_fields:[],read_evidence:effect==='read'?'other':'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',
      requested_effect:effect,model_effect:effect,protected_clauses:[],prerequisites:[]}}})});
   assert.equal(response.routing_status,'accepted');
   return {sessionId,messageId,userText,toolResults:[],source:'chat',createdBy:null,userAttachments:attachments,
    requestContext:{revit:{document:{projectIdentity:{fingerprint:'test-model'}}}}};
  }
  for(const source of ['chat','stream']) {
   const sessionId=`ordinary-${source}`,userText='Pick up these redlines; let me know if you have questions.';
   const attachment=storeAttachmentUpload({session_id:sessionId,filename:'marks.pdf',data_base64:markedPdf([1,6]).toString('base64')});
   const input=await intake(sessionId,userText,'apply',[attachment]);
   const prepared=(await prepareAssignmentTurnWithAttachments({...input,source,sourceWorkAllowance:{units:1000}} as any))!;
   const snapshot=getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
   assert.equal(snapshot.spec.source_user_request,userText);
   assert.equal(snapshot.spec.execution_policy!.source_work_allowance!.units,3);
   assert.equal(snapshot.spec.execution_policy!.max_provider_calls,192);
   assert.equal(snapshot.spec.execution_policy!.max_total_tokens,24_000_000);
   assert.equal(snapshot.spec.execution_policy!.max_wall_clock_ms,60*60_000);
   assert.equal(snapshot.spec.execution_policy!.source_work_allowance!.sources[0]!.sha256,attachment.sha256);
   assert.deepEqual(snapshot.criteria,{},'workload counting is not completion proof');
   const before=JSON.stringify(snapshot.spec);
   fs.appendFileSync(path.join(root,attachment.relative_path),'changed');
   const resumed=await prepareAssignmentTurnWithAttachments({...input,userText:'Continue',messageId:'resume',suppliedBinding:{
    assignment_id:prepared.assignmentId,assignment_run_id:prepared.runId,assignment_generation:prepared.generation}});
   assert.equal(resumed!.assignmentId,prepared.assignmentId);
   assert.equal(JSON.stringify(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.spec),before,'later attachments never expand an existing immutable assignment');
  }
  for(const effect of ['read','preview'] as const) {
   const sessionId=`bounded-${effect}`,userText=effect==='read'?'Review the marked PDF; do not change the model.':'Preview these redlines; do not apply them.';
   const attachment=storeAttachmentUpload({session_id:sessionId,filename:'marks.pdf',data_base64:markedPdf([1,6]).toString('base64')});
   const prepared=(await prepareAssignmentTurnWithAttachments(await intake(sessionId,userText,effect,[attachment])))!;
   assert.equal(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.spec.execution_policy!.source_work_allowance,undefined);
  }
  const foreign=storeAttachmentUpload({session_id:'another-owner',filename:'marks.pdf',data_base64:markedPdf([6]).toString('base64')});
  const invalid=await intake('foreign-reader','Pick up these redlines.','apply',[foreign]);
  await assert.rejects(prepareAssignmentTurnWithAttachments(invalid),/not_registered/);
  assert.equal(getCurrentGoalForSession('foreign-reader'),null,'a bad upload must fail before creating work');
 });
});
