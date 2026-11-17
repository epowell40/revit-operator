import { agentModelRequiresReasoning, normalizeAgentModel } from '../public/agent_model_catalog.mjs';
import { taskDraftKey } from "../public/task_navigation.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createComposerDraftStore, staleComposerNotice } from '../public/composer_draft.mjs';
import { refreshAssignmentDisplayContext } from '../public/assignment_display_context.mjs';

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const normalizedSource = source.replace(/\r\n/g,'\n');
function functionSource(name) {
  const start=normalizedSource.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  const asyncStart=normalizedSource.slice(start-6,start)==='async ' ? start-6 : start;
  return normalizedSource.slice(asyncStart,normalizedSource.indexOf('\n}\n',start)+2);
}

const settingsHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const modelSelect = settingsHtml.match(/<select id="agentModel"[^>]*>([\s\S]*?)<\/select>/)[1];
const modelOptions = [...modelSelect.matchAll(/value="([^"\n]+)"/g)].map(match => match[1]);
function bootModelSettings(storage) {
  const agentModel = { current: '', get value() { return this.current; },
    set value(value) { this.current = modelOptions.includes(value) ? value : ''; },
    addEventListener(_event, handler) { this.change = handler; } };
  const control = () => ({ value: '', checked: false, options: [{value:'none',disabled:false}], addEventListener(_event, handler) { this.change = handler; } });
  const elements = { agentModel, agentReasoning: control(), showWork: control() };
  const settings = runInNewContext(['readBoolSetting', 'writeBoolSetting', 'readStringSetting', 'writeStringSetting',
    'normalizeSpeedModel', 'normalizeReasoningEffort', 'getSpeedSettings', 'synchronizeModelReasoning', 'initializeSpeedControls'].map(functionSource).join('\n')
    + '; initializeSpeedControls(); getSpeedSettings', { elements, agentModelRequiresReasoning, normalizeAgentModel,
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  return { model: agentModel, reasoning: elements.agentReasoning, showWork: elements.showWork, settings };
}

test('Settings preserves each offered model through change, reload, and the request payload', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const storage = new Map([['operator.speedDefaultsVersion', 'unified-agent-v1'], ['operator.agentReasoning', 'high'], ['operator.speedMode', '0'], ['operator.speedDiet', '0']]);
    const page = bootModelSettings(storage);
    page.model.value = model;
    assert.equal(page.model.value, model, 'model must be an actual selectable option');
    page.model.change();
    assert.equal(storage.get('operator.agentModel'), model);
    const reloaded = bootModelSettings(storage);
    assert.equal(reloaded.model.value, model);
    const payload = reloaded.settings();
    assert.equal(payload.agent_model, model);
    assert.equal(payload.agent_reasoning_effort, 'high');
    assert.equal(payload.speed_mode, true);
    assert.equal(payload.context_diet, true);
  }
});

test('GPT-6.1 selection visibly uses low when a saved None effort is incompatible, without changing other models', () => {
  const storage = new Map([['operator.speedDefaultsVersion', 'unified-agent-v1'], ['operator.agentModel', 'gpt-5.6-sol'], ['operator.agentReasoning', 'none']]);
  const page = bootModelSettings(storage);
  assert.equal(page.settings().agent_reasoning_effort, 'none');
  page.model.value = 'gpt-6.1-sol'; page.model.change();
  assert.equal(page.reasoning.value, 'low');
  assert.equal(page.reasoning.options[0].disabled, true);
  assert.equal(page.settings().agent_model, 'gpt-6.1-sol');
  assert.equal(page.settings().agent_reasoning_effort, 'low');
  const reloaded = bootModelSettings(storage);
  assert.equal(reloaded.reasoning.value, 'low');
  assert.equal(reloaded.reasoning.options[0].disabled, true);
  reloaded.model.value = 'gpt-5.6-sol'; reloaded.model.change();
  assert.equal(reloaded.reasoning.options[0].disabled, false);
  reloaded.reasoning.value = 'none'; reloaded.reasoning.change();
  assert.equal(reloaded.settings().agent_reasoning_effort, 'none');
});

