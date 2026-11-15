import {runInNewContext} from 'node:vm';import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';import test,{after} from 'node:test';import {once} from 'node:events';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {mkdtemp,rm,readFile} from 'node:fs/promises';import os from 'node:os';
const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'operator-public-controller-'));process.env.OPERATOR_WORKSPACE_ROOT=temp;process.env.OPERATOR_CLIENT_CONFIG_PATH=path.join(temp,'client.json');await writeFile(process.env.OPERATOR_CLIENT_CONFIG_PATH,JSON.stringify({auth_mode:'shared_token'}));process.env.OPERATOR_TOKEN='synthetic-local-token';process.env.OPERATOR_BACKEND_URL='http://127.0.0.1:7007';after(()=>rm(temp,{recursive:true,force:true}));
async function loadDelegatedDesktopModule(label) {
  const previous=process.env.OPERATOR_DESKTOP_NO_LISTEN;
  process.env.OPERATOR_DESKTOP_NO_LISTEN = "1";
  try{return await import(`${pathToFileURL(path.join(appDir, "server.js")).href}?delegated-${label}-${Date.now()}`);}
  finally{if(previous===undefined)delete process.env.OPERATOR_DESKTOP_NO_LISTEN;else process.env.OPERATOR_DESKTOP_NO_LISTEN=previous;}
}
test('fresh computer entry delivers checked conversation answers without opening a model task456',async t=>{
 const desktop=await loadDelegatedDesktopModule('fresh-conversation-answer456');let contextReads=0,goals=0;
 const route=async(p)=>{if(p==='/chat/intake')return{routing_status:'accepted',route:'answer',history_saved:true,assistant_message:'Synthetic checked answer; no model work.'};if(p==='/api/agent-goal'){goals++;throw Error('must not create a model task');}throw Error('Unexpected synthetic route '+p);};
 desktop.configureOperatorDesktopTestHooks({computerRunTestHooks:{enableSidecarAssignment:true,enableConversationIntake:true,ensureComputerBackendSession:async()=>'answer-session456',readBackendJson:route,buildHybridBackendContext:async()=>{contextReads++;return{ui:{revit_document:{project_fingerprint:'synthetic-document'}}};}},chatRunTestHooks:{readSimpleRevitContext:async()=>({ok:false}),routeConversationIntake:route}});
 const server=desktop.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{desktop.configureOperatorDesktopTestHooks();await new Promise(resolve=>server.close(resolve));});
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/computer/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Explain this synthetic fixture.',message_id:'answer-message456'})});
 assert.equal(response.status,200,await response.text());const state=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/computer/state')).json();
 assert.equal(state.running,false);assert.equal(state.progress.phase,'completed');assert.equal(goals,0);assert.equal(contextReads,0);assert.equal(state.sidecarAssignment??null,null);assert.ok(state.messages.some(m=>m.text==='Synthetic checked answer; no model work.'));
});

test('Stop during fresh answer classification cannot publish a late answer456',async t=>{
 const desktop=await loadDelegatedDesktopModule('stopped-conversation-answer456');let enter,release;const entered=new Promise(r=>enter=r),pending=new Promise(r=>release=r);
 const route=async()=>{enter();await pending;return{routing_status:'accepted',route:'answer',history_saved:true,assistant_message:'Must not publish after Stop'};};
 desktop.configureOperatorDesktopTestHooks({computerRunTestHooks:{enableSidecarAssignment:true,enableConversationIntake:true,ensureComputerBackendSession:async()=>'stopped-answer456'},chatRunTestHooks:{readSimpleRevitContext:async()=>({ok:false}),routeConversationIntake:route}});
 const server=desktop.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{release();desktop.configureOperatorDesktopTestHooks();await new Promise(resolve=>server.close(resolve));});const base='http://127.0.0.1:'+server.address().port;
 const run=fetch(base+'/api/computer/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Synthetic explanation',message_id:'stopped-answer-message456'})});await entered;
 assert.equal((await fetch(base+'/api/computer/stop',{method:'POST'})).status,200);release();assert.equal((await (await run).json()).stopped,true);
 const state=await(await fetch(base+'/api/computer/state')).json();assert.notEqual(state.progress.phase,'completed');assert.ok(!state.messages.some(m=>m.text==='Must not publish after Stop'));
});

test('fresh conversation entry keeps unpersisted answers blocked456',async t=>{
 const desktop=await loadDelegatedDesktopModule('unpersisted-conversation-answer456');let goals=0;
 const route=async(p)=>{if(p==='/chat/intake')return{routing_status:'accepted',route:'answer',history_saved:false,assistant_message:'Unpersisted assertion'};goals++;throw Error('Unexpected model route');};
 desktop.configureOperatorDesktopTestHooks({computerRunTestHooks:{enableSidecarAssignment:true,enableConversationIntake:true,ensureComputerBackendSession:async()=>'unpersisted-session456',readBackendJson:route,buildHybridBackendContext:async()=>({})},chatRunTestHooks:{readSimpleRevitContext:async()=>({ok:false}),routeConversationIntake:route}});
 const server=desktop.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{desktop.configureOperatorDesktopTestHooks();await new Promise(resolve=>server.close(resolve));});
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/computer/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Synthetic explanation',message_id:'unpersisted-message456'})});assert.ok(response.status>=400);assert.equal(goals,0);
 const state=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/computer/state')).json();assert.notEqual(state.progress.phase,'completed');assert.ok(!state.messages.some(m=>m.text==='Unpersisted assertion'));
});

