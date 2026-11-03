import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeDevelopmentArtifact,readDevelopmentArtifact} from './development-artifact-store.mjs';
test('repeated successful and failed snapshots retain exact payloads with bounded incremental growth',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-artifact-test-')),store=path.join(root,'objects');
 try{
  const rows=Array.from({length:1024},(_,id)=>({id,parameters:Array.from({length:20},(_,i)=>({name:'P'+i,value:'unchanged '+id}))}));
  const base={status:200,payload:{rows},image:'data:image/png;base64,'+'A'.repeat(200_000)};
  let firstBytes=0;
  for(let i=0;i<40;i++){
   const file=path.join(root,'snapshot'+i+'.json'),value={...base,status:i%2?500:200,at:String(i)};
   writeDevelopmentArtifact(file,value,{store});assert.deepEqual(readDevelopmentArtifact(file),value);
   const bytes=fs.readdirSync(store).reduce((n,k)=>n+fs.statSync(path.join(store,k)).size,0);
   if(i===0)firstBytes=bytes;else assert.equal(bytes,firstBytes,'same payload stored once despite metadata/error changes');
  }
  const object=fs.readdirSync(store)[0];fs.appendFileSync(path.join(store,object),'corruption');
  assert.throws(()=>readDevelopmentArtifact(path.join(root,'snapshot0.json')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('crash recovery reclaims a dead writer and expired temporary files while live ownership stays protected',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-artifact-lease-')),store=path.join(root,'objects'),lock=path.join(store,'.writer');
 try{
  fs.mkdirSync(lock,{recursive:true});fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}));
  const value={image:'X'.repeat(100_000)};assert.throws(()=>writeDevelopmentArtifact(path.join(root,'blocked.json'),value,{store}),/active/);
  const child=spawnSync(process.execPath,['-e','']);assert.equal(child.status,0);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:child.pid,at:Date.now()-3600_000}));
  const temporary=path.join(store,'a'.repeat(64)+'.json.gz.'+'b'.repeat(8)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(4)+'-'+'b'.repeat(12)+'.tmp');fs.writeFileSync(temporary,'partial');fs.utimesSync(temporary,0,0);
  writeDevelopmentArtifact(path.join(root,'recovered.json'),value,{store});assert.deepEqual(readDevelopmentArtifact(path.join(root,'recovered.json')),value);assert(!fs.existsSync(temporary));assert(!fs.existsSync(lock));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('legacy JSON and literal marker-shaped data roundtrip; budget failure leaves source receipt absent',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-artifact-guard-'));
 try{
  const file=path.join(root,'legacy.json');fs.writeFileSync(file,'{"a":1}');assert.deepEqual(readDevelopmentArtifact(file),{a:1});
  const literal={schema:'operator.development-artifact/v1',encoding:{t:'rows'},value:[undefined],omitted:undefined};
  const marker=path.join(root,'literal.json');writeDevelopmentArtifact(marker,literal,{store:path.join(root,'objects')});assert.deepEqual(readDevelopmentArtifact(marker),JSON.parse(JSON.stringify(literal)));
  const blocked=path.join(root,'blocked.json');assert.throws(()=>writeDevelopmentArtifact(blocked,{literal:{t:'rows',refs:[]},image:'X'.repeat(100_000)},{store:path.join(root,'objects'),budget:{minFreeBytes:0,maxBytes:1,maxObjects:1}}),/budget/);assert(!fs.existsSync(blocked));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
