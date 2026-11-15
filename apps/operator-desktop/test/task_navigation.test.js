import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {taskDraftKey} from '../public/task_navigation.mjs';
import {createComposerDraftStore,staleComposerNotice,saveComposerRefreshTarget,readComposerRefreshTarget,clearComposerRefreshTarget} from '../public/composer_draft.mjs';
import {beginComposerSend} from '../public/composer_intake.mjs';
import {savedAssignmentNavigationTargetV2} from '../assignment_mutation.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function body(name){const start=source.indexOf('async function '+name+'(');assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}\n',start)+2);}
function memoryStore(){const records=new Map();return createComposerDraftStore({storage:{get:async k=>records.get(k),put:async(k,v)=>records.set(k,structuredClone(v)),delete:async k=>records.delete(k)}});}

test('opening the newest task retains the older same-conversation task in selectable history without changing the current target',async()=>{
  const row=(id,version)=>({id:'goal:'+id,updated_at:'2026-10-16T04:35:42Z',_sourceKind:'assignment_kernel_v2',_sourceRecordId:id,_assignmentVersion:version,_bindingV2:{assignment_id:id,session_id:'same',run_id:'run:'+id,generation:1}});
  const current=row('newer',17),older=row('older',4),state={resetting:false,streaming:false,goalsSyncRequestId:0,sessionId:'same',taskNavigationAssignmentId:'newer',activeGoalId:'',goals:[],goalSelectionPinned:false};
  const sync=runInNewContext(body('syncGoals')+';syncGoals',{
    state,URLSearchParams,refreshAssignmentRevitContext:async()=>null,
    fetchJson:async route=>route.includes('/task?')?{assignment:current}:{assignments:[current,older]},
    readSavedAssignmentHistoryV2:async()=>({assignments:[current,older]}),
    assignmentProjectionToGoalView:v=>v,retainNewerAssignmentViewsV2:incoming=>incoming,
    chooseCurrentAssignment(){throw Error('Explicit target must remain current');},assignmentIsNewer:()=>false,
    renderGoalPanel(){},syncVerifiedWorkPacket:async()=>{},selectedGoal:()=>state.goals.find(v=>v.id===state.activeGoalId),renderCompactWork(){}});
  await sync();assert.deepEqual(Array.from(state.goals,v=>v.id).sort(),['goal:newer','goal:older']);
  assert.equal(state.activeGoalId,'goal:newer');assert.equal(state.taskNavigationAssignmentId,'newer');assert.equal(state.goalSelectionPinned,false);
});

test('explicit saved-task action navigates only the selected canonical history and never sends or resumes it',async()=>{
  const selected={id:'goal:older',_sourceKind:'assignment_kernel_v2',_sourceRecordId:'older',_assignmentVersion:4,
    _bindingV2:{assignment_id:'older',session_id:'same',run_id:'original-run',generation:1}};
  for(const scenario of ['open','not-history','streaming','resetting','resume-pending','foreign','legacy']){
    const calls=[],state={sessionId:'same',goalSelectionPinned:scenario!=='not-history',streaming:scenario==='streaming',resetting:scenario==='resetting',assignmentResumePending:scenario==='resume-pending'};
    const goal=scenario==='foreign'?{...selected,_bindingV2:{...selected._bindingV2,session_id:'other'}}:scenario==='legacy'?{...selected,_sourceKind:'goal'}:selected;
    const action=runInNewContext(body('openSelectedSavedAssignmentV2')+';openSelectedSavedAssignmentV2',{
      state,selectedGoal:()=>goal,savedAssignmentNavigationTargetV2,setStatus(){},
      openTaskConversation:async target=>calls.push(target),runGoalControl(){throw Error('Opening never resumes work');},fetchJson(){throw Error('Opening does not send a new request');}});
    await action();assert.equal(calls.length,scenario==='open'?1:0,scenario);
    if(calls.length)assert.deepEqual(calls[0],{session_id:'same',assignment_id:'older'});
  }
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/id="goalOpenSavedTaskButton"[^>]*hidden>Open this saved task/);
  assert.match(source,/elements\.goalOpenSavedTaskButton\?\.addEventListener\("click", \(\) => openSelectedSavedAssignmentV2\(\)/);
  assert.match(source,/querySelector\("#taskResumeButton"\)\.hidden = state\.streaming \|\| state\.goalSelectionPinned/);
});

