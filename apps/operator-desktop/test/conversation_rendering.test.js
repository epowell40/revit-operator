import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {renderAssistantBlocks,appendInlineText,compactWorkSummary} from '../public/conversation_ui.js';
import {currentTaskState,taskStateLabel} from '../public/task_navigation.mjs';
import {messagePresentation} from '../public/activity_feedback.mjs';
import {retainedWorkReportMessage} from '../work_report.mjs';
const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
function fn(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf('\n}\n',start)+2);}
// HTML disabled IDL attributes coerce assignments (including undefined) to Boolean.
function browserControl(){let disabled=false;return {get disabled(){return disabled;},set disabled(value){disabled=Boolean(value);}};}

test('saved apply review exposes budget continuation only when canonical policy permits renewal',()=>{
 const state={streaming:false,sessionId:'conversation',taskNavigation:[]};
 const elements={assignmentCompact:{},assignmentCompactStep:{},stopButton:{}};
 const goal={_sourceKind:'assignment_kernel_v2',_bindingV2:{session_id:'conversation',assignment_id:'task'},
  _assignmentPhase:'awaiting_user_review',_projection:{execution:{requested_effect:'apply'},truth:{}}};
 const controls={};
 const render=runInNewContext(fn('newRequestAfterReport')+'\n'+fn('assignmentContextPresentation')+'\n'+fn('renderCompactWork')+';renderCompactWork',
  {state,elements,currentTaskState,taskStateLabel,compactWorkSummary,selectedGoal:()=>goal,document:{querySelector:id=>controls[id]||={}}});
 render();assert.equal(controls['#taskBudgetContinueButton'].hidden,true,'Missing capability fails closed');
 goal._canRenewResources=false;render();assert.equal(controls['#taskBudgetContinueButton'].hidden,true);
 goal._canRenewResources=true;render();assert.equal(controls['#taskBudgetContinueButton'].hidden,false);
 goal._providerUsageHold={hold_id:'usage'};render();assert.equal(controls['#taskBudgetContinueButton'].disabled,true);
 state.streaming=true;render();assert.equal(controls['#taskBudgetContinueButton'].hidden,true);
});

test('new chat resets old transcript scroll position, including a queued animation frame',()=>{
 const host={scrollTop:800,scrollHeight:900};let frame;let scrolled=0;
 const elements={chatScroll:host,messages:{lastElementChild:{scrollIntoView(){scrolled++;}}}};
 const scroll=runInNewContext(fn('scrollMessagesToBottom')+';scrollMessagesToBottom',{elements,requestAnimationFrame:cb=>{frame=cb;}});
 scroll();assert.equal(host.scrollTop,900);assert.equal(scrolled,1);
 elements.messages.lastElementChild=null;frame();assert.equal(host.scrollTop,0);
 host.scrollTop=800;scroll();assert.equal(host.scrollTop,0);frame();assert.equal(host.scrollTop,0);
});

test('C51 actual compact banner clears stale Paused after a completed resumed task, retaining real paused and uncertain states',()=>{
 const state={streaming:false,sessionId:'conversation',taskNavigation:[{session_id:'conversation',assignment_id:'task',state:'paused'}]};
 const elements={assignmentCompact:{},assignmentCompactStep:{textContent:''},stopButton:{}};
 const goal={_sourceKind:'assignment_kernel_v2',_bindingV2:{session_id:'conversation',assignment_id:'task'},_assignmentPhase:'complete',_canResume:false,_projection:{truth:{}}};
 const controls={};
 const render=runInNewContext(fn('newRequestAfterReport')+'\n'+fn('assignmentContextPresentation')+'\n'+fn('renderCompactWork')+';renderCompactWork',{state,elements,currentTaskState,taskStateLabel,compactWorkSummary,selectedGoal:()=>goal,document:{querySelector:id=>controls[id]||=( {})}});
 render();assert.equal(elements.assignmentCompact.hidden,true);assert.equal(elements.assignmentCompactStep.textContent,'');assert.equal(controls['#taskResumeButton'].hidden,true);
 goal._assignmentPhase='paused';goal._canResume=true;render();assert.equal(elements.assignmentCompact.hidden,false);assert.equal(elements.assignmentCompactStep.textContent,'Paused');assert.equal(controls['#taskResumeButton'].hidden,false);
 goal._assignmentPhase='complete';goal._canResume=false;goal._projection.truth.outcome_uncertain=true;render();assert.equal(elements.assignmentCompactStep.textContent,'Result uncertain');
});

