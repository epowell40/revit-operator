import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {sha256,validateCase,collect,loadCollection,gradeCase,gradeAnnotation,compareMixed,compareSchedule,comparePackage,workflowPhaseDigest,workflowExecutionLogs,savedFileAfterProcessExit,assertWorkflowFinalizationEvidence} from './workflow-harness.mjs';
test('owned exit identity accepts Windows path spellings but retains creation-time and executable checks',async()=>{
 const expected={pid:22,exe:'C:/Program Files/Autodesk/Revit 2024/Revit.exe',created_utc:'2026-10-26T12:00:00Z'};let calls=0;
 assert.equal(await savedFileAfterProcessExit({expected,readProcess:async()=>++calls===1?{...expected,exe:'c:\\program files\\autodesk\\revit 2024\\revit.exe'}:null,sleep:async()=>{},readFile:()=>true}),true);
 for(const actual of [{...expected,exe:'C:/Other/Revit.exe'},{...expected,created_utc:'2026-10-26T13:00:00Z'}])
  await assert.rejects(savedFileAfterProcessExit({expected,readProcess:async()=>actual,readFile:()=>assert.fail('no hash')}),/identity changed/);
});
function accountingFixture(){
 const at=s=>`2026-01-01T00:00:${String(s).padStart(2,'0')}.000Z`;
 const usage=i=>({input_tokens:100,cached_input_tokens:60+i*10,cache_write_input_tokens:30-i*10,output_tokens:5});
 const calls=[0,1,2].map(i=>({call_id:i===0?'external:owner':`call${i}`,upstream_receipt:i===0?{call_id:'call0'}:undefined,model:'fixture',dispatched_at:at(i===2?20:i),completed_at:at(i===2?24:i+1),usage:usage(i)}));
 const operation=(p,t,effect='applied')=>({request_identity:{path:p},persistent_effect:effect,operation_role:'root',opened_at:at(t-1),result:{authority:'native-host',status:'succeeded',completed_at:at(t)}});
 const kernel={current_binding:{assignment_id:'a',session_id:'s'},provider_calls:Object.fromEntries(calls.map(c=>[c.call_id,c])),operations:{edit:operation('/revit/configure-schedule',5),save:operation('/revit/save-as',10),read:operation('/revit/schedules',15,'none')},outcome:'blocked'};
 const state={backendSessionId:'s',modelCallReceipts:calls.map((c,i)=>({call_id:`call${i}`,route:i===1?'codex_agent':'desktop_computer',tokens:usage(i),started_at_utc:c.dispatched_at})),functionToolReceipts:[{tool_name:'delegate_revit_task',recorded_at:at(8)},{tool_name:'review_current_work',recorded_at:at(25),arguments:{capture_mode:'target_view'},evidence_ref:{assignment_id:'a',session_id:'s'},result:{reviewer_response_id:'call2',state:'unavailable',reason:'frame_changed'}}]};
 const toolCalls=[{ts:at(3),tool:'edit',server:'fixture',thread_id:'t',turn_id:'1'},{ts:at(12),tool:'check',server:'fixture',thread_id:'t',turn_id:'1'}];
 return{input:{kernel,state,canonical:{binding:{assignment_id:'a'},providers:3,operations:3,progress:{startedAt:at(0),updatedAt:at(30)}},toolCalls,toolOutputs:toolCalls.map(r=>({...r,status:'completed',error:null})),agentEvents:[{event:'USER_TURN_RECEIVED',ts:at(1)}]},pricing:{ordinaryInputTokens:u=>Number.isFinite(u.cache_write_input_tokens)?u.input_tokens-u.cached_input_tokens-u.cache_write_input_tokens:null,standardProviderTextTokenCostUsd:(_m,u)=>Number.isFinite(u.cache_write_input_tokens)?1:null,PROVIDER_TOKEN_PRICING_SNAPSHOT:{basis:'fixture'}}};
}
test('retained digest reconciles cache classes and owner/helper/reviewer without combining tool/kernel units',()=>{
 const f=accountingFixture(),r=workflowPhaseDigest(f.input,f.pricing);
 assert.equal(r.accounting.inputTokens,300);assert.equal(r.accounting.cacheReadTokens,210);assert.equal(r.accounting.cacheWriteTokens,60);assert.equal(r.accounting.uncachedTokens,30);
 for(const role of ['owner','helper','reviewer'])assert.equal(r.roles[role].calls,1);
 assert.equal(r.counts.providerCalls,3);assert.equal(r.counts.kernelOperations,3);assert.equal(r.counts.helperMcpTools,2);assert.equal(r.counts.ownerFunctionTools,2);
 assert.equal(r.afterSave.providers.calls,1);assert.equal(r.afterSave.helperMcpTools,1);assert.equal(r.timing.secondsAfterLastSave,20);assert.equal(r.outcome,'blocked');assert.equal(r.actualBillingUsd,null);
 assert.equal(r.accounting.standardTextPriceEquivalentUsd,3);assert.equal(r.accounting.receiptEstimateUsd,null);
});
test('unified direct calls use actual canonical/Sidecar records, never fabricated helper logs',()=>{
 const f=accountingFixture();f.input.state.modelCallReceipts[1].route='desktop_computer';
 f.input.state.functionToolReceipts[0].tool_name='native__revit_call_tool';
 const logs={toolCalls:null,toolOutputs:null,agentEvents:null};
 const selected=workflowExecutionLogs({...f.input,logs});
 const digest=workflowPhaseDigest({...f.input,...selected},f.pricing);
 assert.equal(digest.counts.directNativeFunctionTools,1);assert.equal(digest.counts.helperMcpTools,0);assert.equal(digest.roles.helper.calls,0);assert.equal(digest.accounting.calls,3);
 for(const mutate of [x=>x.logs.toolCalls=[],x=>x.state.backendSessionId='foreign',x=>x.state.functionToolReceipts[0].tool_name='delegate_revit_task',x=>x.state.modelCallReceipts[1].route='codex_agent',x=>x.state.modelCallReceipts.pop()]){
  const input=structuredClone({...f.input,logs});mutate(input);assert.throws(()=>workflowExecutionLogs(input));
 }
 const old=accountingFixture().input;assert.equal(workflowExecutionLogs({...old,logs:{toolCalls:old.toolCalls,toolOutputs:old.toolOutputs,agentEvents:old.agentEvents}}).basis,'retained-helper-logs');
});
test('helper turn timestamp cannot silently assign a later provider call to the pre-save phase',()=>{
 const f=accountingFixture(),at=s=>`2026-01-01T00:00:${s}.000Z`;
 f.input.kernel.provider_calls.call1.completed_at=at(18);
 // Actual retained Codex receipts repeat the helper-turn start and have no
 // per-call duration. The call may have started before or after the save.
 const r=workflowPhaseDigest(f.input,f.pricing),helper=r.providerRows.find(x=>x.role==='helper');
 assert.equal(helper.startedAt,null);assert.equal(helper.reportedStartedAt,f.input.state.modelCallReceipts[1].started_at_utc);
 assert.equal(r.afterSave.providers,null);assert.equal(r.afterSave.providersWithKnownStart.calls,1);
 assert.deepEqual(r.afterSave.unattributedProviderIds,['call1']);assert.equal(r.afterSave.providerTimingComplete,false);
 assert.equal(r.accounting.calls,3);assert.equal(r.accounting.standardTextPriceEquivalentUsd,3,'full costs are still reconciled');
});
test('retained digest refuses contradictory model/kernel usage or mixed input cohorts',()=>{
 for(const change of [x=>x.state.modelCallReceipts[0].tokens.cached_input_tokens++,x=>x.state.backendSessionId='foreign',x=>x.canonical.providers++,x=>x.toolOutputs.pop(),x=>x.agentEvents=[]]){
  const f=accountingFixture();change(f.input);assert.throws(()=>workflowPhaseDigest(f.input,f.pricing));
 }
});
test('missing cache-write usage remains unknown instead of being priced as zero',()=>{
 const f=accountingFixture();delete f.input.kernel.provider_calls['external:owner'].usage.cache_write_input_tokens;delete f.input.state.modelCallReceipts[0].tokens.cache_write_input_tokens;
 const r=workflowPhaseDigest(f.input,f.pricing);assert.equal(r.accounting.cacheWriteTokens,null);assert.equal(r.accounting.uncachedTokens,null);assert.equal(r.accounting.standardTextPriceEquivalentUsd,null);
});
test('foreign reviewer references cannot misattribute an owner-route response as an accepted owned review',()=>{
 const f=accountingFixture();f.input.state.functionToolReceipts[1].evidence_ref.assignment_id='foreign';
 const r=workflowPhaseDigest(f.input,f.pricing);assert.equal(r.roles.reviewer.calls,0);assert.equal(r.roles.unknown.calls,1);assert.equal(r.outcome,'blocked');
});
function cleanup(root){assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('workflow-harness-'));fs.rmSync(root,{recursive:true});}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-harness-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const source=path.join(root,'original.rvt'),link=path.join(root,'link.rvt'),promptFile=path.join(root,'prompt.txt');
 fs.writeFileSync(source,'immutable disposable source');fs.writeFileSync(link,'linked source');fs.writeFileSync(promptFile,'Add review note, verify and save separately.');
 const m={schema:'operator.workflow-case.v1',caseId:'annotation-original',caseRoot:root,workspace,source,sourceSha256:sha256(source),host:path.join(workspace,'input.rvt'),result:path.join(workspace,'output.rvt'),promptFile,
  links:[{path:link,sha256:sha256(link)}],kind:'annotation',expected:{text:'REVIEW NOTE',sheet:'T100'},actor:{hardSeconds:540,intervention:'none_except_safety_stop'}};
 const file=path.join(root,'case.json');fs.writeFileSync(file,JSON.stringify(m));return{m,file};
}
test('case manifest binds exact source/links and confines output; existing source is never staged over',()=>{
 const{m,file}=fixture();try{
  assert.equal(validateCase(file).sourceSha256,m.sourceSha256);
  for(const change of [n=>n.result=n.source,n=>n.sourceSha256='0'.repeat(64),n=>n.links[0].sha256='0'.repeat(64),n=>n.actor.hardSeconds=541,n=>n.command='arbitrary shell']){
   const n=structuredClone(m);change(n);fs.writeFileSync(file,JSON.stringify(n));assert.throws(()=>validateCase(file));
  }
 }finally{cleanup(m.caseRoot);}
});
test('collector refuses competing actor work before native requests or output creation',async()=>{
 const{m}=fixture();let calls=0;try{await assert.rejects(collect(m,'baseline',{async actorRunning(){return true;},async read(){calls++;}}));assert.equal(calls,0);assert(!fs.existsSync(path.join(m.caseRoot,'baseline')));}finally{cleanup(m.caseRoot);}
});
function snapshots(m){
 const labels=['equipment','terminals','ducts','fittings','accessories','flex','titleblocks','viewports','schedule-graphics','text-notes','air-device-tags','equipment-tags','room-tags','space-tags','duct-tags','dimensions','lines','spaces'];
 const b=Object.fromEntries(labels.map(k=>[k,{count:0,items:[],elementIds:[],canonical_attempt_settlement:{attempt:'before'}}]));
 const old={elementId:1,uniqueId:'old-note',text:'EXISTING',ownerViewId:10};b['text-notes']={count:1,items:[old],elementIds:[1]};b['all-text']={items:[old]};b.sheets={items:[{id:10,sheetNumber:'T100'}]};
 b.titleblocks={count:1,elementIds:[4],items:[{elementId:4,ownerViewId:10,geometry:{boundingBox:{min:{x:0,y:0},max:{x:1,y:1}}}}]};b.connectors={results:[{id:100,connectors:[{connectorId:2,index:0,physicalConnectedTo:[{id:200},{id:201}]}]}]};
 const a=structuredClone(b),note={elementId:2,uniqueId:'new-note',textTypeUniqueId:'existing-type',text:'REVIEW NOTE\r',ownerViewId:10,boundingBox:{min:{x:.2,y:.2},max:{x:.8,y:.8}}};
 a['all-text'].items.push(note);a['text-notes'].items.push(note);a['text-notes'].elementIds.push(2);a['text-notes'].count++;
 a.connectors.results[0].connectors[0].index=8;a.connectors.results[0].connectors[0].physicalConnectedTo.reverse();return {b,a};
}
test('annotation grade preserves exact cohorts and graph, rejects unintended changes and outside-paper placement',()=>{
 const{m}=fixture();try{
  for(const [label,change]of [['wrong owner',a=>a['all-text'].items[1].ownerViewId=11],['outside paper',a=>a['all-text'].items[1].boundingBox.max.x=2],['lost old note',a=>a['all-text'].items.shift()],['unrelated model edit',a=>a.equipment.items.push({elementId:8})],['changed physical reference',a=>a.connectors.results[0].connectors[0].physicalConnectedTo.pop()]]){
   const{b,a}=snapshots(m);change(a);assert.throws(()=>gradeAnnotation(m,'after',b,a),label);
  }
  const{b,a}=snapshots(m);assert(gradeAnnotation(m,'after',b,a).nativeScopePassed);assert.throws(()=>gradeAnnotation(m,'after',b,a),'do not overwrite previous grade');
 }finally{cleanup(m.caseRoot);}
});