test('Settings keeps Sol as the default and rejects unknown stored or selected models', () => {
  assert.match(modelSelect, /value="gpt-5\.6-sol" selected/);
  assert.equal([...modelSelect.matchAll(/\bselected\b/g)].length, 1);
  const fresh = bootModelSettings(new Map());
  assert.equal(fresh.settings().agent_model, 'gpt-5.6-sol');
  assert.equal(fresh.settings().agent_reasoning_effort, 'medium');
  const storage = new Map([['operator.speedDefaultsVersion', 'unified-agent-v1'], ['operator.agentModel', 'unknown-model']]);
  const page = bootModelSettings(storage);
  assert.equal(page.model.value, 'gpt-5.6-sol');
  assert.equal(page.settings().agent_model, 'gpt-5.6-sol');
  page.model.value = 'unknown-model';
  page.model.change();
  assert.equal(storage.get('operator.agentModel'), 'gpt-5.6-sol');
});

test('refresh warning survives idle status polling and restores the actual unsent PDF after page reload',async()=>{
  const records=new Map();
  const storage={get:async k=>records.get(k),put:async(k,v)=>records.set(k,structuredClone(v)),delete:async k=>records.delete(k)};
  const attachment={id:'pdf-1',name:'Example_Task_List.pdf',mimeType:'application/pdf',sizeBytes:3,dataBase64:'YWJj'};
  const notices=new Map();
  function element() {return {children:[],appendChild(child){this.children.push(child);if(child.id)notices.set(child.id,child);},replaceChildren(){this.children=[];},setAttribute(){},addEventListener(_event,handler){this.handler=handler;}};}
  const elements={promptInput:{value:'Read this reference'},chatForm:element(),statusText:{textContent:''}};
  const state={sessionId:'saved-session',pendingAttachments:[attachment]};
  const bindings={state,elements,document:{getElementById:id=>notices.get(id),createElement:element},window:{location:{reload(){}}},
    composerDraftStore:createComposerDraftStore({storage}),composerDraftKey:'test-tab-key',composerDraftTimer:null,composerDraftRevision:0,
    taskDraftKey,staleComposerNotice,clearTimeout,conciseStatus:t=>t,updateStatusTone(){},localStorage:{getItem:()=> 'saved-session'},STORAGE_KEY:'key',renderAttachStrip(){},updateFeedbackBarVisibility(){}};
  const api=runInNewContext(['setStatus','showComposerNotice','persistComposerDraft','restoreComposerDraft','showStaleComposerNotice'].map(functionSource).join('\n')+'; ({setStatus,showStaleComposerNotice,restoreComposerDraft})',bindings);
  await api.showStaleComposerNotice();
  api.setStatus('Ready');
  assert.match(notices.get('composerNotice').children[0].textContent,/unsent text and attachments are saved/);
  assert.equal(notices.get('composerNotice').children[1].textContent,'Refresh');
  elements.promptInput.value='';state.pendingAttachments=[];
  await api.restoreComposerDraft();
  assert.equal(elements.promptInput.value,'Read this reference');assert.deepEqual(state.pendingAttachments,[attachment]);
  assert.equal(state.sessionId,'saved-session');
});

test('background context polling is cached-only while an explicit refresh cannot join it',async()=>{
  const state={}; const calls=[];let finishCache;
  const refresh=runInNewContext(functionSource('refreshAssignmentRevitContext')+'; refreshAssignmentRevitContext',{
    state,refreshAssignmentDisplayContext,assignmentRevitContextFromHealth:health=>health.context,
    fetchJson:route=>{calls.push(route);return route.includes('prefer_cached') ? new Promise(resolve=>{finishCache=resolve;}) : Promise.resolve({context:{document_title:'Fresh'}});}
  });
  const polling=refresh({cachedOnly:true});
  const fresh=await refresh(); assert.equal(fresh.document_title,'Fresh');
  finishCache({context:{document_title:'Old'}});await polling;
  assert.equal(state.assignmentRevitContext.document_title,'Fresh');
  assert.deepEqual(calls,['/api/revit/health?prefer_cached=1','/api/revit/health']);
  assert.match(functionSource('syncGoals'),/refreshAssignmentRevitContext\(\{ cachedOnly: true \}\)/);
  assert.doesNotMatch(functionSource('syncGoals'),/const contextRefresh = state\.streaming/);
  assert.match(functionSource('runGoalControl'),/const liveContext = await refreshAssignmentRevitContext\(\)/);
  assert.match(functionSource('runGoalControl'),/assignmentContextPresentation\(goal, liveContext\)/);
});

