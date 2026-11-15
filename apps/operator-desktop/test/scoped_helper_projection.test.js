import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {projectSidecarFunctionOutput} from '../evidence_projection.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-helper-envelope-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
const {storeEvidence,readAuthoritativeEvidence}=await import('../../operator-backend/dist/src/evidence/evidence_store.js');const {__closeForTests}=await import('../../operator-backend/dist/src/memory/sqlite_store.js');
after(()=>{__closeForTests();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});});
test('synthetic bounded helper report reaches the Sidecar model without private history or verification authority',async()=>{
 const scope={session_id:'synthetic-session',assignment_id:'synthetic-task',run_id:'synthetic-run',generation:1},binding={...scope,principal_id:'local:test',document_fingerprint:'synthetic-doc'};
 const report={kind:'scope_report',claimed_completed:['Checked visible labels'],remaining_work:['Check border'],uncertainties:['Not exhaustive']};
 const inner=storeEvidence({scope:{...scope,attempt_id:'helper:synthetic'},source:'operator.desktop-helper-report',trust_level:'untrusted_caller',verification_relevance:'supporting',raw:{schema:'operator.desktop-helper-report.v1',binding,turn_id:'synthetic',report,verified:false}});
 const helper={schema:'operator.desktop-helper-return.v1',binding,turn_id:'synthetic',source_tool:'operator_manage_work_plan',request_hash:'a'.repeat(64),control_command_id:null,report,evidence_ref:inner.ref,verified:false};
 const raw={ok:true,session_id:scope.session_id,desktop_helper_return:helper,durable_assignment_kernel_v2:{snapshot:{current_binding:binding,history:'unrelated history '.repeat(80000)}}};
 const p=await projectSidecarFunctionOutput({toolCall:{name:'delegate_revit_task',call_id:'synthetic',arguments:'{}'},functionOutput:{type:'function_call_output',call_id:'synthetic',output:JSON.stringify(raw)},scope,storeEvidence:async body=>({ok:true,...storeEvidence({scope:body.scope,source:body.source,media_type:body.media_type,trust_level:body.trust_level,verification_relevance:body.verification_relevance,raw:body.raw_json})})});
 const h=JSON.parse(p.model_output.output).evidence_projections[0].helper_findings;assert(h);assert.deepEqual(h.report,report);assert.equal(h.verified,false);assert.equal(h.whole_task_verified,false);assert.doesNotMatch(p.model_output.output,/unrelated history/);assert(p.telemetry.projected_bytes<8192);assert.deepEqual(JSON.parse(readAuthoritativeEvidence(p.evidence_ref,scope).toString()),raw);
});
