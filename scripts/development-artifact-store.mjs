// Lossless storage for development receipts. This codec grants no evidence
// authority/currentness and does not alter actor inputs or native validators.
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
const digest=b=>createHash('sha256').update(b).digest('hex');
const schema='operator.development-artifact/v1',threshold=64*1024;
export const ARTIFACT_BUDGET={maxBytes:8*1024**3,maxObjects:150_000,minFreeBytes:1024**3};
function direct(p){for(let c=path.resolve(p);;){if(fs.existsSync(c))assert(!fs.lstatSync(c).isSymbolicLink(),'Artifact reparse path');const parent=path.dirname(c);if(parent===c)break;c=parent;}}
function put(root,raw,budget,state){
 const hash=digest(raw),file=path.join(root,hash+'.json.gz');
 if(fs.existsSync(file)){assert.equal(digest(zlib.gunzipSync(fs.readFileSync(file),{maxOutputLength:256*1024**2})),hash,'Existing artifact digest mismatch');return{hash,bytes:raw.length};}
 const packed=zlib.gzipSync(raw,{level:3}),stat=fs.statfsSync(root);
 assert(stat.bavail*stat.bsize>=budget.minFreeBytes+packed.length,'Artifact disk headroom exhausted');
 // Directory-level limits are intentionally conservative. Never evict referenced
 // qualification evidence to admit a new test; require explicit archival first.
 assert(state.count<budget.maxObjects,'Artifact object budget exhausted');
 assert(state.bytes+packed.length<=budget.maxBytes,'Artifact byte budget exhausted');
 const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx');
 try{fs.writeFileSync(fd,packed);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}finally{fs.unlinkSync(temporary);}
 assert.equal(digest(zlib.gunzipSync(fs.readFileSync(file))),hash);
 state.count++;state.bytes+=packed.length;
 return{hash,bytes:raw.length};
}
export function writeDevelopmentArtifact(file,value,{store,budget=ARTIFACT_BUDGET}={}){
 const raw=Buffer.from(JSON.stringify(value,null,2));
 if(raw.length<threshold&&value?.schema!==schema){fs.writeFileSync(file,raw,{flag:'wx'});return;}
 assert(store&&path.isAbsolute(store),'Explicit absolute artifact store required');direct(store);fs.mkdirSync(store,{recursive:true});
 const lock=path.join(store,'.writer');
 // Reclaim only a recognized dead writer; live/unknown ownership is protected.
 if(fs.existsSync(lock)){
  direct(lock);let owner;try{owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));}catch{throw Error('Artifact writer ownership is unknown');}
  assert(Number.isSafeInteger(owner.pid)&&owner.pid>0&&Number.isFinite(owner.at),'Artifact writer ownership is unknown');
  let dead=false;try{process.kill(owner.pid,0);}catch(error){dead=error.code==='ESRCH';}
  assert(dead,'Artifact writer is active or cannot be identified');
  assert.deepEqual(fs.readdirSync(lock),['owner.json'],'Unexpected writer lease contents');
  fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);
 }
 fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});
 try {
 for(const name of fs.readdirSync(store))if(/^[a-f0-9]{64}\.json\.gz\.[a-f0-9-]{36}\.tmp$/.test(name)){
  const temporary=path.join(store,name);direct(temporary);if(Date.now()-fs.statSync(temporary).mtimeMs>24*3600_000)fs.unlinkSync(temporary);
 }
 const objects=fs.readdirSync(store).filter(x=>/^[a-f0-9]{64}\.json\.gz$/.test(x));
 const files=fs.readdirSync(store,{withFileTypes:true}).filter(e=>e.isFile());
 const state={count:files.length,bytes:files.reduce((n,e)=>n+fs.statSync(path.join(store,e.name)).size,0)};
 const encode=v=>{
  if(typeof v==='string'&&Buffer.byteLength(v)>threshold)return{t:'blob',ref:put(store,Buffer.from(JSON.stringify(v)),budget,state)};
  if(Array.isArray(v)){
   if(Buffer.byteLength(JSON.stringify(v))>threshold){const refs=[];for(let i=0;i<v.length;i+=64)refs.push(put(store,Buffer.from(JSON.stringify(v.slice(i,i+64))),budget,state));return{t:'rows',count:v.length,refs};}
   return{t:'array',items:v.map(encode)};
  }
  if(v&&typeof v==='object')return{t:'object',entries:Object.entries(v).map(([k,x])=>[k,encode(x)])};
  return{t:'value',value:v};
 };
 const record={schema,store:path.relative(path.dirname(file),store),sha256:digest(raw),bytes:raw.length,encoding:encode(JSON.parse(raw.toString('utf8')))};
 fs.writeFileSync(file,JSON.stringify(record),{flag:'wx'});
 // Read through the same consumer boundary before claiming storage succeeded.
 assert.equal(digest(Buffer.from(JSON.stringify(readDevelopmentArtifact(file),null,2))),record.sha256);
 } finally {fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
}
export function readDevelopmentArtifact(file){
 const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));if(value?.schema!==schema)return value;
 assert(typeof value.store==='string'&&value.store.length<4096&&Number.isSafeInteger(value.bytes)&&value.bytes<=512*1024**2,'Malformed artifact envelope');
 const root=path.resolve(path.dirname(file),value.store);direct(root);
 const get=ref=>{
  assert(/^[a-f0-9]{64}$/.test(ref?.hash)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=256*1024**2,'Malformed artifact reference');
  const target=path.join(root,ref.hash+'.json.gz');direct(target);
  const raw=zlib.gunzipSync(fs.readFileSync(target),{maxOutputLength:ref.bytes+1});assert.equal(raw.length,ref.bytes);assert.equal(digest(raw),ref.hash,'Artifact digest mismatch');return JSON.parse(raw.toString());
 };
 const decode=node=>{
  assert(node&&typeof node==='object');
  if(node.t==='value')return node.value;
  if(node.t==='blob')return get(node.ref);
  if(node.t==='rows'){const rows=node.refs.flatMap(get);assert.equal(rows.length,node.count);return rows;}
  if(node.t==='array')return node.items.map(decode);
  if(node.t==='object')return Object.fromEntries(node.entries.map(([k,v])=>[k,decode(v)]));
  throw Error('Unknown artifact encoding');
 };
 const decoded=decode(value.encoding),raw=Buffer.from(JSON.stringify(decoded,null,2));assert.equal(raw.length,value.bytes);assert.equal(digest(raw),value.sha256,'Artifact envelope digest mismatch');return decoded;
}
