import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';
import assert from 'node:assert/strict';import test from 'node:test';import {once} from 'node:events';import http from 'node:http';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const OPERATOR_TOKEN='synthetic-local-token';
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function close(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections?.();
  await closed;
}
async function waitUntil(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for secure integration state.");
}
async function loadDesktop(t, env = {}) {
 const temp=await mkdtemp(path.join(os.tmpdir(),'public-auth-test-')); t.after(()=>rm(temp,{recursive:true,force:true})); env.OPERATOR_CLIENT_CONFIG_PATH=path.join(temp,'client.json'); await writeFile(env.OPERATOR_CLIENT_CONFIG_PATH,JSON.stringify({auth_mode:'shared_token'}));
  const keys = [
    "OPERATOR_CLIENT_CONFIG_PATH", "OPERATOR_DESKTOP_NO_LISTEN", "OPERATOR_BACKEND_URL", "OPERATOR_BEARER_TOKEN",
    "OPERATOR_TOKEN", "REVIT_OPERATOR_MODE", "OPERATOR_TOOL_EXPOSURE_PROFILE",
    "OPERATOR_CLIENT_AUTH_STORE_PATH", "OPERATOR_DESKTOP_POWERSHELL", "REVIT_BRIDGE_URL"
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    OPERATOR_DESKTOP_NO_LISTEN: "1",
    OPERATOR_TOKEN,
    REVIT_OPERATOR_MODE: "local",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "certified",
    ...env
  });
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  return import(`${pathToFileURL(path.join(appDir, "server.js")).href}?secure-integration=${Date.now()}-${Math.random()}`);
}
test("general-question HTTP and streaming intake bypass native context while model questions still read it", async t => {
  const prompt = "What is static pressure in an HVAC duct? Keep it to two sentences.";
  const received = []; let nativeCalls = 0; let policies = 0;
  const backend = await listen(async (request, response) => {
    if (request.url === "/chat/intake") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ route: "task", routing_status: "accepted" }));
    if (request.url === "/desktop/computer/config") return response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ sidecar_agent_profile: generalAgentLaboratoryProfile() }));
    if (request.url === "/chat/context-policy") {
      let raw = ""; for await (const part of request) raw += part;
      const body = JSON.parse(raw); policies++;
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        schema: "revit-operator.chat-context-policy.v1", session_id: body.session_id, message_id: body.message_id,
        requires_revit_context: body.user_text !== prompt
      }));
    }
    if (request.url === "/chat" || request.url === "/chat/stream") {
      let raw = ""; for await (const part of request) raw += part;
      const body = JSON.parse(raw); received.push(body);
      const answer = "Static pressure is force per unit area against the duct walls.";
      if (request.url === "/chat") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ assistant_message: answer, actions: [] }));
      return response.writeHead(200, { "content-type": "text/event-stream" }).end(`event: assistant.done\ndata: ${JSON.stringify({ text: answer })}\n\nevent: actions\ndata: {"actions":[]}\n\nevent: done\ndata: {}\n\n`);
    }
    if (request.url.startsWith("/revit/")) nativeCalls++;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  t.after(() => close(backend.server));
  const desktop = await loadDesktop(t, { OPERATOR_BACKEND_URL: backend.url, REVIT_BRIDGE_URL: backend.url,
    REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" });
  desktop.configureOperatorDesktopTestHooks({ chatRunTestHooks: { readSimpleRevitContext: async () => ({ ok: false }),
    buildHybridBackendContext: async () => { nativeCalls++; return { revit: { source: { live: true } }, ui: {} }; } } });
  const server = desktop.app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => close(server));
  for (const route of ["/api/chat", "/api/chat/stream"]) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "operator.backend.v1", session_id: "general-session", message_id: route, user_text: prompt }) });
    assert.equal(result.status, 200); assert.match(await result.text(), /force per unit area/);
  }
  assert.equal(policies, 2); assert.equal(nativeCalls, 0);
  assert.equal(received.length, 2);
  for (const body of received) {
    assert.equal(body.context.revit, undefined); assert.equal(body.context.ui.model_context_requested, false);
    assert.equal(body.context.ui.authoritative_user_text, prompt);
  }
  const model = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "operator.backend.v1", session_id: "general-session", message_id: "model", user_text: "What is the diameter of the selected duct?" }) });
  await model.text(); assert.equal(nativeCalls, 1);
});
test('chat HTTP rejection proves exact pre-admission failure but never restores an existing run key', async t => {
  let denyOwnership = true, dispatched = 0;
  const backend = await listen((request, response) => {
    if (request.url.startsWith('/api/agent-goal')) {
      return response.writeHead(denyOwnership ? 503 : 200, { 'content-type': 'application/json' }).end('{}');
    }
    if (request.url === '/chat/intake') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ route: 'task', routing_status: 'accepted' }));
    }
    if (request.url === '/chat' || request.url === '/chat/stream') dispatched++;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  t.after(() => close(backend.server));
  const desktop = await loadDesktop(t, { OPERATOR_BACKEND_URL: backend.url });
  desktop.configureOperatorDesktopTestHooks({ chatRunTestHooks: {
    buildHybridBackendContext: async () => { throw Error('After admission: fixture unavailable'); }
  } });
  const server = desktop.app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { session_id: 'admission-session', message_id: 'original-message', user_text: 'Review the attached electrical redlines',
    pending_attachments: [{ filename: 'original.pdf', data_base64: 'unchanged-file-bytes' }] };
  const post = () => fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const rejected = await post(); assert.equal(rejected.status, 503);
  assert.deepEqual((await rejected.json()).submission_admission, {
    schema: 'revit-operator.chat-submission-admission/v1', state: 'not_admitted',
    session_id: body.session_id, message_id: body.message_id, request_dispatched: false
  });
  assert.equal(dispatched, 0);
  denyOwnership = false;
  assert.equal((await (await fetch(`${base}/api/task-run?session_id=${body.session_id}`)).json()).active_run, null);
  const admitted = await post(); assert.equal(admitted.status, 200);
  const stagedFailure = await admitted.text();
  assert.match(stagedFailure, /"submission_admission"/);
  assert.match(stagedFailure, /"request_dispatched":false/);
  const duplicate = await post(); assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).submission_admission, undefined);
  denyOwnership = true;
  const oldKeyOnUnavailableBackend = await post(); assert.equal(oldKeyOnUnavailableBackend.status, 503);
  assert.equal((await oldKeyOnUnavailableBackend.json()).submission_admission, undefined);
  assert.equal(dispatched, 0);
});
test('cached-only health polling on a cold Sidecar makes no backend or native request', async t => {
  let probes=0;
  const backend=await listen((_req,res)=>{probes++;res.writeHead(503).end();});
  t.after(()=>close(backend.server));
  const desktop=await loadDesktop(t,{OPERATOR_BACKEND_URL:backend.url});
  const server=desktop.app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>close(server));
  const url=`http://127.0.0.1:${server.address().port}/api/revit/health?prefer_cached=1`;
  const before=probes;
  for(let i=0;i<3;i++) {
    const response=await fetch(url,{signal:AbortSignal.timeout(1000)});
    assert.equal(response.status,200);
    const health=await response.json();
    assert.equal(health.ok,false); assert.equal(health.context,null);
    assert.equal(health.reason,'no_cached_health_available'); assert.equal(health.authority,'display_only');
  }
  assert.equal(probes,before,'display polling must not bootstrap or inspect Revit');
});
test('attachment socket failure restores a fresh draft, attempted model-task dispatch never does', async t => {
  let uploads=0, tasks=0;
  const backend=await listen((request,response)=>{
    if(request.url==='/attachments/upload'){uploads++;return request.socket.destroy();}
    if(request.url==='/chat/stream'){tasks++;return request.socket.destroy();}
    const payload=request.url==='/chat/intake'?{route:'task',routing_status:'accepted'}
      :request.url==='/chat/context-policy'?{requires_live_model_context:false}:{};
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(payload));
  });
  t.after(()=>close(backend.server));
  const desktop=await loadDesktop(t,{OPERATOR_BACKEND_URL:backend.url});
  desktop.configureOperatorDesktopTestHooks({chatRunTestHooks:{readSimpleRevitContext:async()=>({ok:false}),
    buildHybridBackendContext:async()=>({revit:{},ui:{}})}});
  const server=desktop.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>close(server));
  const post=body=>fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const body={session_id:'attachment-failure-session',message_id:'upload-failure',user_text:'Review these drawing marks',
    pending_attachments:[{id:'source-pdf',filename:'original.pdf',mime:'application/pdf',dataBase64:'JVBERi0xLjQ='}]};
  const uploadFailure=await(await post(body)).text();
  assert.match(uploadFailure,/"submission_admission"/);assert.match(uploadFailure,/"request_dispatched":false/);
  assert.equal(uploads,1);assert.equal(tasks,0);
  const taskFailure=await(await post({...body,message_id:'task-response-lost',pending_attachments:[]})).text();
  assert.equal(tasks,1);assert.equal(taskFailure.includes('submission_admission'),false);
});