test('live compact status does not describe a read execution as model changes',()=>{
 const state={streaming:true,agentProgress:'',taskNavigation:[]},elements={assignmentCompact:{},assignmentCompactStep:{textContent:''},stopButton:{}};
 const goal={current_step:'Executing task',_projection:{execution:{requested_effect:'read'}}};
 const render=runInNewContext(fn('newRequestAfterReport')+'\n'+fn('assignmentContextPresentation')+'\n'+fn('renderCompactWork')+';renderCompactWork',{state,elements,compactWorkSummary,currentTaskState,selectedGoal:()=>goal,document:{querySelector:()=>({})}});
 render();assert.equal(elements.assignmentCompactStep.textContent,'Checking the model…');
 goal._projection.execution.requested_effect='preview';render();assert.equal(elements.assignmentCompactStep.textContent,'Preparing a preview…');
 goal._projection.execution.requested_effect='apply';render();assert.equal(elements.assignmentCompactStep.textContent,'Making the requested changes…');
 state.streaming=false;render();assert.equal(elements.assignmentCompactStep.textContent,'');assert.equal(elements.assignmentCompact.hidden,true);
});

test('saved review shows Ready for review without a question or an enabled Resume control',()=>{
 const state={streaming:false,sessionId:'conversation',taskNavigation:[{session_id:'conversation',assignment_id:'task',state:'needs_input'}]};
 const elements={assignmentCompact:{},assignmentCompactStep:{textContent:''},stopButton:{}};
 const goal={_sourceKind:'assignment_kernel_v2',_bindingV2:{session_id:'conversation',assignment_id:'task'},_assignmentPhase:'awaiting_user_review',_canResume:false,_projection:{truth:{}}};
 const controls={};
 const render=runInNewContext(fn('newRequestAfterReport')+'\n'+fn('assignmentContextPresentation')+'\n'+fn('renderCompactWork')+';renderCompactWork',{state,elements,currentTaskState,taskStateLabel,compactWorkSummary,selectedGoal:()=>goal,document:{querySelector:id=>controls[id]||={}}});
 render();assert.equal(elements.assignmentCompact.hidden,false);assert.equal(elements.assignmentCompactStep.textContent,'Ready for review');
 assert.equal(controls['#taskResumeButton'].hidden,true);assert.equal(controls['#taskPauseButton'].hidden,true);
 goal._assignmentPhase='awaiting_user_input';render();assert.equal(elements.assignmentCompactStep.textContent,'Needs your input');
 goal._assignmentPhase='awaiting_user_review';goal._projection.truth.reconciliation_required=true;render();assert.equal(elements.assignmentCompactStep.textContent,'Result uncertain');
 goal._projection.truth.reconciliation_required=false;goal._assignmentPhase='paused';goal._canResume=true;render();
 assert.equal(elements.assignmentCompactStep.textContent,'Paused');assert.equal(controls['#taskResumeButton'].hidden,false);
});

test('actual SSE handler presents progress separately and final text supersedes streamed preamble',()=>{
 const state={streaming:true},message={text:''};let renderCount=0,summaryCount=0;
 const dispatch=runInNewContext(fn('dispatchBackendSseEvent')+';dispatchBackendSseEvent',{state,renderNextCertifiedReadUi(){},certifiedReadSseFixture(){},setStatus(){},renderMessages(){renderCount++;},renderCompactWork(){summaryCount++;}});
 const event=(name,payload)=>dispatch({event:name,data:[JSON.stringify(payload)]},message);
 event('assistant.progress',{text:'Reviewing the last two pages.'});
 assert.equal(message.text,'');assert.equal(state.agentProgress,'Reviewing the last two pages.');assert.equal(summaryCount,1);
 for(const text of ['Reading model information…','Reviewing a tool issue…','Preparing a question…','Preparing the workbook…']) {
  event('assistant.progress',{text});assert.equal(state.agentProgress,text);assert.equal(message.text,'');
 }
 event('assistant.delta',{text:'Old preamble.## Findings\n- Partial'});
 event('assistant.done',{text:'## Findings\n- Red marks on page 3.'});
 assert.equal(message.text,'## Findings\n- Red marks on page 3.');assert.equal(renderCount,2);
 event('assistant.done',{text:''});assert.equal(message.text,'','an empty final must not resurrect stale streamed claims');
});

