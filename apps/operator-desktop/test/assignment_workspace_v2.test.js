import { fileURLToPath } from "node:url";
test('Details uses advisory canonical work records instead of legacy workflow units',()=>{
 const p=fixture(),s=p.snapshot;
 s.spec.execution_policy={mode:'single_actor_review_v1'};s.outcome='awaiting_user_review';s.terminal=false;
 s.work_plan={items:[{item_id:'area',description:'Front exterior',operation_ids:[],location_history:[{drafting:{stage:'checked',pass:'coverage'}}]}]};
 s.work_plan_claims=[{item_id:'area',verified:false}];
 const view=assignmentWorkspaceGoalV2(p);
 assert.equal(view.work_items.length,1);assert.equal(view.work_items[0].id,'area');
 assert.equal(view.work_items[0].status,'reported_complete');assert.equal(view._projection.progress.reported,1);
 assert.equal(view._projection.progress.completed,0);assert.equal(view.status,'awaiting_user_review');
});
import { createBrowserAssetFreshness } from "../browser_asset_freshness.js";
import { assertLoadedBrowserFresh } from "../public/browser_asset_freshness_ui.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import express from "express";
import { assignmentWorkspaceGoalV2, readAssignmentWorkspaceV2 } from "../assignment_workspace_v2.js";
import { acknowledgeAssignmentMutationV2, acknowledgeAssignmentControlV2, acceptAssignmentMutationViewV2, retainNewerAssignmentViewsV2, readSavedAssignmentHistoryV2 } from "../assignment_mutation.mjs";
import { readNavigationAssignment } from "../task_navigation.mjs";
import { routeSavedChatSubmission } from "../public/composer_intake.mjs";
import { createAssignmentInputControl, assignmentInputErrorText } from "../../../packages/operator-assistant-ui/assignment_input_controls.mjs";

test('product renewal presentation requires advertised server support as well as a settled canonical checkpoint',()=>{
 const p=fixture(),s=p.snapshot,b=s.current_binding;
 s.spec.binding={...b};s.spec.requested_effect='apply';s.outcome='awaiting_user_review';s.terminal=false;
 s.spec.execution_policy={mode:'single_actor_review_v1',selected_by:'trusted_runtime_host',principal_id:b.principal_id,
  session_id:b.session_id,document_fingerprint:b.document_fingerprint,ready_work_handoff:'continue_ready_work_v1'};
 s.completion_proposal={review_id:'review',verified:false};s.pending_review_ids=['review'];
 assert.equal(assignmentWorkspaceGoalV2(p)._canRenewResources,false,'Older backend is not silently assumed to support renewal');
 p.supports_explicit_resource_renewal_v1=true;assert.equal(assignmentWorkspaceGoalV2(p)._canRenewResources,true);
 s.unresolved_unknown_operation_ids=['unknown'];assert.equal(assignmentWorkspaceGoalV2(p)._canRenewResources,false);
 s.unresolved_unknown_operation_ids=[];s.execution_control={state:'paused',command_id:'pause',changed_at:'2026-09-04T10:01:00Z'};
 assert.equal(assignmentWorkspaceGoalV2(p)._canRenewResources,false);
});

test("canonical pending-input display carries immutable prerequisite kind and source clause", () => {
  const publication = fixture();
  const sourceClause = 'Ask my approval before removing the selected objects. <b>Literal text</b>';
  publication.snapshot.spec.interpreted_scope = { scope: { prerequisites: [
    { variable_id: "consent", kind: "approval", source_quote: sourceClause },
    { variable_id: "representation", kind: "information", source_quote: "Ask how it should be represented before making changes." }
  ] } };
  publication.snapshot.clarifications = {
    consent: { clarification_id: "consent", variable_id: "consent", question: "Approve removal?", input_kind: "information" },
    representation: { clarification_id: "representation", variable_id: "representation", question: "How should I represent it?", input_kind: "approval" }
  };
  const inputs = assignmentWorkspaceGoalV2(publication)._pendingInputs;
  assert.deepEqual(inputs[0], { clarification_id: "consent", variable_id: "consent", question: "Approve removal?", input_kind: "approval", source_clause: sourceClause });
  assert.equal(inputs[1].input_kind, "information", "display kind comes from the saved scope, not the question or caller metadata");
  assert.equal(inputs[1].source_clause, undefined);
});

test("actual pending approval form sends explicit boolean consent through Sidecar, and never resumes on blank or decline", async t => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function renderAssignmentInputsV2("), source.indexOf("async function runGoalControl("));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
    append(...nodes) { this.children.push(...nodes); } appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; } setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const container = new Element("section");
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const sourceClause = 'Ask my approval before removing the selected objects. <b>Literal text</b>';
  const goal = { id: "goal:inventory", _assignmentVersion: 7, _sourceKind: "assignment_kernel_v2", _sourceRecordId: "inventory", _bindingV2: binding,
    _pendingInputs: [{ clarification_id: "consent", variable_id: "consent", question: "Approve removal?", input_kind: "approval", source_clause: sourceClause }] };
  const calls = [], resumed = [], statuses = [];
  const fetchJson = await browserControlTransport(t, calls);
  const state = { sessionId: "session-1", goalSelectionPinned: false, goals: [goal] };
  const render = runInNewContext(`${code}; renderAssignmentInputsV2`, {
    elements: { assignmentInputs: container }, state, document: { createElement: tag => new Element(tag) }, selectedGoal: () => state.goals[0],
    createAssignmentInputControl, assignmentInputErrorText,
    fetchJson, acceptAssignmentMutationViewV2, renderGoalPanel() {}, runGoalControl: async (...args) => resumed.push(args), setStatus: value => statuses.push(value)
  });
  render(goal);
  const form = container.children[0], input = form.children[0].children[0];
  assert.equal(input.tag, "select"); assert.equal(input.value, "");
  const clause = form.children[0].children[1];
  assert.equal(clause.textContent, sourceClause); assert.equal(clause.innerHTML, undefined, "source clauses must render as text");
  for (const invalid of ["", "yes", "decline"]) {
    input.value = invalid;
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(calls.length, 0); assert.equal(resumed.length, 0);
    assert.doesNotMatch(statuses.at(-1), /assignment_kernel|assignment_approval/);
  }
  assert.match(statuses.at(-1), /remains paused/);
  input.value = "approve";
  render(goal); assert.equal(container.children[0], form, "polling preserves a user's explicit choice");
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls[0].body, { ...binding, clarification_id: "consent", supplied_values: { consent: true } });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][0], "resume");
});

