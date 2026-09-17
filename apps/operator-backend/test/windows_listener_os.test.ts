import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root=['../packages/operator-runtime-identity','../../packages/operator-runtime-identity'].map(p=>path.resolve(p))
  .find(p=>fs.existsSync(path.join(p,'windows_listener_inspector.mjs')))!;
const {createWindowsListenerInspector}=await import(pathToFileURL(path.join(root,'windows_listener_inspector.mjs')).href);

test('fresh Windows OS inspection sees a harmless Node listener and rejects its closed port, including a supplied preferred pid',{
  skip:process.platform!=='win32'
},async()=>{
  const server=http.createServer((_req,res)=>res.end('fixture')).listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as any).port;const inspector=createWindowsListenerInspector();
  try {
    const identity=await inspector.inspect({port});
    assert.equal(identity.pid,process.pid);assert.equal(identity.process_name.toLowerCase(),'node.exe');
    assert.equal(identity.owner_matches_current_user,true);
    assert.equal(new Date(identity.created_utc).toISOString(),identity.created_utc);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await assert.rejects(inspector.inspect({port,preferredPid:process.pid}),/Expected exactly one listener/);
  }finally{server.close();inspector.close();}
});