test("benchmark linked fixture can close through exact foreground Revit UI before reopen", async (t) => {
  const originalNoListen = process.env.OPERATOR_DESKTOP_NO_LISTEN;
  process.env.OPERATOR_DESKTOP_NO_LISTEN = "1";
  t.after(() => {
    if (originalNoListen === undefined) delete process.env.OPERATOR_DESKTOP_NO_LISTEN;
    else process.env.OPERATOR_DESKTOP_NO_LISTEN = originalNoListen;
  });
  const desktop = await import(`${pathToFileURL(path.join(appDir, "server.js")).href}?benchmark-verified-ui-close=${Date.now()}`);
  const fixturePath = "C:\\fixtures\\Snowdon Towers Sample HVAC.rvt";
  let activeTitle = "Snowdon Towers Sample HVAC";
  const bridgePaths = [];
  const uiCloses = [];
  let clock = 1_000;
  const result = await desktop.openGeneralRevitBenchmarkFixture({
    fixture: "snowdon_hvac", sample_path: fixturePath, force_reopen: true
  }, {
    requireExists: false,
    fixtureCloseMode: "verified_ui",
    closeViaVerifiedRevitUi: async (context) => {
      uiCloses.push(context);
      activeTitle = "";
      return { status: "Close Requested Via Verified Revit UI", process_id: 25288 };
    },
    readHealth: async () => activeTitle ? {
      ok: true, context: { process_id: 25288, readiness: { has_active_uidocument: true },
        document: { title: activeTitle, path: fixturePath } }
    } : { ok: true, context: { process_id: 25288, readiness: { has_active_uidocument: false }, document: null } },
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    timeoutMs: 25_000,
    fetchRevitBridge: async (pathname) => {
      bridgePaths.push(pathname);
      if (pathname === "/revit/open-model") activeTitle = "Snowdon Towers Sample HVAC";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(uiCloses.length, 1);
  assert.equal(uiCloses[0].process_id, 25288);
  assert.equal(uiCloses[0].document_path, fixturePath);
  assert.deepEqual(bridgePaths, ["/revit/computer-use-guard", "/revit/computer-use-guard", "/revit/open-model"]);
});

test("verified UI benchmark close refuses foreign fixtures and missing native process identity", async (t) => {
  const originalNoListen = process.env.OPERATOR_DESKTOP_NO_LISTEN;
  process.env.OPERATOR_DESKTOP_NO_LISTEN = "1";
  t.after(() => {
    if (originalNoListen === undefined) delete process.env.OPERATOR_DESKTOP_NO_LISTEN;
    else process.env.OPERATOR_DESKTOP_NO_LISTEN = originalNoListen;
  });
  const desktop = await import(`${pathToFileURL(path.join(appDir, "server.js")).href}?benchmark-verified-ui-close-deny=${Date.now()}`);
  for (const [documentPath, processId] of [
    ["C:\\Users\\Eli\\Work\\Project HVAC.rvt", 25288],
    ["C:\\other-fixtures\\Snowdon Towers Sample HVAC.rvt", 25288],
    ["C:\\fixtures\\Snowdon Towers Sample HVAC.rvt", 0]
  ]) {
    let nativeCalls = 0;
    let uiCalls = 0;
    await assert.rejects(() => desktop.openGeneralRevitBenchmarkFixture({
      fixture: "snowdon_hvac", sample_path: "C:\\fixtures\\Snowdon Towers Sample HVAC.rvt", force_reopen: true
    }, {
      requireExists: false, fixtureCloseMode: "verified_ui",
      readHealth: async () => ({ ok: true, context: { process_id: processId,
        document: { title: "Snowdon Towers Sample HVAC", path: documentPath } } }),
      fetchRevitBridge: async () => { nativeCalls++; throw new Error("must not dispatch"); },
      closeViaVerifiedRevitUi: async () => { uiCalls++; throw new Error("must not send keys"); }
    }), /exact disposable Snowdon host/);
    assert.equal(nativeCalls, 0);
    assert.equal(uiCalls, 0);
  }
});

test("benchmark model-health route holds its fixture lease and blocks competing work", async () => {
  const source = await readFile(path.join(appDir, "server.js"), "utf8");
  const routeName = "/api/benchmark/revit-fixture/model-health";
  const start = source.indexOf(`app.post("${routeName}", async (`);
  const end = source.indexOf("\n});", start);
  assert.ok(start > 0 && end > start);
  let handler;
  let reads = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const gate = createForegroundRevitWorkGate();
  runInNewContext(source.slice(start, end + 4), {
    app: { post: (_route, callback) => { handler = callback; } },
    benchmarkFixtureWorkGate: gate,
    isForegroundRevitWorkActive: () => gate.isBusy(),
    readGeneralRevitBenchmarkModelHealth: async () => { reads++; return await pending; },
    sendJsonError: (res, error, status) => { res.status = status; res.error = error; }
  });
  const response = () => ({ status: 200, json(value) { this.body = value; } });
  const first = response();
  const firstWork = handler({}, first);
  const blocked = response();
  await handler({}, blocked);
  assert.equal(blocked.status, 409);
  assert.equal(reads, 1);
  release({ status: "Ok", links: { revit: { items: [] } } });
  await firstWork;
  assert.equal(first.body.status, "Ok");
  assert.equal(gate.isBusy(), false);
});

test("computer run forwards GPT-6 selection rather than silently using the fallback", async (t) => {
  const desktop = await loadDelegatedDesktopModule("computer-run-gpt6-selection");
  const requests = [];
  desktop.configureOperatorDesktopTestHooks({ computerRunTestHooks: {
    resolveSemanticAecTransport: async () => null,
    readBackendComputerConfig: async () => ({ available: true, model: "gpt-5.6-sol", reasoning_effort: "medium" }),
    captureScreenshot: async () => "AA==",
    requestComputerResponse: async (request) => {
      requests.push(request);
      return { id: "outer-gpt6", output: [], output_text: "Desktop inspected." };
    }
  } });
  const server = desktop.app.listen(0, "127.0.0.1");
  t.after(async () => {
    desktop.configureOperatorDesktopTestHooks();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = await fetch(`${baseUrl}/api/computer/run`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Summarize the desktop.", speed_settings: {
      agent_model: "gpt-6-sol", agent_reasoning_effort: "medium"
    } })
  });
  assert.equal(run.status, 200);
  await waitUntil(async () => !(await (await fetch(`${baseUrl}/api/computer/state`)).json()).running);
  const state = await (await fetch(`${baseUrl}/api/computer/state`)).json();
  assert.equal(state.requestedSpeedSettings.agent_model, "gpt-6-sol");
  assert.equal(requests[0]?.model, "gpt-6-sol");
});

test("Sidecar refuses to execute when the backend omits canonical run binding", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-assignment-unbound-rejection");
  await assert.rejects(
    desktop.beginSidecarComputerAssignment("Inspect the active model.", [], {
      ensureComputerBackendSession: async () => "session-sidecar-unbound",
      readBackendJson: async () => ({ ok: true, goal: { id: "goal-sidecar-unbound", status: "active" } })
    }),
    /refusing unbound outer execution/
  );
});