test("a retained approval mismatch shows actionable text without mutating the pending task or diagnostic error", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function renderAssignmentInputsV2("), source.indexOf("async function runGoalControl("));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
    append(...nodes) { this.children.push(...nodes); } appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; } setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const container = new Element("section");
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const question = { clarification_id: "representation", variable_id: "representation", question: "How should the ambiguous 6-inch bathroom ceiling-device symbol be represented?" };
  const goal = { id: "goal:inventory", _assignmentVersion: 7, _sourceKind: "assignment_kernel_v2", _sourceRecordId: "inventory", _bindingV2: binding, _pendingInputs: [question] };
  const state = { sessionId: "session-1", goalSelectionPinned: false, goals: [goal] };
  const failure = Error("assignment_kernel_v2_approval_requires_explicit_true");
  const statuses = []; let resumed = false;
  const render = runInNewContext(`${code}; renderAssignmentInputsV2`, {
    elements: { assignmentInputs: container }, state, document: { createElement: tag => new Element(tag) }, selectedGoal: () => state.goals[0],
    createAssignmentInputControl, assignmentInputErrorText, fetchJson: async () => { throw failure; },
    acceptAssignmentMutationViewV2, renderGoalPanel() {}, runGoalControl: async () => { resumed = true; }, setStatus: value => statuses.push(value)
  });
  render(goal);
  const form = container.children[0]; form.children[0].children[0].value = "Use a provisional proxy and leave service unresolved.";
  await form.listeners.submit({ preventDefault() {} });
  assert.match(statuses.at(-1), /explicit approval choice/);
  assert.doesNotMatch(statuses.at(-1), /assignment_kernel/);
  assert.equal(failure.message, "assignment_kernel_v2_approval_requires_explicit_true");
  assert.equal(state.goals[0], goal); assert.deepEqual(goal._pendingInputs, [question]); assert.equal(resumed, false);
});

test("Sidecar server and browser use the exact tested public acknowledgment protocol", async () => {
  const source = await readFile(new URL("../../../packages/operator-assistant-ui/assignment_mutation.mjs", import.meta.url), "utf8");
  for (const relative of ["../assignment_mutation.mjs", "../public/assignment_mutation.mjs", "../../../packages/operator-assistant-ui/assignment_mutation.mjs"]) {
    assert.equal(await readFile(new URL(relative, import.meta.url), "utf8"), source, relative);
  }
  const inputSource = await readFile(new URL("../../../packages/operator-assistant-ui/assignment_input_controls.mjs", import.meta.url), "utf8");
  for (const relative of ["../assignment_input_controls.mjs", "../public/assignment_input_controls.mjs", "../../../packages/operator-assistant-ui/assignment_input_controls.mjs"]) {
    assert.equal(await readFile(new URL(relative, import.meta.url), "utf8"), inputSource, relative);
  }
});

