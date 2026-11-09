import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopToolHistoryCache,boundedPromptCacheDiagnostic} from '../src/desktop_prompt_cache.js';
const result=(id:string)=>({type:'function_call_output',call_id:id,output:'exact native result '+id});
const feedback=(n:number)=>({role:'user',content:[{type:'input_text',text:'HOST CURRENT CHECK FEEDBACK. '+n}]});
const strip=(v:any):any=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>k!=='prompt_cache_breakpoint').map(([k,x])=>[k,strip(x)])):v;

test('cache endpoint survives replacement of volatile feedback with exact growing tool history',()=>{
 const history=[{role:'user',content:'Draft the drawing'},result('a')],a=[...history,feedback(1)],b=[...history,result('b'),feedback(2)];
 const old=structuredClone(a),one=desktopToolHistoryCache(a,'gpt-6.1-sol',true),two=desktopToolHistoryCache(b,'gpt-6.1-sol',true);
 assert.deepEqual(one.options,{mode:'implicit'});
 assert.equal(one.diagnostic.breakpoints[0]!.prefix_sha256,two.diagnostic.breakpoints[0]!.prefix_sha256);
 assert.deepEqual(strip((one.input as any[]).slice(0,2)),strip((two.input as any[]).slice(0,2)));
 assert.deepEqual(a,old);assert.deepEqual((one.input as any[]).at(-1),feedback(1));
});

test('three explicit boundaries leave implicit slot; normalize text consistently without changing values',()=>{
 const input=Array.from({length:12},(_,i)=>result(String(i))),original=structuredClone(input);
 const p=desktopToolHistoryCache(input,'gpt-6.1-terra',true);
 assert.deepEqual(p.diagnostic.breakpoints.map(x=>x.index),[9,10,11]);
 for(const [i,row]of (p.input as any[]).entries())assert.equal(row.output[0].text,input[i]!.output);
 assert.deepEqual(input,original);
});

test('opaque compaction, images, IDs, calls and genuine model states are not rewritten',()=>{
 const opaque={type:'compaction',encrypted_content:'opaque-contents'},image={type:'input_image',detail:'original',image_url:'data:image/png;base64,AA=='},call={type:'function_call',name:'read',call_id:'a',arguments:'{}'},r={type:'function_call_output',call_id:'a',output:[image,{type:'input_text',text:'geometry mismatched'}]};
 const input=[opaque,call,r,feedback(3)],p=desktopToolHistoryCache(input,'gpt-6.1-sol',true);
 assert.deepEqual(strip(p.input),input);assert.equal((p.input as any[])[0],opaque);assert.equal((p.input as any[])[2].output[0],image);
 assert.equal(p.diagnostic.breakpoints.length,1);
 const changed=desktopToolHistoryCache([opaque,call,{...r,output:[image,{type:'input_text',text:'geometry changed'}]},feedback(3)],'gpt-6.1-sol',true);
 assert.notEqual(changed.diagnostic.breakpoints[0]!.prefix_sha256,p.diagnostic.breakpoints[0]!.prefix_sha256);
});

test('legacy models, review/unbound requests, image-only outputs and existing markers get no added policy',()=>{
 for(const [model,enabled,input]of [['gpt-5.4',true,[result('a')]],['gpt-6.1-sol',false,[result('a')]],['gpt-6.1-sol',true,[feedback(1)]],['gpt-6.1-sol',true,[{type:'function_call_output',call_id:'a',output:[{type:'input_image',image_url:'data:image/png;base64,AA=='}]}]],['gpt-6.1-sol',true,[{type:'function_call_output',call_id:'a',output:[{type:'input_text',text:'keep',prompt_cache_breakpoint:{mode:'explicit'}}]}]]] as const){
  const p=desktopToolHistoryCache(input,model,enabled);assert.equal(p.input,input);assert.equal(p.options,undefined);assert.equal(p.diagnostic.enabled,false);
 }
});

test('provider diagnostics retain bounded observations, never prompt content or authority',()=>{
 assert.deepEqual(boundedPromptCacheDiagnostic({type:'cache_miss',reason:'tools_changed',cache_missed_tokens:123,prompt:'private',complete:true}),{type:'cache_miss',reason:'tools_changed',cache_missed_tokens:123});
 assert.deepEqual(boundedPromptCacheDiagnostic({type:'unavailable',reason:'private words',cache_missed_tokens:-1}),{type:'unavailable'});
 assert.equal(boundedPromptCacheDiagnostic({type:'task_complete'}),undefined);
});
