import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'native-view-activation-'));
const keys=['OPERATOR_DESKTOP_NO_LISTEN','OPERATOR_WORKSPACE_ROOT'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
Object.assign(process.env,{OPERATOR_DESKTOP_NO_LISTEN:'1',OPERATOR_WORKSPACE_ROOT:temp});
const desktop=await import('../server.js?native-view-activation');
after(()=>{for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(temp,{recursive:true,force:true});});
const context=(id=624550)=>({process_id:14024,document:{sessionId:'sample-document-session',projectIdentity:{fingerprint:'a'.repeat(64)},activeView:{id,name:id===624550?'Electrical Power Riser Diagram':'Power Riser - North'}}});
test('ordinary Sidecar activation waits for the native pending view without replaying activation',async()=>{
 let activations=0,reads=0,guards=0;
 const result=await desktop.activateRevitView({view_id:624641},{
  assertCurrent:async()=>{guards++;},delay:async()=>{},
  fetchContext:async()=>({ok:true,data:context(++reads<3?624550:624641)}),
  fetchActivate:async()=>{activations++;return{ok:true,data:{ok:true,activationPending:true,focusPending:false,activeViewId:624550,activeViewName:'Electrical Power Riser Diagram',requestedViewId:624641,requestedViewName:'Power Riser - North'}};}
 });
 assert.deepEqual(result,{ok:true,active_view:{id:624641,name:'Power Riser - North'}});
 assert.equal(activations,1);assert.equal(reads,3);assert(guards>=4);
});
test('ordinary activation rejects a different document after a pending native response',async()=>{
 let reads=0,activations=0;
 const r=await desktop.activateRevitView({view_id:624641},{assertCurrent:async()=>{},delay:async()=>{},
  fetchContext:async()=>{const c=context(reads?624641:624550);if(reads++)c.document.sessionId='other';return {ok:true,data:c};},
  fetchActivate:async()=>{activations++;return {ok:true,data:{ok:true,activationPending:true,requestedViewId:624641,activeViewId:624550}};}});
 assert.equal(r.ok,false);assert.match(r.error,/context_changed/);assert.equal(activations,1);
});
test('ordinary pending timeout stays pending and activation is not repeated',async()=>{
 let activations=0,reads=0;
 const r=await desktop.activateRevitView({view_id:624641},{assertCurrent:async()=>{},delay:async()=>{},
  fetchContext:async()=>{reads++;return{ok:true,data:context()};},
  fetchActivate:async()=>{activations++;return{ok:true,data:{ok:true,activationPending:true,requestedViewId:624641,activeViewId:624550}};}});
 assert.equal(r.ok,false);assert.equal(r.activation_pending,true);assert.equal(activations,1);assert.equal(reads,6);
});
test('normal activation requires canonical control before any native dispatch',async()=>{
 let calls=0;const unexpected=async()=>{calls++;throw Error('unexpected');};
 const r=await desktop.activateRevitView({view_id:624641},{fetchActivate:unexpected,fetchContext:unexpected});
 assert.equal(r.ok,false);assert.match(r.error,/canonical Assignment/);assert.equal(calls,0);
});
test('ordinary owner forwards exact native focus body and requires actual native focus',async()=>{
 let body;
 const r=await desktop.activateRevitView({view_id:624641,bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]},{
  assertCurrent:async()=>{},delay:async()=>{},fetchContext:async()=>({ok:true,data:context(624641)}),
  fetchActivate:async value=>{body=value;return {ok:true,data:{ok:true,activationPending:false,focusPending:false,requestedViewId:624641,activeViewId:624641,activeViewName:'Power Riser - North',didZoom:true}};}
 });
 assert.equal(r.ok,true);assert.deepEqual(body,{viewId:624641,bboxMinXyz:[1,2,0],bboxMaxXyz:[3,4,0]});
 assert.equal(r.focus.confirmed,true);
});
test('ordinary model-visible owner tool exposes the shared focus contract',()=>{
 const t=desktop.buildComputerTools().filter(t=>t.name==='activate_revit_view');assert.equal(t.length,1);
 assert.equal(t[0].parameters.additionalProperties,false);
 for(const key of ['bbox_min_xyz','bbox_max_xyz','show_element_ids','zoom_to_fit'])assert(t[0].parameters.properties[key]);
 assert.match(t[0].description,/native_visible_region/);assert.match(t[0].description,/unseen/);
});
test('invalid owner focus cannot dispatch native navigation',async()=>{
 let dispatch=0;const options={assertCurrent:async()=>{},delay:async()=>{},fetchContext:async()=>({ok:true,data:context()}),fetchActivate:async()=>{dispatch++;throw Error('unexpected');}};
 for(const t of [{view_id:624641,bbox_min_xyz:[0,0,0]},{view_id:'624641trailing',zoom_to_fit:true},{view_id:624641,show_element_ids:[1,1]}]){
  const r=await desktop.activateRevitView(t,options);assert.equal(r.ok,false);
 }
 assert.equal(dispatch,0);
});