test("Sidecar sends the exact read request and adopts the backend's canonical effect", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-read-no-write-effect");
  const calls = [];
  const readBackendJson = async (pathname, options) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    return boundSidecarGoalResponse("goal-sidecar-read-no-write", body, "active", { requestedEffect: "read" });
  };

  const assignment = await desktop.beginSidecarComputerAssignment(
    "Count all air devices in the project and break the total down by family and type. You may inspect an existing air-device schedule. Do not change the model.",
    [],
    {
      ensureComputerBackendSession: async () => "session-sidecar-read-no-write",
      readBackendJson
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/api/agent-goal");
  assert.equal(calls[0].body.work_budget.requested_effect, undefined);
  assert.equal(assignment.work_budget.requested_effect, "read");
});

test("Sidecar V2 consumes the authoritative Work Return and never calls legacy settlement", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-v2-authoritative-settlement");
  const calls = [];
  let runId = "";
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      runId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-v2-settle", body, "active", { kernelVersion: 2 });
    }
    if (pathname === "/api/assignments/goal-sidecar-v2-settle/work-return") {
      return {
        ok: true,
        work_return: {
          schema: "revit-operator.work-return/v2",
          work_return_id: "wr_v2_settle",
          work_return_hash: `sha256:${"a".repeat(64)}`,
          assignment_id: "goal-sidecar-v2-settle",
          run_id: runId,
          generation: 1,
          status: "complete"
        }
      };
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the active schedule.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-v2-settle",
    readBackendJson
  });
  const settled = await desktop.settleSidecarComputerAssignment(
    "complete",
    "Assistant prose is not settlement truth.",
    { readBackendJson }
  );

  assert.equal(settled.kernel_version, 2);
  assert.equal(settled.work_return.status, "complete");
  assert.equal(calls.filter(call => call.pathname === "/api/agent-goal/sidecar-settle").length, 0);
});

test("Sidecar-owned outer-agent work creates and settles one canonical backend assignment", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-assignment-lifecycle");
  const calls = [];
  const readBackendJson = async (pathname, options) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal/sidecar-settle") return boundSidecarGoalResponse("goal-sidecar", body, body.outcome);
    return boundSidecarGoalResponse("goal-sidecar", body);
  };
  await desktop.beginSidecarComputerAssignment(
    "Use Dynamic Revit code execution to count the air terminals. Do not change the model.",
    [],
    { ensureComputerBackendSession: async () => "session-sidecar", readBackendJson }
  );
  desktop.recordComputerBackendActionReceipt({
    action_id: "semantic-schedule-cell-update-preflight",
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { dryRun: true, apply: false }
  }, {
    action_id: "semantic-schedule-cell-update-preflight",
    path: "/revit/update-schedule-cell",
    request_effect: "preview",
    request_dispatched: true,
    status: "done",
    result_summary: "Preview found one matching schedule cell.",
    result_json: { status: "Dry Run", candidate: { row: 4, column: 2 } }
  });
  await desktop.settleSidecarComputerAssignment("complete", "Found 509 air terminals with matching level totals.", { readBackendJson });

  assert.deepEqual(calls.map((call) => call.pathname), [
    "/api/agent-goal",
    "/api/agent-goal/sidecar-settle"
  ]);
  assert.equal(calls[0].body.replace_blocked_sidecar, true);
  assert.equal(calls[0].body.start_assignment_run, true);
  assert.match(calls[0].body.assignment_run_id, /^sidecar:/);
  assert.equal(calls[0].body.work_budget.mode, "sidecar_computer");
  assert.equal(calls[0].body.work_budget.source, "operator_desktop");
  assert.equal(calls[0].body.work_budget.requested_effect, undefined);
  assert.equal(calls[1].body.outcome, "complete");
  assert.equal(calls[1].body.assignment_id, "goal-sidecar");
  assert.equal(calls[1].body.assignment_run_id, calls[0].body.assignment_run_id);
  assert.equal(calls[1].body.assignment_generation, 1);
  assert.match(calls[1].body.assistant_summary, /509 air terminals/);
  assert.equal(calls[1].body.evidence.schema, "revit-operator.sidecar-assignment-evidence.v1");
  assert.deepEqual(calls[1].body.evidence.function_tools, [{
    tool_name: "revit_action",
    call_id: "semantic-schedule-cell-update-preflight",
    path: "/revit/update-schedule-cell",
    request_effect: "preview",
    request_dispatched: true,
    status: "success",
    step: 1,
    result: {
      ok: true,
      status: "done",
      error: null,
      result_summary: "Preview found one matching schedule cell.",
      evidence: { result_json: { status: "Dry Run", candidate: { row: 4, column: 2 } } }
    }
  }]);
});