async function browserControlTransport(t, calls, { remainingQuestion = false } = {}) {
  const browserSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const app = express();
  app.use(express.json());
  app.post('/api/assignment-workspace/v2/executor', (req,res) => res.json({ok:true,executor:'backend',binding:req.body}));
  const freshness = createBrowserAssetFreshness(fileURLToPath(new URL("../public", import.meta.url)));
  app.use(freshness.middleware);
  const routeStart = serverSource.indexOf('for (const [localPath, backendPath] of [');
  const routes = serverSource.slice(routeStart, serverSource.indexOf('app.get("/api/assignments",', routeStart));
  let publication;
  runInNewContext(routes, { app, acknowledgeAssignmentMutationV2, acknowledgeAssignmentControlV2, interruptPausedComputerOwner:()=>false, assignmentWorkspaceGoalV2, readBackendJson: async (path, options) => {
    if (options.method === "GET") {
      assert.equal(path, `/api/assignments/v2/${publication.assignment_id}`);
      return { assignment_kernel_v2: publication };
    }
    const body = JSON.parse(options.body);
    assert.ok(body?.assignment_id && body?.session_id && body?.run_id && body.generation > 0,
      "real browser JSON must survive the Sidecar HTTP parser and backend proxy");
    calls.push({ path, body });
    if (path === "/api/assignments/clarification-responses") {
      publication = fixture();
      publication.assignment_id = body.assignment_id;
      publication.assignment_version = publication.snapshot.assignment_version = 8;
      publication.snapshot.current_binding = { ...publication.snapshot.current_binding,
        assignment_id: body.assignment_id, session_id: body.session_id, run_id: body.run_id, generation: body.generation };
      publication.snapshot.terminal = false; publication.snapshot.outcome = remainingQuestion ? "awaiting_user_input" : "active";
      publication.snapshot.pending_input_variable_ids = remainingQuestion ? ["corner"] : [];
      publication.snapshot.clarifications = remainingQuestion ? { corner: { clarification_id: "corner", variable_id: "corner", question: "Corner-room rule?" } } : {};
      Object.assign(publication.provider_ledger, { assignment_id: body.assignment_id, run_id: body.run_id, generation: body.generation });
      return { ok: true, assignment_snapshot_v2: publication.snapshot };
    }
    if (path === "/api/assignments/v2/execution-control") {
      publication = fixture(); publication.assignment_version = publication.snapshot.assignment_version = (body.expected_assignment_version || 7) + 1;
      Object.assign(publication.snapshot, { terminal: false, terminal_reason: undefined, outcome: "active",
        execution_control: { state: body.action === "pause" ? "paused" : "running", command_id: body.command_id, changed_at: "2026-09-04T10:02:00Z" } });
      return { ok: true, assignment_snapshot_v2: publication.snapshot };
    }
    return { ok: true };
  }, sendJsonError: (res, error) => res.status(409).json({ error: error.message }) });
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const fetchSource = browserSource.slice(browserSource.indexOf("async function fetchJson("), browserSource.indexOf("// TESTABLE_EXECUTION_ADMISSION_PRESENTATION_START"));
  const localFetch = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const loadedBrowserIdentity = freshness.snapshot().identity;
  const transport = runInNewContext(`${fetchSource}; fetchJson`, { fetch: localFetch, loadedBrowserIdentity });
  transport.currentPublication = () => publication;
  transport.loadedBrowserIdentity = loadedBrowserIdentity;
  transport.assertLoadedBrowserFresh = identity => assertLoadedBrowserFresh(identity, localFetch);
  return transport;
}

test("untyped browser JSON cannot silently become a valid control command", async t => {
  const calls = [];
  const fetchJson = await browserControlTransport(t, calls);
  await assert.rejects(fetchJson("/api/assignment-workspace/v2/control", {
    method: "POST", body: JSON.stringify({ assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 })
  }));
  assert.equal(calls.length, 0);
});

function fixture() {
  const binding = { assignment_id: "inventory", run_id: "run-1", generation: 1, session_id: "session-1", principal_id: "local:test", document_fingerprint: "model-1" };
  return {
    schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: "inventory", assignment_version: 7,
    snapshot: {
      schema: "revit-operator.assignment-snapshot/v2", assignment_version: 7, current_binding: binding,
      spec: { source_user_request: "Count air devices", requested_effect: "read", created_at: "2026-09-04T10:00:00Z",
        criteria: [{ criterion_id: "count", requirement: "Ground the inventory" }],
        work_units: [{ work_unit_id: "work-primary" }, { work_unit_id: "work-evidence" }] },
      outcome: "complete", terminal: true, terminal_reason: "Verified inventory", finished_at: "2026-09-04T10:01:00Z",
      provider_call_ids: [], provider_calls: {}, in_flight_provider_call_ids: [],
      criteria: { count: { status: "pass", reason: "Live inventory", evaluated_at: "2026-09-04T10:00:59Z" } },
      work_unit_states: { "work-primary": "complete", "work-evidence": "complete" },
      observations: { inventory: { observation_id: "inventory-result", payload: { total: 509, bulky: "x".repeat(10000) } } },
      operations: {}, unresolved_unknown_operation_ids: [], quiescent: true,
      pending_input_variable_ids: [], pending_review_ids: [], clarifications: {}
    },
    provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: "inventory", run_id: "run-1", generation: 1, call_ids: [], calls: {}, in_flight_call_ids: [] }
  };
}

function index(publication) {
  return { ok: true, schema: "revit-operator.assignment-kernel-session-index-response/v2",
    assignment_kernel_v2_session_index: { schema: "revit-operator.assignment-kernel-session-index/v2", session_id: "session-1",
      assignments: [{ assignment_id: publication.assignment_id, assignment_version: publication.assignment_version,
        binding: publication.snapshot.current_binding, outcome: publication.snapshot.outcome, terminal: publication.snapshot.terminal }] } };
}

test("ordinary apply omits an unused preview step but retains executed or blocked work", () => {
  const publication = fixture();
  const snapshot = publication.snapshot;
  snapshot.spec.requested_effect = "apply";
  snapshot.spec.work_units.push({ work_unit_id: "work-preview" });
  snapshot.work_unit_states["work-preview"] = "complete";
  assert(!assignmentWorkspaceGoalV2(publication).work_items.some(item => item.id === "work-preview"));
  snapshot.work_unit_states["work-preview"] = "blocked";
  assert(assignmentWorkspaceGoalV2(publication).work_items.some(item => item.id === "work-preview"));
  snapshot.work_unit_states["work-preview"] = "complete";
  snapshot.operations.preview = { work_unit_id: "work-preview" };
  assert(assignmentWorkspaceGoalV2(publication).work_items.some(item => item.id === "work-preview"));
  delete snapshot.operations.preview;
  snapshot.spec.requested_effect = "preview";
  assert(assignmentWorkspaceGoalV2(publication).work_items.some(item => item.id === "work-preview"));
});