test('opening selected history in the same conversation reloads the exact older task without Resume or a new request',async()=>{
  const binding={assignment_id:'older',session_id:'same',run_id:'original-run',generation:1};
  const selected={_bindingV2:binding};
  const state={sessionId:'same',goalSelectionPinned:true,captureState:{},pendingAttachments:[],backendMessages:[],computerMessages:[],computerEvents:[],taskNavigationEpoch:0};
  const storage=new Map(),reads=[];let saved=0;
  const context={state,elements:{promptInput:{value:'Keep my unsent draft',focus(){}}},composerDraftRevision:0,
    selectedGoal:()=>selected,document:{querySelector:()=>({close(){}})},
    localStorage:{setItem:(key,value)=>storage.set(key,value)},
    async persistComposerDraft(){saved++;return true;},async restoreComposerDraft(){},
    setSession:id=>{state.sessionId=id;},setStreaming(){},setStatus(){},updateControls(){},showComposerNotice(){},
    renderAttachStrip(){},renderMessages(){},renderEvents(){},renderGoalPanel(){},renderWorkReturnPanel(){},renderTaskHistory(){},
    async restoreConversationHistory(){},async syncGoals(){reads.push(state.taskNavigationAssignmentId);},async syncTaskNavigation(){},
    fetchJson(){throw Error('Opening saved history must never execute or Resume');}};
  const open=runInNewContext(body('openTaskConversation')+';openTaskConversation',context);
  await open({session_id:'same',assignment_id:'older'});
  assert.equal(saved,1,'Persist the composer draft before navigating');
  assert.equal(state.goalSelectionPinned,false);
  assert.equal(state.taskNavigationAssignmentId,'older');
  assert.deepEqual(JSON.parse(storage.get('operator-desktop.task-target')),['same','older']);
  assert.deepEqual(reads,['older']);
});

test('C51 sending the first message clears the original New Chat key before session allocation, retaining neighboring drafts',async()=>{
  const store=memoryStore(),tab='first-message-test';let handler,sent=0;
  const attachment={id:'pdf',name:'markup.pdf',mimeType:'application/pdf',sizeBytes:3,dataBase64:'YWJj'};
  const state={sessionId:'',pendingAttachments:[attachment],backendMessages:[]};
  const elements={chatForm:{addEventListener(_event,fn){handler=fn;}},promptInput:{value:'Is this the mechanical model?',focus(){}}};
  await store.save(await taskDraftKey(tab,'other-task'),{text:'Other unsent work',attachments:[attachment],sessionId:'other-task'});
  const start=source.indexOf('elements.chatForm.addEventListener("submit", async (event) => {'),end=source.indexOf('\n});',start)+4;
  const clearStart=source.indexOf('function clearChatComposerForSubmission('),clearEnd=source.indexOf('\n}\n',clearStart)+2;
  const context={state,elements,composerDraftStore:store,composerDraftKey:tab,composerDraftTimer:null,taskDraftKey,clearTimeout,
    beginComposerSend,pausedTaskAcceptsDirection:()=>false,selectedGoal:()=>null,loadedBrowserIdentity:'current',async assertLoadedBrowserFresh(){},
    setStatus(){},updateControls(){},renderAttachStrip(){},updateFeedbackBarVisibility(){},scheduleComposerDraftSave(){},showComposerNotice(){},
    createChatSubmission:(text,attachments)=>({rawPrompt:text,text,attachments}),beginOptimisticChatSubmission(){},
    async sendPrompt(){sent++;state.sessionId='allocated-session';},handleChatSubmissionFailure(error){throw error;}};
  runInNewContext([body('persistComposerDraft'),source.slice(clearStart,clearEnd),source.slice(start,end)].join('\n'),context);
  await handler({preventDefault(){}});
  assert.equal(sent,1);assert.equal(await store.load(await taskDraftKey(tab,'')),null);
  assert.equal((await store.load(await taskDraftKey(tab,'other-task'))).text,'Other unsent work');
  assert.deepEqual((await store.load(await taskDraftKey(tab,'other-task'))).attachments,[attachment]);
});

test('reopening the UI restores the selected saved task only for its exact conversation',()=>{
  const start=source.indexOf('function setSession('),end=source.indexOf('\n}\n',start)+2;
  const state={sessionId:''},storage=new Map([['operator-desktop.task-target',JSON.stringify(['same-chat','older-paused'])]]);
  const set=runInNewContext(source.slice(start,end)+';setSession',{state,STORAGE_KEY:'session',
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    elements:{sessionBadge:{}},updateFeedbackBarVisibility(){}});
  set('same-chat');assert.equal(state.taskNavigationAssignmentId,'older-paused');
  set('different-chat');assert.equal(state.taskNavigationAssignmentId,'');
});