function mixedSnapshots(m){
 const{b}=snapshots(m);b['spaces-parameters']={items:[{id:99,uniqueId:'space-native-uid',parameters:{Number:'201',Name:'Electrical',Level:'L2',Comments:''},parameterDetails:[{name:'Comments',parameterId:-1010106,storageType:'String',isReadOnly:false,value:'',valueString:''}]}]};
 const a=structuredClone(b),r=a['spaces-parameters'].items[0];r.parameters.Comments='REVIEW';r.parameterDetails[0].value='REVIEW';r.parameterDetails[0].valueString='REVIEW';
 m.expected={number:'201',name:'Electrical',parameter:'Comments',value:'REVIEW'};return{b,a};
}
test('mixed case requires three native parameter projections and preserves all unrelated cohorts',()=>{
 const{m}=fixture();try{
  const good=mixedSnapshots(m);assert.equal(compareMixed(m,good.b,good.a).spaceId,99);
  for(const change of [a=>a['spaces-parameters'].items[0].parameterDetails[0].valueString='',a=>a['spaces-parameters'].items[0].uniqueId='foreign',a=>a['spaces-parameters'].items[0].parameters.Name='Changed',a=>a['spaces-parameters'].items[0].parameterDetails[0].isReadOnly=true,a=>a.connectors.results[0].connectors.pop(),a=>a['all-text'].items[0].text='changed',a=>a['spaces-parameters'].items.push(structuredClone(a['spaces-parameters'].items[0]))]){
   const{b,a}=mixedSnapshots(m);change(a);assert.throws(()=>compareMixed(m,b,a));
  }
 }finally{cleanup(m.caseRoot);}
});
function scheduleSnapshots(m){
 const{b}=snapshots(m);const box={minU:.1,minV:.3,maxU:.6,maxV:.8},placement={instanceId:80,scheduleId:50,point:{u:.1,v:.8},boundingBox:box};
 b['sheet-T100']={sheetElementId:10,placedSchedules:[placement]};
 const geo={min:{x:.1,y:.3,z:0},max:{x:.6,y:.8,z:0},center:{x:.35,y:.55,z:0},size:{x:.5,y:.5,z:0}};
 b['schedule-graphics']={items:[{elementId:80,geometry:{boundingBox:geo}}]};
 b['schedule-50']={schedule:{id:50,uniqueId:'schedule-uid',name:'Spaces'},definitionIdentity:{complete:true,id:50,uniqueId:'schedule-uid'},fields:[{fieldId:7,index:0,name:'Name',isHidden:false,widths:{complete:true,sheetColumnWidthFeet:.5,gridColumnWidthFeet:.5}}],definitionSnapshot:{complete:true,definition:{fields:[{index:0,name:'Name',sheetWidth:.5,gridWidth:.5}],table:[{section:'Body',rows:[{heightFeet:.5,cells:[{text:'Native unchanged value',styleIndex:1}]}]}],sort:[1],tableStyles:[{font:'Arial'}]}},table:{body:{rows:[{cells:['Native unchanged value']}]}}};
 m.expected={sheet:'T100',schedule:'Spaces',field:'Name',widthInches:7.2};const a=structuredClone(b),s=a['schedule-50'];s.fields[0].widths.sheetColumnWidthFeet=.6;s.fields[0].widths.gridColumnWidthFeet=.6;s.definitionSnapshot.definition.fields[0].sheetWidth=.6;s.definitionSnapshot.definition.fields[0].gridWidth=.6;
 a['sheet-T100'].placedSchedules[0].boundingBox.maxU=.7;const g=a['schedule-graphics'].items[0].geometry.boundingBox;g.max.x=.7;g.center.x=.4;g.size.x=.6;return{b,a};
}
test('schedule width permits exact field delta and accounted row reflow; rejects unrelated fields, cells, style, anchors and geometry',()=>{
 const{m}=fixture();try{
  const good=scheduleSnapshots(m);assert.equal(compareSchedule(m,good.b,good.a).scheduleId,50);
  for(const change of [a=>a['schedule-50'].fields[0].widths.gridColumnWidthFeet=.7,a=>a['schedule-50'].definitionSnapshot.definition.sort=[2],a=>a['schedule-50'].table.body.rows[0].cells=['Changed'],a=>a['schedule-50'].definitionSnapshot.definition.tableStyles[0].font='Other',a=>a['sheet-T100'].placedSchedules[0].point.u=.2,a=>a['sheet-T100'].placedSchedules[0].boundingBox.minV=.2,a=>a['schedule-graphics'].items[0].geometry.boundingBox.center.x=0,a=>a.equipment.items.push({id:3}),a=>a['schedule-50'].definitionSnapshot.complete=false]){
   const{b,a}=scheduleSnapshots(m);change(a);assert.throws(()=>compareSchedule(m,b,a));
  }
 }finally{cleanup(m.caseRoot);}
});

