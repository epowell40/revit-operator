import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function render(health=null,local=false){
 const elements={environmentSummary:{}};
 const start=source.indexOf('function renderEnvironmentProfile('),end=source.indexOf('\nasync function refreshEnvironmentProfile(',start);
 const state={backendLocal:local,environmentRevitHealth:health,environmentProfileStatus:'ready'};
 const invoke=runInNewContext(source.slice(start,end)+';renderEnvironmentProfile',{
  state,elements,computeEnvironmentStatus:()=> 'ready',environmentBadgePresentation:()=>({}),
  environmentDiagnosticSummary,environmentTone:()=>'',escapeHtml:x=>x
 });
 invoke({manifest:{preferred_output_dir:'/tmp/RevitOperator/Exports',capabilities:{powershell:false,revit_api:false}}});
 return elements.environmentSummary.textContent;
}
// Production summary is imported when present; the legacy renderer never calls it.
let environmentDiagnosticSummary;
try {({environmentDiagnosticSummary}=await import('../public/environment_diagnostics_ui.mjs'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('hosted Linux profile cannot describe Windows Revit or PowerShell readiness',()=>{
 const text=render();
 assert.match(text,/Hosted exports: \/tmp\/RevitOperator\/Exports/);
 assert.match(text,/Local Revit: Not verified/);
 assert.doesNotMatch(text,/PowerShell restricted|Revit API not verified/);
});
test('fresh local native response is distinct from hosted profile capabilities',()=>{
 const text=render({ok:true,context:{process_id:42,readiness:{revit_launched:true},document:{title:'E101 test'}}});
 assert.match(text,/Local Revit: Responding/);assert.match(text,/E101 test/);
});
test('cached or unavailable health is not displayed as fresh local verification',()=>{
 assert.match(render({ok:true,cached:true,context:{process_id:42,readiness:{revit_launched:true}}}),/Local Revit: Last known responsive/);
 assert.match(render({ok:false,context:null}),/Local Revit: No response/);
});
function healthRefresh(fetchJsonWithTimeout){
 const start=source.indexOf('async function refreshEnvironmentRevitHealth('),end=source.indexOf('\nasync function refreshEnvironmentProfile(',start);
 const state={};
 const refresh=runInNewContext(source.slice(start,end)+';refreshEnvironmentRevitHealth',{state,fetchJsonWithTimeout});
 return {state,refresh};
}
test('ordinary display uses cached native health; explicit diagnostics refresh probes local Revit',async()=>{
 const paths=[];const {refresh}=healthRefresh(async path=>{paths.push(path);return{ok:false,context:null};});
 await refresh();await refresh({fresh:true});
 assert.deepEqual(paths,['/api/revit/health?prefer_cached=1','/api/revit/health']);
});
test('late display read cannot overwrite newer explicit local diagnostics',async()=>{
 let finish;const fresh={ok:false,context:null};
 const {refresh,state}=healthRefresh(path=>path.includes('?')?new Promise(resolve=>{finish=resolve;}):Promise.resolve(fresh));
 const old=refresh();await refresh({fresh:true});finish({ok:true,context:{process_id:42}});await old;
 assert.equal(state.environmentRevitHealth,fresh);
});
test('failed local probe removes stale display success without changing assignment state',async()=>{
 const {refresh,state}=healthRefresh(async()=>{throw Error('deadline');});
 state.environmentRevitHealth={ok:true};state.assignment={id:'keep'};
 await refresh({fresh:true});assert.equal(state.environmentRevitHealth.ok,false);
 assert.equal(state.assignment.id,'keep');
});