test('running task Details receives the preflight identity after a cold Home page',async()=>{
  const state={streaming:true,sessionId:'session',goalsSyncRequestId:0,goals:[],assignmentRevitContext:null},routes=[];
  const api=runInNewContext(['refreshAssignmentRevitContext','syncGoals'].map(functionSource).join('\n')+';syncGoals',{
    state,URLSearchParams,refreshAssignmentDisplayContext,assignmentRevitContextFromHealth:health=>health.context,
    fetchJson:async route=>{routes.push(route);return route.startsWith('/api/revit/health')?{context:{document_fingerprint:'project',document_title:'Disposable'}}:{assignments:[]};},
    retainNewerAssignmentViewsV2:()=>[],chooseCurrentAssignment:()=>null,assignmentProjectionToGoalView:v=>v,
    renderGoalPanel(){},selectedGoal:()=>null,syncVerifiedWorkPacket:async()=>{},renderCompactWork(){}
  });
  await api();assert.equal(state.assignmentRevitContext.document_fingerprint,'project');
  assert.equal(routes.filter(route=>route==='/api/revit/health?prefer_cached=1').length,1);
  assert.equal(routes.some(route=>route==='/api/revit/health'||route.includes('/revit/context')),false);
});
test("history restoration ignores a late response for the previous conversation", async () => {
  let finish;
  const state = { sessionId: "old", backendMessages: [], streaming: false };
  let renders = 0;
  const restore = runInNewContext(functionSource('restoreConversationHistory') + "; restoreConversationHistory", {
    state, fetchJson: () => new Promise(resolve => { finish = resolve; }),
    mergeConversationHistory: () => { throw new Error("A stale response must not be merged."); },
    renderMessages: () => { renders++; }, setStatus: () => {}
  });
  const pending = restore();
  state.sessionId = "new";
  finish({ session_id: "old", messages: [{ role: "user", text: "Old question" }] });
  await pending;
  assert.equal(renders, 0);
  assert.deepEqual(state.backendMessages, []);
});
test("work details open on request, expose their state, and return keyboard focus on close", () => {
  const nodes = Object.fromEntries(["workDetails", "workDetailsButton", "assignmentCompactToggle"].map(id => [id, {
    hidden: true, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, focus() { this.focused = true; }
  }]));
  const heading = { focus() { this.focused = true; } };
  const start = source.indexOf("function showWorkDetails(open) {");
  const end = source.indexOf("\nelements.assignmentCompactToggle", start);
  const show = runInNewContext(source.slice(start, end) + "; showWorkDetails", {
    elements: { assignmentHeading: heading }, document: { querySelector: id => nodes[id.slice(1)], getElementById: id => nodes[id] }
  });
  show(true);
  assert.equal(nodes.workDetails.hidden, false);
  assert.equal(nodes.workDetailsButton.attributes["aria-expanded"], "true");
  assert.equal(heading.focused, true);
  show(false);
  assert.equal(nodes.workDetails.hidden, true);
  assert.equal(nodes.workDetailsButton.focused, true);
});