test('opening another task saves the old redline draft, detaches its observer, and restores the target conversation without executing work',async()=>{
  const store=memoryStore(),tab='task-test-tab';let detached=0,session='old';const statuses=[];
  const oldAttachment={id:'redline',name:'markup.pdf',mimeType:'application/pdf',sizeBytes:3,dataBase64:'YWJj'};
  await store.save(await taskDraftKey(tab,'new'),{text:'Next room',attachments:[],sessionId:'new'});
  const state={sessionId:'old',streaming:true,activeRunKind:'backend',backendAbortController:{abort(){detached++;}},pendingAttachments:[oldAttachment],
    captureState:{},computerSyncRequestId:0,goalsSyncRequestId:0,verifiedWorkPacketRequestId:0,
    focusedBatchJobId:'old-batch',desktopCaptureSuppressed:true,computerRunSubmissionPending:false};
  const elements={promptInput:{value:'Check this markup',focus(){} }};
  const bindings={state,elements,composerDraftStore:store,composerDraftKey:tab,composerDraftTimer:null,composerDraftRevision:0,
    taskDraftKey,crypto:webcrypto,clearTimeout,localStorage:{getItem:()=>session},STORAGE_KEY:'session',document:{querySelector:()=>({close(){}})},
    setSession(id){state.sessionId=id;session=id;},setStreaming(value){state.streaming=value;},setStatus:text=>statuses.push(text),
    updateControls(){},showComposerNotice(){},renderAttachStrip(){},renderMessages(){},renderEvents(){},renderGoalPanel(){},renderWorkReturnPanel(){},renderTaskHistory(){},updateFeedbackBarVisibility(){},
    async restoreConversationHistory(){state.backendMessages=[{role:'assistant',text:'Saved answer in '+session}];},async syncGoals(){},async syncTaskNavigation(){},taskStateLabel:value=>value,
    fetchJson(){throw Error('Opening a task must not execute or reset work');}};
  const open=runInNewContext([body('persistComposerDraft'),body('restoreComposerDraft'),body('openTaskConversation'),'openTaskConversation'].join('\n'),bindings);
  await open({session_id:'new',assignment_id:null,state:'paused'});
  assert.equal(detached,1);assert.equal(state.sessionId,'new');assert.equal(elements.promptInput.value,'Next room');
  assert.equal(state.backendMessages[0].text,'Saved answer in new');
  assert.equal((await store.load(await taskDraftKey(tab,'old'))).text,'Check this markup');
  assert.deepEqual((await store.load(await taskDraftKey(tab,'old'))).attachments,[oldAttachment]);
  assert.equal(state.focusedBatchJobId,'','an unrelated batch must not appear as work in the newly selected conversation');
  assert.equal(state.desktopCaptureSuppressed,true,'navigation cannot release server-owned capture suppression for background work');
});

