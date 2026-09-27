import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexInstructionBindingError, assertConfiguredBenchmarkInstructions, hostInstructionBinding } from "../src/codex/instruction_binding.js";
import { getOrCreateCodexThread } from "../src/brains/codex_thread_lifecycle.js";
import { getCodexThreadStartProfile, getThinReferenceCodexProfile } from "../src/brains/codex_turn_profile.js";
import { startCodexProviderTurnWhenActive } from "../src/brains/thin_reference_execution.js";
import { codexTelemetryThreadKey } from "../src/brains/codex_turn_model_telemetry.js";
import { getCodexThreadId } from "../src/memory/sqlite_store.js";

const a = { baseInstructions: "base A", developerInstructions: "skills A" };
const b = { baseInstructions: "base A", developerInstructions: "skills B" };

test("loaded A rejects B before provider dispatch while matching reuse preserves durable thread", async t => {
  const oldResearch = process.env.OPERATOR_WEB_RESEARCH_MODE;
  const oldDenylist = process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
  process.env.OPERATOR_WEB_RESEARCH_MODE = "unrestricted";
  delete process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
  t.after(() => {
    if (oldResearch === undefined) delete process.env.OPERATOR_WEB_RESEARCH_MODE;
    else process.env.OPERATOR_WEB_RESEARCH_MODE = oldResearch;
    if (oldDenylist === undefined) delete process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS;
    else process.env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS = oldDenylist;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-instruction-binding-"));
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const tracePath = path.join(root, "trace.jsonl");
  const resumeStatusPath = path.join(root, "resume-status.txt");
  fs.writeFileSync(resumeStatusPath, "active");
  const sourceTestDir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(sourceTestDir, "fixtures/codex_app_server_fixture.js"), path.join(sourceTestDir, "../../test/fixtures/codex_app_server_fixture.js")].find(file => fs.existsSync(file))!;
  const client = (active = false) => new CodexAppServer({ cwd: root, codexHome: path.join(root, ".codex"),
    command: process.execPath, commandPrefixArgs: [fixture],
    spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root, "state.json"), CODEX_FIXTURE_TRACE_PATH: tracePath,
      ...(active ? { CODEX_FIXTURE_RESUME_STATUS_PATH: resumeStatusPath } : {}) } });
  const first = client();
  const second = client();
  const activeRejoin = client(true);
  const profile = getCodexThreadStartProfile({ session_id: "binding-test", context: {} }, a);
  const args = { sessionId: "binding-test", profile, cwd: root,
    settings: { model: "fixture", reasoning_effort: "medium" as const }, getDynamicTools: async () => [] };
  try {
    await first.ensureStarted();
    const threadId = await getOrCreateCodexThread({ ...args, client: first });
    const durableKey = codexTelemetryThreadKey(profile);
    assert.equal(getCodexThreadId(durableKey), threadId);
    const envelopePath = path.join(root, "expected.json");
    fs.writeFileSync(envelopePath, JSON.stringify({ schema: "revit-operator.benchmark-run-envelope/v2", identity: { run_id: "instruction-test" }, instruction_bundle_hashes: hostInstructionBinding(b) }));
    const previousEnvelope = process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH;
    process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH = envelopePath;
    try {
      await assert.rejects(getOrCreateCodexThread({ ...args, client: first }), CodexInstructionBindingError);
    } finally {
      if (previousEnvelope === undefined) delete process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH;
      else process.env.OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH = previousEnvelope;
    }
    await assert.rejects(getOrCreateCodexThread({ ...args, profile: { ...profile, ...b }, client: first }), CodexInstructionBindingError);
    assert.throws(() => first.startBoundTurn({ threadId, input: [] }, b), CodexInstructionBindingError);
    assert.equal(getCodexThreadId(durableKey), threadId);
    assert.equal(await getOrCreateCodexThread({ ...args, client: first }), threadId);
    let trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 0);
    assert.equal((trace.match(/"method":"thread\/start"/g) ?? []).length, 1);
    assert.equal((trace.match(/"method":"thread\/resume"/g) ?? []).length, 0);
    assert.equal((trace.match(/"method":"turn\/interrupt"/g) ?? []).length, 0);
    const started = await first.startBoundTurn({ threadId, input: [] }, a);
    assert.deepEqual(first.getTurnInstructionBinding(threadId, started.turn.id), hostInstructionBinding(a));
    first.acknowledgePersistedTurnInstructionBinding(threadId, started.turn.id);
    assert.equal(first.getTurnInstructionBinding(threadId, started.turn.id), undefined);
    first.stop();
    assert.equal(first.getThreadInstructionBinding(threadId), undefined);
    await second.ensureStarted();
    const secondId = await getOrCreateCodexThread({ ...args, client: second });
    assert.notEqual(secondId, threadId, "cold recovery must restore raw-event capability through a recorded replacement");
    assert.equal(second.hasRawEventThread(secondId), true);
    assert.deepEqual(second.getThreadInstructionBinding(secondId), hostInstructionBinding(a));
    assert.throws(() => second.startBoundTurn({ threadId: secondId, input: [] }, b), CodexInstructionBindingError);
    await second.startBoundTurn({ threadId: secondId, input: [] }, a);
    await assert.rejects(second.resumeThread({ threadId: secondId, ...b }), CodexInstructionBindingError);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 2);
    assert.equal(getCodexThreadId(durableKey), secondId);
    await activeRejoin.ensureStarted();
    assert.equal(await getOrCreateCodexThread({ ...args, client: activeRejoin, monitoringOnly: true }), secondId);
    assert.equal(activeRejoin.hasLoadedThread(secondId), true);
    assert.equal(activeRejoin.hasRawEventThread(secondId), false);
    assert.equal(activeRejoin.getThreadInstructionBinding(secondId), undefined);
    assert.throws(() => activeRejoin.startBoundTurn({ threadId: secondId, input: [] }, a), CodexInstructionBindingError);
    await assert.rejects(getOrCreateCodexThread({ ...args, client: activeRejoin }), /prior thread is active/);
    assert.equal(getCodexThreadId(durableKey), secondId);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 2, "active metadata resume must not replay a turn");
    fs.writeFileSync(resumeStatusPath, "idle");
    const thirdId = await getOrCreateCodexThread({ ...args, client: activeRejoin });
    assert.notEqual(thirdId, secondId);
    assert.deepEqual(activeRejoin.getThreadInstructionBinding(thirdId), hostInstructionBinding(a));
    await activeRejoin.startBoundTurn({ threadId: thirdId, input: [] }, a);
    assert.equal(getCodexThreadId(durableKey), thirdId);
    trace = fs.readFileSync(tracePath, "utf8");
    assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 3, "only the requested new turn may start after idle acknowledgement");
    assert.equal((trace.match(/"method":"thread\/start"/g) ?? []).length, 3, "two idle cold recoveries restore raw-event capability without replaying turns");
    const threadRequests = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => ["thread/start", "thread/resume"].includes(row.method) && row.params?.config);
    assert.ok(threadRequests.some(row => row.method === "thread/start"));
    assert.ok(threadRequests.some(row => row.method === "thread/resume"));
    for (const row of threadRequests) assert.equal(row.params.config.web_search, "live", "live research survives creation and process resume");
    assert.equal((trace.match(/"method":"turn\/interrupt"/g) ?? []).length, 0);
  } finally {
    first.stop(); second.stop(); activeRejoin.stop();
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
    // SQLite may still hold this exact diagnostic fixture open on Windows.
    // Leave it in the OS temporary directory rather than forcing handle cleanup.
  }
});

