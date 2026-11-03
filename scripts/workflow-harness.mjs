import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {readDevelopmentArtifact,writeDevelopmentArtifact} from './development-artifact-store.mjs';

export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const json = readDevelopmentArtifact;

// Passive pre-Send monitor: only observe a genuinely new ordinary UI start.
// This helper cannot dispatch, resume, restart, or infer a successful outcome.
export async function waitForWorkflowUiStart({initial,armedAt,readState,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=180000}) {
  assert(initial?.running===false,'Arm only while the owned UI is idle');
  assert(Number.isFinite(armedAt)&&Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=180000,'Bounded pre-Send wait required');
  for(;;){
    const state=await readState(),started=Date.parse(state?.progress?.startedAt);
    if(state?.running===true&&Number.isFinite(started)&&started>=armedAt&&state.progress.startedAt!==initial.progress?.startedAt)return state;
    assert(now()-armedAt<timeoutMs,'No new UI task observed; no task was dispatched or restarted');
    await sleep(250);
  }
}

// A normal-close request or absent top-level window is not process exit.
// Hashing is deliberately after the host's exact process-exit observation.
export async function savedFileAfterProcessExit({expected,readProcess,readFile,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=60000}) {
  assert(Number.isSafeInteger(expected?.pid)&&expected.pid>0&&typeof expected.created_utc==='string'&&typeof expected.exe==='string','Exact owned process required');
  const start=now();
  for(;;){
    const process=await readProcess(expected.pid);
    if(process==null)return readFile();
    assert(typeof process.exe==='string'&&path.win32.normalize(process.exe).toLowerCase()===path.win32.normalize(expected.exe).toLowerCase()
      &&Date.parse(process.created_utc)===Date.parse(expected.created_utc),'Process identity changed; do not inspect or stop its replacement');
    assert(now()-start<timeoutMs,'Owned normal exit pending; file has not been hashed');
    await sleep(250);
  }
}
const write = (file,value,store) => writeDevelopmentArtifact(file,value,{store:store??path.join(path.dirname(file),'.artifact-payloads-v1')});
const inside=(parent,child)=>{const r=path.relative(parent,child);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const fingerprint=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

/** Case data, not copied executable scripts. It cannot supply a shell command,
 * arbitrary route, model mutation or agent-visible target recipe. */
export function validateCase(file) {
 const m=json(file);assert.equal(m.schema,'operator.workflow-case.v1');
 for(const k of ['caseId','caseRoot','workspace','source','host','result','promptFile'])assert(typeof m[k]==='string'&&m[k],k);
 assert(/^[a-z][a-z0-9-]{1,79}$/.test(m.caseId),'safe case ID');
 for(const k of ['caseRoot','workspace','source','host','result','promptFile'])assert(path.isAbsolute(m[k]),'absolute '+k);
 assert(inside(m.caseRoot,file)&&inside(m.caseRoot,m.promptFile),'case-owned manifest and prompt');
 assert(inside(m.workspace,m.host)&&inside(m.workspace,m.result)&&m.host!==m.result,'separate workspace model paths');
 assert(path.extname(m.host)==='.rvt'&&path.extname(m.result)==='.rvt');
 assert(/^[a-f0-9]{64}$/.test(m.sourceSha256)&&sha256(m.source)===m.sourceSha256,'exact retained source');
 assert(['annotation','schedule','mixed','package'].includes(m.kind));
 if(m.kind==='package')assert.deepEqual(Object.keys(m.expected??{}).sort(),['note','schedule','space'],'bounded package components');
 assert(Array.isArray(m.links)&&m.links.length>0&&m.links.every(x=>path.isAbsolute(x.path)&&sha256(x.path)===x.sha256),'exact linked inputs');
 assert(m.actor.hardSeconds>0&&m.actor.hardSeconds<=540&&m.actor.intervention==='none_except_safety_stop');
 assert(!Object.keys(m).some(k=>/command|shell|recipe|targetIds|coordinates/i.test(k)),'no executable or solved recipe');
 assert(fs.existsSync(m.promptFile),'ordinary prompt');return m;
}

export function timeline(m,event,details={}) {
 fs.mkdirSync(m.caseRoot,{recursive:true});
 fs.appendFileSync(path.join(m.caseRoot,'timeline.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...details})+'\n');
}

const categories=[['equipment','OST_MechanicalEquipment'],['terminals','OST_DuctTerminal'],['ducts','OST_DuctCurves'],
 ['fittings','OST_DuctFitting'],['accessories','OST_DuctAccessory'],['flex','OST_FlexDuctCurves'],['titleblocks','OST_TitleBlocks'],
 ['viewports','OST_Viewports'],['schedule-graphics','OST_ScheduleGraphics'],['text-notes','OST_TextNotes'],
 ['air-device-tags','OST_DuctTerminalTags'],['equipment-tags','OST_MechanicalEquipmentTags'],['room-tags','OST_RoomTags'],
 ['space-tags','OST_MEPSpaceTags'],['duct-tags','OST_DuctTags'],['dimensions','OST_Dimensions'],['lines','OST_Lines'],['spaces','OST_MEPSpaces']];

/** Every call is serial and read-only through the supplied normal protected
 * transport. Actor state and exact current process/document are mandatory. */
export async function collect(m,phase,client) {
 assert(['baseline','after','reopen'].includes(phase));assert(!(await client.actorRunning()),'no competing reads during actor');
 const dir=path.join(m.caseRoot,phase);fs.mkdirSync(dir,{recursive:false});timeline(m,'collection_started',{phase});
 const records={};
 async function capture(label,route,body) {
  const r=await client.read(route,body);write(path.join(dir,label+'.json'),{at:new Date().toISOString(),route,body,status:r.status,payload:r.payload},path.join(m.batchRoot??path.dirname(m.caseRoot),'.artifact-payloads-v1'));
  assert.equal(r.status,200,label);records[label]=r.payload;return r.payload;
 }
 const ctx=await capture('context','/revit/context');
 assert.equal(ctx.process_id,await client.expectedPid(phase),'exact owned Revit');
 const expected=phase==='baseline'?[m.host]:phase==='reopen'?[m.result]:[m.host,m.result];
 assert(expected.some(p=>p.toLowerCase()===ctx.document.path.toLowerCase()),'exact case document');
 const health=await capture('health','/revit/model-health',{includeLinks:true,includeWarnings:false,includeOpenDocuments:true});
 assert.equal(health.links.revit.items.length,m.links.length);
 for(const x of m.links)assert.equal(health.links.revit.items.filter(i=>i.loaded&&i.path?.toLowerCase()===x.path.toLowerCase()).length,1,'exact loaded link '+x.path);
 const sheets=await capture('sheets','/revit/sheets',{action:'list'});assert(!sheets.hasMore);
 for(const s of sheets.items??sheets.sheets??[])await capture('sheet-'+s.sheetNumber,'/revit/sheets',{action:'detail',sheetId:s.id,includePlacedViews:true,includeViewports:true,includeViewportGeometry:true});
 await capture('views','/revit/views',{action:'list',includeTemplates:true,offset:0,limit:500});
 for(const [label,category]of categories) {
  const p=await capture(label,'/revit/find-elements',{category,includeGeometry:true,limit:5000});
  assert(p.itemsComplete&&!p.truncated,'complete '+label);
 }
 const graphIds=['equipment','terminals','ducts','fittings','accessories','flex'].flatMap(k=>records[k].elementIds);
 await capture('connectors','/revit/get-connectors',{elementIds:graphIds,includeAllRefs:true,includeCoordinateSystem:true,maxConnectorsPerElement:128});
 for(const label of ['equipment','terminals','ducts','fittings','accessories','flex','spaces','titleblocks'])
  if(records[label].elementIds.length)await capture(label+'-parameters','/revit/get-parameters',{elementIds:records[label].elementIds,includeEmpty:true});
 const notes=await capture('all-text','/revit/find-text-notes',{max:500});assert(notes.ok&&notes.scope==='active_project'&&notes.itemsComplete&&notes.items.length<500);
 const types=await capture('text-types','/revit/create-text',{action:'list_types'});
 if(types.textTypes.length)await capture('text-type-parameters','/revit/get-parameters',{elementIds:types.textTypes.map(x=>x.id),includeEmpty:true});
 const tags=[...records['equipment-tags'].elementIds,...records['duct-tags'].elementIds,...records['space-tags'].elementIds];
 for(let i=0;i<tags.length;i+=200)await capture('tag-refs-'+i,'/revit/get-element-summary',{elementIds:tags.slice(i,i+200),includeTagReferences:true});
 const schedules=await capture('schedules','/revit/schedules',{action:'list',kind:'regular',offset:0,max:500});assert(schedules.complete&&!schedules.hasMore);
 for(const s of schedules.items) {
  const data=await capture('schedule-'+s.id,'/revit/schedules',{action:'detail',scheduleId:s.id,includeFields:true,includeData:true,includeDefinitionSnapshot:true,maxRows:500,maxColumns:100});
  assert(data.definitionSnapshot?.complete,'complete schedule definition/table '+s.id);
  for(const part of ['header','body'])assert(!data.table?.[part]?.hasMoreRows&&!data.table?.[part]?.hasMoreColumns,'complete cells '+s.id);
 }
 write(path.join(dir,'ready.json'),{passed:true,at:new Date().toISOString(),phase,processId:ctx.process_id,document:ctx.document.path,
  inventoryCategories:categories.length,connectorOwners:graphIds.length,notes:notes.items.length,schedules:schedules.items.length,
  scope:'Independent collected state; actual UI, native effects, actor SaveAs and fresh-process persistence remain separate obligations.'});
 timeline(m,'collection_finished',{phase,requests:Object.keys(records).length});return records;
}

function normalize(value,m,key='') {
 if(Array.isArray(value)) {
  const a=value.map(v=>normalize(v,m));
  if(['connectors','connectedTo','physicalConnectedTo','results','elementIds'].includes(key))a.sort((x,y)=>JSON.stringify(stable(x)).localeCompare(JSON.stringify(stable(y))));
  if(key==='items'&&a.every(v=>v&&typeof v==='object'&&(v.elementId??v.id??v.textNoteId)!=null))a.sort((x,y)=>(x.elementId??x.id??x.textNoteId)-(y.elementId??y.id??y.textNoteId));
  return a;
 }
 if(!value||typeof value!=='object')return value;
 const o=structuredClone(value),paths=new Set([m.host,m.result]),titles=new Set([m.host,m.result].map(x=>path.basename(x,'.rvt')));
 if(Array.isArray(o.parameterDetails))for(const p of o.parameterDetails)if(p.name==='File Path'&&p.isReadOnly===true) {
  for(const k of ['value','valueString'])if(paths.has(p[k]))p[k]='$readonly-case-path$';
  if(paths.has(o.parameters?.['File Path']))o.parameters['File Path']='$readonly-case-path$';
 }
 if(titles.has(o.documentTitle))o.documentTitle='$case-document-title$';
 return Object.fromEntries(Object.entries(o).filter(([k])=>k!=='canonical_attempt_settlement'&&!(k==='index'&&'connectorId'in o)).map(([k,v])=>[k,normalize(v,m,k)]));
}

const collectionEvidence=Symbol('workflow collection evidence');
const caseEvidenceIdentity=m=>({caseId:m.caseId,kind:m.kind,sourceSha256:m.sourceSha256,host:m.host,result:m.result,
 promptSha256:sha256(m.promptFile),expectedSha256:fingerprint(m.expected)});
function collectionWitness(m,phase,files,ready,context) {
 assert(['baseline','after','reopen'].includes(phase));const dir=path.join(m.caseRoot,phase);
 files??=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(file=>({file,sha256:sha256(path.join(dir,file))}));
 ready??=json(path.join(dir,'ready.json'));context??=json(path.join(dir,'context.json')).payload;
 assert.equal(ready.passed,true);assert.equal(ready.phase,phase,'collection phase');
 assert(Number.isSafeInteger(ready.processId)&&ready.processId>0);assert.equal(context.process_id,ready.processId,'native collection process');
 assert.equal(context.document.path,ready.document,'native collection document');
 const allowed=phase==='baseline'?[m.host]:phase==='reopen'?[m.result]:[m.host,m.result];
 assert(allowed.some(p=>p.toLowerCase()===ready.document.toLowerCase()),'case-bound collection document');
 return{schema:'operator.workflow-collection-evidence.v1',case:caseEvidenceIdentity(m),phase,processId:ready.processId,document:ready.document,files};
}
export function loadCollection(m,phase) {
 const dir=path.join(m.caseRoot,phase),files=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort(),records={},hashes=[];let ready;
 for(const file of files){const bytes=fs.readFileSync(path.join(dir,file)),r=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  hashes.push({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});if(file==='ready.json')ready=r;
  else{assert.equal(r.status,200,'successful collected native read '+file);assert(r.payload!==undefined,'collected native payload '+file);records[file.slice(0,-5)]=r.payload;}}
 Object.defineProperty(records,collectionEvidence,{value:collectionWitness(m,phase,hashes,ready,records.context)});return records;
}
function bindNativeGrade(result,baseline,actual) {
 const b=baseline[collectionEvidence],a=actual[collectionEvidence];
 // Pure fixture comparisons remain useful, but cannot produce a finalizable
 // grade without the independent collected-file provenance.
 result.evidenceBinding=b&&a?{schema:'operator.workflow-native-grade-evidence.v1',baseline:b,actual:a,factsSha256:fingerprint(result)}:null;
 return result;
}
function visualFileInfo(bytes) {
 if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  &&bytes.readUInt32BE(8)===13&&bytes.subarray(12,16).toString()==='IHDR'&&bytes.subarray(-8,-4).toString()==='IEND')
  return{mimeType:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 // Both browser and native capture may return JPEG bytes under a caller's
 // legacy .png filename. Inspect the actual format, never infer it from that
 // filename. This bounded marker/header check is not pixel-semantic review.
 if(bytes.length>=16&&bytes.readUInt16BE(0)===0xffd8&&bytes.readUInt16BE(bytes.length-2)===0xffd9){
  for(let i=2;i+4<=bytes.length;){
   if(bytes[i++]!==0xff)break;while(i<bytes.length&&bytes[i]===0xff)i++;const marker=bytes[i++];
   if([0xd9,0xda].includes(marker))break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
   if(i+2>bytes.length)break;const size=bytes.readUInt16BE(i);if(size<2||i+size>bytes.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=8)
    return{mimeType:'image/jpeg',width:bytes.readUInt16BE(i+5),height:bytes.readUInt16BE(i+3)};
   i+=size;
  }
 }
 assert.fail('Recognized image header/dimensions/trailer required');
}

/** Offline QA only: bind the existing finalizer's independent artifacts.
 * This neither evaluates an Assignment nor changes its outcome/authority.
 * Image presence is necessary, never a substitute for actual visual review. */
export function assertWorkflowFinalizationEvidence(m,{actor,kernel,state,canonical,grades,ui}) {
 assert(['annotation','mixed','schedule'].includes(m.kind),'package requires its own whole-request adjudication');
 const binding=kernel?.current_binding;assert(binding&&typeof binding==='object');
 for(const key of ['assignment_id','run_id','session_id','principal_id','document_fingerprint'])assert(typeof binding[key]==='string'&&binding[key].length>0,'exact '+key);
 assert(Number.isSafeInteger(binding.generation)&&binding.generation>0);
 assert.deepEqual(actor.binding,binding,'actor/kernel binding');assert.deepEqual(canonical.binding,binding,'canonical/kernel binding');
 assert.equal(state.backendSessionId,binding.session_id,'ordinary UI session');
 assert.equal(actor.startedAt,state.progress.startedAt,'actual UI start');assert.equal(actor.startedAt,canonical.progress.startedAt,'canonical start');
 assert(Number.isFinite(Date.parse(actor.startedAt)));
 assert.equal(kernel.outcome,'complete');assert.equal(canonical.outcome,'complete');assert(kernel.terminal&&kernel.quiescent&&canonical.quiescent);
 for(const key of ['unresolved_unknown_operation_ids','in_flight_operation_ids','in_flight_provider_call_ids'])assert.equal(kernel[key].length,0,key);
 for(const key of ['unknown','inflight','pendingProviders'])assert.equal(canonical[key].length,0,key);
 assert(Object.values(kernel.provider_calls).every(c=>c.usage));assert.equal(canonical.providers,Object.keys(kernel.provider_calls).length);assert.equal(canonical.operations,Object.keys(kernel.operations).length);
 assert.equal(state.running,false);assert.equal(state.error,'');
 const expectedSheet=m.expected.sheet??'M002';assert.equal(ui.actualSheet,expectedSheet);
 for(const key of ['actualFullSheet','actualFocusedContent','readable','clearOfOtherContent','correctDeliveredLinkClicked','normalOwnedClose','usefulCanonicalAnswer'])assert.equal(ui[key],true,key);
 if(m.kind==='mixed')assert.equal(ui.writtenFollowupPresent,true);
 for(const key of ['rootContentEdits','rootSaves','rootActorSteering','rootActorNativeReads'])assert.equal(ui[key],0,key);
 assert.equal(ui.correctNativeVersion,'2024');
 assert(Array.isArray(ui.images)&&ui.images.length>=3&&ui.images.length<=30,'result, full-sheet and focused visual evidence required');
 const roles=[/result[-_]ui\.(png|jpe?g)$/i,/-full\.(png|jpe?g)$/i,/-focused\.(png|jpe?g)$/i];assert(roles.every(role=>ui.images.some(p=>typeof p==='string'&&role.test(path.basename(p)))),'all visual roles required');
 const seen=new Set(),images=ui.images.map(p=>{
  assert(typeof p==='string'&&!path.isAbsolute(p));const absolute=path.resolve(m.caseRoot,p);assert(inside(m.caseRoot,absolute),'case-owned visual artifact');
  const key=absolute.toLowerCase();assert(!seen.has(key),'distinct visual artifacts');seen.add(key);
  const bytes=fs.readFileSync(absolute),info=visualFileInfo(bytes);assert(info.width>0&&info.height>0,'positive image dimensions');
  return{path:p,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),...info};
 });
 for(const phase of ['after','reopen']) {
  const grade=grades[phase];assert.equal(grade?.nativeScopePassed,true);assert.equal(grade.phase,phase,'grade phase');
  const {evidenceBinding,...facts}=grade;assert.equal(evidenceBinding?.schema,'operator.workflow-native-grade-evidence.v1','collected native grade evidence required');
  assert.equal(evidenceBinding.factsSha256,fingerprint(facts),'exact grade facts');
  assert.deepEqual(evidenceBinding.baseline,collectionWitness(m,'baseline'),'baseline evidence binding');
  assert.deepEqual(evidenceBinding.actual,collectionWitness(m,phase),'current evidence binding');
  if(phase==='after')assert.equal(evidenceBinding.actual.processId,evidenceBinding.baseline.processId,'same first process');
  else assert.notEqual(evidenceBinding.actual.processId,evidenceBinding.baseline.processId,'fresh independent process');
 }
 return{images,scope:'Offline artifact identity/presence only. Existing native/file/process/visual and truthful-delivery gates remain necessary; no canonical outcome is created or changed.'};
}

/** Annotation is the first complete vertical slice. Other case kinds cannot
 * acquire a pass by reusing this grader. Exact preserved cohorts, not counts. */
export function compareAnnotation(m,baseline,actual) {
 assert.equal(m.kind,'annotation');
 const targets=actual['all-text'].items.filter(x=>x.text.replace(/\r?\n|\r/g,'\n').replace(/\n$/,'')===m.expected.text);
 assert.equal(targets.length,1,'one exact editable requested note');const note=targets[0];
 const sheet=(actual.sheets.items??actual.sheets.sheets).filter(s=>s.sheetNumber===m.expected.sheet);assert.equal(sheet.length,1);
 assert.equal(note.ownerViewId,sheet[0].id);assert(note.uniqueId&&note.textTypeUniqueId);
 const paper=actual.titleblocks.items.filter(t=>t.ownerViewId===sheet[0].id).map(t=>t.geometry?.boundingBox);assert.equal(paper.length,1);
 const bb=note.boundingBox;assert(bb&&paper[0]);
 for(const axis of ['x','y'])assert(bb.min[axis]>=paper[0].min[axis]-1e-7&&bb.max[axis]<=paper[0].max[axis]+1e-7,'inside printed paper '+axis);
 const oldIds=new Set(baseline['all-text'].items.map(x=>x.elementId));assert(!oldIds.has(note.elementId),'new note');
 assert.equal(fingerprint(baseline['all-text'].items),fingerprint(actual['all-text'].items.filter(x=>oldIds.has(x.elementId))),'all prior exact notes');
 for(const [label]of categories) {
  const b=normalize(baseline[label],m),a=normalize(actual[label],m);
  if(label==='text-notes') {a.items=a.items.filter(x=>x.elementId!==note.elementId);a.elementIds=a.elementIds.filter(x=>x!==note.elementId);
   for(const key of ['count','returned','total','totalCount'])if(typeof a[key]==='number'&&typeof b[key]==='number'){assert.equal(a[key],b[key]+1,'exact added-note count '+key);a[key]-=1;}}
  assert.equal(fingerprint(a),fingerprint(b),'preserve inventory '+label);
 }
 for(const label of Object.keys(baseline).filter(k=>k==='connectors'||k==='views'||k==='sheets'||k.startsWith('sheet-')||k.endsWith('-parameters')||k.startsWith('tag-refs-')||k.startsWith('schedule-')||k==='text-types'))
  assert.equal(fingerprint(normalize(actual[label],m)),fingerprint(normalize(baseline[label],m)),'preserve '+label);
 return{noteId:note.elementId,noteUniqueId:note.uniqueId,owner:note.ownerViewId,text:note.text,insidePrintedPaper:true,allPriorNotesPreserved:true};
}
export function gradeAnnotation(m,phase,baseline,actual) {
 assert(['after','reopen'].includes(phase));
 const result=bindNativeGrade({at:new Date().toISOString(),phase,nativeScopePassed:true,...compareAnnotation(m,baseline,actual),
  limits:'Native preservation/appearance scope only. Full workflow requires independent canonical settlement, actor saved-file proof, fresh-process equality and actual UI/readability/final answer/link.'},baseline,actual);
 write(path.join(m.caseRoot,phase+'-native-grade.json'),result);return result;
}

export function summarize(m) {
 const events=fs.readFileSync(path.join(m.caseRoot,'timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 return {caseId:m.caseId,start:events[0]?.at,last:events.at(-1)?.at,totalElapsedSeconds:events.length?(Date.parse(events.at(-1).at)-Date.parse(events[0].at))/1000:0,
  interventions:events.filter(x=>x.event==='intervention'),events:events.length,
  scope:'Total recorded harness cycle, not just actor time. Canonical usage/outcome and UI checks are separate evidence.'};
}

const equal=(a,b,label)=>assert.equal(fingerprint(a),fingerprint(b),label);
const near=(a,b,label)=>assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-7,label);
/** Independent snapshot grading only. This never creates native evidence or
 * advances an actor's checklist, saved-artifact or task outcome. */
export function comparePreservedCollections(m,baseline,actual) {
 for(const label of Object.keys(baseline).filter(k=>!['context','health'].includes(k))) {
  assert(label in actual,'missing cohort '+label);
  equal(normalize(actual[label],m),normalize(baseline[label],m),'preserve '+label);
 }
}
export function compareMixed(m,baseline,actual) {
 const e=m.expected,b=structuredClone(baseline),a=structuredClone(actual);
 assert.equal(e.parameter,'Comments');assert(typeof e.value==='string'&&e.value.length>0);
 const rows=b['spaces-parameters'].items.filter(r=>r.parameters?.Number===e.number&&r.parameters?.Name===e.name&&(!e.levelContains||r.parameters.Level?.includes(e.levelContains)));
 assert.equal(rows.length,1,'unique actual space');const row=rows[0];assert(row.uniqueId);
 const matches=a['spaces-parameters'].items.filter(r=>r.id===row.id&&r.uniqueId===row.uniqueId);assert.equal(matches.length,1);
 const changed=matches[0];
 for(const [record,value]of [[row,''],[changed,e.value]]) {
  assert.equal(record.parameters.Comments,value,'actual Comments dictionary');
  const details=record.parameterDetails.filter(p=>p.parameterId===-1010106&&p.name==='Comments');assert.equal(details.length,1);
  const d=details[0];assert.equal(d.storageType,'String');assert.equal(d.isReadOnly,false);
  assert.equal(d.value,value,'native raw Comments');assert.equal(d.valueString,value,'native display Comments');
 }
 changed.parameters.Comments='';const detail=changed.parameterDetails.find(p=>p.parameterId===-1010106);detail.value='';detail.valueString='';
 comparePreservedCollections(m,b,a);return{spaceId:row.id,spaceUniqueId:row.uniqueId,parameter:e.parameter,value:e.value};
}
export function compareSchedule(m,baseline,actual) {
 const e=m.expected,b=structuredClone(baseline),a=structuredClone(actual);
 const entries=Object.entries(b).filter(([k,v])=>k.startsWith('schedule-')&&v.schedule?.name===e.schedule);assert.equal(entries.length,1,'unique schedule');
 const [key,bs]=entries[0],as=a[key];assert(bs.definitionSnapshot.complete&&as?.definitionSnapshot?.complete,'complete native definitions');
 assert(bs.definitionIdentity.complete&&as.definitionIdentity.complete);equal(as.definitionIdentity,bs.definitionIdentity,'schedule persistent identity');
 const fields=bs.fields.filter(f=>f.name===e.field&&!f.isHidden);assert.equal(fields.length,1);const bf=fields[0],af=as.fields.find(f=>f.fieldId===bf.fieldId);
 assert(af?.widths.complete&&bf.widths.complete);const feet=e.widthInches/12;assert(feet>0&&feet<1);
 near(af.widths.sheetColumnWidthFeet,feet,'requested sheet width');near(af.widths.gridColumnWidthFeet,feet,'requested grid width');
 const delta=feet-bf.widths.sheetColumnWidthFeet;
 af.widths.sheetColumnWidthFeet=bf.widths.sheetColumnWidthFeet;af.widths.gridColumnWidthFeet=bf.widths.gridColumnWidthFeet;
 const bd=bs.definitionSnapshot.definition,ad=as.definitionSnapshot.definition,df=ad.fields.find(f=>f.index===bf.index),db=bd.fields.find(f=>f.index===bf.index);
 assert(df&&db);near(df.sheetWidth,feet,'snapshot sheet width');near(df.gridWidth,feet,'snapshot grid width');df.sheetWidth=db.sheetWidth;df.gridWidth=db.gridWidth;
 // A width edit may reflow rows, but cannot change any cell, merge, style,
 // membership or row order. Bound each reflow and account for its exact height.
 let heightDelta=0;assert.equal(ad.table.length,bd.table.length);
 for(let s=0;s<bd.table.length;s++) {
  const before=bd.table[s],after=ad.table[s];assert.equal(after.rows.length,before.rows.length);
  for(let r=0;r<before.rows.length;r++) {
   const br=before.rows[r],ar=after.rows[r];
   assert(Number.isFinite(ar.heightFeet)&&ar.heightFeet>0&&ar.heightFeet<=Math.max(.5,br.heightFeet),'bounded row reflow');
   heightDelta+=ar.heightFeet-br.heightFeet;ar.heightFeet=br.heightFeet;
  }
 }
 equal(normalize(as,m),normalize(bs,m),'only requested field widths and bounded row heights');
 const sheetKey='sheet-'+e.sheet,placements=b[sheetKey].placedSchedules.filter(p=>p.scheduleId===bs.schedule.id);assert.equal(placements.length,1);
 const bp=placements[0],ap=a[sheetKey].placedSchedules.find(p=>p.instanceId===bp.instanceId);assert(ap);
 equal(ap.point,bp.point,'exact placement anchor');
 for(const k of ['minU','maxV'])near(ap.boundingBox[k],bp.boundingBox[k],'fixed table edge '+k);
 near(ap.boundingBox.maxU,bp.boundingBox.maxU+delta,'table width follows exact field delta');
 near(ap.boundingBox.minV,bp.boundingBox.minV-heightDelta,'table height follows exact row reflow');
 const paper=a.titleblocks.items.filter(t=>t.ownerViewId===a[sheetKey].sheetElementId).map(t=>t.geometry.boundingBox);assert.equal(paper.length,1);
 assert(ap.boundingBox.minU>=paper[0].min.x&&ap.boundingBox.maxU<=paper[0].max.x&&ap.boundingBox.minV>=paper[0].min.y&&ap.boundingBox.maxV<=paper[0].max.y,'printed paper');
 for(const p of a[sheetKey].placedSchedules.filter(p=>p.instanceId!==ap.instanceId)) {
  const x=ap.boundingBox,y=p.boundingBox;
  assert(x.maxU<=y.minU||x.minU>=y.maxU||x.maxV<=y.minV||x.minV>=y.maxV,'no schedule overlap');
 }
 const gi=a['schedule-graphics'].items.find(i=>i.elementId===bp.instanceId),gb=b['schedule-graphics'].items.find(i=>i.elementId===bp.instanceId);assert(gi&&gb);
 const box=gi.geometry.boundingBox,x=ap.boundingBox;
 near(box.min.x,x.minU,'inventory left');near(box.max.x,x.maxU,'inventory right');near(box.min.y,x.minV,'inventory bottom');near(box.max.y,x.maxV,'inventory top');
 for(const axis of ['x','y','z']){near(box.center[axis],(box.min[axis]+box.max[axis])/2,'bbox center');near(box.size[axis],box.max[axis]-box.min[axis],'bbox size');}
 gi.geometry.boundingBox=gb.geometry.boundingBox;ap.boundingBox=bp.boundingBox;
 comparePreservedCollections(m,b,a);return{scheduleId:bs.schedule.id,scheduleUniqueId:bs.schedule.uniqueId,field:e.field,widthInches:e.widthInches,heightDeltaFeet:heightDelta};
}
export function gradeCase(m,phase,baseline,actual) {
 if(m.kind==='annotation')return gradeAnnotation(m,phase,baseline,actual);
 assert(['after','reopen'].includes(phase));
 const facts=m.kind==='schedule'?compareSchedule(m,baseline,actual):m.kind==='mixed'?compareMixed(m,baseline,actual):m.kind==='package'?comparePackage(m,baseline,actual):assert.fail('unsupported case kind');
 const result=bindNativeGrade({at:new Date().toISOString(),phase,nativeScopePassed:true,...facts,
  limits:'Independent native scope only. Canonical completion, actor SaveAs/file proof, fresh-process persistence, actual sheet and final written answer/link remain separate.'},baseline,actual);
 write(path.join(m.caseRoot,phase+'-native-grade.json'),result);return result;
}

/** Compose independently checked, disjoint deltas. The schedule check covers
 * every non-note cohort after only the already-verified Comments projection is
 * reconciled. The note check then covers both note inventories and all old
 * notes, with only those already-verified parameter/schedule cohorts reconciled.
 * No raw collection, native receipt or actor state is edited or certified. */
export function comparePackage(m,baseline,actual){
 assert.equal(m.kind,'package');assert.deepEqual(Object.keys(m.expected).sort(),['note','schedule','space']);const e=m.expected;
 const space=compareMixed({...m,expected:e.space},{'spaces-parameters':baseline['spaces-parameters']},{'spaces-parameters':actual['spaces-parameters']});
 const b=structuredClone(baseline),a=structuredClone(actual);a['spaces-parameters']=structuredClone(b['spaces-parameters']);
 for(const key of ['all-text','text-notes']){delete b[key];delete a[key];}
 const schedule=compareSchedule({...m,expected:e.schedule},b,a);
 const noteBaseline=structuredClone(baseline),scheduleKey='schedule-'+schedule.scheduleId;
 for(const key of ['spaces-parameters','schedule-graphics','sheet-'+e.schedule.sheet,scheduleKey])noteBaseline[key]=structuredClone(actual[key]);
 const note=compareAnnotation({...m,kind:'annotation',expected:e.note},noteBaseline,actual);
 return{note,schedule,space,exactThreeDeltas:true,allOtherCollectedCohortsPreserved:true};
}

/** Retained-workflow telemetry, never completion/authorization evidence. Reuse
 * host pricing/category functions; keep cache writes separate from uncached
 * input and keep provider/tool/kernel units and overlapping spans distinct. */
export function workflowExecutionLogs({kernel,state,logs}){
 const keys=['toolCalls','toolOutputs','agentEvents'];
 if(keys.every(key=>Array.isArray(logs[key])))return {...logs,basis:'retained-helper-logs'};
 assert(keys.every(key=>logs[key]===null),'partial execution logs cannot be silently omitted');
 assert.equal(state.backendSessionId,kernel.current_binding.session_id,'exact unified session');
 assert((state.functionToolReceipts??[]).some(r=>r.tool_name?.startsWith('native__')),'actual unified native receipt required');
 assert(!(state.functionToolReceipts??[]).some(r=>r.tool_name==='delegate_revit_task'),'missing helper logs');
 const receipts=new Map((state.modelCallReceipts??[]).map(r=>[r.call_id,r]));
 assert.equal(receipts.size,(state.modelCallReceipts??[]).length,'unique provider receipt');
 for(const call of Object.values(kernel.provider_calls)){
  const receipt=receipts.get(call.upstream_receipt?.call_id??call.call_id);
  assert(receipt?.route==='desktop_computer','unmatched or helper provider cannot use absent helper logs');
 }
 return {toolCalls:[],toolOutputs:[],agentEvents:[],basis:'unified-canonical-and-sidecar; no helper logs created'};
}
export function workflowPhaseDigest({kernel:k,state:s,canonical:c,toolCalls=[],toolOutputs=[],agentEvents=[]},pricing){
 assert.equal(s.backendSessionId,k.current_binding.session_id,'exact retained actor session');
 assert.equal(c.binding.assignment_id,k.current_binding.assignment_id,'canonical assignment');
 assert.equal(c.providers,Object.keys(k.provider_calls).length,'canonical provider cohort');
 assert.equal(c.operations,Object.keys(k.operations).length,'canonical operation cohort');
 const models=new Map((s.modelCallReceipts??[]).map(r=>[r.call_id,r]));
 assert.equal(models.size,(s.modelCallReceipts??[]).length,'unique model receipts');
 const reviews=(s.functionToolReceipts??[]).filter(r=>r.tool_name==='review_current_work');
 const allReviewerIds=new Set(reviews.map(r=>r.result?.reviewer_response_id).filter(Boolean));
 const reviewerIds=new Set(reviews.filter(r=>r.evidence_ref?.assignment_id===k.current_binding.assignment_id&&r.evidence_ref?.session_id===k.current_binding.session_id)
  .map(r=>r.result?.reviewer_response_id).filter(Boolean));
 const rows=Object.values(k.provider_calls).map(call=>{
  const id=call.upstream_receipt?.call_id??call.call_id,m=models.get(id),u=call.usage??{};
  if(m)for(const key of ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens'])assert.equal(m.tokens?.[key],u[key],'model/kernel usage agreement '+key);
  const role=reviewerIds.has(id)?'reviewer':allReviewerIds.has(id)?'unknown':m?.route==='codex_agent'?'helper':m?.route==='desktop_computer'?'owner':'unknown';
  const reportedStartedAt=m?.started_at_utc??call.dispatched_at??null;
  // The pinned Codex raw-completion adapter records its enclosing helper-turn
  // start on every receipt. The kernel imports that same timestamp; it is not
  // a second independent source of per-call dispatch time. Preserve it without
  // silently assigning later calls/cost to an earlier workflow phase.
  const startedAt=m?.route==='codex_agent'||!Number.isFinite(Date.parse(reportedStartedAt))?null:reportedStartedAt;
  return{id,kernelCallId:call.call_id,role,startedAt,reportedStartedAt,
   startTimingBasis:m?.route==='codex_agent'?'helper_turn_start_only':startedAt?'host_call_start':'unavailable',completedAt:call.completed_at,
   input:u.input_tokens,cacheRead:u.cached_input_tokens,cacheWrite:u.cache_write_input_tokens,uncached:pricing.ordinaryInputTokens(u),output:u.output_tokens,
   priceEquivalentUsd:pricing.standardProviderTextTokenCostUsd(call.model,u),receiptEstimateUsd:u.estimated_cost_usd??null};
 });
 assert.equal(new Set(rows.map(r=>r.id)).size,rows.length,'one model receipt per provider call');
 const completeSum=(rs,key)=>rs.every(r=>Number.isFinite(r[key])&&r[key]>=0)?rs.reduce((n,r)=>n+r[key],0):null;
 const summarize=rs=>({calls:rs.length,inputTokens:completeSum(rs,'input'),cacheReadTokens:completeSum(rs,'cacheRead'),cacheWriteTokens:completeSum(rs,'cacheWrite'),
  uncachedTokens:completeSum(rs,'uncached'),outputTokens:completeSum(rs,'output'),standardTextPriceEquivalentUsd:completeSum(rs,'priceEquivalentUsd'),receiptEstimateUsd:completeSum(rs,'receiptEstimateUsd')});
 const ops=Object.values(k.operations),applied=ops.filter(o=>o.persistent_effect==='applied'&&o.result?.authority==='native-host'&&o.result.status==='succeeded');
 const saves=applied.filter(o=>o.request_identity?.path==='/revit/save-as').sort((a,b)=>Date.parse(a.result.completed_at)-Date.parse(b.result.completed_at)),save=saves.at(-1)?.result.completed_at??null;
 const first=applied.filter(o=>o.request_identity?.path!=='/revit/save-as').sort((a,b)=>Date.parse(a.result.completed_at)-Date.parse(b.result.completed_at))[0];
 const frequencies=items=>items.reduce((o,key)=>(o[key]=(o[key]??0)+1,o),{}),after=at=>save&&Date.parse(at)>Date.parse(save);
 const unknownPostSave=save?rows.filter(r=>r.startedAt===null&&(!Number.isFinite(Date.parse(r.completedAt))||after(r.completedAt))):[];
 const knownPostSave=summarize(rows.filter(r=>after(r.startedAt)));
 const turns=agentEvents.filter(e=>e.event==='USER_TURN_RECEIVED').map(e=>e.ts),returns=(s.functionToolReceipts??[]).filter(r=>r.tool_name==='delegate_revit_task').map(r=>r.recorded_at);
 assert.equal(turns.length,returns.length,'actual helper starts and returns reconcile');
 const helperSpans=turns.map((at,i)=>{assert(Date.parse(returns[i])>=Date.parse(at),'helper interval');return{startedAt:at,returnedAt:returns[i],seconds:(Date.parse(returns[i])-Date.parse(at))/1000};});
 const signatures=rs=>frequencies(rs.map(r=>JSON.stringify([r.ts,r.tool,r.server,r.thread_id,r.turn_id])));
 assert.deepEqual(signatures(toolCalls),signatures(toolOutputs),'MCP call/output cohorts reconcile');
 const stopped=c.progress.updatedAt,started=c.progress.startedAt;
 const rollup=summarize(rows);if(rollup.inputTokens!==null&&rollup.cacheReadTokens!==null&&rollup.cacheWriteTokens!==null&&rollup.uncachedTokens!==null)
  assert.equal(rollup.inputTokens,rollup.cacheReadTokens+rollup.cacheWriteTokens+rollup.uncachedTokens,'disjoint input categories');
 return{schema:'operator.workflow-phase-digest.v1',assignmentId:k.current_binding.assignment_id,outcome:k.outcome,
  reconciliation:{providerCalls:rows.length,modelReceipts:models.size,unmatchedKernelCalls:rows.filter(r=>!models.has(r.id)).map(r=>r.kernelCallId),unmatchedModelReceipts:[...models.keys()].filter(id=>!rows.some(r=>r.id===id)),
   modelUsageAgreesWhereMatched:true,unknownProviderStartIds:rows.filter(r=>!Number.isFinite(Date.parse(r.startedAt))).map(r=>r.kernelCallId),mcpCallsAndOutputsAgree:true},accounting:rollup,roles:Object.fromEntries(['owner','helper','reviewer','unknown'].map(role=>[role,summarize(rows.filter(r=>r.role===role))])),
  counts:{providerCalls:rows.length,helperMcpTools:toolCalls.length,ownerFunctionTools:(s.functionToolReceipts??[]).length,
   directNativeFunctionTools:(s.functionToolReceipts??[]).filter(r=>r.tool_name?.startsWith('native__')).length,
   directNativeToolFrequency:frequencies((s.functionToolReceipts??[]).filter(r=>r.tool_name?.startsWith('native__')).map(r=>r.tool_name)),
   kernelOperations:ops.length,kernelOperationRoles:frequencies(ops.map(o=>o.operation_role??'unspecified')),helperToolFrequency:frequencies(toolCalls.map(r=>r.tool))},
  timing:{startedAt:started,stoppedAt:stopped,actorSeconds:(Date.parse(stopped)-Date.parse(started))/1000,firstNativeEffectAt:first?.result.completed_at??null,secondsToFirstEffect:first?(Date.parse(first.result.completed_at)-Date.parse(started))/1000:null,lastNativeSave:save,
   secondsAfterLastSave:save?(Date.parse(stopped)-Date.parse(save))/1000:null,helperSpans,ownerRelaySpans:helperSpans.slice(0,-1).map((r,i)=>({startedAt:r.returnedAt,endedAt:helperSpans[i+1].startedAt,seconds:(Date.parse(helperSpans[i+1].startedAt)-Date.parse(r.returnedAt))/1000})),
   reviewSpans:reviews.map(r=>({mode:r.arguments?.capture_mode,capturedAt:r.result?.capture?.frame?.captured_at_utc??null,returnedAt:r.recorded_at,state:r.result?.state,reason:r.result?.reason?.split('\n')[0].slice(0,160)}))},
  afterSave:save?{providers:unknownPostSave.length?null:knownPostSave,providersWithKnownStart:knownPostSave,
   providerTimingComplete:unknownPostSave.length===0,unattributedProviderIds:unknownPostSave.map(r=>r.id),
   helperMcpTools:toolCalls.filter(r=>after(r.ts)).length,helperToolFrequency:frequencies(toolCalls.filter(r=>after(r.ts)).map(r=>r.tool)),kernelOperationsOpened:ops.filter(o=>after(o.opened_at)).length}:null,
  toolFailures:toolOutputs.filter(r=>r.status!=='completed'||r.error).map(r=>({at:r.ts,tool:r.tool,status:r.status,error:r.error})),providerRows:rows,pricingSnapshot:pricing.PROVIDER_TOKEN_PRICING_SNAPSHOT,actualBillingUsd:null,
  limits:'Retained telemetry only. Role is receipt-route plus exact owned reviewer-response identity; unknown routes stay unknown. Codex helper receipts expose a turn start, not per-call dispatch; startedAt is null for these calls. Unknown post-save attribution is null, never zero; full usage totals remain valid. Provider, owner-function, worker-MCP and kernel counts are distinct. Helper/owner-relay/review spans may overlap; never sum them as total wall time. Post-save time includes necessary verification. Cache categories are disjoint subsets of input; price-equivalent snapshot and receipt estimates are not invoices. Root coding usage, unrecorded setup and actual billing remain unavailable. This digest does not grant completion or alter historical outcomes.'};
}
