import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import express from "express";
import { parseAssignmentKernelPublicationV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { assignmentWorkspaceGoalV2 } from "../assignment_workspace_v2.js";
import { acceptAssignmentMutationViewV2, retainNewerAssignmentViewsV2 } from "../assignment_mutation.mjs";
import * as assignmentMutation from "../assignment_mutation.mjs";
import { createAssignmentInputControl, assignmentInputErrorText } from "../assignment_input_controls.mjs";
import { createBrowserAssetFreshness } from "../browser_asset_freshness.js";
import { assertLoadedBrowserFresh } from "../public/browser_asset_freshness_ui.js";
import { parseTaskNavigation, currentTaskState, groupTasks, taskStateLabel } from "../public/task_navigation.mjs";
import { refreshAssignmentDisplayContext } from "../public/assignment_display_context.mjs";
import {acknowledgedComputerPause} from '../saved_computer_assignment.mjs';
import {routeSavedChatSubmission} from '../public/composer_intake.mjs';

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function body(name, isAsync = false) {
  const start = source.indexOf(`${isAsync ? "async " : ""}function ${name}(`);
  assert.ok(start >= 0, name); return source.slice(start, source.indexOf("\n}\n", start) + 2);
}
function fixture(mode = "chatgpt") {
  const binding = { assignment_id: "held-task", session_id: "same-conversation", run_id: "same-run", generation: 1, principal_id: "local:test", document_fingerprint: "same-model" };
  const budget = { max_reasoning_turns: 50, max_provider_calls: 100, max_operations: 200, max_equivalent_operations: 3,
    max_no_progress_epochs: 4, max_reconciliation_attempts: 2, max_wall_clock_ms: 600000, max_total_tokens: 100000 };
  const hold = { schema: "revit-operator.provider-usage-hold/v1", hold_id: "usage-hold-1", binding: { ...binding }, attempt_id: "issued-attempt",
    provider_thread_id: "provider-thread", provider_turn_id: "provider-turn", code: "usageLimitExceeded", recorded_at: "2026-09-27T16:01:00Z", resume_budget: budget,
    worker_identity: { provider: "openai_codex", configured_billing_mode: mode, requested_model: "gpt-6-astra", requested_reasoning_effort: "medium", reported_model: null, reported_model_source: null } };
  return { schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: binding.assignment_id, assignment_version: 7,
    snapshot: { schema: "revit-operator.assignment-snapshot/v2", assignment_version: 7, current_binding: binding,
      spec: { binding: { ...binding }, source_user_request: "Continue the existing drafting task", requested_effect: "apply", created_at: "2026-09-27T16:00:00Z", criteria: [], work_units: [] },
      outcome: "active", terminal: false, quiescent: true, provider_usage_hold: hold, provider_call_ids: [], provider_calls: {}, in_flight_provider_call_ids: [],
      operations: {}, observations: {}, criteria: {}, work_unit_states: {}, unresolved_unknown_operation_ids: [], in_flight_operation_ids: [],
      pending_input_variable_ids: [], pending_review_ids: [], clarifications: {} },
    provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: binding.assignment_id, run_id: binding.run_id, generation: binding.generation, call_ids: [], calls: {}, in_flight_call_ids: [] } };
}
function controlBinding(publication) { const b = publication.snapshot.current_binding; return Object.fromEntries(["assignment_id", "session_id", "run_id", "generation"].map(key => [key, b[key]])); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

for (const mode of ["chatgpt", "api_key", "unknown"]) test(`safe ${mode} held attempt survives publication and workspace without inventing response receipts`, () => {
  const p = fixture(mode), parsed = parseAssignmentKernelPublicationV2(p), view = assignmentWorkspaceGoalV2(parsed);
  assert.equal(view._assignmentPhase, "waiting_for_usage"); assert.equal(view._canResume, true); assert.equal(view._canPause, true);
  assert.equal(view._providerUsageHold.hold_id, "usage-hold-1"); assert.equal(view._providerUsageHold.worker_identity.configured_billing_mode, mode);
  assert.equal(view.updated_at, "2026-09-27T16:01:00Z"); assert.match(view.current_step, /model changes may be unsaved/);
  assert.equal(parsed.provider_ledger.call_ids.length, 0); assert.equal(parsed.snapshot.provider_usage_hold.worker_identity.reported_model, null);
  const expected = { chatgpt: /configured ChatGPT sign-in/, api_key: /configured API-key login/, unknown: /unconfirmed account mode/ }[mode];
  assert.match(view.current_step, expected); assert.doesNotMatch(view.current_step, /prepaid|restored|billing balance|saved to disk/i);
  p.snapshot.provider_usage_hold.worker_identity.requested_model = "changed-after-projection";
  assert.equal(view._providerUsageHold.worker_identity.requested_model, "gpt-6-astra");
});

test("old no-hold publications stay valid; malformed or foreign holds fail closed at parser and workspace", () => {
  const old = fixture(); delete old.snapshot.provider_usage_hold; assert.equal(assignmentWorkspaceGoalV2(parseAssignmentKernelPublicationV2(old)).status, "active");
  for (const mutate of [
    h => { h.code = "rateLimitExceeded"; }, h => { h.hold_id = ""; }, h => { h.provider_turn_id = "bad\nturn"; },
    h => { h.binding.document_fingerprint = "foreign"; }, h => { h.binding.principal_id = "someone-else"; },
    h => { h.binding.generation = 2; }, h => { h.attempt_id = "a".repeat(257); }, h => { h.recorded_at = "not-a-date"; },
    h => { h.resume_budget.max_provider_calls = -1; }, h => { delete h.resume_budget.max_total_tokens; },
    h => { h.worker_identity.api_key = "do-not-publish"; }, h => { h.worker_identity.auth_path = "private-path"; },
    h => { h.worker_identity.reported_model = "fallback-is-not-reported"; }, h => { h.worker_identity.reported_model_source = "requested_fallback"; },
    h => { h.worker_identity.requested_reasoning_effort = "unknown-effort"; }, h => { h.diagnostic = "raw secret-bearing error"; },
    h => { h.hold_id = "h".repeat(241); }, h => { h.provider_turn_id = "bad\u007fturn"; },
    h => { h.resume_budget.max_provider_calls = 0; }, h => { h.resume_budget.max_wall_clock_ms = 2_147_483_648; },
    ...["requested_model", "reported_model"].flatMap(key => ["<model>", "gpt 6", "bad\u007fmodel", "m".repeat(161)].map(value => h => {
      h.worker_identity[key] = value;
      if (key === "reported_model") h.worker_identity.reported_model_source = "raw_response";
    }))
  ]) {
    const p = fixture(); mutate(p.snapshot.provider_usage_hold);
    assert.throws(() => parseAssignmentKernelPublicationV2(p), /provider_usage_hold/);
    assert.throws(() => assignmentWorkspaceGoalV2(p), /provider_usage_hold/);
  }
});

test("settling, unknown effects, independent Pause and pending questions retain precedence over Resume", () => {
  const p = fixture(); p.snapshot.quiescent = false; p.snapshot.in_flight_operation_ids = ["admitted-write"];
  let v = assignmentWorkspaceGoalV2(p); assert.equal(v.status, "stopping_after_usage_limit"); assert.equal(v._canResume, false); assert.equal(v._canRecover, true);
  p.snapshot.unresolved_unknown_operation_ids = ["uncertain-write"];
  v = assignmentWorkspaceGoalV2(p); assert.equal(v.status, "outcome_uncertain"); assert.equal(v._canResume, false);
  assert.equal(currentTaskState({ state: "waiting_for_usage" }, v, "same-conversation"), "unknown");
  p.snapshot.unresolved_unknown_operation_ids = []; p.snapshot.quiescent = true; p.snapshot.in_flight_operation_ids = [];
  p.snapshot.execution_control = { state: "paused", command_id: "pause-user", changed_at: "2026-09-27T16:02:00Z" };
  v = assignmentWorkspaceGoalV2(p); assert.equal(v.status, "paused"); assert.equal(v._providerUsageHold.hold_id, "usage-hold-1"); assert.match(v.current_step, /also paused/);
  p.snapshot.pending_input_variable_ids = ["answer"]; assert.equal(assignmentWorkspaceGoalV2(p)._canResume, false);
  p.snapshot.pending_input_variable_ids = []; p.snapshot.pending_review_ids = ["review"]; assert.equal(assignmentWorkspaceGoalV2(p)._canResume, false);
});

function element() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, replaceChildren() {}, appendChild() {}, addEventListener() {} }; }
function renderHarness(goal) {
  const elements = new Proxy({}, { get(target, key) { return target[key] ||= element(); } });
  const state = { streaming: false, goals: [], taskNavigation: [{ session_id: goal._bindingV2.session_id, state: "ready" }], sessionId: goal._bindingV2.session_id, assignmentRevitContext: { document_fingerprint: goal._projection.target.document_fingerprint } };
  const nodes = new Map(); const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); }, createElement: () => element() };
  const code = ["assignmentContextPresentation", "goalStatusPresentation", "goalProgressPresentation", "goalStatusLabel", "renderGoalPanel", "renderCompactWork"].map(name => body(name)).join("\n");
  const context = { state, elements, document, selectedGoal: () => goal, currentTaskState, taskStateLabel,
    escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    renderVerifiedWorkPacketPanel() {}, renderAssignmentInputsV2() {}, renderRunSummary() {}, compactWorkSummary: () => "" };
  return { ...runInNewContext(code + ";({renderGoalPanel,renderCompactWork})", context), elements, state, nodes, context };
}