test('actual message renderer uses blocks for assistant prose and keeps user input literal',()=>{
 const document={createTextNode:text=>({tag:'text',textContent:text}),createElement:tag=>({tag,children:[],ownerDocument:document,textContent:'',appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}})};
 const messages=document.createElement('section');
 const render=runInNewContext(fn('renderMessages')+';renderMessages',{messagePresentation,state:{checkedProjectCopy:null,sessionId:"",taskNavigationEpoch:0},document,elements:{messages},activeMessages:()=>[
  {role:'user',text:'## Please inspect this'}, {role:'assistant',text:'## Findings\n- **Page 3:** red marks.\n- <img onerror=run()>\n\n## Model evidence\n- [1] Retained row value.'}],
  renderSessionStartScreen(){},splitAssistantControlText:text=>({text}),renderAssistantBlocks,renderLinkedText:appendInlineText,updateFeedbackBarVisibility(){},scrollMessagesToBottom(){}});
 render();
 const user=messages.children[0].children[1],answer=messages.children[1].children[1];
 assert.ok(user.children.some(n=>n.textContent.includes('## Please inspect')));
 assert.deepEqual(answer.children.map(n=>n.tag),['h3','ul','details']); assert.equal(answer.children[2].open,undefined); assert.equal(answer.children[2].children[0].textContent,'Model evidence');assert.equal(answer.children[1].children.length,2);
 const flatten=n=>[n,...n.children?.flatMap(flatten)??[]];
 assert.equal(flatten(answer).some(n=>n.tag==='img'),false);assert.ok(flatten(answer).some(n=>n.textContent?.includes('<img onerror=run()>')));
});

test('C55 short review stays three bullets through message rendering and restored Details remain closed',()=>{
 const document={createTextNode:text=>({tag:'text',textContent:text}),createElement:tag=>({tag,children:[],ownerDocument:document,textContent:'',appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}})};
 const messages=document.createElement('section');
 const text='- Project and levels: HVAC, Parking through Roof.\n- Mechanical sheets: 17.\n- Not verified: design loads and whether R1 needs a plan.\n\n## Details\nSupporting view inventory.\n\n### Scope and limitations\nLinked model not inspected.\n\n### Model evidence\n- [1] Sheet count: 17';
 const render=runInNewContext(fn('renderMessages')+';renderMessages',{messagePresentation,state:{checkedProjectCopy:null,sessionId:"",taskNavigationEpoch:0},document,elements:{messages},activeMessages:()=>[{role:'assistant',text}],
  renderSessionStartScreen(){},splitAssistantControlText:text=>({text}),renderAssistantBlocks,renderLinkedText:appendInlineText,updateFeedbackBarVisibility(){},scrollMessagesToBottom(){}});
 for(let restore=0;restore<2;restore++){
  render();const answer=messages.children[0].children[1];
  assert.deepEqual(answer.children.map(n=>n.tag),['ul','details']);assert.equal(answer.children[0].children.length,3);
  assert.equal(answer.children[1].open,undefined);assert.equal(answer.children[1].children[0].textContent,'Details');
  assert.equal(answer.children[1].children.filter(n=>n.tag==='h4').length,2,'scope and model evidence headings remain inside the disclosure');
 }
});

test('retained desktop report keeps its full qualified evidence in closed Details on live and restored rendering',()=>{
 const claim='Saved M002. '+'Native evidence retained. '.repeat(20)+'Visual review unavailable.';
 const text=retainedWorkReportMessage({name:'report_work_for_review'},{output:JSON.stringify({ok:true,verification_policy:'advisory',completion_proposal:{review_id:'review',verified:false,claimed_completed:[claim],remaining_work:['Check the layout.'],uncertainties:['Whole-project scope not checked.']}})});
 const document={createTextNode:text=>({tag:'text',textContent:text}),createElement:tag=>({tag,children:[],ownerDocument:document,textContent:'',appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}})};
 const messages=document.createElement('section');
 const render=runInNewContext(fn('renderMessages')+';renderMessages',{messagePresentation,state:{checkedProjectCopy:null,sessionId:"",taskNavigationEpoch:0},document,elements:{messages},activeMessages:()=>[{role:'assistant',text}],renderSessionStartScreen(){},splitAssistantControlText:text=>({text}),renderAssistantBlocks,renderLinkedText:appendInlineText,updateFeedbackBarVisibility(){},scrollMessagesToBottom(){}});
 const flatten=n=>[n,...n.children?.flatMap(flatten)??[]];
 for(let restore=0;restore<2;restore++){
  render();const answer=messages.children[0].children[1];const details=answer.children.find(n=>n.tag==='details');
  assert.ok(details);assert.equal(details.open,undefined);
  assert.ok(flatten(details).some(n=>n.textContent===claim));
  const summary=answer.children.filter(n=>n!==details).flatMap(flatten).map(n=>n.textContent).filter(Boolean).join(' ');
  assert.ok(summary.length<800);assert.match(flatten(details).map(n=>n.textContent).join(" "),/not independently verified/);assert.match(summary,/Check the layout/);assert.match(summary,/Whole-project scope not checked/);
 }
});

