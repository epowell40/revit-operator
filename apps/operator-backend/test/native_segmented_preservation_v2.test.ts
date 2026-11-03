import{test}from'node:test';import assert from'node:assert/strict';import{gzipSync}from'node:zlib';import{createHash}from'node:crypto';
import{expandNativeAccessoryPreservationV2 as expand,expandNativeAccessoryReadbackV2 as read}from'../src/verification/native_preservation_snapshot_v2.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export function segmented(value:any){const bytes=Buffer.from(JSON.stringify(value)),segments=[];for(let offset=0;offset<bytes.length;offset+=2_000_000){const b=bytes.subarray(offset,offset+2_000_000);segments.push({index:segments.length,uncompressedBytes:b.length,sha256:hash(b),data:gzipSync(b).toString('base64')});}return{schema:'operator.native_preservation_json.v2',encoding:'segmented-gzip-base64',uncompressedBytes:bytes.length,sha256:hash(bytes),segments};}
const source={label:'native unicode 💧',values:[1.234567890123,null,false],padding:'x'.repeat(2_000_001)};
const wrap=(v:any)=>({preservationBefore:v,preservationAfter:v});
test('segmented lossless snapshot restores exact fields across2MB boundary',()=>assert.deepEqual(expand(wrap(segmented(source))),wrap(source)));
const damage:Record<string,(p:any)=>void>={missing:p=>p.segments.pop(),reorder:p=>p.segments.reverse(),duplicate:p=>p.segments[1]=p.segments[0],
 index:p=>p.segments[0].index=1,chunkHash:p=>p.segments[0].sha256='0'.repeat(64),wholeHash:p=>p.sha256='0'.repeat(64),total:p=>p.uncompressedBytes++,
 missingLength:p=>delete p.segments[0].uncompressedBytes,shortChunk:p=>p.segments[0].uncompressedBytes--,base64:p=>p.segments[0].data='@@@=',extra:p=>p.complete=true,
 extraChunkField:p=>p.segments[0].verified=true,encodedOversize:p=>p.segments[0].data='A'.repeat(3000004),expandedOversize:p=>p.uncompressedBytes=64000001,
 wrongEncoding:p=>p.encoding='gzip-base64',wrongSchema:p=>p.schema='foreign',nested:p=>p.data='nested',fractional:p=>p.uncompressedBytes=2000000.5};
for(const[name,mutate]of Object.entries(damage))test('segmented transport rejects '+name,()=>{const p=segmented(source);mutate(p);assert.throws(()=>expand(wrap(p)));});
test('a compressed bomb cannot claim a bounded first segment',()=>{const p=segmented(source),bytes=Buffer.alloc(2_000_001,120);p.segments[0]!.data=gzipSync(bytes).toString('base64');p.segments[0]!.sha256=hash(bytes);assert.throws(()=>expand(wrap(p)));});
test('small snapshots must retain legacy codec rather than alternate segmented shape',()=>assert.throws(()=>expand(wrap(segmented({x:1})))));
const settlement={schema:'revit-operator.native-attempt-settlement.v1',requested_effect:'read',effect_state:'none',effect_authority:'native_host',request_dispatched:true,method:'POST',path:'/revit/get-connectors'};
test('native HTTP read decoration remains outside the strict compressed snapshot',()=>{
 const p={...segmented(source),canonical_attempt_settlement:settlement};
 assert.deepEqual(read(p),{...source,canonical_attempt_settlement:settlement});
 assert.throws(()=>expand(wrap(p)),'nested APPLY snapshots do not carry HTTP decoration');
});
for(const [name,change]of Object.entries({schema:{schema:'foreign'},effect:{effect_state:'unknown'},mutation:{requested_effect:'apply'},authority:{effect_authority:'model'},dispatch:{request_dispatched:false},route:{path:'/revit/other'},method:{method:'GET'}}))test('decorated read rejects '+name,()=>assert.throws(()=>read({...segmented(source),canonical_attempt_settlement:{...settlement,...change}})));
test('read decoration does not hide extra codec fields',()=>assert.throws(()=>read({...segmented(source),canonical_attempt_settlement:settlement,verified:true})));