test("actual task UI keeps held work visible and distinguishes configured/requested from provider-reported model", () => {
  const p = fixture(), v = assignmentWorkspaceGoalV2(p), h = renderHarness(v); h.renderGoalPanel(); h.renderCompactWork();
  assert.equal(h.elements.assignmentStatus.textContent, "Waiting for usage"); assert.equal(h.elements.assignmentCompact.hidden, false);
  assert.match(h.elements.goalSummary.innerHTML, /Configured ChatGPT sign-in/); assert.match(h.elements.goalSummary.innerHTML, /Requested model: gpt-6-astra/);
  assert.doesNotMatch(h.elements.goalSummary.innerHTML, /Provider-reported model/);
  h.state.streaming = true; h.state.agentProgress = "Making more changes"; h.renderCompactWork();
  assert.equal(h.elements.assignmentCompactStep.textContent, "Waiting for usage", "a retained hold outranks stale worker progress");
  h.state.streaming = false;
  p.snapshot.provider_usage_hold.worker_identity.reported_model = 'gpt-5.6-sol'; p.snapshot.provider_usage_hold.worker_identity.reported_model_source = "rerouted";
  const reported = renderHarness(assignmentWorkspaceGoalV2(p)); reported.renderGoalPanel();
  assert.match(reported.elements.goalSummary.innerHTML, /Provider-reported model: gpt-5.6-sol/);
  h.state.assignmentResumePending = "command"; h.renderGoalPanel(); h.renderCompactWork();
  assert.equal(h.elements.goalResumeButton.disabled, "command"); assert.equal(h.nodes.get("#taskResumeButton").disabled, true);
});

