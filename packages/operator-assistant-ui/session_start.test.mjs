import assert from 'node:assert/strict';
import test from 'node:test';
import {sessionStartPresentation,renderSessionStart} from './task_navigation.mjs';
const task=(id,state='paused',updated='2026-10-08T10:00:00Z')=>({task_id:id,session_id:id,assignment_id:id,title:'Saved '+id,state,updated_at:updated,summary:''});
test('startup separates running work, paused work and uncertain results without auto-resuming',()=>{
 const p=sessionStartPresentation([task('recent','unknown','2026-10-08T11:00:00Z'),task('paused'),task('running','working')]);
 assert.deepEqual(p.rows.map(r=>r.task.task_id),['running','recent','paused']);
 assert.equal(p.rows[0].action,'View running task');assert.equal(p.rows[1].status,'Result needs checking');assert.equal(p.rows[2].status,'Paused');
 assert.match(p.status,/does not resume/);assert.match(p.status,/already running can continue/);
});
test('loading and disconnected discovery do not claim a task is running or safely paused',()=>{
 for(const options of [{loading:true},{unavailable:true}]){
  const p=sessionStartPresentation([task('old','working')],options);assert.equal(p.rows[0].status,'Status not confirmed');assert.equal(p.rows[0].action,'Review saved task');
 }
 assert.match(sessionStartPresentation([],{unavailable:true}).status,/unavailable/);
});
test('recent completed work remains reachable without implying it should restart',()=>{
 const p=sessionStartPresentation([task('done','complete')]);assert.equal(p.rows[0].status,'Complete');assert.equal(p.rows[0].action,'Review saved task');
 assert.equal(sessionStartPresentation(Array.from({length:10},(_,i)=>task(String(i)))).rows.length,3);
});
test('rendering is inert, escapes task titles, preserves unchanged focused buttons and opens only explicit selection',()=>{
 const document={createElement(tag){return {tag,ownerDocument:document,dataset:{},children:[],listeners:{},textContent:'',append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},setAttribute(){},addEventListener(k,fn){this.listeners[k]=fn;}}}};
 const root=document.createElement('section'),rows=[{...task('one'),title:'<img src=x onerror=run()>'}];let opened=[],browsed=0;
 renderSessionStart(root,rows,{},t=>opened.push(t),()=>browsed++);assert.equal(opened.length,0);assert.equal(browsed,0);
 const button=root.children.find(x=>x.className==='sessionStartTask');assert.equal(button.children[0].textContent,rows[0].title);
 renderSessionStart(root,rows,{},t=>opened.push(t),()=>browsed++);assert.equal(root.children.find(x=>x.className==='sessionStartTask'),button);
 button.listeners.click();assert.deepEqual(opened,[rows[0]]);root.children.at(-1).listeners.click();assert.equal(browsed,1);
});