test('intentional Refresh then fresh-page bootstrap recovers the exact conversation PDF without Resume or resend',async()=>{
  const store=memoryStore(),tab='refresh-test-tab',records=new Map();let reloads=0,historyReads=0;
  const attachment={id:'original',name:'marked.pdf',mimeType:'application/pdf',sizeBytes:3,dataBase64:'YWJj'};
  const state={sessionId:'saved',pendingAttachments:[attachment],captureState:{},taskNavigationEpoch:0};
  const elements={promptInput:{value:'Fix the marked overlap',focus(){}}};
  const sessionStorage={getItem:k=>records.get(k),setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
  const context={state,elements,sessionStorage,saveComposerRefreshTarget,readComposerRefreshTarget,clearComposerRefreshTarget,
    composerDraftStore:store,composerDraftKey:tab,composerDraftTimer:null,composerDraftRevision:0,taskDraftKey,clearTimeout,
    window:{location:{reload(){reloads++;}}},localStorage:{setItem(){}},document:{querySelector:()=>({close(){}})},
    setSession(id){state.sessionId=id;},setStreaming(v){state.streaming=v;},setStatus(){},updateControls(){},showComposerNotice(){},staleComposerNotice,
    renderAttachStrip(){},renderMessages(){},renderEvents(){},renderGoalPanel(){},renderWorkReturnPanel(){},renderTaskHistory(){},updateFeedbackBarVisibility(){},
    async restoreConversationHistory(){historyReads++;},async syncGoals(){},async syncTaskNavigation(){},
    fetchJson(){throw Error('Refresh must not Resume, authorize or send');}};
  const api=runInNewContext(['persistComposerDraft','restoreComposerDraft','openTaskConversation','refreshComposerPage','restoreComposerAfterRefresh']
    .map(body).join('\n')+';({refreshComposerPage,restoreComposerAfterRefresh})',context);
  await api.refreshComposerPage();assert.equal(reloads,1);assert.equal(readComposerRefreshTarget(sessionStorage,tab).sessionId,'saved');
  // Actual startup initializes a fresh conversation, unlike the old reload fixture.
  state.sessionId='';state.pendingAttachments=[];elements.promptInput.value='';
  await api.restoreComposerAfterRefresh();
  assert.equal(state.sessionId,'saved');assert.equal(elements.promptInput.value,'Fix the marked overlap');assert.deepEqual(state.pendingAttachments,[attachment]);
  assert.equal(historyReads,1);assert.equal(readComposerRefreshTarget(sessionStorage,tab),null);
  assert.equal((await store.load(await taskDraftKey(tab,'saved'))).attachments[0].dataBase64,'YWJj');
  await api.restoreComposerAfterRefresh();assert.equal(historyReads,1,'one-shot navigation intent');
});

test('late stream events from the previous task cannot alter the selected conversation',async()=>{
  const state={sessionId:'old',backendMessageId:'first'};let callback,dispatches=0;
  const stream=runInNewContext(body('streamBackendChat')+';streamBackendChat',{state,loadedBrowserIdentity:'identity',
    fetch:async()=>({ok:true,body:{getReader(){return{};}}}),consumeAuthoritativeBackendSse:async(_reader,onEvent)=>{callback=onEvent;},
    dispatchBackendSseEvent(){dispatches++;}});
  await stream({session_id:'old',message_id:'first'},{},{});
  state.sessionId='new';state.backendMessageId='second';callback({event:'assistant.replace',data:['{"text":"Old answer"}']});assert.equal(dispatches,0);
});

test('retrying a lost steering response preserves the saved command id and original provider-turn fence',async()=>{
  const commands=[],statuses=[],store=memoryStore();let attempts=0;
  const binding={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1};
  const state={sessionId:'session',pendingAttachments:[]},elements={promptInput:{value:'Start with the north wing'}};
  const submit=runInNewContext(body('submitTaskDirection')+';submitTaskDirection',{state,elements,composerDraftStore:store,composerDraftKey:'steering-test-tab',taskDraftKey,crypto:webcrypto,
    updateControls(){},async persistComposerDraft(){return true;},async assertLoadedBrowserFresh(){},loadedBrowserIdentity:'identity',async syncGoals(){},selectedGoal:()=>({_bindingV2:binding}),
    async restoreConversationHistory(){},setStatus:text=>statuses.push(text),async showStaleComposerNotice(){},
    async fetchJson(url,options){
      if(url.endsWith('/turn-control'))return{active_turn:{turn_id:attempts ? 'newer-turn' : 'original-turn'}};
      const command=JSON.parse(options.body);commands.push(command);attempts++;
      if(attempts===1)throw Error('Response connection lost');return{receipt:{state:'accepted'}};
    }});
  await submit();assert.equal(elements.promptInput.value,'Start with the north wing');assert.equal(commands.length,1);
  await submit();assert.equal(commands.length,2);assert.equal(commands[0].command_id,commands[1].command_id);assert.equal(commands[1].expected_turn_id,'original-turn');
  assert.equal(elements.promptInput.value,'');assert.equal(statuses.at(-1),'Direction saved.');
  elements.promptInput.value='Start with the north wing';await submit();
  assert.notEqual(commands[2].command_id,commands[1].command_id,'an intentional later direction gets its own identity after confirmed acceptance');
});

test('a paused bound task accepts directions while remaining paused; an unrelated conversation does not',()=>{
  const start=source.indexOf('function pausedTaskAcceptsDirection('),end=source.indexOf('\n}\n',start)+2;
  const state={sessionId:'paused-task',streaming:false};const goal={_bindingV2:{session_id:'paused-task'},_assignmentPhase:'paused'};
  const eligible=runInNewContext(source.slice(start,end)+';pausedTaskAcceptsDirection',{state,selectedGoal:()=>goal});
  assert.equal(eligible(),true);assert.equal(state.streaming,false);
  state.sessionId='another-task';assert.equal(eligible(),false);
  state.sessionId='paused-task';goal._assignmentPhase='complete';assert.equal(eligible(),false);
});

test('a delayed new-conversation response cannot replace the task the user just opened',async()=>{
  let resolve;const state={sessionId:'',taskNavigationEpoch:1};
  const ensure=runInNewContext(body('ensureSession')+';ensureSession',{state,fetchJson:()=>new Promise(done=>{resolve=done;}),setSession(id){state.sessionId=id;}});
  const pending=ensure();state.taskNavigationEpoch++;state.sessionId='selected-task';resolve({session_id:'obsolete-new-session'});
  await assert.rejects(pending,/selected conversation changed/);assert.equal(state.sessionId,'selected-task');
});

test('progressive task history renders initial rows immediately and final status from split network chunks',async()=>{
  const initial={schema:'revit-operator.task-navigation/v1',loading:true,tasks:[]},final={...initial,loading:false};
  const bytes=new TextEncoder().encode(JSON.stringify(initial)+'\n'+JSON.stringify(final)+'\n');
  const chunks=[bytes.slice(0,17),bytes.slice(17,90),bytes.slice(90)];const shown=[];let canceled=0;
  const state={taskCatalogueBusy:false,taskNavigationUpdatedAt:0};
  const load=runInNewContext(body('loadTaskCatalogue')+';loadTaskCatalogue',{state,loadedBrowserIdentity:'current',TextDecoder,
    fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>chunks.length?{value:chunks.shift(),done:false}:{done:true},cancel:async()=>{canceled++;}})}}),
    renderSessionStartScreen(){},showTaskCatalogue:page=>shown.push(page),document:{querySelector:()=>({open:false})}});
  await load();assert.deepEqual(shown.map(page=>page.loading),[true,false]);assert.ok(state.taskNavigationUpdatedAt>0);assert.equal(state.taskCatalogueBusy,false);assert.equal(canceled,1);
});