test("task navigation accepts both usage states, keeps waiting in Needs you and old polls cannot resurrect a hold", () => {
  const p = fixture(), waiting = assignmentWorkspaceGoalV2(p);
  const tasks = parseTaskNavigation({ schema: "revit-operator.task-navigation/v1", tasks: [
    { task_id: "a", session_id: "other", assignment_id: "task-a", title: "Held work", state: "waiting_for_usage", summary: "Retained", updated_at: "2026-09-27T16:01:00Z" },
    { task_id: "b", session_id: "next", assignment_id: "task-b", title: "Settling", state: "stopping_after_usage_limit", summary: "Settling", updated_at: "2026-09-27T16:01:00Z" }
  ] });
  const groups = groupTasks(tasks); assert.equal(groups.find(g => g.title === "Working").items[0].task_id, "b"); assert.equal(groups.find(g => g.title === "Needs you").items[0].task_id, "a");
  assert.equal(currentTaskState({ state: "ready" }, waiting, "same-conversation"), "waiting_for_usage");
  delete p.snapshot.provider_usage_hold; p.assignment_version = p.snapshot.assignment_version = 8; const released = assignmentWorkspaceGoalV2(p);
  assert.equal(retainNewerAssignmentViewsV2([waiting], [released])[0], released);
});

