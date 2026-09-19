import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const root=['../packages/operator-runtime-identity','../../packages/operator-runtime-identity'].map(p=>path.resolve(p))
  .find(p=>fs.existsSync(path.join(p,'windows_listener_inspector.mjs')))!;
const {createWindowsListenerInspector}=await import(pathToFileURL(path.join(root,'windows_listener_inspector.mjs')).href);
function harness(reply:(request:any,child:any)=>void) {
  const children:any[]=[], launches:any[]=[];
  const spawnWorker=(...args:any[])=>{
    launches.push(args);const child:any=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{child.killed=true;};child.ref=()=>{};child.unref=()=>{};
    let buffer='';child.stdin.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);reply(JSON.parse(line),child);
    }});
    children.push(child);queueMicrotask(()=>child.stdout.write('{"ready":true}\n'));return child;
  };
  return {children,launches,spawnWorker};
}

test('Windows inspector reuses the host but never a listener observation, even for the same port',async()=>{
  let calls=0;const h=harness((r,c)=>c.stdout.write(JSON.stringify({id:r.id,snapshot:{pid:++calls,port:r.port}})+'\n'));
  const inspector=createWindowsListenerInspector({spawnWorker:h.spawnWorker,environment:{Path:'kept',PSModulePath:'incompatible',pSmOdUlEpAtH:'also incompatible'}});
  try {
    await inspector.warm();
    assert.equal((await inspector.inspect({port:5000})).pid,1);
    assert.equal((await inspector.inspect({port:5000})).pid,2);
    assert.equal(h.launches.length,1);
    assert.equal(h.launches[0][2].windowsHide,true);
    assert.deepEqual(h.launches[0][2].env,{Path:'kept'});
    await assert.rejects(inspector.inspect({port:5000,host:'127.0.0.1; execute'}),/Invalid/);
    await assert.rejects(inspector.inspect({port:5000,preferredPid:2147483648}),/Invalid/);
    assert.equal(calls,2);
  } finally {inspector.close();}
});

test('timeout invalidates the worker, rejects all queued reads and never replays them',async()=>{
  const h=harness(()=>{});const inspector=createWindowsListenerInspector({spawnWorker:h.spawnWorker,timeoutMs:15});
  try {
    const results=await Promise.allSettled([inspector.inspect({port:5000}),inspector.inspect({port:5001})]);
    assert.equal(results.filter(r=>r.status==='rejected').length,2);
    assert.equal(h.children[0].killed,true);assert.equal(h.children.length,1);
    await inspector.warm();assert.equal(h.children.length,2,'Only an explicit new operation starts another worker');
  }finally{inspector.close();}
});

test('mismatched worker responses fail closed; OS errors do not become cached successes',async()=>{
  for(const response of [{id:'foreign',snapshot:{pid:1}},{error:'Listener disappeared'}]) {
    const h=harness((r,c)=>c.stdout.write(JSON.stringify({id:r.id,...response})+'\n'));
    const inspector=createWindowsListenerInspector({spawnWorker:h.spawnWorker});
    try{await assert.rejects(inspector.inspect({port:5000}),/unexpected request identity|Listener disappeared/);}finally{inspector.close();}
  }
});

test('private desktop bundles the same public inspector and includes both transitive runtime modules',async t=>{
  const desktop=path.resolve(root,'../../operator-desktop');
  if(!fs.existsSync(path.join(desktop,'server.js'))) return t.skip('Private desktop integration is checked in its own composition');
  for(const name of ['windows_listener_inspector.mjs','windows_listener_worker.mjs']) {
    assert.equal(fs.readFileSync(path.join(desktop,name),'utf8'),fs.readFileSync(path.join(root,name),'utf8'));
  }
  const {generateRuntimeDependencyManifest}=await import(pathToFileURL(path.join(desktop,'scripts/runtime_dependency_graph.mjs')).href);
  const manifest=await generateRuntimeDependencyManifest({root:desktop,entryPoints:['server.js']});
  for(const name of ['windows_listener_inspector.mjs','windows_listener_worker.mjs']) assert.ok(manifest.runtime_files.some((f:any)=>f.path===name));
});
