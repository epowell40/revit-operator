import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {gunzipSync} from "node:zlib";
import test from "node:test";
import {READ_ATTACHMENT_TOOL,readRegisteredPdfAttachment} from "../src/attachments/read_attachment.js";
import {storeAttachmentUpload} from "../src/attachments/upload_store.js";
import {appendUploadIndexRecord} from "../src/attachments/upload_index.js";
import {McpInputValidator} from "../src/codex/mcp_input_validation.js";
import {CodexMcpToolRuntime} from "../src/codex/mcp_tool_runtime.js";
import {createOperatorBackendAuth} from "../src/operator_backend_auth.js";
import {attachmentPdf} from "./pdf_attachment.fixtures.js";

function workspace(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-vector-attachment-")),prior=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});});return root;
}
const upload=()=>storeAttachmentUpload({session_id:"owner",filename:"detail.pdf",data_base64:attachmentPdf(1).toString("base64")});
const result=async(args:unknown)=>{const response=await readRegisteredPdfAttachment("owner",args);assert.equal(response.content[0].type,"text");return JSON.parse((response.content[0] as {text:string}).text);};

test("registered vector summary preserves source context and immutable complete plan without giant coordinate output",async t=>{
 const root=workspace(t),attachment=upload(),args={attachment_id:attachment.id,mode:"vector",pages:[1]};
 new McpInputValidator().validate(READ_ATTACHMENT_TOOL.name,args,[READ_ATTACHMENT_TOOL]);
 const response=await readRegisteredPdfAttachment("owner",args);assert.equal(response.content.length,1);assert.equal(response.content[0].type,"text");
 const info=JSON.parse((response.content[0] as {text:string}).text);assert.equal(info.mode,"vector");assert.equal(info.source,"detail.pdf");assert.equal(info.page,1);assert.equal(info.sha256,attachment.sha256);
 assert.equal(info.native_write_allowed,false);assert.equal(info.visual_review_established,false);assert.equal(info.native_sheet_identity_established,false);assert.equal(info.source_read_truncated,false);
 assert.equal(info.counts.line_commands,1);assert.equal(info.counts.text_records,1);assert(!("paths" in info));assert(JSON.stringify(info).length<8000);
 const packed=fs.readFileSync(path.join(root,info.plan_artifact.relative_path));
 assert.equal(crypto.createHash("sha256").update(packed).digest("hex"),info.plan_artifact.sha256);
 const plan=JSON.parse(gunzipSync(packed).toString());assert.equal(plan.planSha256,info.plan_sha256);assert.equal(plan.text[0].text,"Fixture page 1");
 const again=await result(args);assert.deepEqual(again.plan_artifact,info.plan_artifact);
});
test("whole records require matching source plan and retain spatial context",async t=>{
 workspace(t);const attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]},info=await result(base);
 const request={...base,vector_section:"contours",vector_offset:0,vector_limit:1,expected_plan_sha256:info.plan_sha256,vector_filter_region:{min_u:0,min_v:0,max_u:1,max_v:1}};
 new McpInputValidator().validate(READ_ATTACHMENT_TOOL.name,request,[READ_ATTACHMENT_TOOL]);
 const page=await result(request);assert.equal(page.record_page.records.length,1);assert.equal(page.record_page.records[0].commands.length,2);assert.equal(page.record_page.page,1);
 assert.deepEqual(page.record_page.region,[0,0,200,200]);assert.equal(page.record_page.sourceLabel,"detail.pdf");
 await assert.rejects(result({...request,expected_plan_sha256:"0".repeat(64)}),/plan changed/);
 await assert.rejects(result({...request,expected_plan_sha256:undefined}),/summary first/);
 await assert.rejects(result({...request,region:{min_u:0,min_v:0,max_u:.5,max_v:.5}}),/plan changed/);
});
test("registered native plan is immutable, source-bound and compact while retaining full entities outside context",async t=>{
 const root=workspace(t),attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]},summary=await result(base);
 const request={...base,vector_section:"native_plan",expected_plan_sha256:summary.plan_sha256,native_layout:{paperWidthInches:4,viewScale:100,partSize:50}};
 new McpInputValidator().validate(READ_ATTACHMENT_TOOL.name,request,[READ_ATTACHMENT_TOOL]);
 const info=await result(request),ref=info.native_plan_artifact,packed=fs.readFileSync(path.join(root,ref.relative_path));
 assert.equal(crypto.createHash("sha256").update(packed).digest("hex"),ref.sha256);
 const raw=gunzipSync(packed),plan=JSON.parse(raw.toString());assert.equal(crypto.createHash("sha256").update(raw).digest("hex"),ref.unpacked_sha256);
 assert.equal(plan.nativePlanSha256,info.native_plan_sha256);assert.equal(plan.sourceSha256,attachment.sha256);assert.equal(plan.sourcePlanSha256,summary.plan_sha256);
 assert.equal(plan.entities.length,2);assert.equal(plan.entities[0].kind,"line");assert.equal(plan.entities[1].text,"Fixture page 1");
 assert.equal(info.native_import_available,false);assert.equal(info.native_import_status,"withheld_pending_live_native_commit_qualification");
 assert.equal(plan.nativeWriteAllowed,false);assert.equal(info.native_write_allowed,false);assert(!("entities" in info));assert(Buffer.byteLength(JSON.stringify(info))<8000);
 assert.deepEqual((await result(request)).native_plan_artifact,ref);
 await assert.rejects(result({...request,vector_limit:1}),/without record paging/);
 await assert.rejects(result({...base,native_layout:request.native_layout}),/only to native_plan/);
 fs.writeFileSync(path.join(root,ref.relative_path),"previous evidence");await assert.rejects(result(request),/no overwrite/);
 assert.equal(fs.readFileSync(path.join(root,ref.relative_path),"utf8"),"previous evidence");
});
test("explicit historical revision omissions retain source identities and cannot delete another record implicitly",async t=>{
 const root=workspace(t),attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]},info=await result(base);
 const plan=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,info.plan_artifact.relative_path))).toString());
 const omitted={recordId:plan.paths[0].contours[0].id,reason:"historical_revision",evidence:"Source detail shows this contour is an old project revision mark."};
 const selected=await result({...base,expected_plan_sha256:info.plan_sha256,vector_omissions:[omitted]});
 const selection=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,selected.selection_artifact.relative_path))).toString());
 assert.equal(selection.paths.length,0);assert.equal(selection.text.length,1);assert.deepEqual(selection.omissions,[omitted]);assert.equal(selection.nativeWriteAllowed,false);
 await assert.rejects(result({...base,expected_plan_sha256:info.plan_sha256,vector_omissions:[{...omitted,recordId:"forged"}]}),/omission/);
});
test("vector access keeps host conversation, upload namespace and immutable-byte authority",async t=>{
 const root=workspace(t),attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]};
 await assert.rejects(readRegisteredPdfAttachment("other",base),/not registered/);
 await assert.rejects(readRegisteredPdfAttachment("",base),/No current conversation/);
 await assert.rejects(result({...base,sourcePath:"other.pdf"}),/host-bound/);
 await assert.rejects(result({...base,session_id:"other"}),/host-bound/);
 appendUploadIndexRecord({...attachment,id:"forged",session_id:"owner",relative_path:"outside.pdf"});
 await assert.rejects(result({...base,attachment_id:"forged"}),/path is invalid/);
 fs.appendFileSync(path.join(root,attachment.relative_path!),"changed");await assert.rejects(result(base),/changed since upload/);
});
test("invalid vector paging, multi-page input and conflicting fields fail before partial return",async t=>{
 workspace(t);const attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]},validator=new McpInputValidator();
 for(const extra of [{pages:[1,2]},{pages:[0]},{vector_limit:101},{vector_offset:-1},{vector_section:"invented"},{expected_plan_sha256:"short"},{start_char:1}]){
  assert.throws(()=>validator.validate(READ_ATTACHMENT_TOOL.name,{...base,...extra},[READ_ATTACHMENT_TOOL]));
  await assert.rejects(result({...base,...extra}));
 }
 await assert.rejects(result({...base,vector_limit:1}),/Summary/);
 await assert.rejects(result({...base,region:{min_u:0,min_v:0,max_u:0,max_v:1}}),/nonempty/);
});
test("existing immutable plan collision is rejected without overwriting the artifact",async t=>{
 const root=workspace(t),attachment=upload(),base={attachment_id:attachment.id,mode:"vector",pages:[1]},info=await result(base),file=path.join(root,info.plan_artifact.relative_path);
 fs.writeFileSync(file,"existing unrelated bytes");await assert.rejects(result(base),/no overwrite/);assert.equal(fs.readFileSync(file,"utf8"),"existing unrelated bytes");
});
test("the actual native-worker attachment boundary binds vector reads to the live owner lease",async t=>{
 const root=workspace(t),attachment=upload(),args={attachment_id:attachment.id,mode:"vector",pages:[1]};
 const runtime=new CodexMcpToolRuntime({backendCwd:process.cwd(),workspaceRoot:root,codexHome:root,spawnEnv:{}});
 await assert.rejects(runtime.readAttachmentForTurn(args,{turnId:"vector-turn",sessionId:"owner"}),/not bound/);
 const lease=runtime.beginBackendAuthLease("owner",createOperatorBackendAuth("shared_token","test-only"));runtime.bindBackendAuthLeaseTurn(lease,"vector-turn");
 await assert.rejects(runtime.readAttachmentForTurn(args,{turnId:"vector-turn",sessionId:"other"}),/binding does not match/);
 const response=await runtime.readAttachmentForTurn(args,{turnId:"vector-turn",sessionId:"owner"}) as {content:Array<{text:string}>};
 assert.equal(JSON.parse(response.content[0].text).mode,"vector");
 runtime.endBackendAuthLease(lease);await assert.rejects(runtime.readAttachmentForTurn(args,{turnId:"vector-turn",sessionId:"owner"}),/not bound/);
});