test('actual restored answer displays the reported duct table instead of pipe-delimited prose',()=>{
 const document={createTextNode:text=>({tag:'text',textContent:text}),createElement:tag=>({tag,children:[],ownerDocument:document,textContent:'',set innerHTML(value){assert.equal(value,'');this.children=[];},appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];}})};
 const messages=document.createElement('section');
 const answer='| Duct type | Count |\n|---|---:|\n| Mitered Elbows / Taps | 2 |\n| Taps | 8 |\n| Tees | 10 |\n| **Total** | **20** |';
 const render=runInNewContext(fn('renderMessages')+';renderMessages',{messagePresentation,state:{checkedProjectCopy:null,sessionId:"",taskNavigationEpoch:0},document,elements:{messages},activeMessages:()=>[{role:'assistant',text:answer}],
  renderSessionStartScreen(){},splitAssistantControlText:text=>({text}),renderAssistantBlocks,renderLinkedText:appendInlineText,updateFeedbackBarVisibility(){},scrollMessagesToBottom(){}});
 render();
 const flatten=n=>[n,...n.children?.flatMap(flatten)??[]],nodes=flatten(messages);
 assert.equal(nodes.filter(n=>n.tag==='table').length,1);assert.equal(nodes.filter(n=>n.tag==='th').length,2);
 assert.equal(nodes.filter(n=>n.tag==='td').length,8);assert.ok(nodes.some(n=>n.tag==='strong'&&n.textContent==='20'));
 render();assert.equal(flatten(messages).filter(n=>n.tag==='table').length,1,'restoration/rerender does not duplicate the table');
});

test('actual compaction SSE progress stays separate from answers and retains Pause and steering until stream teardown',()=>{
 const state={streaming:true,activeRunKind:'backend',sessionId:'conversation',agentProgress:'',taskNavigation:[],captureState:{mode:'',busy:false},composerSubmissionPending:false};
 const elements={assignmentCompact:{},assignmentCompactStep:{textContent:''},stopButton:browserControl(),sendButton:browserControl(),chatForm:{setAttribute(){}},newSessionButton:browserControl(),attachButton:browserControl(),attachInput:browserControl(),refreshScreenButton:browserControl(),promptInput:browserControl()};
 const goal={_sourceKind:'assignment_kernel_v2',_bindingV2:{session_id:'conversation',assignment_id:'task'},_assignmentPhase:'active',_canResume:false,_projection:{truth:{}}};
 const controls={},message={text:''};
 const api=runInNewContext(fn('newRequestAfterReport')+'\n'+fn('assignmentContextPresentation')+'\n'+fn('renderCompactWork')+'\n'+fn('updateControls')+'\n'+fn('setStreaming')+'\n'+fn('dispatchBackendSseEvent')+';({dispatchBackendSseEvent,setStreaming,updateControls})',{
  state,elements,currentTaskState,taskStateLabel,compactWorkSummary,selectedGoal:()=>goal,document:{querySelector:id=>controls[id]||={}},pausedTaskAcceptsDirection:()=>false,
  renderNextCertifiedReadUi(){},certifiedReadSseFixture(){},setStatus(){},renderMessages(){},updateStatusTone(){},updateFeedbackBarVisibility(){}});
 api.updateControls();
 for(const text of ['Organizing task notes…','Continuing the task…']){
  api.dispatchBackendSseEvent({event:'assistant.progress',data:[JSON.stringify({text})]},message);
  assert.equal(elements.assignmentCompactStep.textContent,text);assert.equal(message.text,'');assert.equal(state.streaming,true);
  assert.equal(controls['#taskPauseButton'].hidden,false);assert.equal(elements.sendButton.disabled,false);assert.equal(elements.sendButton.textContent,'Steer');assert.equal(elements.promptInput.disabled,false);
  assert.equal(goal._assignmentPhase,'active');
 }
 goal._assignmentPhase='paused';goal._canResume=true;api.setStreaming(false);
 assert.equal(state.agentProgress,'');assert.equal(elements.assignmentCompactStep.textContent,'Paused');assert.equal(controls['#taskPauseButton'].hidden,true);assert.equal(controls['#taskResumeButton'].hidden,false);
});
