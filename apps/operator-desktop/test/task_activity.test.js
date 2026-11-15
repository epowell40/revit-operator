import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {taskActivityPresentation} from '../public/conversation_ui.js';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function fn(name){const start=source.indexOf('function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('\n}\n',start)+2);}
test('active computer route presents actual current tool/wait, backend route excludes old computer events',()=>{
 const root={},seen=[],state={streaming:true,activeRunKind:'computer',computerProgress:{currentAction:'native__get_elements'},computerEvents:[{text:'Step 2: running native__execute_csharp.'}]};
 const render=vm.runInNewContext(fn('renderLiveActivity')+';renderLiveActivity',{state,document:{getElementById:()=>root},selectedGoal:()=>null,compactWorkSummary:()=>'',renderTaskActivity:(container,input)=>{assert.equal(container,root);seen.push(taskActivityPresentation(input))},fetch(){throw Error('Activity rendering must not fetch or dispatch work')}});
 render();assert.equal(seen.at(-1).label,'Reading model information…');assert.equal(seen.at(-1).recent.length,1);
 state.activeRunKind='backend';state.agentProgress='Checking the east branch';render();assert.equal(seen.at(-1).label,'Checking the east branch');assert.equal(seen.at(-1).recent.length,0);
 state.streaming=false;render();assert.equal(seen.at(-1).visible,false);
});
test('backend progress events update freshness without creating an assistant answer or claiming completion',()=>{
 const state={};let rendered=0;
 const dispatch=vm.runInNewContext(fn('dispatchBackendSseEvent')+';dispatchBackendSseEvent',{state,renderNextCertifiedReadUi(){},certifiedReadSseFixture(){},renderCompactWork(){rendered++},renderMessages(){throw Error('Progress is not the answer')}});
 const answer={text:''};dispatch({event:'assistant.progress',data:[JSON.stringify({text:'Reading the drawing…'})]},answer);
 assert.equal(state.agentProgress,'Reading the drawing…');assert(state.activityUpdatedAt>0);assert.equal(rendered,1);assert.equal(answer.text,'');
});
test('animation and elapsed ticker add no polling, capture, provider calls or false percent',()=>{
 const tick=source.slice(source.indexOf('// Local animation/timer only:'),source.indexOf('\nfunction showWorkDetails'));
 assert.match(tick,/if \(state.streaming\) renderLiveActivity\(\)/);assert.doesNotMatch(tick,/fetch|refreshScreen|sendPrompt/);
 const css=fs.readFileSync(new URL('../public/conversation.css',import.meta.url),'utf8');assert.match(css,/prefers-reduced-motion: reduce/);
});