async function controlHarness(t, options = {}) {
  const publication = options.publication ? clone(options.publication) : fixture(), initialVersion = publication.assignment_version;
  const state = { sessionId: publication.snapshot.current_binding.session_id, streaming: false, assignmentRevitContext: null }, calls = [], sent = [], statuses = [], healthRequests = [], executorRequests = [];
  let goal = assignmentWorkspaceGoalV2(publication);
  state.goals = [goal];
  const app = express(); app.use(express.json()); const freshness = createBrowserAssetFreshness(fileURLToPath(new URL("../public", import.meta.url))); app.use(freshness.middleware);
  app.post("/api/assignment-workspace/v2/executor", (req, res) => {
    assert.deepEqual(req.body, controlBinding(publication), "Executor discovery must retain the exact acknowledged task.");
    executorRequests.push(clone(req.body));
    res.json(options.executorResponse ?? { ok: true, executor: "backend", binding: controlBinding(publication) });
  });
  app.get("/api/revit/health", async (req, res) => {
    healthRequests.push({ prefer_cached: req.query.prefer_cached ?? null }); await options.onHealth?.();
    if (options.healthFailure) return res.status(502).json({ error: "Native health unavailable" });
    res.json(options.health ?? { ok: true, context: { document: { title: "Disposable model", projectIdentity: { fingerprint: publication.snapshot.current_binding.document_fingerprint } } } });
  });
  const start = serverSource.indexOf('function interruptPausedComputerOwner(');
  const route = serverSource.slice(start, serverSource.indexOf('app.get("/api/assignments",', start));
  runInNewContext(route, { app, computerState:{running:false}, acknowledgedComputerPause,
    updateComputerProgress:()=>{throw Error('Resume must not interrupt an active owner');},addComputerEvent:()=>{},
    acknowledgeAssignmentControlV2: assignmentMutation.acknowledgeAssignmentControlV2, assignmentWorkspaceGoalV2, readBackendJson: async (path, request) => {
    if (request.method === "GET") {
      assert.equal(path, `/api/assignments/v2/${publication.assignment_id}`);
      await options.onExactRead?.(publication);
      return { assignment_kernel_v2: clone(publication) };
    }
    assert.equal(path, "/api/assignments/v2/execution-control"); const command = JSON.parse(request.body); calls.push(command); await options.onPost?.(command);
    publication.assignment_version = publication.snapshot.assignment_version = initialVersion + 1;
    delete publication.snapshot.provider_usage_hold;
    publication.snapshot.execution_control = { state: "running", command_id: command.command_id, changed_at: "2026-09-27T16:02:00Z" };
    const result = { ok: true, assignment_snapshot_v2: clone(publication.snapshot) }; options.onAck?.(result); return result;
  }, sendJsonError: (res, error) => res.status(409).json({ error: error.message }) });
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const localFetch = (url, request) => fetch(`http://127.0.0.1:${server.address().port}${url}`, request), loadedBrowserIdentity = freshness.snapshot().identity;
  const fetchStart = source.indexOf("async function fetchJson(");
  const fetchJson = runInNewContext(source.slice(fetchStart, source.indexOf("// TESTABLE_EXECUTION_ADMISSION_PRESENTATION_START", fetchStart)) + ";fetchJson", { fetch: localFetch, loadedBrowserIdentity });
  let commandCount = 0;
  const code = ["runCanonicalGoalControl", "resumeCanonicalAssignment", "runGoalControl", "refreshAssignmentRevitContext"].map(name => body(name, true)).join("\n")
    + "\n" + ["assignmentContextPresentation", "assignmentRevitContextFromHealth"].map(name => body(name)).join("\n");
  const context = { state, fetchJson, refreshAssignmentDisplayContext, loadedBrowserIdentity, routeSavedChatSubmission, assertLoadedBrowserFresh: identity => assertLoadedBrowserFresh(identity, localFetch),
    crypto: { randomUUID: () => "resume-" + ++commandCount }, selectedGoal: () => goal, setStatus: text => statuses.push(text),
    async syncGoals() { options.onSync?.(publication); if (options.supersededPoll) return; goal = assignmentWorkspaceGoalV2(publication); state.goals = [goal]; },
    acceptAssignmentMutationViewV2(state, response, binding) { const accepted = acceptAssignmentMutationViewV2(state, response, binding); if (accepted) goal = accepted; return accepted; },
    createChatSubmission: (text, attachments) => ({ text, attachments, id: "same-chat-message" }),
    async sendBackendPrompt(submission) { sent.push(clone(submission)); }, showStaleComposerNotice() {}, renderGoalPanel() {} };
  const api = runInNewContext(code + ";({control:runCanonicalGoalControl,resume:runGoalControl})", context);
  return { state, calls, sent, statuses, healthRequests, executorRequests, publication, getGoal: () => goal, setGoal: value => { goal = value; }, ...api, context };
}