test("Sidecar retains the exact assignment binding while canonical settlement is deferred", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-assignment-settlement-barrier");
  const calls = [];
  let settleCount = 0;
  const readBackendJson = async (pathname, options) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal/sidecar-settle") {
      settleCount += 1;
      return boundSidecarGoalResponse(
        "goal-sidecar-barrier",
        body,
        settleCount === 1 ? "active" : "complete"
      );
    }
    return boundSidecarGoalResponse("goal-sidecar-barrier", body);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the active schedule.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-barrier",
    readBackendJson
  });
  const first = await desktop.settleSidecarComputerAssignment("complete", "Inspection finished.", { readBackendJson });
  const second = await desktop.settleSidecarComputerAssignment("complete", "Inspection finished.", { readBackendJson });
  const afterTerminal = await desktop.settleSidecarComputerAssignment("complete", "Inspection finished.", { readBackendJson });

  assert.equal(first.goal.status, "active");
  assert.equal(second.goal.status, "complete");
  assert.equal(afterTerminal, null);
  const settlements = calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle");
  assert.equal(settlements.length, 2);
  assert.equal(settlements[0].body.assignment_run_id, settlements[1].body.assignment_run_id);
  assert.equal(settlements[0].body.assignment_generation, settlements[1].body.assignment_generation);
  assert.equal(settlements[0].body.assignment_generation, 1);
});

test("Sidecar recovers a committed clarification after the settlement response connection is lost", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-clarification-settlement-response-loss");
  const calls = [];
  let assignmentRunId = "";
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-response-loss", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle") {
      throw new TypeError("fetch failed");
    }
    if (pathname === "/api/assignments/goal-sidecar-response-loss") {
      return {
        ok: true,
        assignment: {
          source_record_id: "goal-sidecar-response-loss",
          target: { session_id: "session-sidecar-response-loss" },
          control_plane: {
            assignment_id: "goal-sidecar-response-loss",
            run_id: assignmentRunId,
            generation: 1,
            terminal_state: "open",
            pending_clarification_id: "clar_response_loss",
            pending_review_id: null,
            clarifications: [{
              clarification_id: "clar_response_loss",
              status: "pending",
              missing_fields: ["newText"],
              question: "What exact wording should replace the selected note?"
            }]
          }
        }
      };
    }
    if (pathname === "/api/assignments/goal-sidecar-response-loss/work-return") {
      return {
        ok: true,
        work_return: {
          schema: "revit-operator.work-return/v1",
          work_return_id: "wr1_response_loss",
          work_return_hash: `sha256:${"a".repeat(64)}`,
          assignment_id: "goal-sidecar-response-loss",
          run_id: assignmentRunId,
          generation: 1,
          status: "awaiting_user_input",
          clarification_id: "clar_response_loss",
          question: "What exact wording should replace the selected note?"
        }
      };
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Replace the selected note after obtaining the wording.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-response-loss",
    readBackendJson
  });
  const settled = await desktop.settleSidecarComputerAssignment(
    "complete",
    "I need the exact replacement wording.",
    { readBackendJson }
  );

  assert.equal(settled.recovered_after_response_loss, true);
  assert.equal(calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle").length, 1);
  const continuation = desktop.normalizeSidecarClarificationContinuation("Current issue wording", null);
  assert.equal(continuation.pending.clarification_id, "clar_response_loss");
  assert.deepEqual(continuation.pending.missing_fields, ["newText"]);
  assert.deepEqual(continuation.supplied_values, { newText: "Current issue wording" });
});

test("Sidecar preserves an authenticated committed clarification when settlement and projection transports both fail", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-clarification-double-transport-loss");
  const calls = [];
  let assignmentRunId = "";
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-double-loss", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle"
        || pathname === "/api/assignments/goal-sidecar-double-loss") {
      throw new TypeError("fetch failed");
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Replace the selected note after obtaining the wording.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-double-loss",
    readBackendJson
  });
  desktop.recordCanonicalAssignmentOutcome(boundCanonicalAssignmentOutcome(
    "goal-sidecar-double-loss",
    "session-sidecar-double-loss",
    assignmentRunId,
    { outcomeState: "awaiting_user_input", clarificationId: "clar_double_loss" }
  ));

  const settled = await desktop.settleSidecarComputerAssignment(
    "complete",
    "I need the exact replacement wording.",
    { readBackendJson }
  );

  assert.equal(settled.recovered_after_response_loss, true);
  assert.equal(settled.recovered_from, "authenticated_chat_outcome");
  assert.equal(calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle").length, 1);
  assert.equal(calls.filter((call) => call.pathname === "/api/assignments/goal-sidecar-double-loss").length, 1);
  const continuation = desktop.normalizeSidecarClarificationContinuation("Current issue wording", null);
  assert.equal(continuation.pending.clarification_id, "clar_double_loss");
  assert.deepEqual(continuation.supplied_values, { replacement_text: "Current issue wording" });
});