test("host-configured benchmark envelope mismatch fails closed without trusting request context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instruction-envelope-"));
  const file = path.join(root, "envelope.json");
  const env = { OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH: file };
  try {
    assert.throws(() => assertConfiguredBenchmarkInstructions(a, env), CodexInstructionBindingError);
    fs.writeFileSync(file, JSON.stringify({ schema: "revit-operator.benchmark-run-envelope/v2", identity: { run_id: "instruction-test" }, instruction_bundle_hashes: hostInstructionBinding(b) }));
    assert.throws(() => assertConfiguredBenchmarkInstructions(a, env), CodexInstructionBindingError);
    assertConfiguredBenchmarkInstructions(b, env);
    assert.equal(hostInstructionBinding(a).system_instruction_sha256, hostInstructionBinding({ ...a }).system_instruction_sha256);
    assert.notEqual(hostInstructionBinding(a).system_instruction_sha256, hostInstructionBinding(b).system_instruction_sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("both production turn dispatch paths use the bound method and one frozen profile", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const source = [path.join(testDir, "../src/brains/codex_brain.ts"), path.join(testDir, "../../src/brains/codex_brain.ts")].find(file => fs.existsSync(file))!;
  const text = fs.readFileSync(source, "utf8");
  assert.equal((text.match(/\.startBoundTurn\(/g) ?? []).length, 2);
  assert.equal((text.match(/startCodexProviderTurnWhenActive\(/g) ?? []).length, 2, "initial and missing-thread recovery dispatches recheck pause/cancellation after setup");
  assert.doesNotMatch(text, /(?:activeClient|c)\.startTurn\(/);
  assert.match(text, /const threadProfile = Object\.freeze\(thinReference \? getThinReferenceCodexProfile\(req\.session_id, Boolean\(assignmentKernelV2\?\.snapshot\.spec\.execution_policy\)\) : getCodexThreadStartProfileForTest\(req\)\)/,
    "the optional advisory profile must come from the bound saved assignment policy, never request/provider text");
  assert.equal((text.match(/\b(?:const|let) threadProfile\s*=/g) ?? []).length, 1,
    "initial and replacement thread startup must share one frozen profile selection");
  assert.doesNotMatch(text, /\bthreadProfile\.[A-Za-z_$][\w$]*\s*=(?!=)/,
    "the captured profile must not be rewritten during setup or recovery");
  for (const client of ["activeClient", "c"]) {
    assert.match(text, new RegExp(`startCodexProviderTurnWhenActive\\(\\{ signal: cb\\.abortSignal, binding: assignmentKernelV2\\?\\.binding,\\s*readSnapshot: \\(\\) => assignmentKernelV2 \\? currentCodexAssignmentSnapshotV2\\(assignmentKernelV2\\.binding\\) : null \\}, \\(\\) => ${client}\\.startBoundTurn\\(\\{\\s*threadId,\\s*input: withCodexCapabilityHandoff\\(providerInput, threadId\\),\\s*model: agentSettings\\.model,\\s*effort: agentSettings\\.reasoning_effort\\s*\\}, threadProfile\\)\\)`),
      `${client} must dispatch directly from the current-state guard with the same frozen instruction profile`);
  }
  assert.match(text, /if \(error instanceof CodexInstructionBindingError\) return instructionBindingStop\(error\)/);
});

test("thin and advisory profiles retain exact bound instructions across guarded dispatch and cold thread replacement", async () => {
  const previousWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  const sourceTestDir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = [path.join(sourceTestDir, "fixtures/codex_app_server_fixture.js"), path.join(sourceTestDir, "../../test/fixtures/codex_app_server_fixture.js")].find(file => fs.existsSync(file))!;
  try {
    for (const advisory of [false, true]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-recovery-"));
      process.env.OPERATOR_WORKSPACE_ROOT = root;
      const tracePath = path.join(root, "trace.jsonl");
      const client = () => new CodexAppServer({ cwd: root, codexHome: path.join(root, ".codex"),
        command: process.execPath, commandPrefixArgs: [fixture],
        spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root, "state.json"), CODEX_FIXTURE_TRACE_PATH: tracePath } });
      const first = client(), replacement = client();
      const profile = Object.freeze(getThinReferenceCodexProfile(`profile-${advisory}`, advisory));
      const wrongProfile = Object.freeze(getThinReferenceCodexProfile(`profile-${advisory}`, !advisory));
      const args = { sessionId: `profile-${advisory}`, profile, cwd: root,
        settings: { model: "fixture", reasoning_effort: "medium" as const }, getDynamicTools: async () => [] };
      try {
        assert.equal(profile.profileNamespace, advisory ? "advisory-reference-v1" : "thin-reference-v1");
        assert.throws(() => Object.assign(profile, { baseInstructions: "replacement instructions" }), TypeError);
        await first.ensureStarted();
        const threadId = await getOrCreateCodexThread({ ...args, client: first });
        const started = await startCodexProviderTurnWhenActive({ readSnapshot: () => null },
          () => first.startBoundTurn({ threadId, input: [] }, profile));
        assert.deepEqual(first.getTurnInstructionBinding(threadId, started.turn.id), hostInstructionBinding(profile));
        first.acknowledgePersistedTurnInstructionBinding(threadId, started.turn.id);
        first.stop();
        await replacement.ensureStarted();
        const replacementId = await getOrCreateCodexThread({ ...args, client: replacement });
        assert.notEqual(replacementId, threadId);
        assert.deepEqual(replacement.getThreadInstructionBinding(replacementId), hostInstructionBinding(profile));
        assert.throws(() => startCodexProviderTurnWhenActive({ readSnapshot: () => null },
          () => replacement.startBoundTurn({ threadId: replacementId, input: [] }, wrongProfile)), CodexInstructionBindingError);
        const resumed = await startCodexProviderTurnWhenActive({ readSnapshot: () => null },
          () => replacement.startBoundTurn({ threadId: replacementId, input: [] }, profile));
        assert.deepEqual(replacement.getTurnInstructionBinding(replacementId, resumed.turn.id), hostInstructionBinding(profile));
        replacement.acknowledgePersistedTurnInstructionBinding(replacementId, resumed.turn.id);
        const trace = fs.readFileSync(tracePath, "utf8");
        assert.equal((trace.match(/"method":"turn\/start"/g) ?? []).length, 2,
          "only the two requested bound turns may dispatch; the mismatched advisory policy must not dispatch");
        assert.equal(getCodexThreadId(codexTelemetryThreadKey(profile)), replacementId);
      } finally { first.stop(); replacement.stop(); }
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousWorkspace;
  }
});

test("saved pause direction and current Resume receipt reach actual bound provider input; later controls still fence it",async()=>{
  const {prepareAssignmentTurn}=await import("../src/assignments/turn_preparation.js");
  const {steerAssignment,assignmentDirections}=await import("../src/assignments/task_steering.js");
  const {controlAssignmentExecutionV2}=await import("../src/assignments/assignment_kernel_v2_controls.js");
  const {getAssignmentKernelSnapshotV2}=await import("../src/assignments/assignment_kernel_v2_store.js");
  const {prepareCodexAssignmentProgressV2}=await import("../src/brains/codex_assignment_progress.js");
  const {buildCodexTurnInput}=await import("../src/brains/codex_turn_input.js");
  const {runWithRequestContext}=await import("../src/request_context.js");
  const {createOperatorBackendAuth}=await import("../src/operator_backend_auth.js");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-resume-context-"));
  const keys=["OPERATOR_WORKSPACE_ROOT","OPERATOR_ASSIGNMENT_KERNEL_V2","REVIT_OPERATOR_MODE","OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS"] as const;
  const previous=keys.map(key=>process.env[key]);
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";
  process.env.REVIT_OPERATOR_MODE="local";process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS="resume-context";
  const testDir=path.dirname(fileURLToPath(import.meta.url));
  const fixture=[path.join(testDir,"fixtures/codex_app_server_fixture.js"),path.join(testDir,"../../test/fixtures/codex_app_server_fixture.js")].find(file=>fs.existsSync(file))!;
  const tracePath=path.join(root,"trace.jsonl");
  const client=new CodexAppServer({cwd:root,codexHome:path.join(root,".codex"),command:process.execPath,commandPrefixArgs:[fixture],
    spawnEnv:{...process.env,CODEX_FIXTURE_STATE_PATH:path.join(root,"state.json"),CODEX_FIXTURE_TRACE_PATH:tracePath}});
  try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth("shared_token","test-only")},async()=>{
    const prepared=prepareAssignmentTurn({sessionId:"resume-context",messageId:"original",userText:"Review the connected devices; do not change or save the model.",toolResults:[],source:"chat",createdBy:null,
      requestContext:{revit:{document:{projectIdentity:{fingerprint:"resume-document"}}}}})!;
    const binding=getAssignmentKernelSnapshotV2(prepared.bindingV2!.assignment_id)!.current_binding;
    controlAssignmentExecutionV2({binding,action:"pause",command_id:"pause",expected_command_id:null});
    const text="Keep the review read-only and do not save. Stay paused until I press Resume.";
    await steerAssignment({binding,command_id:"saved-review",text,expected_turn_id:null});
    const running=controlAssignmentExecutionV2({binding,action:"resume",command_id:"resume",expected_command_id:"pause"});
    const progress=prepareCodexAssignmentProgressV2(binding);
    // Execute the actual production JSON packing expression rather than a second formatter.
    const brainPath=[path.join(testDir,"../src/brains/codex_brain.ts"),path.join(testDir,"../../src/brains/codex_brain.ts")].find(file=>fs.existsSync(file))!;
    const source=fs.readFileSync(brainPath,"utf8");
    const expression=source.match(/JSON.stringify\((directions\.map\(direction => \([^\n]+?\)\))\)/)?.[1];
    assert.ok(expression,"the existing direction JSON projection is source-bound");
    const packed=new Function("directions",`return ${expression};`)(assignmentDirections(binding));
    const input=await buildCodexTurnInput({version:"operator.backend.v1",session_id:binding.session_id,message_id:"resume-turn",user_text:"Continue the same review.",tool_results:[]},
      ["ADDITIONAL USER DIRECTIONS, in order:\n"+JSON.stringify(packed)],true);
    input.push({type:"text",text:progress.prompt,text_elements:[]});
    const profile=Object.freeze(getThinReferenceCodexProfile(binding.session_id,true));
    await client.ensureStarted();
    const threadId=await getOrCreateCodexThread({sessionId:binding.session_id,profile,cwd:root,settings:{model:"fixture",reasoning_effort:"medium"},getDynamicTools:async()=>[],client});
    const dispatch=()=>client.startBoundTurn({threadId,input},profile);
    await startCodexProviderTurnWhenActive({binding,readSnapshot:()=>getAssignmentKernelSnapshotV2(binding.assignment_id)},dispatch);
    const wire=fs.readFileSync(tracePath,"utf8").trim().split(/\r?\n/).map(line=>JSON.parse(line)).filter(row=>row.method==="turn/start");
    assert.equal(wire.length,1);
    const sent=wire[0].params.input.filter((row:any)=>row.type==="text").map((row:any)=>row.text).join("\n\n");
    assert.ok(sent.includes(text),"old direction must be retained exactly");
    const marker="CURRENT CANONICAL EXECUTION CONTROL (host receipt, not user instructions):";
    assert.ok(sent.lastIndexOf(marker)>sent.lastIndexOf(text),"provider input must end with the actual canonical Resume context");
    const receipt=JSON.parse(sent.split(marker+"\n")[1].split("\n")[0]);
    assert.deepEqual(receipt.execution_control,running.execution_control);assert.deepEqual(receipt.binding,binding);
    assert.equal(receipt.assignment_version,progress.snapshot.assignment_version);
    assert.deepEqual(packed,[{text,delivery:"saved",delivery_updated_at:assignmentDirections(binding)[0].updated_at}]);
    assert.match(source,/latest delivery receipt update, not necessarily when the direction was first saved/);
    const cancelled=new AbortController();cancelled.abort("user_requested_pause");
    assert.throws(()=>startCodexProviderTurnWhenActive({binding,signal:cancelled.signal,readSnapshot:()=>running},dispatch),/request_interrupted/);
    assert.throws(()=>startCodexProviderTurnWhenActive({binding:{...binding,generation:binding.generation+1},readSnapshot:()=>running},dispatch),/assignment_binding_changed/);
    const paused=controlAssignmentExecutionV2({binding,action:"pause",command_id:"pause-after-setup",expected_command_id:"resume"});
    assert.throws(()=>startCodexProviderTurnWhenActive({binding,readSnapshot:()=>paused},dispatch),/user_requested_pause/);
    assert.equal(prepareCodexAssignmentProgressV2(binding).prompt,"");
    assert.deepEqual(paused.spec,running.spec);assert.deepEqual(paused.operations,running.operations);
    assert.equal(fs.readFileSync(tracePath,"utf8").trim().split(/\r?\n/).filter(line=>JSON.parse(line).method==="turn/start").length,1,"cancellation, foreign generation and a later Pause must not dispatch stale prepared input");
  });}finally{client.stop();keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
});
