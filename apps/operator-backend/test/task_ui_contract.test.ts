import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

const directory=[path.resolve("../packages/operator-assistant-ui"),path.resolve("../../packages/operator-assistant-ui")].find(root=>fs.existsSync(path.join(root,"task_navigation.mjs")))!;
assert.ok(directory,"Shared task navigation module must be installed in this composition");
const {parseTaskNavigation,groupTasks,taskDraftKey,readNavigationAssignment,currentTaskState}=await import(pathToFileURL(path.join(directory,"task_navigation.mjs")).href);
const {createTaskRunRegistry}=await import(pathToFileURL(path.join(directory,"task_runs.mjs")).href);
const {createComposerDraftStore}=await import(pathToFileURL(path.join(directory,"composer_draft.mjs")).href);

test("C51 completed resumed task supersedes stale paused discovery without hiding uncertainty or another conversation",()=>{
  const task={session_id:"conversation",assignment_id:"task",state:"paused"};
  const goal:any={_sourceKind:"assignment_kernel_v2",_bindingV2:{session_id:"conversation",assignment_id:"task"},_assignmentPhase:"complete"};
  for(const phase of ["complete","complete_with_issues","verified_noop"]){goal._assignmentPhase=phase;assert.equal(currentTaskState(task,goal,"conversation"),"complete");}
  assert.equal(currentTaskState(task,goal,"other"),"paused");
  goal._projection={truth:{outcome_uncertain:true}};assert.equal(currentTaskState(task,goal,"conversation"),"unknown");
  goal._projection={};goal._assignmentPhase="paused";assert.equal(currentTaskState(task,goal,"conversation"),"paused");
  goal._assignmentPhase="awaiting_user_input";assert.equal(currentTaskState(task,goal,"conversation"),"needs_input");
  goal._assignmentPhase="active";goal._canResume=false;assert.equal(currentTaskState(task,goal,"conversation"),"working");
  goal._canResume=true;assert.equal(currentTaskState(task,goal,"conversation"),"ready");
  assert.equal(currentTaskState({...task,state:"unknown"},goal,"conversation"),"unknown");
});

test("saved-task lookup targets the exact older assignment and rejects a foreign conversation or unvalidated publication",async()=>{
  const paths:string[]=[];
  const view={_sourceKind:'assignment_kernel_v2',_assignmentVersion:17,related_session_id:'conversation',_bindingV2:{session_id:'conversation',assignment_id:'older-paused'}};
  const read=async(path:string)=>{paths.push(path);return{assignment_kernel_v2:{validated:true}};};
  assert.deepEqual(await readNavigationAssignment(read,()=>view,'conversation','older-paused'),view);
  assert.deepEqual(paths,['/api/assignments/v2/older-paused']);
  await assert.rejects(readNavigationAssignment(read,()=>view,'foreign','older-paused'),/does not match/);
  await assert.rejects(readNavigationAssignment(read,()=>view,'conversation','newer-complete'),/does not match/);
  await assert.rejects(readNavigationAssignment(read,()=>({...view,_sourceKind:'discovery'}),'conversation','older-paused'),/does not match/);
  await assert.rejects(readNavigationAssignment(read,()=>{throw Error('invalid journal');},'conversation','older-paused'),/invalid journal/);
});

test("task groups expose older working and paused conversations before recent results",()=>{
  const tasks=Array.from({length:100},(_,i)=>({task_id:String(i),session_id:"session"+i,title:"Task "+i,state:"complete",updated_at:new Date(i*1000).toISOString(),summary:"",assignment_id:null}));
  tasks[0].state="working";tasks[1].state="paused";
  const groups=groupTasks(parseTaskNavigation({schema:"revit-operator.task-navigation/v1",tasks}));
  assert.equal(groups[0].items[0].task_id,"0");assert.equal(groups[1].items[0].task_id,"1");assert.equal(groups[2].items[0].task_id,"99");
  assert.throws(()=>parseTaskNavigation({schema:"revit-operator.task-navigation/v1",tasks:[tasks[0],tasks[0]]}),/unavailable/);
});

