import test from'node:test';import assert from'node:assert/strict';
import{nativeArtifactReceiptEffectV1}from'../assignment-kernel-v2-contracts/index.js';
import{planSavedRevitModelOpen}from'./saved_model_open.mjs';
import{readStableModelFileForOpen}from'./saved_model_open.mjs';
import fs from'node:fs';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
const binding={assignment_id:'a',run_id:'r',generation:1,session_id:'s'},filePath='C:\\workspace\\artifacts\\Result.rvt';
function fixture(){const identity={session_id:'d',project_fingerprint:'a'.repeat(64),path:filePath};
 const file={path:filePath,size_bytes:22,sha256:'b'.repeat(64),stable_read:true},receipt={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
  saved_revit_version:'2024',expected_output_paths:[filePath],expected_export_calls:1,export_calls:[true],outputs:[{...file,fresh_output:true}],
  save_document:{native_save_returned:true,same_document:true,document_session_changed:false,document_path_changed:false,project_binding_changed:false,before:identity,after:identity}};
 const op={operation_id:'save',binding,requested_effect:'apply',request_identity:{method:'POST',path:'/revit/save-as'},dispatch_state:'dispatched',persistent_effect:'applied',
  result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_artifact_receipt:receipt}};
 return{binding,filePath,file,validateReceipt:nativeArtifactReceiptEffectV1,snapshot:{current_binding:binding,terminal:true,quiescent:true,
  in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],operations:{save:op}}};}
test('native saved version selects its exact known installed-path candidate, never the Windows default or a caller executable',()=>{
 const f=fixture();f.executable='C:\\evil.exe';f.revit_version='2027';const p=planSavedRevitModelOpen(f);
 assert.equal(p.executable,'C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe');assert.deepEqual(p.args,[filePath]);assert.equal(p.revit_version,'2024');
 assert(!Object.hasOwn(p,'native_postcondition_verified'));assert(!Object.hasOwn(p,'whole_task_verified'));
});
const variants={
 missingVersion:f=>delete f.snapshot.operations.save.result.native_artifact_receipt.saved_revit_version,
 guessedVersion:f=>f.snapshot.operations.save.result.native_artifact_receipt.saved_revit_version='2024.3',
 numericVersion:f=>f.snapshot.operations.save.result.native_artifact_receipt.saved_revit_version=2024,
 newlineVersion:f=>f.snapshot.operations.save.result.native_artifact_receipt.saved_revit_version='2024\n',
 arbitraryExecutable:f=>f.snapshot.operations.save.result.native_artifact_receipt.saved_revit_version='C:\\run.exe',
 foreignSession:f=>f.snapshot.current_binding={...binding,session_id:'foreign'},
 foreignOperation:f=>f.snapshot.operations.save.binding={...binding,run_id:'foreign'},
 foreignResult:f=>f.snapshot.operations.save.result.binding={...binding,generation:2},
 failed:f=>f.snapshot.operations.save.result.status='failed',
 unknownEffect:f=>f.snapshot.operations.save.persistent_effect='unknown',
 noNative:f=>f.snapshot.operations.save.result.authority='worker',
 changedHash:f=>f.file.sha256='c'.repeat(64),changedSize:f=>f.file.size_bytes=21,
 wrongPath:f=>f.filePath='C:\\workspace\\artifacts\\Other.rvt',unstable:f=>f.file.stable_read=false,
 malformedReceipt:f=>f.snapshot.operations.save.result.native_artifact_receipt.save_document=null,
 preview:f=>f.snapshot.operations.save.result.native_artifact_receipt.phase='preview',
 paused:f=>f.snapshot.execution_control={state:'paused'},pendingUsage:f=>f.snapshot.provider_usage_hold={reason:'pending'},
 inflight:f=>f.snapshot.in_flight_operation_ids=['op'],unknown:f=>f.snapshot.unresolved_unknown_operation_ids=['op'],
 pendingProvider:f=>f.snapshot.in_flight_provider_call_ids=['call'],active:f=>f.snapshot.terminal=false,
 unc:f=>f.filePath='\\\\server\\share\\Result.rvt',notModel:f=>f.filePath='C:\\workspace\\artifacts\\run.exe',
 competingVersions:f=>{const o=structuredClone(f.snapshot.operations.save);o.operation_id='other';o.result.native_artifact_receipt.saved_revit_version='2027';f.snapshot.operations.other=o;}
};
for(const [name,change]of Object.entries(variants))test(name+' refuses without a launch plan',()=>{const f=fixture();change(f);assert.throws(()=>planSavedRevitModelOpen(f));});
test('a settled blocked task can open its genuinely saved partial without being labelled complete',()=>{const f=fixture();f.snapshot.outcome='blocked';assert.equal(planSavedRevitModelOpen(f).revit_version,'2024');});
test('disk identity is streamed and concurrent replacement/write refuses without native proof claims',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-open-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'saved.rvt'),bytes=Buffer.alloc(100000,7);fs.writeFileSync(file,bytes);
 const facts=await readStableModelFileForOpen(file);assert.equal(facts.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(facts.size_bytes,bytes.length);
 await assert.rejects(readStableModelFileForOpen(file,{duringRead:()=>fs.appendFileSync(file,'changed')}),/changed/);
 await assert.rejects(readStableModelFileForOpen(dir));
});
