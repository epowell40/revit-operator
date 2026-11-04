import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitCourierJobClaim } from '../src/courier/revit_tool_job_claim_support.js';
import { isSupportedNativeTransport, isSupportedToolRoute, isSupportedStandaloneExecutorTool, requireSupportedNativeTransport } from '../src/capabilities/supported_tool_inventory.js';
import { claimNextRevitToolJob, REVIT_COURIER_JOB_VERSION, __testOnlyResetRevitCourierJobIndexCache } from '../src/courier/revit_tool_jobs.js';
import { computeRequestHash } from '../src/capabilities/tool_certification.js';

function hosted(work: (root: string) => void) {
  const prior={...process.env},root=fs.mkdtempSync(path.join(os.tmpdir(),'native-csharp-courier-'));
  Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'hosted',OPERATOR_AUTH_MODE:'principal_jwt',OPERATOR_BRAIN:'codex',OPERATOR_OPENAI_API_KEY:'test-provider-key'});
  delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
  __testOnlyResetRevitCourierJobIndexCache();
  try { work(root); } finally {
    __testOnlyResetRevitCourierJobIndexCache();
    for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];
    Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});
  }
}
function writeNativeJob(root: string,mode: string,admissionChanges: Record<string,unknown>={},jobChanges: Record<string,unknown>={}) {
  const id=randomUUID().replace(/-/g,''),route=`/revit/dynamic-runtime/run-native-${mode}-v1`;
  const body={source:'public class Query { public static string Execute(Autodesk.Revit.DB.Document doc) { return doc.Title; } }',targetRevitYear:'2024',expectedDocumentFingerprint:'sha256:'+'a'.repeat(64),nativeProgram:{entryType:'Query',mode:mode==='read'?'read':'write',effectScope:'active_document'},workerDeadlineMs:15000};
  const admission={schema:'revit-operator.general-agent-courier-admission.v1',source:'backend_general_agent',runtime_mode:'hosted',exposure_profile:'general',capability_profile:'general_agent',general_agent_ready:true,method:'POST',path:route,channel:'typed_mcp',alias:'operator_run_dynamic_revit_program',request_hash:computeRequestHash('POST',route,body),effect_hash:'sha256:'+'2'.repeat(64),...admissionChanges};
  const file=path.join(root,'artifacts/revit-courier/jobs',id,'job.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:REVIT_COURIER_JOB_VERSION,id,session_id:'session-a',message_id:'message-a',correlation_id:id,idempotency_key:'b'.repeat(64),method:'POST',path:route,body,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),status:'pending',claim:null,turn_token_sha256:'sha256:'+'3'.repeat(64),target_executor_id:'worker-1',general_agent_admission:admission,...jobChanges}));
  return {id,file,body};
}

// Retained403: the model's valid native C# read reached the courier but was
// rejected before workstation execution. Apply is the same producer's neighbor.
for (const mode of ['read', 'apply']) {
  test(`native CSharp courier ${mode} claims its registered workstation executor without admitting raw native forwarding`, () => {
    const path = `/revit/dynamic-runtime/run-native-${mode}-v1`;
    assert.equal(isSupportedNativeTransport('POST', path), false);
    assert.equal(isSupportedToolRoute('POST', path), true);
    assert.equal(isSupportedStandaloneExecutorTool('POST',path,'revit-operator.native-program-workstation.v1'),true);
    assert.equal(isSupportedStandaloneExecutorTool('POST',path,'revit-operator.safe-read-host.v1'),false);
    assert.throws(()=>requireSupportedNativeTransport('POST',path),/outside the supported product inventory/);
    const errors: string[] = [];
    assert.equal(admitCourierJobClaim({method:'POST',path,status:'pending',version:'v1',general_agent_admission:{}}, 'v1', e=>errors.push(e.code)), true);
    assert.deepEqual(errors, []);
  });
  test(`native CSharp courier ${mode} reaches the real job-claim consumer with exact admission intact`,()=>hosted(root=>{
    const job=writeNativeJob(root,mode);
    const claim=claimNextRevitToolJob({session_id:'session-a',executor_id:'worker-1'}).job;
    assert.equal(claim?.id,job.id);assert.deepEqual(claim?.body,job.body);
    assert.equal((claim as any).general_agent_admission.alias,'operator_run_dynamic_revit_program');
    assert.equal((claim as any).general_agent_admission.request_hash,computeRequestHash('POST',claim!.path,job.body));
    assert.equal(claim?.status,'running');
  }));
}

for(const change of [{path:'/revit/context'},{method:'GET'},{source:'untrusted_caller'},{runtime_mode:'development'},{request_hash:'bad'},{channel:'untrusted'},{extra:true}])
  test(`native CSharp claim preserves admission rejection ${JSON.stringify(change)}`,()=>hosted(root=>{
    writeNativeJob(root,'read',change);
    assert.equal(claimNextRevitToolJob({session_id:'session-a',executor_id:'worker-1'}).job,null);
  }));

test('native CSharp claim preserves missing-admission, foreign-executor and live-lease fences',()=>{
  hosted(root=>{writeNativeJob(root,'read',{}, {general_agent_admission:undefined});assert.equal(claimNextRevitToolJob({session_id:'session-a',executor_id:'worker-1'}).job,null);});
  hosted(root=>{const job=writeNativeJob(root,'apply',{}, {target_executor_id:'other-worker'}),before=fs.readFileSync(job.file,'utf8');assert.equal(claimNextRevitToolJob({session_id:'session-a',executor_id:'worker-1'}).job,null);assert.equal(fs.readFileSync(job.file,'utf8'),before);});
  hosted(root=>{const job=writeNativeJob(root,'apply',{}, {status:'running',claim:{executor_id:'worker-1',claimed_at:new Date().toISOString(),lease_expires_at:new Date(Date.now()+60000).toISOString()}}),before=fs.readFileSync(job.file,'utf8');assert.equal(claimNextRevitToolJob({session_id:'session-a',executor_id:'worker-1'}).job,null);assert.equal(fs.readFileSync(job.file,'utf8'),before);});
});

test('courier transport support keeps unknown methods/routes closed and never invents a failure for running work', () => {
  for (const [method,path] of [['GET','/revit/dynamic-runtime/run-native-read-v1'],['POST','/revit/dynamic-runtime/run-native-arbitrary-v1'],['POST','/revit/certified/sheets/count'],['POST','/revit/dynamic-runtime/native-program-apply-v1']]) {
    for (const status of ['pending','running']) {
      const errors: string[]=[];
      assert.equal(admitCourierJobClaim({method,path,status,version:'v1',general_agent_admission:{}},'v1',e=>errors.push(e.code)),false);
      assert.deepEqual(errors,status==='pending'?['PRODUCT_TOOL_NOT_SUPPORTED']:[]);
    }
  }
});
