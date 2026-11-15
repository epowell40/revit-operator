import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function fn(name){const at=src.indexOf('function '+name+'(');assert(at>=0);return (name==='submitFeedback'?'async ':'')+src.slice(at,src.indexOf('\n}\n',at)+2);}
test('visible feedback sends exact selected task and survives navigation during a request',async()=>{
 const binding={assignment_id:'a',session_id:'s',run_id:'r',generation:1};
 let goal={_sourceKind:'assignment_kernel_v2',_bindingV2:binding},finish,posted;
 const state={sessionId:'s',streaming:false},elements={fbNote:{value:'Missing tag'},feedbackBar:{classList:{remove(){}}}};
 const submit=vm.runInNewContext(fn('submitFeedback')+';submitFeedback',{state,elements,selectedGoal:()=>goal,
  fetchJson:async(url,options)=>{posted=JSON.parse(options.body);await new Promise(r=>{finish=r;});return{};},setStatus(){},appendActivityEvent(){},renderEvents(){}});
 const pending=submit('partial');assert.deepEqual(posted.task_binding,binding);
 state.sessionId='new';elements.fbNote.value='New task note';finish();await pending;assert.equal(elements.fbNote.value,'New task note');
 await assert.rejects(submit('failed'),/Reopen/);
 goal={_sourceKind:'assignment_kernel_v2'};await assert.rejects(submit('failed'),/Reopen/);
});
test('feedback is beside answers, outside settings, and hidden during execution or blank chat',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert(html.indexOf('id="feedbackBar"')>html.indexOf('id="messages"'));
 const state={sessionId:'s',streaming:false};let visible,answer='Done';
 const update=vm.runInNewContext(fn('updateFeedbackBarVisibility')+';updateFeedbackBarVisibility',{state,latestAssistantMessage:()=>answer,elements:{feedbackBar:{classList:{toggle:(_c,v)=>visible=v}}}});
 update();assert.equal(visible,true);state.streaming=true;update();assert.equal(visible,false);state.streaming=false;answer='';update();assert.equal(visible,false);
});
