import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordWorkPlanLocationV2, projectWorkPlanLocationV2, type WorkPlanLocationHintV2 } from '../src/domain/assignment-kernel/work_plan_location.js';
import { declareWorkPlanV2 } from '../src/domain/assignment-kernel/work_plan.js';
import { projectWorkPlan } from '../src/assignments/work_plan_projection.js';
const hint:WorkPlanLocationHintV2={status:'candidate',reason:'Reviewed full page and enlarged mark; native address still requires revalidation.',
  source:{attachment_id:'source-pdf',filename:'drawings.pdf',sha256:'a'.repeat(64),page:4,page_count:26,sheet_label:'E010',region:{min_u:.48,min_v:.6,max_u:.76,max_v:.727}},
  native:{document_fingerprint:'document-a',view_id:1661139,view_name:'CONCEPTUAL POWER DISTRIBUTION',sheet_number:'E010'}};
function fixture():any {
  const s=JSON.parse(fs.readFileSync('test/fixtures/c43-area-budget-plan.json','utf8'));
  s.current_binding.document_fingerprint='document-a';
  s.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[{item_id:'main1',description:'Pick up current-rating redline',source_basis:'E010',declared_at:'2026-10-12T12:00:00Z',operation_ids:[]}]};
  return s;
}
test('parent source/crop/native address survives serialization and remains navigation only',()=>{
  const s=fixture(),before=structuredClone(s);
  s.work_plan=recordWorkPlanLocationV2(s,'main1',hint,'2026-10-12T12:01:00Z');
  const restored=JSON.parse(JSON.stringify(s)),p=projectWorkPlan(restored.work_plan,0,0,restored)!;
  const location=p.scope.items[0]!.location_hint!;
  assert.equal(location.source!.sheet_label,'E010');assert.equal(location.source!.page,4);assert.equal(location.source!.page_count,26);
  assert.deepEqual(location.source!.region,hint.source!.region);assert.equal(location.native!.view_name,hint.native!.view_name);
  assert.equal(location.verified,false);assert.equal(location.binding_current,true);assert.equal(location.history_count,1);
  assert.equal(p.completed_count,0);assert.equal(s.work_plan.items[0].completed_at,undefined);
  for(const k of ['operations','criteria','unresolved_unknown_operation_ids'])assert.deepEqual(s[k],before[k]);
  assert.equal(before.work_plan.items[0].location_history,undefined,'no input mutation');
  restored.current_binding.generation++;assert.equal(projectWorkPlanLocationV2(restored.work_plan.items[0],restored)!.binding_current,false);
});
test('ambiguous and unresolved updates retain prior addresses without claiming proof',()=>{
  const s=fixture();s.work_plan=recordWorkPlanLocationV2(s,'main1',hint,'2026-10-12T12:01:00Z');
  s.work_plan=recordWorkPlanLocationV2(s,'main1',{status:'ambiguous',reason:'Two candidate views; ask for intended view.'},'2026-10-12T12:02:00Z');
  assert.equal(s.work_plan.items[0].location_history[0].source.page,4);
  assert.equal(projectWorkPlanLocationV2(s.work_plan.items[0],s)!.status,'ambiguous');
  assert.equal(projectWorkPlanLocationV2(s.work_plan.items[0],s)!.native,undefined);
  for(let i=2;i<16;i++)s.work_plan=recordWorkPlanLocationV2(s,'main1',{status:'unresolved',reason:'Awaiting source clarification.'},'2026-10-12T12:03:00Z');
  assert.throws(()=>recordWorkPlanLocationV2(s,'main1',hint,'2026-10-12T12:04:00Z'),/history reached/);
});
test('reject stale documents, forged proof, malformed source/crop, oversized and unknown item locations',()=>{
  for(const h of [
    {...hint,verified:true}, {...hint,native:{...hint.native,document_fingerprint:'foreign'}},
    {...hint,source:{...hint.source,page:27}}, {...hint,source:{...hint.source,sha256:'missing'}},
    {...hint,source:{...hint.source,region:{min_u:.8,min_v:.6,max_u:.7,max_v:.8}}},
    {...hint,source:{...hint.source,sheet_label:'E010\u0000'}}, {...hint,source:null},
    {...hint,reason:'x'.repeat(241)}, {status:'candidate',reason:'No address'},
    {...hint,source:{...hint.source,filename:'測'.repeat(160)}},
  ])assert.throws(()=>recordWorkPlanLocationV2(fixture(),'main1',h as any,'2026-10-12T12:01:00Z'));
  assert.throws(()=>recordWorkPlanLocationV2(fixture(),'missing',hint,'2026-10-12T12:01:00Z'));
  const s=fixture();s.operations={};delete s.work_plan;
  assert.throws(()=>declareWorkPlanV2(s,{items:[{item_id:'fake',description:'Draft',source_basis:'PDF',location_history:[{...hint,verified:true}]}],assumptions:[]} as any,'2026-10-12T12:01:00Z'));
});
test('large multilingual source plans with locations remain pageable and do not grow a history in context',()=>{
  const s=fixture();s.work_plan.items=Array.from({length:128},(_,i)=>({...s.work_plan.items[0],item_id:'item'+i,description:'測'.repeat(266),source_basis:'図'.repeat(266)}));
  for(const item of s.work_plan.items)s.work_plan=recordWorkPlanLocationV2(s,item.item_id,hint,'2026-10-12T12:01:00Z');
  let start:number|null=0;const seen:string[]=[];
  while(start!==null){const p:NonNullable<ReturnType<typeof projectWorkPlan>>=projectWorkPlan(s.work_plan,start,0,s)!;assert(p.scope.items.length>0);assert(Buffer.byteLength(JSON.stringify(p))<6500);seen.push(...p.scope.items.map(i=>i.item_id));assert(p.scope.next_start===null||p.scope.next_start>start);start=p.scope.next_start;}
  assert.deepEqual(seen,s.work_plan.items.map((i:any)=>i.item_id));
});
