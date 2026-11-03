import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {expandNativeAccessoryPreservationV2 as expand} from '../src/verification/native_preservation_snapshot_v2.js';
const packBytes=(b:Buffer)=>({schema:'operator.native_preservation_json.v1',encoding:'gzip-base64',uncompressedBytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),data:gzipSync(b).toString('base64')});
const pack=(p:any)=>packBytes(Buffer.from(JSON.stringify(p)));
const wrap=(p:any)=>({preservationBefore:p,preservationAfter:p,transaction:{committed:true}});
const file=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures/native-placement-snapshot151.json');
const fixture=()=>JSON.parse(fs.readFileSync(fs.existsSync(file)?file:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../test/fixtures/native-placement-snapshot151.json'),'utf8'));
test('actual151 bytes roundtrip with all fields and existing retained2MB cap',()=>{
 const f=fixture(),bytes=gunzipSync(Buffer.from(f.gzipBase64,'base64'));assert.equal(bytes.length,1404503);assert.equal(createHash('sha256').update(bytes).digest('hex'),f.decodedSha256);
 const original=JSON.parse(bytes.toString('utf8')),encoded=wrap(packBytes(bytes)),before=JSON.stringify(encoded),out=expand(encoded);
 assert.deepEqual(out.preservationBefore,original);assert.deepEqual(out.preservationAfter,original);assert.equal(JSON.stringify(encoded),before);
 assert(Buffer.byteLength(before)+128000<2_000_000);assert(Buffer.byteLength(JSON.stringify(wrap(original)))>2_000_000);
});
test('legacy uncompressed snapshots preserve values, arrays, null and unicode',()=>{const p={value:'é 💧',a:[null,false,1.25],complete:true};assert.deepEqual(expand(wrap(p)),wrap(p));assert.deepEqual(expand(wrap(pack(p))),wrap(p));});
const bad:Record<string,(p:any)=>void>={
 sha:p=>p.sha256='0'.repeat(64),length:p=>p.uncompressedBytes++,oversize:p=>p.uncompressedBytes=2000001,negative:p=>p.uncompressedBytes=-1,
 fractional:p=>p.uncompressedBytes=2.5,missing:p=>delete p.sha256,extra:p=>p.extra=true,encoding:p=>p.encoding='deflate',schema:p=>p.schema='foreign',
 base64:p=>p.data='@@@=',whitespace:p=>p.data+='\n',truncated:p=>p.data=p.data.slice(0,-4),packedOversize:p=>p.data='A'.repeat(900004),
 conflict:p=>p.nativePlacementState={complete:true}
};
for(const[name,change]of Object.entries(bad))test('reject '+name,()=>{const p=pack({complete:true});change(p);assert.throws(()=>expand(wrap(p)));});
for(const [name,b] of Object.entries({bomb:Buffer.from(JSON.stringify({value:'x'.repeat(2000001)})),invalidUtf8:Buffer.from([123,34,120,34,58,34,0xff,34,125]),invalidJson:Buffer.from('{'),array:Buffer.from('[]'),null:Buffer.from('null'),nested:Buffer.from(JSON.stringify(pack({complete:true})))}))test('reject expanded '+name,()=>{const p=packBytes(b);if(name==='bomb')p.uncompressedBytes=100;assert.throws(()=>expand(wrap(p)));});
test('legacy over-bound and missing snapshots refuse',()=>{assert.throws(()=>expand(wrap({value:'x'.repeat(2000001)})));assert.throws(()=>expand({preservationBefore:{}}));});
