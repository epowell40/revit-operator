import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

const publicApp=new URL('../../apps/operator-desktop/public/app.js',import.meta.url);
const source=fs.readFileSync(fs.existsSync(publicApp)?publicApp:new URL('../../operator-desktop/public/app.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));

test('browser archive, restore and bulk archive deliver JSON through the HTTP body parser',async t=>{
 const requests=[],statuses=[];let refreshes=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=req.headers['content-type']?.startsWith('application/json')?JSON.parse(raw):{};
  requests.push(body);res.setHeader('Content-Type','application/json');
  if(typeof body.archived!=='boolean'){res.statusCode=400;res.end(JSON.stringify({error:'Choose one conversation or all history.'}));}
  else res.end(JSON.stringify({ok:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const context={fetch:(url,options)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,options),
  loadedBrowserIdentity:'test-browser',setStatus:text=>statuses.push(text),syncTaskNavigation:async()=>{refreshes++;}};
 vm.runInNewContext(extract('async function fetchJson(', '// TESTABLE_EXECUTION_ADMISSION_PRESENTATION_START')+
  extract('async function archiveTaskHistory(', 'function setTaskSidebarOpen('),context);
 await context.archiveTaskHistory({session_id:'chat',archived:false});
 await context.archiveTaskHistory({session_id:'chat',archived:true});
 await context.archiveTaskHistory();
 assert.deepEqual(requests,[{session_id:'chat',archived:true},{session_id:'chat',archived:false},{all:true,archived:true}]);
 assert.equal(refreshes,3);assert(statuses.includes('Chat restored.'));
});
