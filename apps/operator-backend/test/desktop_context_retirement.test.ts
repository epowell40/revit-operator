import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import{createHash}from'node:crypto';
import{retireCompletedDesktopImages}from'../src/desktop_response_store.js';
import{storeEvidence,readAuthoritativeEvidence}from'../src/evidence/evidence_store.js';
import{canonicalJsonV2}from'../src/domain/assignment-kernel/index.js';
import{ensureWorkspaceLayout}from'../src/workspace.js';
const binding={session_id:'session',assignment_id:'assignment',run_id:'run',generation:1,kernelVersion:2 as const};
const pixels=Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS0AAAAASUVORK5CYII=','base64'),Buffer.alloc(16_384)]);
function fixture(run:(f:any)=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'context-retirement-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{const evidence=storeEvidence({scope:binding,source:'retirement-test',raw:pixels,media_type:'image/png',trust_level:'host_observed',verification_relevance:'supporting'}),layout=ensureWorkspaceLayout(),dir=path.join(layout.runs,'desktop-responses');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,createHash('sha256').update(canonicalJsonV2([binding.session_id,'owner-context'])).digest('hex')+'.json.context');
  const state:any={terminal:true,quiescent:true,outcome:'complete',current_binding:binding,unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],pending_review_ids:[],pending_input_variable_ids:[],provider_calls:{}};
  const context={binding,complete:true,message_id:'one',window:[{role:'user',content:[{type:'input_text',text:'Preserve task and all native results'}, {type:'input_image',image_url:'data:image/png;base64,'+pixels.toString('base64'),detail:'original'}]}],outputs:[]};
  const reset=()=>fs.writeFileSync(file,JSON.stringify(context));reset();run({root,file,state,context,reset,evidence,layout});
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}}
test('retirement policy protects active, paused, failed, blocked, unknown, pending and foreign work',()=>fixture(f=>{
 const patches=[{terminal:false},{quiescent:false},{outcome:'blocked'},{outcome:'failed'},{execution_control:{state:'paused'}},{provider_usage_hold:{}},{unresolved_unknown_operation_ids:['u']},{in_flight_operation_ids:['o']},{in_flight_provider_call_ids:['p']},{pending_review_ids:['r']},{pending_input_variable_ids:['i']},{provider_calls:{p:{completed_at:'now'}}},{provider_calls:{p:{completed_at:'now',usage:{total_tokens:null}}}},{current_binding:{...binding,generation:2}}];
 const before=fs.readFileSync(f.file);for(const patch of patches){assert.equal(retireCompletedDesktopImages(binding,{...f.state,...patch}).status,'protected');assert.deepEqual(fs.readFileSync(f.file),before);}
}));
test('qualification pins, missing/corrupt original pixels and unsupported image inputs fail closed',()=>fixture(f=>{
 const before=fs.readFileSync(f.file);fs.writeFileSync(f.file+'.retain','qualification evidence');assert.equal(retireCompletedDesktopImages(binding,f.state).status,'pinned');fs.unlinkSync(f.file+'.retain');
 const object=path.resolve(f.layout.root,f.evidence.ref.artifact_location),saved=fs.readFileSync(object);fs.writeFileSync(object,Buffer.alloc(saved.length));assert.equal(retireCompletedDesktopImages(binding,f.state).status,'protected_unverified_or_unavailable');assert.deepEqual(fs.readFileSync(f.file),before);fs.unlinkSync(object);assert.equal(retireCompletedDesktopImages(binding,f.state).status,'protected_unverified_or_unavailable');fs.writeFileSync(object,saved);
 const foreign=structuredClone(f.context);foreign.binding.generation=2;fs.writeFileSync(f.file,JSON.stringify(foreign));assert.equal(retireCompletedDesktopImages(binding,f.state).status,'protected_unverified_or_unavailable');
 for(const part of [{type:'input_image',file_id:'external'},{type:'input_image',image_url:'https://example.test/image.png'},{type:'input_image',image_url:'data:image/png;base64,bad!'}]){const c=structuredClone(f.context);c.window[0].content[1]=part as any;fs.writeFileSync(f.file,JSON.stringify(c));const raw=fs.readFileSync(f.file);assert.equal(retireCompletedDesktopImages(binding,f.state).status,'protected_unverified_or_unavailable');assert.deepEqual(fs.readFileSync(f.file),raw);}
}));
test('30 completed context refreshes reuse original pixels; native text and immutable original evidence survive',()=>fixture(f=>{
 const original=fs.readFileSync(path.resolve(f.layout.root,f.evidence.ref.artifact_location));let recovered=0,maxBytes=0;
 for(let i=0;i<30;i++){f.reset();const r=retireCompletedDesktopImages(binding,f.state);assert.equal(r.status,'retired');recovered+=r.bytes_recovered!;maxBytes=Math.max(maxBytes,fs.statSync(f.file).size);const retained=JSON.parse(fs.readFileSync(f.file,'utf8'));assert.equal(retained.complete,false);assert.match(JSON.stringify(retained),/Preserve task and all native results/);assert(!JSON.stringify(retained).includes('data:image/'));assert.equal(retireCompletedDesktopImages(binding,f.state).status,'unchanged');}
 assert(recovered>600_000);assert(maxBytes<2_000);assert.deepEqual(readAuthoritativeEvidence(f.evidence.ref,binding),original);
 console.log('TEST_IMAGE_CONTEXT_GROWTH '+JSON.stringify({synthetic_refreshes:30,recovered_bytes:recovered,max_working_context_bytes:maxBytes,original_image_objects:1,original_image_bytes:original.length,scope:'Policy-level repeated contexts; actual canonical-terminal producer tested separately'}));
}));