test("an orphaned in-flight task appears under Needs you rather than as a running worker",()=>{
  const rows=parseTaskNavigation({schema:"revit-operator.task-navigation/v1",tasks:[{task_id:"session:old",session_id:"old",assignment_id:"unfinished",
    title:"Read-only custom diagnostics",state:"unknown",updated_at:"2026-09-14T17:12:15.094Z",summary:"A result needs checking before continuing."}]});
  const groups=groupTasks(rows);assert.deepEqual(groups.map((row:any)=>row.title),["Needs you"]);assert.equal(groups[0].items[0].assignment_id,"unfinished");
});
test("task drafts and redline attachments remain separate under exact tuple keys",async()=>{
  const records=new Map();const store=createComposerDraftStore({storage:{get:async(k:string)=>records.get(k),put:async(k:string,v:any)=>records.set(k,v),delete:async(k:string)=>records.delete(k)}});
  const a=await taskDraftKey("tab:a","room:1",webcrypto),b=await taskDraftKey("tab:a:room","1",webcrypto);
  assert.notEqual(a,b);
  const attachment={id:"pdf",name:"redline.pdf",mimeType:"application/pdf",sizeBytes:3,dataBase64:"YWJj"};
  await store.save(a,{text:"First task",attachments:[attachment],sessionId:"first"});await store.save(b,{text:"Second task",attachments:[],sessionId:"second"});
  assert.deepEqual((await store.load(a)).attachments,[attachment]);await store.clear(b);assert.equal(await store.load(b),null);assert.equal((await store.load(a)).text,"First task");
});

test("clearing the original first-message draft is ordered before a newly allocated conversation can save",async()=>{
  const records=new Map();let release:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  const store=createComposerDraftStore({storage:{get:async(k:string)=>records.get(k),put:async(k:string,v:any)=>{await held;records.set(k,v);},delete:async(k:string)=>records.delete(k)}});
  const empty=await taskDraftKey("tab-first-message","",webcrypto),allocated=await taskDraftKey("tab-first-message","allocated",webcrypto);
  const initial=store.save(empty,{text:"Already sent first question",attachments:[],sessionId:""});
  const cleared=store.save(empty,{text:"",attachments:[],sessionId:""});
  release();await initial;await cleared;
  await store.save(allocated,{text:"Next unsent question",attachments:[],sessionId:"allocated"});
  assert.equal(await store.load(empty),null);assert.equal((await store.load(allocated)).text,"Next unsent question");
});
test("observer detachment cannot cancel, re-admit, or overwrite a task outcome",()=>{
  const registry=createTaskRunRegistry();const run=registry.begin({sessionId:"one",messageId:"initial"});
  const detach=run.attach();detach();detach();assert.equal(run.snapshot().state,"running");assert.equal(run.snapshot().observers,0);
  assert.throws(()=>registry.begin({sessionId:"one",messageId:"different"}),/already working/);
  const again=run.attach();run.finish();again();run.finish(true);assert.equal(run.snapshot().state,"finished");
  assert.throws(()=>registry.begin({sessionId:"one",messageId:"initial"}),/already has a run/);
});
test("stop targets an exact active tuple once and old running work survives recent-history eviction",()=>{
  let stops=0,time=0;const registry=createTaskRunRegistry({retained:2,now:()=>++time});
  const a=registry.begin({sessionId:"a:b",messageId:"c"}),b=registry.begin({sessionId:"a",messageId:"b:c"});a.onStop(()=>stops++);
  assert.equal(registry.requestStop("a:b","c"),true);assert.equal(registry.requestStop("a:b","c"),true);assert.equal(stops,1);assert.equal(b.snapshot().state,"running");
  for(let i=0;i<10;i++)registry.begin({sessionId:"recent",messageId:String(i)}).finish();
  assert.equal(registry.get("a:b","c").state,"stopping");assert.equal(registry.forSession("recent").length,2);
  a.finish();assert.equal(registry.requestStop("a:b","c"),false);
});