test("explicit Resume carries exact hold/version/document fences through real HTTP and continues same bound chat once", async t => {
  const h = await controlHarness(t), initial = h.getGoal(); await h.control(initial, "resume");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].expected_hold_id, "usage-hold-1"); assert.equal(h.calls[0].expected_assignment_version, 7);
  assert.equal(h.calls[0].expected_command_id, null); assert.equal(h.calls[0].document_fingerprint, "same-model");
  assert.deepEqual(h.sent[0].assignmentBindingV2, controlBinding(h.publication)); assert.equal(h.sent.length, 1); assert.equal(h.state.assignmentResumePending, false);
  assert.deepEqual(h.executorRequests, [controlBinding(h.publication)]);
});

test("a missing or foreign executor acknowledgement never starts the resumed provider", async t => {
  for (const response of [{ ok: false }, { ok: true, executor: "backend", binding: { ...controlBinding(fixture()), run_id: "foreign-run" } }]) {
    const h = await controlHarness(t, { executorResponse: response });
    await assert.rejects(h.control(h.getGoal(), "resume"), /executor could not be confirmed/);
    assert.equal(h.calls.length, 1, "The acknowledged control is retained; it is not replayed.");
    assert.equal(h.executorRequests.length, 1); assert.equal(h.sent.length, 0);
  }
});

test("accepted Resume uses its exact acknowledged view when background polling was superseded", async t => {
  const h = await controlHarness(t, { supersededPoll: true });
  await h.control(h.getGoal(), "resume");
  assert.equal(h.calls.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.getGoal()._assignmentVersion, h.publication.assignment_version);
  assert.equal(h.getGoal()._executionControl.command_id, h.calls[0].command_id);
  assert.deepEqual(h.sent[0].assignmentBindingV2, controlBinding(h.publication));
});

test("double Resume clicks do not issue another control while the first acknowledgement is pending", async t => {
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), posted = new Promise(resolve => { arrived = resolve; });
  const h = await controlHarness(t, { async onPost() { arrived(); await gate; } }), initial = h.getGoal();
  const first = h.control(initial, "resume"); await posted; const second = h.control(initial, "resume");
  release(); await Promise.all([first, second]); assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1);
});

test("changed or incomplete Resume acknowledgements never start a provider request", async t => {
  for (const mutate of [
    result => { delete result.assignment_snapshot_v2; }, result => { result.assignment_snapshot_v2.assignment_version = 7; },
    result => { result.assignment_snapshot_v2.current_binding.run_id = "other-run"; }, result => { result.assignment_snapshot_v2.current_binding.document_fingerprint = "other-model"; },
    result => { result.assignment_snapshot_v2.execution_control.command_id = "other-command"; }, result => { result.assignment_snapshot_v2.execution_control.state = "paused"; },
    result => { result.assignment_snapshot_v2.provider_usage_hold = { hold_id: "replacement" }; }, result => { result.assignment_snapshot_v2.quiescent = false; },
    result => { result.assignment_snapshot_v2.unresolved_unknown_operation_ids = ["uncertain"]; }, result => { result.assignment_snapshot_v2.pending_review_ids = ["review"]; }
  ]) {
    const h = await controlHarness(t, { onAck: mutate }); await assert.rejects(h.control(h.getGoal(), "resume"), /controls changed|Canonical task (mutation|acknowledgment)/); assert.equal(h.sent.length, 0);
  }
});

test("new Pause or replacement usage hold after acknowledgement prevents stale chat dispatch", async t => {
  for (const kind of ["pause", "hold"]) {
    const held = fixture().snapshot.provider_usage_hold;
    const h = await controlHarness(t, { onSync(p) {
      p.assignment_version = p.snapshot.assignment_version = 9;
      if (kind === "pause") p.snapshot.execution_control = { state: "paused", command_id: "later-pause", changed_at: "2026-09-27T16:03:00Z" };
      else p.snapshot.provider_usage_hold = { ...held, hold_id: "later-hold" };
    } });
    await assert.rejects(h.control(h.getGoal(), "resume"), /controls changed/); assert.equal(h.sent.length, 0);
  }
});

