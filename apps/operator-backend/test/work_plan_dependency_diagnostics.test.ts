import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {prepareAssignmentTurn} from '../src/assignments/turn_preparation.js';
import {handleAssignmentHttpRoute} from '../src/assignments/http_routes.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {getGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';

const fixture=JSON.parse(fs.readFileSync('test/fixtures/work-plan-dependencies-398.json','utf8').replace(/^\uFEFF/,''));
test('retained independent inspection refusals reach HTTP with domain recovery guidance, without accepting scope',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'work-plan-diagnostics-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS:'none'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  const prepared=prepareAssignmentTurn({sessionId:'diagnostic-session',messageId:'first',userText:'Adjust equipment tags and correct missing annotations in the open model.',toolResults:[],source:'chat',createdBy:null,requestContext:{revit:{document:{projectIdentity:{fingerprint:'diagnostic-model'}}}}})!;
  assert(prepared?.bindingV2);const binding=prepared.bindingV2;
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.spec.execution_policy,undefined);
  const request=async(body:unknown,authorized=true)=>{
   const req=Readable.from([Buffer.from(JSON.stringify(body))]) as any;req.method='POST';let text='';
   const res:any={statusCode:200,setHeader(){},writeHead(code:number){this.statusCode=code;return this;},end(value=''){text+=value;}};
   assert(await handleAssignmentHttpRoute(req,res,new URL('http://fixture/api/assignments/v2/work-plan'),()=>{if(!authorized)res.writeHead(403).end();return authorized;}));
   return{status:res.statusCode,body:text?JSON.parse(text):null};
  };
  const before=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  for(const args of fixture.cases){
   const declaration={items:args.items.map((i:any)=>({item_id:i.itemId,kind:i.kind,description:i.description,source_basis:i.sourceBasis,...(i.dependsOn?{depends_on:i.dependsOn}:{})})),assumptions:args.assumptions};
   const result=await request({...binding,action:'declare',declaration});
   assert.equal(result.status,409);assert.equal(result.body.error,'work_plan_dependencies_invalid');
   assert.equal(result.body.guidance,fixture.domain_guidance,'the durable store must not discard the domain explanation before HTTP');
   assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id),before,'rejected scope cannot change accepted events, effects or task outcome');
  }
  const quarantine=getGoal(binding.assignment_id)!.assignment_kernel_v2!.quarantined_events;
  assert.equal(quarantine.length,3);assert(quarantine.every(x=>x.reason===fixture.domain_guidance));
  const unauthorized=await request({...binding,action:'status'},false);assert.equal(unauthorized.status,403);assert.equal(unauthorized.body,null);
  const stale=await request({...binding,generation:99,action:'status'});assert.equal(stale.status,409);assert.equal(stale.body.guidance,undefined);
  const items=[{item_id:'correction',description:'Correct annotation',source_basis:'Drawing'},{item_id:'save',description:'Save corrected output',source_basis:'Request'},
   {item_id:'review',kind:'inspection',depends_on:['correction','save'],description:'Inspect changed targets and saved output',source_basis:'Request'}];
  assert.equal((await request({...binding,action:'declare',declaration:{items,assumptions:[]}})).status,200);
  __testOnlyResetGoalListCache();assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.work_plan!.items.length,3);
  const forged=await request({...binding,action:'complete',item_id:'review',operation_ids:['invented-native-read']});
  assert.equal(forged.status,409);assert.equal(forged.body.guidance,undefined,'unrelated rejection details are not broadly exposed');
  const cyclic=await request({...binding,action:'declare',declaration:{items:[{item_id:'cycle_a',depends_on:['cycle_b'],description:'A',source_basis:'Drawing'},{item_id:'cycle_b',depends_on:['cycle_a'],description:'B',source_basis:'Drawing'}],assumptions:[]}});
  assert.equal(cyclic.status,409);assert.equal(cyclic.body.error,'work_plan_dependency_cycle');assert.equal(cyclic.body.guidance,undefined);
 });}finally{
  __closeForTests();__testOnlyResetGoalListCache();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('work-plan-diagnostics-'));fs.rmSync(root,{recursive:true,force:true});
 }
});