test('one ordinary owner request activates and then focuses a different exact view',async()=>{
 let active=624550;const bodies=[];
 const result=await desktop.activateRevitView({view_id:624641,bbox_min_xyz:[1,2,0],bbox_max_xyz:[3,4,0]}, {
  assertCurrent:async()=>{},delay:async()=>{},fetchContext:async()=>({ok:true,data:context(active)}),
  fetchActivate:async body=>{bodies.push(body);active=body.viewId;return{ok:true,data:{ok:true,activationPending:false,focusPending:false,requestedViewId:active,activeViewId:active,activeViewName:'Target',didZoom:!!body.bboxMinXyz}};}
 });
 assert.equal(result.ok,true);assert.equal(result.focus.confirmed,true);
 assert.deepEqual(bodies,[{viewId:624641},{viewId:624641,bboxMinXyz:[1,2,0],bboxMaxXyz:[3,4,0]}]);
});

for(const fail of ['pending','error','paused','document','process','project'])test('owner navigation stops at '+fail+' before focusing another context',async()=>{
 let active=624550,changed=false;const bodies=[];
 const result=await desktop.activateRevitView({view_id:624641,zoom_to_fit:true},{delay:async()=>{},
  assertCurrent:async()=>{if(fail==='paused'&&changed)throw Error('paused');},
  fetchContext:async()=>{const c=context(active);if(changed){if(fail==='document')c.document.sessionId='other';if(fail==='process')c.process_id++;if(fail==='project')c.document.projectIdentity.fingerprint='b'.repeat(64);}return{ok:true,data:c};},
  fetchActivate:async body=>{bodies.push(body);changed=true;if(fail!=='pending')active=body.viewId;
   if(fail==='error')throw Error('transport_unknown');
   return{ok:true,data:{ok:true,activationPending:true,requestedViewId:624641,activeViewId:624550}};}
 });
 assert.equal(result.ok,false);assert.equal(bodies.length,1);assert.deepEqual(bodies[0],{viewId:624641});
});
test('legacy camel-case activation alias still uses the same plain request',async()=>{
 let body,active=624550;const r=await desktop.activateRevitView({viewId:624641},{assertCurrent:async()=>{},fetchContext:async()=>({ok:true,data:context(active)}),fetchActivate:async b=>{body=b;active=624641;return{ok:true,data:{ok:true,activationPending:false,requestedViewId:624641,activeViewId:624641,activeViewName:'Power Riser - North'}};}});
 assert.equal(r.ok,true);assert.deepEqual(body,{viewId:624641});
});
test('native failed zoom remains an unconfirmed owner result, not a visual pass',async()=>{
 const r=await desktop.activateRevitView({view_id:624641,zoom_to_fit:true},{assertCurrent:async()=>{},fetchContext:async()=>({ok:true,data:context(624641)}),fetchActivate:async()=>({ok:true,data:{ok:true,activationPending:false,focusPending:false,requestedViewId:624641,activeViewId:624641,activeViewName:'Power Riser - North',didZoom:false}})});
 assert.equal(r.ok,false);assert.equal(r.focus_pending,true);
});
