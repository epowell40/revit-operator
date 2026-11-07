import test from 'node:test';import assert from 'node:assert/strict';
import {renderTaskList,renderSessionStart} from './task_navigation.mjs';
function dom(){const document={createElement(tag){return {tag,ownerDocument:document,dataset:{},children:[],listeners:{},attributes:{},textContent:'',append(...v){this.children.push(...v)},replaceChildren(){this.children=[]},setAttribute(k,v){this.attributes[k]=v},addEventListener(k,v){this.listeners[k]=v}}}};return document.createElement('section');}
const task=(id,state)=>({task_id:id,session_id:id,assignment_id:null,title:'Drawing '+id,state,updated_at:'2026-11-07T12:00:00Z',summary:'Retained work'});
test('new workspace keeps old conversations out of the blank main area; examples only prepare text',()=>{
 const root=dom(),selected=[],opened=[];renderSessionStart(root,[task('old','needs_input')],{showSavedWork:false},t=>opened.push(t),()=>{},p=>selected.push(p));
 assert.equal(root.children[0].textContent,'What would you like to work on?');assert.equal(root.children.some(c=>c.className==='sessionStartTask'),false);
 const examples=root.children.find(c=>c.className==='taskExamples');assert.equal(examples.children.length,3);assert.equal(selected.length,0);assert.equal(opened.length,0);
 renderSessionStart(root,[task('changed','complete')],{showSavedWork:false},()=>{},()=>{},()=>{});assert.equal(root.children.find(c=>c.className==='taskExamples'),examples,'Background task polling must not replace focused example buttons');
 examples.children[2].listeners.click();assert.equal(selected.length,1);assert.match(selected[0],/Do not change anything/);assert.equal(opened.length,0);
});
test('sidebar filters retained text, escapes titles, and preserves focused rows on unchanged polling',()=>{
 const root=dom(),tasks=[{...task('A','needs_input'),title:'<img onerror=bad()> Schedule'},task('B','complete')],opened=[];
 renderTaskList(root,tasks,'A',t=>opened.push(t),{query:'schedule'});const section=root.children[0],button=section.children[1];
 assert.equal(button.children[0].textContent,tasks[0].title);assert.equal(button.children[1].textContent,'Needs your input');assert.equal(button.attributes['aria-current'],'page');
 renderTaskList(root,tasks,'A',t=>opened.push(t),{query:'schedule'});assert.equal(root.children[0].children[1],button);assert.equal(opened.length,0);
 button.listeners.click();assert.deepEqual(opened,[tasks[0]]);
 renderTaskList(root,tasks,'A',()=>{},{query:'no match'});assert.equal(root.children[0].textContent,'No matching tasks.');
});
test('unavailable or loading history never presents cached status as confirmed',()=>{
 for(const options of [{loading:true},{unavailable:true}]){
  const root=dom();renderTaskList(root,[task('A','complete')],'',()=>{},options);
  const row=root.children[1].children[1];assert.equal(row.children[1].textContent,'Status not confirmed');assert.equal(row.dataset.taskState,'unknown');
 }
});