test('an expensive history refresh never holds up polling the active task',async()=>{
  let started=0,polled=0;const state={sessionId:'current',taskNavigationUpdatedAt:0,taskNavigationBusy:false};
  const sync=runInNewContext(body('syncTaskNavigation')+';syncTaskNavigation',{state,document:{querySelector:()=>({open:false})},
    loadTaskCatalogue:()=>{started++;return new Promise(()=>{});},fetchJson:async()=>{polled++;return{active_run:null};},setStreaming(){},renderCompactWork(){}});
  await sync();assert.equal(started,1);assert.equal(polled,1);assert.equal(state.taskNavigationBusy,false);
  state.taskNavigationUpdatedAt=Date.now()-20000;await sync();assert.equal(started,1);assert.equal(polled,2);
});

test('Pause during intake stops the new message instead of targeting the previous completed assignment',async()=>{
  const calls=[];const state={sessionId:'same-chat',backendMessageId:'new-message',streaming:true,activeRunKind:'backend'};
  const stop=runInNewContext(body('stopComputerRun')+';stopComputerRun',{state,
    selectedGoal:()=>({_bindingV2:{session_id:'same-chat',assignment_id:'previous'},_canPause:false,_assignmentPhase:'complete'}),
    async syncGoals(){},async runCanonicalGoalControl(){calls.push('wrong-previous-task');},
    async fetchJson(url,options){calls.push({url,body:JSON.parse(options.body)});},setStatus(){}});
  await stop();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/chat/stop');assert.equal(calls[0].body.message_id,'new-message');
});

test('Pause refreshes task identity and refuses to control a conversation selected during that refresh',async()=>{
  let finish,effects=0;const state={sessionId:'first-chat',backendMessageId:'first-message',streaming:true,activeRunKind:'backend'};
  const stop=runInNewContext(body('stopComputerRun')+';stopComputerRun',{state,
    selectedGoal:()=>({_bindingV2:{session_id:'first-chat'},_canPause:true}),syncGoals:()=>new Promise(resolve=>{finish=resolve;}),
    async runCanonicalGoalControl(){effects++;},async fetchJson(){effects++;},setStatus(){}});
  const pending=stop();assert.equal(effects,0);state.sessionId='second-chat';finish();await pending;assert.equal(effects,0);
});

