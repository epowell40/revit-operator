import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function fn(name){const i=source.indexOf('function '+name+'('),start=source.slice(i-6,i)==='async '?i-6:i;assert(i>=0);return source.slice(start,source.indexOf('\n}\n',i)+2);}
test('task sidebar docks on wide screens, overlays narrow screens and never executes work',()=>{
 for(const wide of [true,false]){
  const shown=[],saved=[],attrs={},drawer={open:false,show(){shown.push('dock');this.open=true},showModal(){shown.push('overlay');this.open=true},close(){shown.push('close');this.open=false}};
  const open=vm.runInNewContext(fn('setTaskSidebarOpen')+';setTaskSidebarOpen',{
   document:{querySelector:id=>id==='#taskDrawer'?drawer:{setAttribute(k,v){attrs[k]=v}}},window:{matchMedia:()=>({matches:wide})},localStorage:{setItem:(...v)=>saved.push(v)},renderTaskHistory(){},fetch(){throw Error('UI preference cannot execute work')}});
  open(true);assert.deepEqual(shown,[wide?'dock':'overlay']);assert.equal(attrs['aria-expanded'],'true');
  open(false);assert.equal(drawer.open,false);assert.equal(attrs['aria-expanded'],'false');assert.equal(saved.length,2);
 }
});
test('example selection prepares a draft without submitting or overwriting existing text',()=>{
 const state={sessionId:'',streaming:false,taskNavigation:[],taskCatalogueLoading:false,taskCatalogueUnavailable:false},container={};let callback,saved=0,focus=0;
 const elements={promptInput:{value:'',focus(){focus++}}};
 const render=vm.runInNewContext(fn('renderSessionStartScreen')+';renderSessionStartScreen',{
  state,elements,activeMessages:()=>[],document:{querySelector:()=>container},
  renderSessionStart(_container,_tasks,options,_open,_browse,onExample){assert.equal(options.showSavedWork,false);callback=onExample},scheduleComposerDraftSave(){saved++},fetch(){throw Error('Example cannot send work')}});
 render();callback('Check the current model');assert.equal(elements.promptInput.value,'Check the current model');assert.equal(saved,1);
 elements.promptInput.value='My unsent request';callback('Other example');assert.equal(elements.promptInput.value,'My unsent request');assert.equal(saved,1);assert.equal(focus,2);
});
test('opening another conversation while a computer task works does not stop, reset or resume it',async()=>{
 const state={sessionId:'working',streaming:true,activeRunKind:'computer',taskNavigationEpoch:0,captureState:{},pendingAttachments:[],backendMessages:[],computerMessages:[],computerEvents:[]};
 let saved=0,history=0,rendered=0;const noop=()=>{};
 const open=vm.runInNewContext(fn('openTaskConversation')+';openTaskConversation',{
  state,composerDraftRevision:0,elements:{promptInput:{value:'Unsent work',focus:noop}},selectedGoal:()=>null,document:{querySelector:()=>({matches:()=>false})},localStorage:{setItem:noop},
  updateControls:noop,persistComposerDraft:async()=>{saved++;return true},setSession:id=>{state.sessionId=id},setStreaming:v=>{state.streaming=v},showComposerNotice:noop,
  renderAttachStrip:noop,renderMessages:noop,renderEvents:noop,renderGoalPanel:noop,renderWorkReturnPanel:noop,renderTaskHistory:()=>rendered++,restoreComposerDraft:async()=>{},
  restoreConversationHistory:async()=>history++,setStatus:noop,syncGoals:async()=>{},syncTaskNavigation:async()=>{},fetchJson(){throw Error('Navigation must not send any command')}});
 await open({session_id:'saved-other',assignment_id:null});assert.equal(saved,1);assert.equal(state.sessionId,'saved-other');assert.equal(history,1);assert.equal(rendered,1);assert.equal(state.taskNavigationEpoch,1);
});