test("Sidecar retries the same idempotent settlement once only when reconciliation proves no outcome", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-settlement-precommit-response-loss");
  const calls = [];
  let assignmentRunId = "";
  let settlementCalls = 0;
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-precommit-loss", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle") {
      settlementCalls += 1;
      if (settlementCalls === 1) throw new TypeError("fetch failed");
      return boundSidecarGoalResponse("goal-sidecar-precommit-loss", body, "complete");
    }
    if (pathname === "/api/assignments/goal-sidecar-precommit-loss") {
      return boundSidecarAssignmentProjection(
        "goal-sidecar-precommit-loss",
        "session-sidecar-precommit-loss",
        assignmentRunId
      );
    }
    if (pathname === "/api/assignments/goal-sidecar-precommit-loss/work-return") {
      return { ok: true, work_return: {
        schema: "revit-operator.work-return/v1",
        assignment_id: "goal-sidecar-precommit-loss",
        run_id: assignmentRunId,
        generation: 1,
        status: "complete"
      } };
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the selected note.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-precommit-loss",
    readBackendJson
  });
  await desktop.settleSidecarComputerAssignment("complete", "Inspection complete.", { readBackendJson });

  const settlements = calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle");
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements[0].body, settlements[1].body);
});

test("Sidecar recovers terminal settlement and retries only the secondary Work Return read", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-terminal-settlement-response-loss");
  const calls = [];
  let assignmentRunId = "";
  let workReturnCalls = 0;
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-terminal-loss", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle") throw new TypeError("socket closed");
    if (pathname === "/api/assignments/goal-sidecar-terminal-loss") {
      return boundSidecarAssignmentProjection(
        "goal-sidecar-terminal-loss",
        "session-sidecar-terminal-loss",
        assignmentRunId,
        { terminalState: "complete" }
      );
    }
    if (pathname === "/api/assignments/goal-sidecar-terminal-loss/work-return") {
      workReturnCalls += 1;
      if (workReturnCalls === 1) throw Object.assign(new Error("gateway unavailable"), { status: 503 });
      return { ok: true, work_return: {
        schema: "revit-operator.work-return/v1",
        assignment_id: "goal-sidecar-terminal-loss",
        run_id: assignmentRunId,
        generation: 1,
        status: "complete"
      } };
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the current schedule.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-terminal-loss",
    readBackendJson
  });
  const settled = await desktop.settleSidecarComputerAssignment("complete", "Inspection complete.", { readBackendJson });
  const afterTerminal = await desktop.settleSidecarComputerAssignment("complete", "Inspection complete.", { readBackendJson });

  assert.equal(settled.recovered_after_response_loss, true);
  assert.equal(afterTerminal, null);
  assert.equal(calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle").length, 1);
  assert.equal(workReturnCalls, 2);
});

test("Sidecar does not repeat settlement when an awaiting-review outcome is already committed", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-review-settlement-response-loss");
  const calls = [];
  let assignmentRunId = "";
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-review-loss", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle") throw new TypeError("network connection lost");
    if (pathname === "/api/assignments/goal-sidecar-review-loss") {
      return boundSidecarAssignmentProjection(
        "goal-sidecar-review-loss",
        "session-sidecar-review-loss",
        assignmentRunId,
        { pendingReviewId: "review_nearest_valid_location" }
      );
    }
    if (pathname === "/api/assignments/goal-sidecar-review-loss/work-return") {
      return { ok: true, work_return: {
        schema: "revit-operator.work-return/v1",
        assignment_id: "goal-sidecar-review-loss",
        run_id: assignmentRunId,
        generation: 1,
        status: "awaiting_user_review"
      } };
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Place the device at the nearest valid location.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-review-loss",
    readBackendJson
  });
  const settled = await desktop.settleSidecarComputerAssignment("complete", "The bounded deviation needs review.", { readBackendJson });

  assert.equal(settled.recovered_after_response_loss, true);
  assert.equal(calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle").length, 1);
});

test("Sidecar rejects foreign settlement reconciliation without retrying the POST", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-settlement-foreign-reconciliation");
  const calls = [];
  let assignmentRunId = "";
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") {
      assignmentRunId = body.assignment_run_id;
      return boundSidecarGoalResponse("goal-sidecar-foreign-recovery", body);
    }
    if (pathname === "/api/agent-goal/sidecar-settle") throw new TypeError("fetch failed");
    if (pathname === "/api/assignments/goal-sidecar-foreign-recovery") {
      return boundSidecarAssignmentProjection(
        "goal-sidecar-foreign-recovery",
        "session-sidecar-foreign-recovery",
        assignmentRunId,
        { generation: 2, terminalState: "complete" }
      );
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the selected note.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-foreign-recovery",
    readBackendJson
  });
  await assert.rejects(
    desktop.settleSidecarComputerAssignment("complete", "Inspection complete.", { readBackendJson }),
    /foreign or stale Assignment binding/
  );
  assert.equal(calls.filter((call) => call.pathname === "/api/agent-goal/sidecar-settle").length, 1);
});