test("exact acknowledged refresh respects newer Pause and usage hold even if the normal poll is superseded", async t => {
  for (const kind of ["pause", "hold"]) {
    const held = fixture().snapshot.provider_usage_hold;
    const h = await controlHarness(t, { supersededPoll: true, onExactRead(publication) {
      publication.assignment_version = ++publication.snapshot.assignment_version;
      if (kind === "pause") publication.snapshot.execution_control = { state: "paused", command_id: "newer-pause", changed_at: "2026-09-27T16:03:00Z" };
      else publication.snapshot.provider_usage_hold = clone(held);
    } });
    await assert.rejects(h.control(h.getGoal(), "resume"), /controls changed/);
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0);
  }
});

test("last saved answer cannot automatically Resume a usage hold", async () => {
  class Element { constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ""; } append(...nodes) { this.children.push(...nodes); } appendChild(node) { this.children.push(node); } replaceChildren() { this.children = []; } setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; } }
  const p = fixture(); p.snapshot.pending_input_variable_ids = ["clarify"]; p.snapshot.clarifications = { clarify: { clarification_id: "clarify", variable_id: "clarify", question: "Which size?" } };
  const initial = assignmentWorkspaceGoalV2(p), state = { sessionId: "same-conversation", goalSelectionPinned: false, goals: [initial] }, container = new Element(), resumed = [];
  const render = runInNewContext(body("renderAssignmentInputsV2") + ";renderAssignmentInputsV2", { state, elements: { assignmentInputs: container },
    document: { createElement: () => new Element() }, selectedGoal: () => state.goals[0], createAssignmentInputControl, assignmentInputErrorText,
    acceptAssignmentMutationViewV2, renderGoalPanel() {}, setStatus() {}, runGoalControl: (...args) => resumed.push(args),
    async fetchJson() { p.assignment_version = p.snapshot.assignment_version = 8; p.snapshot.pending_input_variable_ids = []; p.snapshot.clarifications = {}; return { ok: true, assignment: assignmentWorkspaceGoalV2(p) }; }
  });
  render(initial); const form = container.children[0]; form.children[0].children[0].value = "Six inches"; await form.listeners.submit({ preventDefault() {} });
  assert.equal(state.goals[0]._canResume, true, "explicit Resume remains available"); assert.equal(resumed.length, 0, "saving an answer is not explicit Resume");
});

for (const kind of ["failure", "progress_blocker", "provider_budget_exhausted"]) test(`held task with independent ${kind} retains its blocker instead of inviting unusable Resume`, () => {
  const p = fixture();
  p.snapshot.outcome = kind === "progress_blocker" ? "blocked" : "failed";
  if (kind === "progress_blocker") p.snapshot.progress_blocker = { code: "no_progress_budget_exhausted", gap_ids: [], recorded_at: "2026-09-27T16:02:00Z" };
  if (kind === "provider_budget_exhausted") p.snapshot.provider_budget_exhausted = true;
  if (kind === "failure") { p.snapshot.execution_failure_ids = ["cleanup-failed"]; p.snapshot.execution_failures = { "cleanup-failed": {
    schema: "revit-operator.assignment-execution-failure/v2", failure_id: "cleanup-failed", binding: p.snapshot.current_binding,
    code: "assignment_runtime_failed", error_class: "runtime", phase: "response_handoff"
  } }; }
  const view = assignmentWorkspaceGoalV2(p), ui = renderHarness(view); ui.renderGoalPanel(); ui.renderCompactWork();
  assert.equal(view._assignmentPhase, p.snapshot.outcome); assert.equal(view._canResume, false);
  assert.equal(view._providerUsageHold.hold_id, "usage-hold-1");
  assert.equal(currentTaskState({ state: "waiting_for_usage" }, view, "same-conversation"), "failed");
  assert.match(view.current_step, /separate task issue/); assert.doesNotMatch(view.current_step, /Use Resume/);
  assert.ok(ui.elements.goalResumeButton.disabled); assert.equal(ui.nodes.get("#taskResumeButton").hidden, true);
  p.snapshot.execution_control = { state: "paused", command_id: "pause", changed_at: "2026-09-27T16:03:00Z" };
  assert.equal(assignmentWorkspaceGoalV2(p)._assignmentPhase, "paused"); assert.equal(assignmentWorkspaceGoalV2(p)._canResume, false);
  p.snapshot.quiescent = false; p.snapshot.in_flight_operation_ids = ["settling"];
  assert.equal(assignmentWorkspaceGoalV2(p)._assignmentPhase, "pausing");
  delete p.snapshot.execution_control;
  assert.equal(assignmentWorkspaceGoalV2(p)._assignmentPhase, "stopping_after_usage_limit");
  p.snapshot.unresolved_unknown_operation_ids = ["uncertain"];
  assert.equal(assignmentWorkspaceGoalV2(p)._assignmentPhase, "outcome_uncertain");
});