test("canonical workspace separates pause from completion and retains pending questions", () => {
  const publication = fixture();
  const snapshot = publication.snapshot;
  snapshot.terminal = false;
  snapshot.outcome = "awaiting_user_input";
  delete snapshot.terminal_reason;
  snapshot.execution_control = { state: "paused", command_id: "pause-1", changed_at: "2026-09-04T10:00:00Z" };
  snapshot.pending_input_variable_ids = ["replacement_text"];
  snapshot.clarifications = { question: { clarification_id: "question", variable_id: "replacement_text", question: "What exact replacement wording?" } };
  let view = assignmentWorkspaceGoalV2(publication);
  assert.equal(view.status, "paused");
  assert.equal(view._canResume, false);
  assert.equal(view._pendingInputs[0].clarification_id, "question");
  assert.equal(view._bindingV2.assignment_id, publication.assignment_id);
  snapshot.quiescent = false;
  assert.equal(assignmentWorkspaceGoalV2(publication).status, "pausing");
  snapshot.quiescent = true;
  snapshot.pending_input_variable_ids = [];
  snapshot.clarifications.question.resolved_at = "2026-09-04T10:01:00Z";
  view = assignmentWorkspaceGoalV2(publication);
  assert.equal(view._canResume, true);
  assert.deepEqual(view._pendingInputs, []);
  snapshot.unresolved_unknown_operation_ids = ["unknown-edit"];
  assert.equal(assignmentWorkspaceGoalV2(publication)._canResume, false);
});

test("recovery is separate from resume and cannot override unknown effects", () => {
  const publication = fixture();
  const snapshot = publication.snapshot;
  snapshot.terminal = false;
  snapshot.outcome = "active";
  snapshot.quiescent = false;
  snapshot.in_flight_operation_ids = ["interrupted-edit"];
  let view = assignmentWorkspaceGoalV2(publication);
  assert.equal(view._canRecover, true);
  assert.equal(view._canResume, false);
  snapshot.in_flight_operation_ids = [];
  snapshot.quiescent = true;
  snapshot.unresolved_unknown_operation_ids = ["interrupted-edit"];
  view = assignmentWorkspaceGoalV2(publication);
  assert.equal(view._canRecover, false);
  assert.equal(view._canResume, false);
});

