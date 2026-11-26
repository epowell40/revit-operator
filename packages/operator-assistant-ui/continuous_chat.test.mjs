import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {beginComposerSend} from './composer_intake.mjs';
const publicApp=new URL('../../apps/operator-desktop/public/app.js',import.meta.url);
const source=fs.readFileSync(fs.existsSync(publicApp)?publicApp:new URL('../../operator-desktop/public/app.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('elements.chatForm.addEventListener("submit"'),source.indexOf('elements.promptInput.addEventListener("input", scheduleComposerDraftSave);'));
test('Send echoes immediately, retains one chat, and prevents a duplicate during slow preflight',async()=>{
  let submit,release;const held=new Promise(resolve=>release=resolve);const rendered=[],sent=[];
  const state={sessionId:'chat',pendingAttachments:[],attachmentReadsPending:0};
  const goal={_bindingV2:{assignment_id:'old',session_id:'chat',run_id:'run',generation:1}};
  const elements={chatForm:{addEventListener:(_,fn)=>submit=fn},promptInput:{value:'Rename MDP-1'}};
  const context={state,elements,newRequestAfterReport:()=>true,selectedGoal:()=>goal,beginComposerSend,
    setStatus:()=>{},updateControls:()=>{},assertAttachmentTotalSize:()=>{},
    renderMessages:()=>rendered.push(structuredClone(state.sendingMessage)),persistComposerDraft:()=>held,
    assertLoadedBrowserFresh:async()=>{},loadedBrowserIdentity:'browser',
    createChatSubmission:(prompt,attachments)=>({id:'message',text:prompt,attachments,mode:'backend'}),
    assertNewTaskAfterReport:()=>({...goal._bindingV2,review_id:'review'}),
    fetchJson:async path=>path.includes('/executor')?{ok:true,executor:'computer',binding:goal._bindingV2}:{assignment_kernel_v2:{}},
    routeSavedChatSubmission:(s,owner)=>({...s,mode:owner+'-run',newComputerConversation:false}),
    clearChatComposerForSubmission:()=>{elements.promptInput.value='';},beginOptimisticChatSubmission:()=>{},
    sendPrompt:async(s,_,options)=>{sent.push(s);options.onAccepted();},handleChatSubmissionFailure:e=>{throw e;}};
  vm.runInNewContext(handler,context);
  const first=submit({preventDefault(){}});
  assert.equal(rendered[0].text,'Rename MDP-1');assert.equal(rendered[0].sending,true);
  assert.equal(state.composerSubmissionPending,true);
  await submit({preventDefault(){}});assert.equal(sent.length,0);
  release(true);await first;
  assert.equal(sent.length,1);assert.equal(sent[0].nextRequestAfter.session_id,'chat');
  assert.equal(sent[0].newComputerConversation,false);assert.equal(state.sessionId,'chat');
  assert.equal(state.composerSubmissionPending,false);
});

test('rejected late steering removes its pending echo and restores the draft',()=>{
 const start=source.indexOf('function handleChatSubmissionFailure('),end=source.indexOf('function newRequestAfterReport()',start);
 const submission={id:'followup',sessionId:'chat',text:'Keep it short',mode:'computer-interject',transportStarted:true};
 const state={pendingComputerUserMessages:[{id:'followup'}],computerMessages:[{id:'original'},{id:'followup'}]};
 let restored=false,streaming=true;
 const context={state,mayRestoreRejectedChatSubmission:()=>true,restoreChatSubmissionInput:()=>restored=true,
 setStreaming:v=>streaming=v,renderMessages:()=>{},setStatus:()=>{},syncComputerState:async()=>{},syncGoals:async()=>{}};
 vm.runInNewContext(source.slice(start,end)+'; handleChatSubmissionFailure({}, '+JSON.stringify(submission)+');',context);
 assert.equal(restored,true);assert.equal(streaming,false);assert.equal(state.pendingComputerUserMessages.length,0);
 assert.equal(state.computerMessages.length,1);assert.equal(state.computerMessages[0].id,'original');
});
