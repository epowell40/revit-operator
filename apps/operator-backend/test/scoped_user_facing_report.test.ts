import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import {fileURLToPath} from 'node:url';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {getGoalStoragePath,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {retainDesktopHelperReturnV1,takeDesktopHelperReturnV1,desktopHelperReturnAfterDrainV1,DESKTOP_HELPER_RETURN_REASON} from '../src/brains/desktop_helper_return.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const file=[path.join(here,'fixtures/completion-barrier-report-516.json'),path.join(here,'../../test/fixtures/completion-barrier-report-516.json')].find(fs.existsSync)!;
const text='Garage ventilation follow-up: confirm use, openings, existing systems, contaminant criteria and design decisions. No airflow or fan selection has been supplied.';
for(const stage of ['prefixGoal','settledGoal'])test('scoped user-facing text survives actual completion barrier '+stage,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'operator-user-report-')),old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=dir;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=JSON.parse(fs.readFileSync(file,'utf8')),g=f[stage],destination=getGoalStoragePath(g.id)!;fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(g));
  const binding=getAssignmentKernelSnapshotV2(g.id)!.current_binding,marker={schema:'operator.desktop-helper-scope.v1',binding},owner={},before=fs.readFileSync(destination);
  const args=structuredClone(f.call.arguments);args.completionProposal.user_facing_text=text;args.completionProposal.claimed_completed.unshift('INTERNAL CHECKLIST ADMINISTRATION ONLY');
  retainDesktopHelperReturnV1({owner,turn_id:'user-report',binding,marker,tool:'operator_manage_work_plan',arguments:args});
  const report=takeDesktopHelperReturnV1(owner,'user-report');assert(report);assert.equal((report.report as any).user_facing_text,text);assert(report.report.claimed_completed.includes('INTERNAL CHECKLIST ADMINISTRATION ONLY'));assert.deepEqual(fs.readFileSync(destination),before);
  fs.writeFileSync(destination,JSON.stringify(f.settledGoal));const settledBefore=fs.readFileSync(destination);
  const message=desktopHelperReturnAfterDrainV1(report,marker,getAssignmentKernelSnapshotV2(g.id),DESKTOP_HELPER_RETURN_REASON);assert(message);assert(message.includes(text));assert(!message.includes('INTERNAL CHECKLIST ADMINISTRATION ONLY'));assert(!message.includes('Reported remaining work'));assert.match(message,/not independently verified/);assert.deepEqual(fs.readFileSync(destination),settledBefore);
  const changed={...binding,generation:binding.generation+1};assert.equal(desktopHelperReturnAfterDrainV1(report,{...marker,binding:changed},getAssignmentKernelSnapshotV2(g.id),DESKTOP_HELPER_RETURN_REASON),null);
  const paused=structuredClone(getAssignmentKernelSnapshotV2(g.id)!);paused.execution_control={...(paused.execution_control as any),state:'paused'};assert.equal(desktopHelperReturnAfterDrainV1(report,marker,paused,DESKTOP_HELPER_RETURN_REASON),null);
  for(const invalid of ['', 'x'.repeat(8001),42,{text}]){const bad=structuredClone(args);bad.completionProposal.user_facing_text=invalid;assert.throws(()=>retainDesktopHelperReturnV1({owner:{},turn_id:'invalid-report',binding,marker,tool:'operator_manage_work_plan',arguments:bad}));}
 });}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('operator-user-report-'));fs.rmSync(dir,{recursive:true,force:true});}
});