test("Sidecar never reconciles or retries a non-transient settlement authorization failure", async () => {
  const desktop = await loadDelegatedDesktopModule("sidecar-settlement-auth-failure-no-retry");
  const calls = [];
  const readBackendJson = async (pathname, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ pathname, body });
    if (pathname === "/api/agent-goal") return boundSidecarGoalResponse("goal-sidecar-auth-failure", body);
    if (pathname === "/api/agent-goal/sidecar-settle") {
      throw Object.assign(new Error("principal is not authorized"), { status: 401 });
    }
    throw new Error(`Unexpected backend path: ${pathname}`);
  };

  await desktop.beginSidecarComputerAssignment("Inspect the selected note.", [], {
    ensureComputerBackendSession: async () => "session-sidecar-auth-failure",
    readBackendJson
  });
  await assert.rejects(
    desktop.settleSidecarComputerAssignment("complete", "Inspection complete.", { readBackendJson }),
    /not authorized/
  );
  assert.deepEqual(calls.map((call) => call.pathname), [
    "/api/agent-goal",
    "/api/agent-goal/sidecar-settle"
  ]);
});

test("Revit UI dialog requests reach computer observation without a deterministic app launch", async () => {
  const desktop = await loadDelegatedDesktopModule("revit-dialog-no-launch");
  const prompt = "Use computer use to open Revit's Print dialog for the current view, inspect and report the selected printer and print range, then Cancel the dialog and verify that Revit is usable again. Do not submit a print job or modify the model.";
  assert.equal(desktop.revitLaunchDirective(prompt), "");
  assert.equal(desktop.parseRevitLaunchRequest(prompt), null);
  let launches = 0;
  let captures = 0;
  let requests = 0;
  await assert.rejects(desktop.executeComputerLoopForTest(prompt, {
    readBackendComputerConfig: async () => ({available:true, model:"mock", reasoning_effort:"low"}),
    tryFastEnlargedPlanPlacementFromPrompt: async () => null,
    parseFastSheetNameCapsFollowup: () => null,
    parseFastSheetNameUpdate: () => null,
    tryFastSheetNameUpdate: async () => null,
    tryFastSheetParameterUpdateFromPrompt: async () => null,
    tryFastPanelParameterUpdateFromPrompt: async () => null,
    launchLocalApp: async () => { launches++; throw new Error("dialog request must not launch"); },
    captureScreenshot: async () => { captures++; return "AA=="; },
    requestComputerResponse: async request => {
      requests++;
      assert.ok(request.tools.some(tool => tool.type === "computer"));
      assert.ok(request.input[0].content.some(item => item.type === "input_image"));
      assert.ok(!JSON.stringify(request.input).includes("This is a Revit launch request"));
      throw new Error("dialog observation reached");
    }
  }), /dialog observation reached/);
  assert.equal(launches, 0);
  assert.equal(captures, 1);
  assert.equal(requests, 1);
});