function packageSnapshots(m){
 const{b,a}=scheduleSnapshots(m),schedule=structuredClone(m.expected),mixed=mixedSnapshots(m),space=structuredClone(m.expected),notes=snapshots(m);
 b['spaces-parameters']=mixed.b['spaces-parameters'];a['spaces-parameters']=mixed.a['spaces-parameters'];a['all-text']=notes.a['all-text'];a['text-notes']=notes.a['text-notes'];
 m.kind='package';m.expected={note:{text:'REVIEW NOTE',sheet:'T100'},schedule,space};return{b,a};
}
test('package composes only the three independently checked deltas, without mutating evidence or hiding cross-scope edits',()=>{
 const{m}=fixture();try{
  const good=packageSnapshots(m),before=JSON.stringify(good),facts=comparePackage(m,good.b,good.a);assert.equal(facts.note.noteId,2);assert.equal(facts.schedule.scheduleId,50);assert.equal(facts.space.spaceId,99);assert.equal(JSON.stringify(good),before);
  for(const change of [a=>a['all-text'].items[1].ownerViewId=99,a=>a['all-text'].items[0].text='Changed old note',a=>a['spaces-parameters'].items[0].parameterDetails[0].valueString='',a=>a['spaces-parameters'].items[0].parameters.Name='Other',a=>a['schedule-50'].fields[0].widths.gridColumnWidthFeet=.7,a=>a['schedule-50'].definitionSnapshot.definition.tableStyles[0].font='Other',a=>a.connectors.results[0].connectors[0].physicalConnectedTo.pop(),a=>a.equipment.items.push({elementId:999})]){
   const{b,a}=packageSnapshots(m);change(a);assert.throws(()=>comparePackage(m,b,a));
  }
 }finally{cleanup(m.caseRoot);}
});