test("Recover results sends the exact binding through the real Sidecar parser without a chat or resume", async t => {
  const calls = [];
  const transport = await browserControlTransport(t, calls);
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const goal = { _sourceKind: "assignment_kernel_v2", _canRecover: true, _bindingV2: binding };
  const state = { sessionId: "session-1", streaming: false, goalSelectionPinned: false };
  let synced = 0;
  const recover = await appFunction("recoverCanonicalAssignmentResults", "function renderAssignmentInputsV2", {
    state, fetchJson: transport, syncGoals: async () => { synced++; }, setStatus: () => {}
  });
  await recover(goal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/assignments/v2/recover-completions");
  assert.deepEqual(calls[0].body, binding);
  assert.equal(synced, 1);
  state.streaming = true;
  await assert.rejects(recover(goal), /active request/);
  state.streaming = false;
  state.goalSelectionPinned = true;
  await assert.rejects(recover(goal), /current task/);
  state.goalSelectionPinned = false;
  state.sessionId = "foreign";
  await assert.rejects(recover(goal), /another conversation/);
  assert.equal(calls.length, 1);
});

test("Resume posts JSON through the Sidecar HTTP parser and continues the same bound backend task", async t => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function resumeCanonicalAssignment("), source.indexOf("function renderAssignmentInputsV2("));
  const state = { sessionId: "session-1", streaming: false };
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const goal = { id: "goal:inventory", _sourceKind: "assignment_kernel_v2", objective: "Count air devices", _assignmentVersion: 7, _bindingV2: binding, _executionControl: { command_id: "pause-1" }, _canResume: true };
  state.goals = [goal];
  let current = goal;
  const calls = [];
  const fetchJson = await browserControlTransport(t, calls);
  const control = runInNewContext(`${code}; runCanonicalGoalControl`, {
    state, loadedBrowserIdentity: fetchJson.loadedBrowserIdentity, assertLoadedBrowserFresh: fetchJson.assertLoadedBrowserFresh, crypto: { randomUUID: () => "resume-1" },
    fetchJson,
    selectedGoal: () => current,
    acceptAssignmentMutationViewV2(state, result, binding) { const accepted = acceptAssignmentMutationViewV2(state, result, binding); if (accepted) current = accepted; return accepted; },
    syncGoals: async () => { current = assignmentWorkspaceGoalV2(fetchJson.currentPublication()); calls.push("sync"); }, setStatus: () => {},
    routeSavedChatSubmission, createChatSubmission: text => ({ text, attachments: [] }),
    sendBackendPrompt: async submission => calls.push(JSON.parse(JSON.stringify(submission)))
  });
  await control(goal, "resume");
  assert.equal(calls[0].path, "/api/assignments/v2/execution-control");
  assert.equal(calls[0].body.expected_command_id, "pause-1");
  assert.deepEqual(calls[2].assignmentBindingV2, binding);
  assert.equal(calls[2].text, "Continue the existing task using its saved answers and evidence.");
  state.sessionId = "another-session";
  await assert.rejects(control(goal, "resume"), /another conversation/);
  assert.equal(calls.length, 3);
});

test("pending-question form preserves a multiline draft and sends exact JSON through the Sidecar HTTP parser", async t => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function renderAssignmentInputsV2("), source.indexOf("async function runGoalControl("));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    addEventListener(name, handler) { this.listeners[name] = handler; }
  }
  const container = new Element("section");
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const goal = { id: "goal:inventory", _assignmentVersion: 7, _sourceKind: "assignment_kernel_v2", _sourceRecordId: "inventory", _bindingV2: binding,
    _pendingInputs: [{ clarification_id: "question-1", variable_id: "replacement_text", question: "What exact text?" }] };
  const calls = [];
  const fetchJson = await browserControlTransport(t, calls);
  const state = { sessionId: "session-1", goalSelectionPinned: false, goals: [goal] };
  const render = runInNewContext(`${code}; renderAssignmentInputsV2`, {
    elements: { assignmentInputs: container }, state,
    document: { createElement: tag => new Element(tag) }, selectedGoal: () => state.goals[0],
    createAssignmentInputControl, assignmentInputErrorText,
    fetchJson, acceptAssignmentMutationViewV2, renderGoalPanel() {}, runGoalControl: async () => {},
    syncGoals: async () => {}, setStatus: () => {}
  });
  render(goal);
  const form = container.children[0];
  const input = form.children[0].children[0];
  assert.equal(input.tag, "textarea", "a single-line HTML input cannot retain note line breaks");
  const exactText = "  ISSUE 04\nVERIFY AGAINST CURRENT SHEET INDEX\n";
  input.value = exactText;
  render(goal);
  assert.equal(container.children[0], form, "polling must not erase the user's draft");
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(calls[0].path, "/api/assignments/clarification-responses");
  assert.deepEqual(calls[0].body, { ...binding, clarification_id: "question-1", supplied_values: { replacement_text: exactText } });
});

test("workspace reads the canonical index and exact publication, never the V1 list", async () => {
  const publication = fixture();
  const paths = [];
  const result = await readAssignmentWorkspaceV2(async path => {
    paths.push(path);
    if (path === "/api/assignments/v2?limit=30&session_id=session-1") return index(publication);
    if (path === "/api/assignments/v2/inventory") return { assignment_kernel_v2: publication };
    throw new Error(`Unexpected legacy read: ${path}`);
  }, "session-1");
  assert.equal(paths.length, 2);
  const view = result.assignments[0];
  assert.equal(view.status, "complete");
  assert.equal(view._assignmentVersion, 7);
  assert.equal(view._sourceKind, "assignment_kernel_v2");
  assert.equal(view.related_session_id, "session-1");
  assert.equal(view._projection.target.document_fingerprint, "model-1");
  assert.equal(view.work_items.filter(item => item.status === "complete").length, 2);
  assert.equal(view.validation_log.length, 1);
  assert.ok(JSON.stringify(result).length < 3000, "raw evidence must not be copied into the display model");
});

test("C27 floor answer continues once through real Sidecar JSON and never resumes a changed task", async t => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function renderAssignmentInputsV2("), source.indexOf("async function runGoalControl("));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
    append(...nodes) { this.children.push(...nodes); } appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; } setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  for (const scenario of ["continue", "navigate", "generation", "streaming", "history", "more-questions"]) {
    const calls = [], resumed = [];
    const transport = await browserControlTransport(t, calls, { remainingQuestion: scenario === "more-questions" });
    const binding = { assignment_id: "zoning", session_id: "session-1", run_id: "run-1", generation: 1 };
    const goal = { id: "goal:zoning", _assignmentVersion: 7, _sourceKind: "assignment_kernel_v2", _sourceRecordId: "zoning", _bindingV2: binding,
      _pendingInputs: [{ clarification_id: "floor", variable_id: "floor_name", question: "Which floor should I use for the proposed zoning schedule?" }] };
    const state = { sessionId: "session-1", streaming: false, goalSelectionPinned: false, goals: [goal] };
    let release;
    const container = new Element("section");
    const render = runInNewContext(`${code}; renderAssignmentInputsV2`, {
      elements: { assignmentInputs: container }, state, document: { createElement: tag => new Element(tag) }, selectedGoal: () => state.goals[0],
      createAssignmentInputControl, assignmentInputErrorText, acceptAssignmentMutationViewV2, renderGoalPanel() {},
      fetchJson: async (...args) => { await new Promise(resolve => { release = resolve; }); return transport(...args); },
      runGoalControl: async (action, exactBinding) => resumed.push({ action, binding: JSON.parse(JSON.stringify(exactBinding)) }), setStatus() {}
    });
    render(goal);
    const form = container.children[0], input = form.children[0].children[0], button = form.children[1];
    assert.equal(button.textContent, "Continue");
    input.value = "L2";
    state.streaming = true; render(goal);
    assert.equal(container.children[0], form); assert.equal(input.value, "L2"); assert.equal(button.disabled, true);
    await form.listeners.submit({ preventDefault() {} }); assert.equal(release, undefined);
    state.streaming = false; render(goal); assert.equal(button.disabled, false);
    const pending = form.listeners.submit({ preventDefault() {} });
    await form.listeners.submit({ preventDefault() {} });
    if (scenario === "navigate") state.goals[0] = { ...goal, _sourceRecordId: "different", _bindingV2: { ...binding, assignment_id: "different" } };
    if (scenario === "generation") state.goals[0] = { ...goal, _bindingV2: { ...binding, generation: 2 } };
    if (scenario === "streaming") state.streaming = true;
    if (scenario === "history") state.goalSelectionPinned = true;
    release(); await pending;
    assert.equal(calls.length, 1, scenario);
    assert.deepEqual(calls[0].body, { ...binding, clarification_id: "floor", supplied_values: { floor_name: "L2" } });
    assert.equal(resumed.length, scenario === "continue" ? 1 : 0, scenario);
    if (resumed.length) assert.deepEqual(resumed[0], { action: "resume", binding });
  }
});

test("answer continuation rechecks the selected binding after a live model-context read", async () => {
  const binding = { assignment_id: "zoning", session_id: "session-1", run_id: "run-1", generation: 1 };
  const goal = { _sourceKind: "assignment_kernel_v2", _sourceRecordId: "zoning", _bindingV2: binding };
  for (const navigate of [false, true]) {
    let selected = goal, finish;
    const calls = [];
    const control = await appFunction("runGoalControl", "function dispatchBackendSseEvent", {
      state: { sessionId: "session-1", streaming: false, goalSelectionPinned: false }, selectedGoal: () => selected,
      refreshAssignmentRevitContext: () => new Promise(resolve => { finish = resolve; }),
      assignmentContextPresentation: () => ({ resumeBlocked: false }), runCanonicalGoalControl: async (...args) => calls.push(args), setStatus() {}
    });
    const pending = control("resume", binding);
    if (navigate) selected = { ...goal, _bindingV2: { ...binding, generation: 2 } };
    finish({}); await pending;
    assert.equal(calls.length, navigate ? 0 : 1);
    if (!navigate) { assert.equal(calls[0][2](), true); selected = { ...goal, _sourceRecordId: "other" }; assert.equal(calls[0][2](), false); }
  }
});

test("workspace fails closed on a foreign session, regressed version, or incoherent ledger", async () => {
  for (const corrupt of [
    p => { p.snapshot.current_binding.session_id = "foreign-session"; },
    p => { p.assignment_version = p.snapshot.assignment_version = 6; },
    p => { p.provider_ledger.run_id = "foreign-run"; }
  ]) {
    const publication = fixture();
    const discovery = index(structuredClone(publication));
    corrupt(publication);
    await assert.rejects(readAssignmentWorkspaceV2(async path => path.includes("?") ? discovery : { assignment_kernel_v2: publication }, "session-1"));
  }
  await assert.rejects(readAssignmentWorkspaceV2(async () => ({ ok: true, assignments: [] }), "session-1"));
});

test("saved-task HTTP lookup validates the exact publication beyond the recent history page", async t => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf('app.get("/api/assignment-workspace/v2/task",');
  const end = source.indexOf('\nfor (const [localPath, backendPath]', start);
  assert(start >= 0 && end > start);
  const calls = [], app = express(), publication = fixture();
  runInNewContext(source.slice(start, end), { app, readNavigationAssignment, assignmentWorkspaceGoalV2,
    readBackendJson: async path => { calls.push(path); return { assignment_kernel_v2: publication }; },
    sendJsonError: (res, error, status) => res.status(status).json({ error: error.message }) });
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}/api/assignment-workspace/v2/task`;
  const response = await fetch(root + '?session_id=session-1&assignment_id=inventory');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).assignment._bindingV2.assignment_id, 'inventory');
  assert.deepEqual(calls, ['/api/assignments/v2/inventory']);
  assert.equal((await fetch(root + '?session_id=foreign&assignment_id=inventory')).status, 502);
  publication.provider_ledger.run_id = 'foreign-run';
  assert.equal((await fetch(root + '?session_id=session-1&assignment_id=inventory')).status, 502);
});

test("opening an older paused task loads that exact task instead of newer completed work in the conversation", async () => {
  const canonical = assignmentWorkspaceGoalV2(fixture());
  const paused = { ...canonical, id:'goal:older-paused', _sourceRecordId:'older-paused', _canResume:true, _assignmentPhase:'paused',
    _bindingV2:{...canonical._bindingV2,assignment_id:'older-paused'}, updated_at:'2026-09-04T09:00:00Z' };
  const state = { goalsSyncRequestId:0, sessionId:'session-1', streaming:false, taskNavigationAssignmentId:'older-paused',
    activeGoalId:'goal:older-paused', goalSelectionPinned:false, goals:[canonical] };
  const source = await readFile(new URL('../public/app.js', import.meta.url),'utf8');
  const policy = source.match(/\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_START([\s\S]*?)\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_END/)[1];
  const helpers = runInNewContext(`${policy}; ({ assignmentProjectionToGoalView, chooseCurrentAssignment, assignmentIsNewer })`);
  const calls = [];
  const sync = await appFunction('syncGoals','function scheduleGoalsPolling',{
    ...helpers,state,URLSearchParams,Set,retainNewerAssignmentViewsV2,readSavedAssignmentHistoryV2,
    refreshAssignmentRevitContext:async()=>({}),fetchJson:async path=>{calls.push(path);return path.includes('/task?')?{assignment:paused}:{session_id:'session-1',assignments:[canonical]};},
    renderGoalPanel(){},renderCompactWork(){},selectedGoal:()=>state.goals.find(goal=>goal.id===state.activeGoalId),syncVerifiedWorkPacket:async()=>{}
  });
  await sync();
  assert.equal(state.activeGoalId,'goal:older-paused');
  assert.equal(state.goals.find(goal=>goal.id==='goal:older-paused')._canResume,true);
  assert.equal(state.goals.length,2);
  assert.deepEqual(calls,['/api/assignment-workspace/v2/task?session_id=session-1&assignment_id=older-paused','/api/assignment-workspace/v2?session_id=session-1&limit=30']);
});

test("display preserves blocked, partial and uncertain canonical outcomes", () => {
  for (const outcome of ["active", "awaiting_user_input", "awaiting_user_review", "blocked", "failed", "complete_with_issues"]) {
    const publication = fixture();
    publication.snapshot.outcome = outcome;
    publication.snapshot.terminal = ["blocked", "failed", "complete_with_issues"].includes(outcome);
    publication.snapshot.unresolved_unknown_operation_ids = ["unsettled-write"];
    const view = assignmentWorkspaceGoalV2(publication);
    assert.equal(view.status, outcome);
    assert.equal(view._projection.truth.reconciliation_required, true);
  }
});

async function appFunction(name, nextName, context) {
  if (name === "syncComputerState") context.fetchJsonWithTimeout = context.fetchJson;
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\n${nextName}`, start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(`${source.slice(start, end)}; ${name}`, context);
}

async function resetHarness(saveDraft) {
  const state = { sessionId: "old-session", resetting: false, streaming: false, captureState: {},
    activeGoalId: "old-task", goals: [{ id: "old-task" }], backendMessages: ["old message"],
    pendingAttachments: ["draft attachment"], computerSyncRequestId: 0, goalsSyncRequestId: 0,
    verifiedWorkPacketRequestId: 0, workReturn: { old: true } };
  const elements = { promptInput: { value: "draft text", focus() {} }, screenImage: { removeAttribute() {} } };
  const persistedDrafts = [];
  const noop = () => {};
  let status = "";
  let sent = 0;
  const context = { state, elements, fetchJson: () => { throw Error("Opening a new chat must not reset or stop another task"); }, updateControls: noop, setStatus: value => { status = value; },
    persistComposerDraft: async () => { const draft = { text: elements.promptInput.value, attachments: [...state.pendingAttachments] }; if (!await saveDraft()) return false; persistedDrafts.push(draft); return true; },
    composerDraftRevision: 0, document: { querySelector: () => ({ close() {} }) },
    setStreaming: value => { state.streaming = value; }, restoreComposerDraft: async () => {}, restoreConversationHistory: async () => {}, syncTaskNavigation: async () => {},
    showComposerNotice: noop, renderAttachStrip: noop, applyDesktopPreviewCaptureState: noop, setSession: value => { state.sessionId = value; },
    renderGoalPanel: noop, renderWorkReturnPanel: noop, renderTaskHistory: noop, syncGoals: async () => {}, renderMessages: noop,
    renderEvents: noop, renderRunSummary: noop, renderScreenMeta: noop, updateFeedbackBarVisibility: noop,
    createChatSubmission: () => { sent += 1; return null; } };
  // Extract the two actual navigation functions, not every intervening helper:
  // including syncTaskNavigation here shadows the controlled async dependency
  // and starts unrelated background polling after this test has finished.
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const resetSource = source.slice(source.indexOf("async function resetCurrentMode("), source.indexOf("function initializeFreshConversation("));
  const openSource = source.slice(source.indexOf("async function openTaskConversation("), source.indexOf("function showTaskCatalogue("));
  assert.ok(resetSource.includes("return openTaskConversation(null)"));
  assert.ok(openSource.includes("await persistComposerDraft()"));
  const reset = runInNewContext(resetSource + openSource + "; resetCurrentMode", context);
  const send = await appFunction("sendPrompt", "function applySidecarConfig", context);
  return { state, elements, persistedDrafts, reset, send, status: () => status, sent: () => sent };
}

test("New Chat fences Send and old polls until the current draft is durably saved", async () => {
  let finish;
  let calls = 0;
  const h = await resetHarness(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.reset();
  assert.equal(h.state.resetting, true);
  await h.send("What size is this?");
  await h.reset();
  assert.equal(h.sent(), 0, "no submission can capture the old session during reset");
  assert.equal(calls, 1);
  assert.equal(h.state.computerSyncRequestId, 0);
  assert.equal(h.state.goalsSyncRequestId, 0);
  finish(true);
  await pending;
  assert.equal(h.state.sessionId, "");
  assert.equal(h.state.activeGoalId, "");
  assert.equal(h.state.backendMessages.length, 0);
  assert.equal(h.state.workReturn, null);
  assert.equal(h.state.resetting, false);
  assert.equal(h.state.computerSyncRequestId, 1);
  assert.equal(h.state.goalsSyncRequestId, 1);
  assert.deepEqual(h.persistedDrafts, [{ text: "draft text", attachments: ["draft attachment"] }]);
});

test("failed New Chat preserves the conversation and reports the error with retry enabled", async () => {
  const h = await resetHarness(async () => { throw new Error("Draft storage unavailable"); });
  await h.reset();
  assert.equal(h.state.sessionId, "old-session");
  assert.equal(h.state.backendMessages[0], "old message");
  assert.equal(h.state.pendingAttachments[0], "draft attachment");
  assert.equal(h.elements.promptInput.value, "draft text");
  assert.deepEqual(h.persistedDrafts, []);
  assert.equal(h.state.resetting, false);
  assert.match(h.status(), /Draft storage unavailable/);
});

test("computer and assignment polling cannot enter or publish while New Chat is resetting", async () => {
  for (const [name, nextName, counter] of [["syncComputerState", "async function syncNotifications", "computerSyncRequestId"],
    ["syncGoals", "function scheduleGoalsPolling", "goalsSyncRequestId"]]) {
    const state = { resetting: true, [counter]: 0 };
    const sync = await appFunction(name, nextName, { state });
    await sync();
    assert.equal(state[counter], 0);
  }
  let finish;
  const state = { resetting: false, computerSyncRequestId: 0 };
  const sync = await appFunction("syncComputerState", "async function syncNotifications", {
    state, fetchJson: () => new Promise(resolve => { finish = resolve; })
  });
  const pending = sync();
  state.resetting = true;
  finish({ running: true, backendSessionId: "old-session" });
  await pending;
  assert.equal(state.sessionId, undefined, "an already pending response cannot resurrect the old session");
});

test("idle computer polling cannot clear a running backend stream", async () => {
  const state = { computerSyncRequestId: 0, activeRunKind: "backend", streaming: true };
  const sync = await appFunction("syncComputerState", "async function syncNotifications", {
    state, fetchJson: async () => ({ running: false, messages: [], progress: null })
  });
  await sync();
  assert.equal(state.streaming, true);
  assert.equal(state.activeRunKind, "backend");
});

test("assignment polling selects the canonical current-session result and discards old-session responses", async () => {
  const canonical = assignmentWorkspaceGoalV2(fixture());
  const state = { goalsSyncRequestId: 0, sessionId: "session-1", streaming: true, activeGoalId: "", goals: [] };
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const policy = source.match(/\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_START([\s\S]*?)\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_END/)[1];
  const helpers = runInNewContext(`${policy}; ({ assignmentProjectionToGoalView, chooseCurrentAssignment, assignmentIsNewer })`);
  let rendered = 0;
  let changeSession = false;
  const sync = await appFunction("syncGoals", "function scheduleGoalsPolling", {
    ...helpers, state, URLSearchParams, Set, retainNewerAssignmentViewsV2,
    refreshAssignmentRevitContext: async options => { assert.equal(options.cachedOnly,true); return state.assignmentRevitContext; },
    fetchJson: async path => {
      if (changeSession) state.sessionId = "new-chat";
      return { assignments: path.startsWith("/api/assignment-workspace/v2?") ? [canonical]
        : [{ id: "old", related_session_id: "foreign", updated_at: "2099-01-01" }] };
    },
    renderGoalPanel: () => { rendered += 1; }, renderCompactWork() {},
    selectedGoal: () => state.goals.find(goal => goal.id === state.activeGoalId),
    syncVerifiedWorkPacket: async goal => { assert.equal(goal.id, "goal:inventory"); }
  });
  await sync();
  assert.equal(state.activeGoalId, "goal:inventory");
  assert.equal(rendered, 1);
  changeSession = true;
  await sync();
  assert.equal(rendered, 1);
  assert.equal(helpers.chooseCurrentAssignment(state.goals, null, ""), null);
});

test("accepted answer continues once while older concurrent status polls finish out of order", async t => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const extract = (first, last) => source.slice(source.indexOf(first), source.indexOf(last, source.indexOf(first)));
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; }
    append(...v) { this.children.push(...v); } appendChild(v) { this.children.push(v); }
    replaceChildren() { this.children = []; } setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const binding = { assignment_id: "inventory", session_id: "session-1", run_id: "run-1", generation: 1 };
  const old = { id: "goal:inventory", _sourceKind: "assignment_kernel_v2", _sourceRecordId: "inventory", _bindingV2: binding,
    _assignmentVersion: 7, _canResume: false, _pendingInputs: [{ clarification_id: "airflow", variable_id: "cfm", question: "Supply and return CFM?" }] };
  const state = { sessionId: "session-1", goals: [old], activeGoalId: old.id, goalsSyncRequestId: 0, goalSelectionPinned: false, streaming: false };
  const calls = [], resumed = [], pending = [], statuses = []; const container = new Element();
  const transport = await browserControlTransport(t, calls);
  let releaseAnswer; let answerReady;
  const ready = new Promise(resolve => { answerReady = resolve; });
  const context = { URLSearchParams, Promise, state, elements: { assignmentInputs: container },
    document: { createElement: () => new Element() }, selectedGoal: () => state.goals.find(g => g.id === state.activeGoalId),
    createAssignmentInputControl, assignmentInputErrorText,
    acceptAssignmentMutationViewV2, retainNewerAssignmentViewsV2, refreshAssignmentRevitContext: async () => ({}),
    assignmentProjectionToGoalView: v => v, chooseCurrentAssignment: goals => goals[0], assignmentIsNewer: () => false,
    syncVerifiedWorkPacket: async () => {}, renderGoalPanel() {}, setStatus: text => statuses.push(text),
    runGoalControl: async (action, exactBinding) => resumed.push({ action, binding: JSON.parse(JSON.stringify(exactBinding)) }),
    fetchJson: async (route, options) => {
      if (route.endsWith("/input")) { const response = await transport(route, options); answerReady(); return new Promise(resolve => { releaseAnswer = () => resolve(response); }); }
      return new Promise(resolve => pending.push({ route, resolve }));
    } };
  const functions = runInNewContext(extract("async function syncGoals()", "function scheduleGoalsPolling()") + "\n"
    + extract("function renderAssignmentInputsV2(", "async function runGoalControl(") + "; ({syncGoals, renderAssignmentInputsV2})", context);
  functions.renderAssignmentInputsV2(old);
  const firstPoll = functions.syncGoals();
  const form = container.children[0]; form.children[0].children[0].value = "450 CFM supply; 450 CFM return; exhaust remains 0";
  const submitted = form.listeners.submit({ preventDefault() {} }); await ready;
  const secondPoll = functions.syncGoals();
  assert.equal(pending.length, 4); releaseAnswer(); await submitted;
  assert.deepEqual(resumed, [{ action: "resume", binding }]);
  for (const row of [...pending].reverse()) row.resolve({ assignments: row.route.startsWith("/api/assignment-workspace") ? [old] : [] });
  await Promise.all([firstPoll, secondPoll]);
  assert.equal(state.goals[0]._assignmentVersion, 8); assert.equal(state.goals[0]._pendingInputs.length, 0);
  assert.equal(calls.length, 1); assert.equal(resumed.length, 1);
  assert.ok(!statuses.some(text => /remaining task questions/.test(text)));
});