test("conversation keeps feedback beside answers and connection diagnostics inside Settings", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const settings = html.slice(html.indexOf('<details id="advancedPanel"'), html.indexOf('</header>'));
  assert.match(settings, /<summary>Settings<\/summary>/);
  for (const id of ["backendText", "micDeviceSelect", "runtimeProfileBadge"]) assert.ok(settings.includes(`id="${id}"`), id);
  assert.doesNotMatch(settings, /id="feedbackBar"/);
  assert.match(html, /<aside id="workDetails"[^>]+ hidden>/);
  assert.equal([...html.matchAll(/id="promptInput"/g)].length, 1);
  const conversation = html.slice(html.indexOf('id="chatScroll"'), html.indexOf('<aside id="workDetails"'));
  assert.match(conversation, /id="feedbackBar"/, "Task feedback stays visible beside the answer");
  assert.equal([...html.matchAll(/id="feedbackBar"/g)].length, 1);
  assert.match(conversation, /id="assignmentInputs"/, "C27: required task questions must be visible without opening Work details");
  assert.equal([...html.matchAll(/id="assignmentInputs"/g)].length, 1);
  assert.match(source, /if \(!assistantMessage\.directContextAnswer\)/);
  assert.doesNotMatch(source.slice(source.indexOf("async function sendBackendPrompt"), source.indexOf("async function syncComputerState")), /await refreshScreen\(\)/);
});

test('removed switches retain optimized defaults and Show Work still persists independently',()=>{
 assert.doesNotMatch(settingsHtml,/id="speed(?:Mode|Diet)"/);
 assert.match(settingsHtml,/BIMTools Login/);assert.doesNotMatch(settingsHtml,/ClashPilot/);
 const storage=new Map([['operator.speedDefaultsVersion','unified-agent-v1'],['operator.speedMode','0'],['operator.speedDiet','0'],['operator.showWork','1']]);
 const page=bootModelSettings(storage);assert.equal(page.showWork.checked,true);
 assert.equal(page.settings().show_work_as_it_runs,true);
 assert.equal(page.settings().speed_mode,true);assert.equal(page.settings().context_diet,true);
 page.showWork.checked=false;page.showWork.change();assert.equal(bootModelSettings(storage).settings().show_work_as_it_runs,false);
});

test('legacy settings never replace a saved Terra model with Sol during initialization', () => {
  for (const version of [null, 'older-version', 'unified-agent-v1']) {
    const storage = new Map([['operator.agentModel', 'gpt-6.1-terra'], ['operator.agentReasoning', 'high']]);
    if (version) storage.set('operator.speedDefaultsVersion', version);
    const page = bootModelSettings(storage);
    assert.equal(page.model.value, 'gpt-6.1-terra');
    assert.equal(page.settings().agent_model, 'gpt-6.1-terra');
    assert.equal(page.settings().agent_reasoning_effort, 'high');
  }
});

test('screen availability does not advertise the fallback model as the selected model', () => {
  const statement = source.match(/elements\.computerBadge\.textContent = [^;]+;/)?.[0];
  assert.ok(statement);
  for (const available of [true, false]) {
    const elements = { computerBadge: {} };
    runInNewContext(statement, { elements, state: { computerUseAvailable: available }, config: { computerModel: 'gpt-5.6-terra' } });
    assert.equal(elements.computerBadge.textContent, available ? 'Screen control available' : 'Screen control unavailable');
    assert.doesNotMatch(elements.computerBadge.textContent, /terra|sol/i);
  }
});

test('product settings keep implementation controls behind a closed troubleshooting section', () => {
  const settings = settingsHtml.slice(settingsHtml.indexOf('<details id="advancedPanel"'), settingsHtml.indexOf('</header>'));
  const advancedStart = settings.indexOf('<details id="troubleshootingPanel"');
  const advancedEnd = settings.indexOf('</details>', advancedStart);
  const advanced = settings.slice(advancedStart, advancedEnd);
  assert.ok(advancedStart > 0);
  assert.doesNotMatch(advanced.split('>')[0], /\bopen\b/);
  for (const id of ['backendText', 'writeGrantMode', 'computerBadge', 'environmentBadge', 'sessionBadge', 'refreshScreenButton']) {
    assert.ok(advanced.includes(`id="${id}"`), id);
  }
  for (const id of ['agentModel', 'agentReasoning', 'showWork', 'authSignInButton', 'micDeviceSelect']) {
    assert.ok(settings.slice(0, advancedStart).includes(`id="${id}"`), id);
  }
  assert.doesNotMatch(settings, /Hybrid Agent|Global write grant|Agent model/);
  assert.equal([...settings.matchAll(/id="agentModel"/g)].length, 1);
});