function coldCacheCompactResume(publication) {
  const view = assignmentWorkspaceGoalV2(parseAssignmentKernelPublicationV2(publication));
  const ui = renderHarness(view); ui.state.assignmentRevitContext = null; ui.renderCompactWork();
  return { view, ui, button: ui.nodes.get("#taskResumeButton") };
}
async function clickVisibleCompactResume(h) {
  const { ui, button } = coldCacheCompactResume(h.publication);
  let click;
  button.addEventListener = (name, handler) => { assert.equal(name, "click"); click = handler; };
  const line = source.split("\n").find(value => value.startsWith('document.querySelector("#taskResumeButton").addEventListener('));
  assert.ok(line, "the actual compact Resume click handler remains present");
  runInNewContext(line, { document: { querySelector: selector => { assert.equal(selector, "#taskResumeButton"); return button; } }, runGoalControl: h.resume, setStatus: text => h.statuses.push(text) });
  assert.equal(button.hidden, false, "a cold display cache must leave the fresh validation action reachable");
  assert.equal(button.disabled, false); await click(); return ui;
}

test("cold display cache keeps settled held-task compact Resume reachable without claiming target verification", () => {
  const p = fixture(), { view, ui, button } = coldCacheCompactResume(p);
  ui.renderGoalPanel();
  assert.equal(view._canResume, true); assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  assert.equal(ui.elements.assignmentStatus.textContent, "Target unverifiable");
  assert.equal(Boolean(ui.elements.goalResumeButton.disabled), true, "detailed control remains gated by display truth");
  assert.equal(p.snapshot.provider_usage_hold.hold_id, "usage-hold-1");
  ui.state.assignmentResumePending = "pending"; ui.renderCompactWork(); assert.equal(button.disabled, true);
  ui.state.assignmentResumePending = false; ui.state.streaming = true; ui.renderCompactWork(); assert.equal(button.hidden, true);
});

test("cold-cache visible Resume performs fresh health before exact held control and one same-chat continuation", async t => {
  const h = await controlHarness(t);
  await clickVisibleCompactResume(h);
  assert.deepEqual(h.healthRequests, [{ prefer_cached: null }]); assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1);
  assert.equal(h.calls[0].expected_hold_id, "usage-hold-1"); assert.equal(h.calls[0].expected_assignment_version, 7);
  assert.equal(h.calls[0].document_fingerprint, "same-model"); assert.deepEqual(h.sent[0].assignmentBindingV2, controlBinding(h.publication));
});

for (const neighbor of ["wrong-document", "health-failure", "unready-health"]) test(
  "cold-cache Resume remains non-dispatching after fresh " + neighbor, async t => {
    const options = neighbor === "health-failure" ? { healthFailure: true } : { health: neighbor === "unready-health" ? { ok: false, context: null }
      : { ok: true, context: { document: { title: "Other model", projectIdentity: { fingerprint: "wrong-model" } } } } };
    const h = await controlHarness(t, options), retained = clone(h.publication);
    await clickVisibleCompactResume(h);
    assert.deepEqual(h.healthRequests, [{ prefer_cached: null }]); assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0);
    assert.deepEqual(h.publication, retained); assert.match(h.statuses.at(-1), /Resume blocked:/);
  });

test("cold-cache Resume waits for fresh health before admitting any control or continuation", async t => {
  let arrived, release; const started = new Promise(resolve => { arrived = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const h = await controlHarness(t, { async onHealth() { arrived(); await barrier; } });
  const clicked = clickVisibleCompactResume(h);
  await Promise.race([started, clicked]);
  assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0); release(); await clicked;
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1);
});
for (const changed of ["session", "selected-task"]) test("fresh health cannot resume when " + changed + " changes during the read", async t => {
  let h; h = await controlHarness(t, { onHealth() { if (changed === "session") h.state.sessionId = "different-conversation";
    else h.setGoal({ ...h.getGoal(), _sourceRecordId: "different-task", _bindingV2: { ...h.getGoal()._bindingV2, assignment_id: "different-task" } }); } });
  const retained = clone(h.publication); await clickVisibleCompactResume(h);
  assert.equal(h.healthRequests.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0); assert.deepEqual(h.publication, retained);
});