test('startup selects a new conversation, leaving saved task history inert',()=>{
 const state={sessionId:'',taskNavigationAssignmentId:'old-task'};let selected=null,rendered=0;
 const start=source.indexOf('function initializeFreshConversation('),end=source.indexOf('\n}\n',start)+2;
 const init=runInNewContext(source.slice(start,end)+';initializeFreshConversation',{state,setSession(id){selected=id;state.sessionId=id;},renderSessionStartScreen(){rendered++;}});
 init();assert.equal(selected,'');assert.equal(state.taskNavigationAssignmentId,'');assert.equal(rendered,1);
 const bootstrap=source.slice(source.lastIndexOf('beginNonBlockingBootstrapServices({'));
 assert.doesNotMatch(bootstrap.slice(0,bootstrap.indexOf('startPolling:')),/restoreConversationHistory|localStorage/);
 assert.ok(source.lastIndexOf('initializeFreshConversation();')<source.lastIndexOf('await restoreComposerDraft();'));
});
test('fresh composer never restores a previous task draft or pending resume command from localStorage',async()=>{
 const store=memoryStore(),tab='restart-tab',state={sessionId:'',pendingAttachments:[]},elements={promptInput:{value:''}};
 await store.save(await taskDraftKey(tab,'old'),{text:'Old pending instruction',attachments:[],sessionId:'old'});
 await store.save(await taskDraftKey('steer-'+tab,'old'),{text:JSON.stringify({checkpoint:{},session_id:'old'}),attachments:[],sessionId:'old'});
 const restore=runInNewContext(body('restoreComposerDraft')+';restoreComposerDraft',{state,elements,composerDraftStore:store,composerDraftKey:tab,composerDraftRevision:0,taskDraftKey,
  localStorage:{getItem(){return 'old'}},STORAGE_KEY:'session',renderAttachStrip(){},updateFeedbackBarVisibility(){}});
 await restore();assert.equal(elements.promptInput.value,'');assert.equal(state.pendingCheckpointDirection,null);
 assert.equal((await store.load(await taskDraftKey(tab,'old'))).text,'Old pending instruction');
 state.sessionId='old';await restore();assert.equal(elements.promptInput.value,'Old pending instruction');assert.ok(state.pendingCheckpointDirection);
});
test('failed startup discovery remains visibly unavailable and never selects old work',async()=>{
 const state={sessionId:'',taskCatalogueBusy:false,taskCatalogueLoading:true,taskNavigation:[]};let renders=0;
 const load=runInNewContext(body('loadTaskCatalogue')+';loadTaskCatalogue',{state,loadedBrowserIdentity:'current',TextDecoder,
 fetch:async()=>{throw Error('offline')},renderSessionStartScreen(){renders++},document:{querySelector:()=>({open:false})}});
 await load();assert.equal(state.taskCatalogueUnavailable,true);assert.equal(state.taskCatalogueLoading,false);assert.equal(state.sessionId,'');assert.equal(renders,1);
});

test('a late notification from the old conversation cannot repopulate a new chat',async()=>{
 let finish;const state={sessionId:'old',taskNavigationEpoch:0,notificationsAfterId:0};let rendered=0;
 const sync=runInNewContext(body('syncNotifications')+';syncNotifications',{state,fetchJson:()=>new Promise(resolve=>{finish=resolve}),renderEvents(){rendered++},appendActivityEvent(){throw Error('old activity leaked')},setStatus(){throw Error('old status leaked')}});
 const pending=sync();state.sessionId='';state.taskNavigationEpoch++;finish({notifications:[{id:1,text:'Previous task finished'}],next_after_id:1});await pending;
 assert.equal(state.notificationsAfterId,0);assert.equal(rendered,0);
});


test('saved task loads exact Work Return questions without resuming work or accepting stale responses', async()=>{
 const binding={assignment_id:'retained',run_id:'run',generation:1};
 for(const variant of ['bound','foreign','stale','transport']) {
  const state={verifiedWorkPacketRequestId:3,workReturn:null}; let renders=0,calls=0;
  const work={schema:'revit-operator.work-return/v1',...binding,status:'blocked',deviations_or_open_items:['Q1: Which design applies?']};
  const fn=runInNewContext(body('syncSavedWorkReturn')+';syncSavedWorkReturn',{
   state,selectedGoal:()=>({_bindingV2:binding}),renderWorkReturnPanel:()=>renders++,
   fetchJson:async route=>{calls++;assert.match(route,/retained\/work-return$/);if(variant==='transport')throw Error('offline');
    if(variant==='stale')state.verifiedWorkPacketRequestId++;
    return {work_return:variant==='foreign'?{...work,run_id:'other'}:work};}
  });
  await fn({_bindingV2:binding},3);assert.equal(calls,1);
  if(variant==='bound'){assert.equal(state.workReturn,work);assert.equal(renders,1);}
  else assert.equal(state.workReturn,null);
 }
});