test('one chat dispatch carries both uploaded project PDFs', async t => {
  const uploads = [];
  const tasks = [];
  const backend = await listen(async (request, response) => {
    const reply = body => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.url === '/chat/intake') return reply({ route: 'task', routing_status: 'accepted' });
    if (request.url === '/desktop/computer/config') return reply({ sidecar_agent_profile: generalAgentLaboratoryProfile() });
    if (request.url !== '/attachments/upload' && request.url !== '/chat/stream' && request.url !== '/chat/context-policy') return reply({});
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (request.url === '/chat/context-policy') return reply({
      schema: 'revit-operator.chat-context-policy.v1', session_id: body.session_id, message_id: body.message_id,
      requires_revit_context: false
    });
    if (request.url === '/attachments/upload') {
      uploads.push(body);
      return reply({ attachment: { id: body.id, filename: body.filename, mime: body.mime,
        relative_path: `artifacts/uploads/${body.id}.pdf`, session_id: body.session_id } });
    }
    tasks.push(body);
    return response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      'event: assistant.done\ndata: {"text":"Both examples are available."}\n\nevent: actions\ndata: {"actions":[]}\n\nevent: done\ndata: {}\n\n');
  });
  t.after(() => close(backend.server));
  const desktop = await loadDesktop(t, { OPERATOR_BACKEND_URL: backend.url,
    REVIT_OPERATOR_MODE: 'development', OPERATOR_TOOL_EXPOSURE_PROFILE: 'laboratory' });
  desktop.configureOperatorDesktopTestHooks({ chatRunTestHooks: { readSimpleRevitContext: async () => ({ ok: false }) } });
  const server = desktop.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => close(server));
  const body = { version: 'operator.backend.v1', session_id: 'project-reference-session', message_id: 'multi-reference-task',
    user_text: 'Use these two project examples to guide the scheduling work.',
    pending_attachments: [{ id: 'library', filename: 'Library.pdf', dataBase64: 'JVBERi0xLjQ=' },
      { id: 'clinic', filename: 'Clinic.pdf', dataBase64: 'JVBERi0xLjU=' }] };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Both examples are available/);
  assert.deepEqual(uploads.map(a => [a.id, a.session_id, a.data_base64]),
    body.pending_attachments.map(a => [a.id, body.session_id, a.dataBase64]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].user_text, body.user_text);
  assert.deepEqual(tasks[0].user_attachments.map(a => [a.id, a.filename, a.relative_path]),
    body.pending_attachments.map(a => [a.id, a.filename, `artifacts/uploads/${a.id}.pdf`]));
});
test("Stop forwards the exact conversation and message without a test-hook scope error", async (t) => {
  let forwarded;
  const backend = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  t.after(() => close(backend.server));
  const desktop = await loadDesktop(t, { OPERATOR_BACKEND_URL: backend.url });
  desktop.configureOperatorDesktopTestHooks({ chatRunTestHooks: {} });
  const server = desktop.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/stop`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "same-task", message_id: "same-turn" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, { path: "/loop/stop", body: { session_id: "same-task", message_id: "same-turn", stop_reason: "USER_CANCELLED" } });
});

function generalAgentLaboratoryProfile() {
  return {
    schema: "revit-operator.sidecar-agent-profile.v1",
    source: "backend_environment",
    runtime_mode: "development",
    tool_exposure_profile: "laboratory",
    capability_profile: "general_agent_laboratory",
    general_agent_ready: true,
    reason_code: "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY"
  };
}
