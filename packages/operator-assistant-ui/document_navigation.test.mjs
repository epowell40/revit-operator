import test from 'node:test';
import assert from 'node:assert/strict';
import {readDocumentNavigation} from './task_navigation.mjs';
const parent={assignment_id:'parent',session_id:'chat',run_id:'first',generation:1};
const child={assignment_id:'child',session_id:'chat',run_id:'next',generation:1};
function fixture() {
  const fullParent={...parent,document_fingerprint:'old',principal_id:'owner'};
  const spec={binding:{...child,document_fingerprint:'new'},document_parent_binding:fullParent,source_user_request:'Make a new project.',protected:['do not save']};
  const p={snapshot:{current_binding:fullParent,execution_control:{state:'paused',command_id:'document:call'},document_handoff:{command_id:'call',child_spec:structuredClone(spec)}}};
  const c={snapshot:{current_binding:spec.binding,spec}};
  const reads=[];
  const read=async(route,options)=>{assert.equal(options.method,'GET');reads.push(route);return {assignment_kernel_v2:route.endsWith('/parent')?p:c};};
  const parse=p=>p;
  const project=p=>({_sourceKind:'assignment_kernel_v2',related_session_id:'chat',_bindingV2:p.snapshot.current_binding,id:'child'});
  return {p,c,reads,run:()=>readDocumentNavigation(read,parse,project,parent,child)};
}
test('saved task navigation follows only the exact canonical new-document phase without dispatch',async()=>{
  const f=fixture(),view=await f.run();assert.equal(view.id,'child');
  assert.deepEqual(f.reads,['/api/assignments/v2/parent','/api/assignments/v2/child']);
});
test('foreign, stale, unlinked or modified child phases never replace the selected task',async()=>{
  for(const alter of [f=>delete f.p.snapshot.document_handoff,
    f=>f.p.snapshot.current_binding.generation++,f=>f.c.snapshot.current_binding.run_id='foreign',
    f=>f.c.snapshot.current_binding.session_id='other',f=>f.p.snapshot.execution_control.state='running',
    f=>f.p.snapshot.execution_control.command_id='user-pause',
    f=>f.c.snapshot.spec.document_parent_binding={...parent,principal_id:'other'},
    f=>f.c.snapshot.spec.protected=[],f=>f.c.snapshot.spec.binding.document_fingerprint='other']) {
    const f=fixture();alter(f);await assert.rejects(f.run());
  }
});
test('invalid publications are rejected by the canonical parser before projection',async()=>{
  let projected=false;
  await assert.rejects(readDocumentNavigation(async()=>({assignment_kernel_v2:{}}),()=>{throw Error('invalid publication');},()=>{projected=true;},parent,child),/invalid publication/);
  assert.equal(projected,false);
});
