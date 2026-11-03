import test from 'node:test';import assert from 'node:assert/strict';
import {executionOrientation,executionOrientationInput} from './execution_orientation.mjs';
const now=Date.parse('2026-10-28T02:00:00Z');
const fixture=()=>({revit:{schema:'revit-operator.context.v1',source:{live:true},observed_at_utc:new Date(now-1000).toISOString(),process_id:42,version:'2024',username:'not-for-prompt',write_grant:{secret:'not-for-prompt'},document:{title:'Model',path:'C:/workspace/model.rvt',projectIdentity:{fingerprint:'identity'},activeView:{id:7,name:'M103',type:'DrawingSheet'},selection:[11,12]}}});
test('fresh bounded host orientation is data, contains no grants, and does not mutate input',()=>{
 const f=fixture(),before=JSON.stringify(f),p=executionOrientation(f,now);
 assert.equal(p.active_view.id,7);assert.deepEqual(p.selection,{ids:[11,12],count:2,truncated:false});assert.equal(p.verification_authority,false);
 assert.doesNotMatch(JSON.stringify(p),/not-for-prompt|write_grant|username/);assert.equal(JSON.stringify(f),before);
 assert.deepEqual(JSON.parse(executionOrientationInput(f,now).content[0].text),p);
});
test('stale, future, failed, missing and malformed observations are omitted without a refresh',()=>{
 for(const mutate of [f=>f.revit.observed_at_utc=new Date(now-5001).toISOString(),f=>f.revit.observed_at_utc=new Date(now+1).toISOString(),f=>f.revit.source.live=false,f=>f.revit.source.error='unavailable',f=>f.revit.process_id=0,f=>f.revit.document.projectIdentity.fingerprint='',f=>f.revit.document.activeView.id=0,f=>f.revit.document.activeView.name='x'.repeat(261)]){const f=fixture();mutate(f);assert.equal(executionOrientationInput(f,now),null);}
 for(const f of [null,{},[],{revit:{}}])assert.equal(executionOrientation(f,now),null);
});
test('selection caps and absent versus empty remain explicit',()=>{
 const f=fixture();f.revit.document.selection=Array.from({length:30},(_,i)=>i+1);const p=executionOrientation(f,now);assert.equal(p.selection.ids.length,20);assert.equal(p.selection.count,30);assert(p.selection.truncated);
 f.revit.document.selection=[];assert.deepEqual(executionOrientation(f,now).selection,{ids:[],count:0,truncated:false});
 for(const selection of [undefined,[1,1],['1'],[NaN]]){f.revit.document.selection=selection;assert.equal(executionOrientation(f,now).selection,null);}
});