function finalizationFixture(kind='mixed'){
 const{m}=fixture();let pair;
 if(kind==='annotation')pair=snapshots(m);else if(kind==='schedule')pair=scheduleSnapshots(m);else pair=mixedSnapshots(m);
 m.kind=kind;
 const writeSnapshot=(phase,records,pid,document)=>{
  const dir=path.join(m.caseRoot,phase);fs.mkdirSync(dir);const input={...records,context:{process_id:pid,document:{path:document}}};
  for(const[label,payload]of Object.entries(input))fs.writeFileSync(path.join(dir,label+'.json'),JSON.stringify({status:200,payload}));
  fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({passed:true,phase,processId:pid,document}));
 };
 writeSnapshot('baseline',pair.b,11,m.host);writeSnapshot('after',pair.a,11,m.result);writeSnapshot('reopen',pair.a,22,m.result);
 const b=loadCollection(m,'baseline'),grades=Object.fromEntries(['after','reopen'].map(p=>[p,gradeCase(m,p,b,loadCollection(m,p))]));
 const binding={assignment_id:'assignment',run_id:'run',session_id:'session',generation:1,principal_id:'principal',document_fingerprint:'document'},at='2026-10-26T00:00:00Z';
 const kernel={current_binding:binding,outcome:'complete',terminal:true,quiescent:true,unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],provider_calls:{call:{usage:{input_tokens:1}}},operations:{}};
 const actor={binding:structuredClone(binding),startedAt:at},state={backendSessionId:'session',progress:{startedAt:at},running:false,error:''};
 const canonical={binding:structuredClone(binding),progress:{startedAt:at},outcome:'complete',quiescent:true,unknown:[],inflight:[],pendingProviders:[],providers:1,operations:0};
 const ui={actualSheet:m.expected.sheet??'M002',actualFullSheet:true,actualFocusedContent:true,readable:true,clearOfOtherContent:true,correctDeliveredLinkClicked:true,
  normalOwnedClose:true,usefulCanonicalAnswer:true,writtenFollowupPresent:true,rootContentEdits:0,rootSaves:0,rootActorSteering:0,rootActorNativeReads:0,correctNativeVersion:'2024',
  images:['ordinary-result-ui.png','reopen-target-full.png','reopen-target-focused.png']};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0JcAAAAASUVORK5CYII=','base64');
 for(const p of ui.images)fs.writeFileSync(path.join(m.caseRoot,p),png);
 return{m,input:{actor,kernel,state,canonical,grades,ui}};
}
test('finalizer evidence binds exact annotation, schedule and parameter grade producer files without rewriting inputs',()=>{
 for(const kind of ['annotation','schedule','mixed']){
  const{m,input}=finalizationFixture(kind);try{
   const before=JSON.stringify(input);assert.equal(assertWorkflowFinalizationEvidence(m,input).images.length,3);assert.equal(JSON.stringify(input),before);
   for(const p of ['after','reopen'])assert.equal(input.grades[p].evidenceBinding.actual.phase,p);
  }finally{cleanup(m.caseRoot);}
 }
});
test('exact four finalizer audit defects refuse empty images, foreign actor/UI binding and unrelated positive grade',()=>{
 for(const change of [x=>x.ui.images=[],x=>x.actor.binding.session_id='foreign',x=>x.state.backendSessionId='foreign',x=>x.grades.after={nativeScopePassed:true,phase:'foreign',spaceUniqueId:'foreign'}]){
  const{m,input}=finalizationFixture();try{change(input);assert.throws(()=>assertWorkflowFinalizationEvidence(m,input));}finally{cleanup(m.caseRoot);}
 }
});
test('finalizer keeps control, usage, intervention and truthful delivery refusal neighbors',()=>{
 for(const change of [x=>x.actor.binding.generation++,x=>x.canonical.binding.assignment_id='foreign',x=>x.state.progress.startedAt='2026-01-01T00:00:00Z',
  x=>x.kernel.outcome='blocked',x=>x.kernel.unresolved_unknown_operation_ids.push('unknown'),x=>x.kernel.in_flight_operation_ids.push('inflight'),
  x=>x.kernel.in_flight_provider_call_ids.push('pending'),x=>x.canonical.pendingProviders.push('pending'),x=>x.kernel.provider_calls.call.usage=null,
  x=>x.canonical.providers++,x=>x.ui.rootActorSteering=1,x=>x.ui.writtenFollowupPresent=false,x=>x.ui.correctDeliveredLinkClicked=false,x=>x.ui.actualSheet='foreign',
  x=>x.ui.actualFocusedContent=false,x=>x.ui.correctNativeVersion='2025',x=>x.state.running=true,x=>x.state.error='failed']){
  const{m,input}=finalizationFixture();try{change(input);assert.throws(()=>assertWorkflowFinalizationEvidence(m,input));}finally{cleanup(m.caseRoot);}
 }
});
test('finalizer refuses stale grade phase, altered facts, changed snapshot bytes, source scope or prompt',()=>{
 for(const change of [(m,x)=>x.grades.after.phase='reopen',(m,x)=>x.grades.after.value='foreign',
  (m,x)=>x.grades.after.evidenceBinding.actual.processId=22,(m,x)=>x.grades.after.evidenceBinding.baseline.case.expectedSha256='foreign',
  (m)=>fs.appendFileSync(path.join(m.caseRoot,'after/spaces-parameters.json'),' '),
  (m)=>fs.writeFileSync(m.promptFile,'Different task'),(m)=>m.expected.value='Different requested value',
  (m,x)=>x.grades.after.evidenceBinding=null]){
  const{m,input}=finalizationFixture();try{change(m,input);assert.throws(()=>assertWorkflowFinalizationEvidence(m,input));}finally{cleanup(m.caseRoot);}
 }
});
test('visual presence requires distinct owned result/full/focused PNG files and cannot certify pixels',()=>{
 for(const change of [(m,x)=>x.ui.images[1]=x.ui.images[0],(m,x)=>x.ui.images[1]='../outside-full.png',
  (m,x)=>x.ui.images=x.ui.images.slice(0,2),(m,x)=>fs.writeFileSync(path.join(m.caseRoot,x.ui.images[0]),'not a picture'),
  (m,x)=>fs.writeFileSync(path.join(m.caseRoot,x.ui.images[0]),Buffer.from([137,80,78,71,13,10,26,10]))]){
  const{m,input}=finalizationFixture();try{change(m,input);assert.throws(()=>assertWorkflowFinalizationEvidence(m,input));}finally{cleanup(m.caseRoot);}
 }
});
test('legacy unstamped native grades remain unproven; package cannot borrow single-case finalization',()=>{
 const{m,input}=finalizationFixture();try{
  const legacy=structuredClone(input);delete legacy.grades.after.evidenceBinding;assert.throws(()=>assertWorkflowFinalizationEvidence(m,legacy));
  assert.throws(()=>assertWorkflowFinalizationEvidence({...m,kind:'package'},input),/own whole-request/);
 }finally{cleanup(m.caseRoot);}
});
test('capture format follows actual JPEG bytes under legacy png names; malformed markers and dimensions refuse',()=>{
 // Bounded parser fixture only, not a screenshot or image-semantic proof.
 const header=Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,2,0,3,1,0xff,0xd9,0,0]);
 const jpeg=Buffer.concat([header.subarray(0,12),Buffer.from([0xff,0xd9])]);
 // Include one harmless APP segment to keep the marker fixture at16+ bytes.
 const valid=Buffer.concat([jpeg.subarray(0,2),Buffer.from([0xff,0xe0,0,2]),jpeg.subarray(2)]);
 const{m,input}=finalizationFixture();try{
  const target=path.join(m.caseRoot,input.ui.images[0]);fs.writeFileSync(target,valid);
  assert.deepEqual(assertWorkflowFinalizationEvidence(m,input).images[0].mimeType,'image/jpeg');
  const zero=Buffer.from(valid);zero.writeUInt16BE(0,13);const badSize=Buffer.from(valid);badSize.writeUInt16BE(65535,8);
  for(const broken of [valid.subarray(0,-1),zero,badSize]){fs.writeFileSync(target,broken);assert.throws(()=>assertWorkflowFinalizationEvidence(m,input));}
 }finally{cleanup(m.caseRoot);}
});
test('collection witness producer rejects failed reads, wrong phase, process or document before grading',()=>{
 for(const change of [(m)=>{const p=path.join(m.caseRoot,'after/spaces-parameters.json'),r=JSON.parse(fs.readFileSync(p,'utf8'));r.status=500;fs.writeFileSync(p,JSON.stringify(r));},
  (m)=>{const p=path.join(m.caseRoot,'after/ready.json'),r=JSON.parse(fs.readFileSync(p,'utf8'));r.phase='baseline';fs.writeFileSync(p,JSON.stringify(r));},
  (m)=>{const p=path.join(m.caseRoot,'after/context.json'),r=JSON.parse(fs.readFileSync(p,'utf8'));r.payload.process_id++;fs.writeFileSync(p,JSON.stringify(r));},
  (m)=>{const p=path.join(m.caseRoot,'after/ready.json'),r=JSON.parse(fs.readFileSync(p,'utf8'));r.document='foreign.rvt';fs.writeFileSync(p,JSON.stringify(r));}]){
  const{m}=finalizationFixture();try{change(m);assert.throws(()=>loadCollection(m,'after'));}finally{cleanup(m.caseRoot);}
 }
});