async function waitUntil(predicate, timeoutMs = 5_000) {
  const timeoutError = new Error("Timed out waiting for expected state.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw timeoutError;
}

function boundSidecarGoalResponse(goalId, body, status = "active", options = {}) {
  return {
    ok: true,
    goal: { id: goalId, status, work_budget: { ...body.work_budget, requested_effect: options.requestedEffect || "apply" } },
    ...(body?.start_assignment_run === true ? {
      assignment_run: {
        assignment_id: goalId,
        run_id: body.assignment_run_id,
        generation: 1,
        ...(options.kernelVersion ? { kernel_version: options.kernelVersion } : {})
      }
    } : {})
  };
}

import {createForegroundRevitWorkGate} from '../foreground_revit_work.js';
function boundCanonicalAssignmentOutcome(goalId, sessionId, runId, options = {}) {
  const outcomeState = options.outcomeState || "active";
  const terminalState = options.terminalState || "open";
  const clarificationId = options.clarificationId || null;
  return {
    schema: "revit-operator.canonical-assignment-outcome/v1",
    assignment_id: options.assignmentId || goalId,
    run_id: options.runId || runId,
    generation: options.generation || 1,
    session_id: options.sessionId || sessionId,
    requested_effect: options.requestedEffect || "apply",
    outcome_state: outcomeState,
    terminal_state: terminalState,
    terminal_reason: options.terminalReason || null,
    quiescent: options.quiescent !== false,
    pending_clarification: clarificationId ? {
      clarification_id: clarificationId,
      question: options.question || "What exact wording should replace the selected note?",
      missing_fields: options.missingFields || ["replacement_text"]
    } : null,
    pending_review_id: options.pendingReviewId || null,
    last_event_at: "2026-08-25T13:45:00.000Z",
    authority: "canonical_assignment_control_plane"
  };
}

function boundSidecarAssignmentProjection(goalId, sessionId, runId, options = {}) {
  const terminalState = options.terminalState || "open";
  const pendingClarificationId = options.pendingClarificationId || null;
  return {
    ok: true,
    assignment: {
      source_record_id: options.sourceRecordId || goalId,
      target: { session_id: options.sessionId || sessionId },
      control_plane: {
        assignment_id: options.assignmentId || goalId,
        run_id: options.runId || runId,
        generation: options.generation || 1,
        terminal_state: terminalState,
        pending_clarification_id: pendingClarificationId,
        pending_review_id: options.pendingReviewId || null,
        clarifications: pendingClarificationId ? [{
          clarification_id: pendingClarificationId,
          status: "pending",
          missing_fields: options.missingFields || ["newText"],
          question: options.question || "What exact wording should replace the selected note?"
        }] : []
      }
    }
  };
}

test("a long V2 job recovers beyond HTTP grace with one POST and its original frozen clock", async () => {
  const desktop = await loadDelegatedDesktopModule("long-v2-recovery");
  // Exact production binding returned by beginSidecarComputerAssignment: the
  // persisted task id is goal_id, not the normalized HTTP assignment_id field.
  const binding = { kernel_version: 2, goal_id: "long-job",
    run_id: "long-run", generation: 1, session_id: "mock-session", requested_effect: "apply" };
  const current = { assignment_id: binding.goal_id, run_id: binding.run_id, generation: 1,
    session_id: binding.session_id, principal_id: "principal-test", document_fingerprint: "a".repeat(64) };
  const created = Date.now();
  const publication = { schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: binding.goal_id,
    assignment_version: 3, snapshot: { schema: "revit-operator.assignment-snapshot/v2", assignment_version: 3,
      current_binding: current, terminal: false, outcome: "active", unresolved_unknown_operation_ids: [],
      provider_call_ids: [], provider_calls: {}, in_flight_provider_call_ids: [],
      spec: { created_at: new Date(created).toISOString(), execution_policy: { mode: "local_advisory_v1",
        selected_by: "trusted_local_host", session_id: current.session_id, document_fingerprint: current.document_fingerprint,
        max_wall_clock_ms: 2000 } } },
    provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: binding.goal_id,
      run_id: binding.run_id, generation: 1, call_ids: [], calls: {}, in_flight_call_ids: [] } };
  const calls = [];
  let signal;
  let polls = 0;
  const result = await desktop.delegateRevitTaskToBackend("Complete this package of changes.", {
    max_rounds: 1, include_latest_attachments: false,
    __testHooks: { ...delegatedHooks(async (pathname, options) => {
      calls.push({ pathname, signal: options.signal });
      if (pathname === "/chat") { signal = options.signal; throw new TypeError("fetch failed"); }
      assert.equal(options.signal, signal);
      if (pathname === "/api/assignments/v2/long-job") {
        if (polls > 1) { publication.snapshot.terminal = true; publication.snapshot.outcome = "awaiting_user_review"; }
        return publication;
      }
      assert.match(pathname, /^\/chat\/result\?/);
      polls++;
      if (polls === 1) { await new Promise(resolve => setTimeout(resolve, 80)); return { status: "pending" }; }
      return { assistant_message: "The original package completed its available work.", actions: [] };
    }, async () => { throw new Error("No replayed action expected"); }), assignmentBinding: binding,
      chatResultRecoveryGraceMs: 40, chatResultRecoveryPollIntervalMs: 10 }
  });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(c => c.pathname === "/chat").length, 1);
  const reads = calls.filter(c => c.pathname.startsWith("/chat/result?"));
  assert.equal(reads.length, 2);
  assert.equal(reads[0].pathname, reads[1].pathname);
  assert.equal(result.assignment_snapshot_v2.spec.created_at, new Date(created).toISOString());
  // Direct backend-owned edits do not appear in the outer legacy action list.
  for (const unknown of [false, true]) {
    publication.snapshot.terminal = false;
    publication.snapshot.outcome = unknown ? "blocked" : "active";
    publication.snapshot.quiescent = unknown;
    publication.snapshot.unresolved_unknown_operation_ids = unknown ? ["uncertain-preview"] : [];
    publication.snapshot.operations = { write: { persistent_effect: "applied", dispatch_state: "dispatched" } };
    let posts = 0;
    const failed = await desktop.delegateRevitTaskToBackend("Recover this saved editing job.", {
      max_rounds: 1, include_latest_attachments: false,
      __testHooks: { ...delegatedHooks(async pathname => {
        if (pathname === "/chat") { posts++; const error = new Error("Gateway unavailable"); error.status = 500; throw error; }
        assert.equal(pathname, "/api/assignments/v2/long-job"); return publication;
      }, async () => { throw new Error("must not replay"); }), assignmentBinding: binding }
    });
    assert.equal(posts, 1);
    assert.equal(failed.ok, false);
    assert.equal(failed.effect_state, unknown ? "unknown" : "applied");
    assert.equal(failed.backend_work_running, !unknown);
    assert.equal(failed.retryable, false);
    assert.equal(failed.reconciliation_required, unknown);
    assert.deepEqual(failed.unresolved_unknown_operation_ids, unknown ? ["uncertain-preview"] : []);
  }
});
test("Dynamic Revit model output stays compact while preserving report and durable evidence identity", async () => {
  const desktop = await loadDelegatedDesktopModule("dynamic-revit-compact-result");
  const elements = Array.from({ length: 509 }, (_, index) => ({ id: index + 1, payload: "x".repeat(900) }));
  const full = {
    schema: "revit-operator.dynamic-revit-program-run.v1",
    run_id: "dynamic-compact-1",
    requested_mode: "preview",
    execution_attempts: 1,
    execution_ok: true,
    evidence_path: "C:/evidence/dynamic-compact-1/evidence.json",
    evidence: {
      schema: "dynamic-revit-phase2-live-evidence/v0",
      ok: true,
      startedUtc: "2026-08-21T04:00:00.000Z",
      completedUtc: "2026-08-21T04:00:02.000Z",
      sandboxProfile: "windows-lpac-v1-zero-capabilities",
      snapshotReceipt: JSON.stringify({
        schema: "dynamic-revit-snapshot/v0",
        input_hash: `sha256:${"a".repeat(64)}`,
        document: {
          ProjectFingerprint: `sha256:${"b".repeat(64)}`,
          SessionId: "revit-session-1",
          Title: "Snowdon Towers Sample HVAC",
          ActiveViewId: 1420963,
          ActiveViewName: "Cover Sheet"
        },
        elements
      }),
      hostAuthenticationReceipts: [JSON.stringify({
        schema: "dynamic-revit-bootstrap-receipt/v0",
        revitProcessId: 10220,
        launcherProcessId: 2244,
        launcherExecutableHash: `sha256:${"f".repeat(64)}`
      }), "y".repeat(350_000)],
      workerOutput: {
        executionStatus: "completed",
        sourceHash: `sha256:${"c".repeat(64)}`,
        programHash: `sha256:${"d".repeat(64)}`,
        compiledAssemblyHash: `sha256:${"e".repeat(64)}`,
        deterministicReplayVerified: true,
        compileElapsedMs: 1200,
        executionElapsedMs: 49,
        report: { ProjectTotalAirTerminals: "509", CountsMatchProjectTotal: "True" },
        logs: []
      }
    }
  };
  const compact = desktop.compactDynamicRevitProgramResult(full);
  assert.equal(compact.execution_ok, true);
  assert.equal(compact.evidence.snapshot.element_count, 509);
  assert.equal(compact.evidence.snapshot.document.title, "Snowdon Towers Sample HVAC");
  assert.equal(compact.evidence.host.revit_process_id, 10220);
  assert.equal(compact.evidence.execution.report.ProjectTotalAirTerminals, "509");
  assert.equal(compact.evidence_path, full.evidence_path);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") < 20_000);
  assert.doesNotMatch(JSON.stringify(compact), /hostAuthenticationReceipts|"payload"/);
});
test("Dynamic Revit compaction preserves native settlement and bounded change identity without promoting worker success", async () => {
  const desktop = await loadDelegatedDesktopModule("dynamic-native-settlement-projection");
  const project = (apply, preview) => desktop.compactDynamicRevitProgramResult({
    execution_ok: true, requested_mode: "apply", evidence: {
      ok: true, applyReceipt: JSON.stringify(apply), previewReceipt: JSON.stringify(preview)
    }
  }).evidence;
  const native = { schema: "dynamic-revit-apply-receipt/v1", outcome: "committed_verified",
    graph_hash: "graph", document_fingerprint: "document", document_session_id: "session",
    changed_element_ids: [101, 102], retry_permitted: false };
  const preview = { schema: "dynamic-revit-preview-receipt/v0", ok: true,
    preview_id: "preview", rollback_status: "RolledBack", rollback_truth: true,
    projected_changed_element_ids: [101, 102], operation_count: 2 };
  const result = project(native, preview);
  assert.equal(result.apply.ok, true);
  assert.equal(result.apply.status, "committed_verified");
  assert.deepEqual(result.apply.changed_element_ids, [101, 102]);
  assert.equal(result.apply.document_session_id, "session");
  assert.equal(result.apply.graph_hash, "graph");
  assert.equal(result.apply.retry_permitted, false);
  assert.equal(result.preview.rollback_truth, true);
  assert.equal(result.preview.rollback_status, "RolledBack");
  assert.equal(result.preview.operation_count, 2);
  for (const outcome of ["rolled_back", "outcome_uncertain", "", "unexpected"]) {
    const failed = project({ ...native, outcome, ok: true }, { ...preview, ok: false, rollback_truth: false });
    assert.equal(failed.apply.ok, false);
    assert.equal(failed.apply.status, outcome);
    assert.equal(failed.preview.rollback_truth, false);
  }
  const many = project({ ...native, changed_element_ids: Array.from({ length: 501 }, (_, i) => i) }, preview);
  assert.equal(many.apply.changed_element_ids.length, 500);
  assert.equal(many.apply.changed_element_ids_total, 501);
  assert.equal(many.apply.changed_element_ids_truncated, true);
  const missing = project({ schema: native.schema }, {});
  assert.equal(missing.apply.ok, false);
  assert.equal(missing.apply.changed_element_ids_total, null);
  assert.equal(missing.preview, null);
  const legacy = project({ ok: true, status: "legacy", changedElementIds: [4] }, {});
  assert.equal(legacy.apply.ok, true);
  assert.deepEqual(legacy.apply.changed_element_ids, [4]);
});

function delegatedHooks(readBackendJson, executeBackendAction) {
  return {
    assignmentBinding: testAssignmentBinding("delegated"),
    buildHybridBackendContext: async () => ({ ui: { client: "operator-desktop-test" } }),
    ensureComputerBackendSession: async () => "mock-session",
    getLatestComputerUserBackendAttachments: async () => [],
    checkRevitBridgeHealth: async () => ({ ok: true, revit_bridge: { tool_count: 193 } }),
    readBackendJson: async (pathname,options) => pathname === "/chat/intake"
      ? {routing_status:"accepted",route:"task"} : readBackendJson(pathname,options),
    executeBackendAction
  };
}

function testAssignmentBinding(label) {
  return {
    assignment_id: `goal-${label}-test`,
    assignment_run_id: `run-${label}-test`,
    assignment_generation: 1
  };
}
