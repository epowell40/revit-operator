import test from 'node:test';
import assert from 'node:assert/strict';
import {taskActivityPresentation, renderTaskActivity} from './conversation_ui.mjs';
const now=Date.parse('2026-11-07T16:00:00Z');
const running={running:true,startedAt:now-70000,now,progress:{currentAction:'Waiting for the next model response',updatedAt:new Date(now-1000).toISOString()},lastSeenAt:now};
test('old progress never animates a completed or paused task',()=>{
 for(const running of [false,undefined]) assert.equal(taskActivityPresentation({running,progress:{phase:'working',currentAction:'Editing'},now}).visible,false);
});
test('active task has a truthful wait, elapsed time and no invented percentage',()=>{
 const p=taskActivityPresentation(running);assert.equal(p.visible,true);assert.equal(p.label,'Waiting for the agent’s response…');assert.equal(p.elapsed,'1m 10s elapsed');assert.equal('percent' in p,false);assert.equal(p.tone,'working');
});
test('long silence and connection loss are explicit; polling is not productive progress',()=>{
 const p=taskActivityPresentation({...running,progress:{...running.progress,updatedAt:new Date(now-90000).toISOString()}});
 assert.match(p.detail,/No new activity for 1m 30s/);assert.equal(p.tone,'waiting');
 const lost=taskActivityPresentation({...running,connectionLost:true});assert.equal(lost.tone,'waiting');assert.match(lost.label,/Connection interrupted/);assert.doesNotMatch(lost.label,/complete|failed/i);
});
test('brief model updates and bounded recent actual events; raw code stays in Details',()=>{
 const p=taskActivityPresentation({...running,agentProgress:'Checking the east branch\n before continuing.',events:[
 {text:'Step 1: running revit_execute_csharp.'},{text:'Read active Revit context: Model / L2.'},{text:'Function tool x failed: raw private data'},{text:'Captured screenshot 1920x1080.'},{text:'Captured screenshot 1920x1080.'}]});
 assert.equal(p.label,'Checking the east branch before continuing.');assert(p.recent.includes('Running a Revit operation…'));assert(p.recent.includes('Inspecting the current view…'));assert(p.recent.length<=4);assert.equal(new Set(p.recent).size,p.recent.length);assert(!JSON.stringify(p.recent).includes('raw private'));
});
function dom(){const doc={createElement(tag){return{tag,ownerDocument:doc,children:[],dataset:{},attributes:{},append(...xs){this.children.push(...xs)},replaceChildren(...xs){this.children=xs},setAttribute(k,v){this.attributes[k]=v},textContent:''}}};return doc.createElement('section');}
test('render uses safe text, preserves expanded history on ticks and hides after stop',()=>{
 const root=dom();renderTaskActivity(root,{...running,agentProgress:'<img onerror=bad()> Checking'});const nodes=root._activityNodes;assert.equal(nodes.label.textContent,'<img onerror=bad()> Checking');nodes.details.open=true;
 renderTaskActivity(root,{...running,now:now+1000});assert.equal(root._activityNodes,nodes);assert.equal(nodes.details.open,true);
 renderTaskActivity(root,{running:false});assert.equal(root.hidden,true);assert.equal(root.dataset.tone,'idle');
});
