import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadPolicy() {
  const source = await readFile(path.join(appDir, "public", "app.js"), "utf8");
  const match = source.match(/\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_START([\s\S]*?)\/\/ TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_END/);
  assert.ok(match?.[1], "assignment workspace policy must remain independently testable");
  return runInNewContext(`${match[1]}; ({ runtimeProfilePresentation, goalProgressPresentation, goalStatusPresentation, assignmentProjectionToGoalView, assignmentContextPresentation, assignmentIsActionable, chooseCurrentAssignment, assignmentIsNewer })`);
}

test("runtime profile copy distinguishes general-agent, unavailable, and offline states", async () => {
  const policy = await loadPolicy();
  const general = { ...policy.runtimeProfilePresentation({ general_agent: true, project_queries: true }, true) };
  assert.equal(general.key, "general_agent_laboratory");
  assert.equal(general.projectQueries, true);
  assert.equal(general.label, 'Service connected');
  assert.match(general.summary, /local service/i);
  assert.match(general.summary, /permissions are checked when a task starts/i);

  const hosted = { ...policy.runtimeProfilePresentation({ key: "general_agent", general_agent: true, project_queries: true }, true) };
  assert.equal(hosted.key, "general_agent");
  assert.equal(hosted.label, "Service connected");
  assert.match(hosted.summary, /Connected to BIMTools/i);

  const unavailable = { ...policy.runtimeProfilePresentation({ key: "general_agent_unavailable", general_agent: false }, true) };
  assert.equal(unavailable.key, "general_agent_unavailable");
  assert.equal(unavailable.projectQueries, false);
  assert.match(unavailable.summary, /No Revit task will be started/i);

  const offline = { ...policy.runtimeProfilePresentation({ general_agent: true, project_queries: true }, false) };
  assert.equal(offline.key, "offline");
  assert.equal(offline.projectQueries, false);
});

test("assignment progress comes only from durable work-item state", async () => {
  const policy = await loadPolicy();
  const advisory=policy.goalProgressPresentation({_projection:{progress:{basis:'actor_work_plan',total:1,reported:1,checked:1}}});
  assert.equal(advisory.percent,null);assert.equal(advisory.completed,0);
  assert.match(advisory.text,/1 of 1 work items reported done/);assert.match(advisory.text,/Not independently verified/);
  const handoff=policy.goalProgressPresentation({_projection:{progress:{basis:'review_handoff'}}});
  assert.equal(handoff.percent,null);assert.equal(handoff.completed,0);assert.match(handoff.text,/Result ready for review/);
  const noPlan = { ...policy.goalProgressPresentation({ work_items: [] }) };
  assert.equal(noPlan.percent, null);
  assert.equal(noPlan.text, "No plan yet");

  const progress = { ...policy.goalProgressPresentation({
    work_items: [
      { status: "complete" },
      { status: "skipped" },
      { status: "in_progress" },
      { status: "pending" }
    ]
  }) };
  assert.equal(progress.completed, 2);
  assert.equal(progress.total, 4);
  assert.equal(progress.percent, 50);
  assert.equal(progress.text, "2 of 4 steps complete");
});

test("canonical assignment projection drives lifecycle, plan, evidence, and source controls", async () => {
  const policy = await loadPolicy();
  const view = policy.assignmentProjectionToGoalView({
    schema: "revit-operator.assignment-projection/v1",
    id: "goal:g-1",
    source_kind: "goal",
    source_record_id: "g-1",
    title: "Inspect HVAC",
    objective: "Inspect the HVAC model",
    lifecycle: { phase: "inspecting", source_status: "active", current_step: "Counting terminals", summary: "Working" },
    plan: { steps: [{ id: "count", title: "Count terminals", status: "in_progress" }] },
    progress: { determinate: true, total: 1, completed: 0, skipped: 0, ratio: 0 },
    evidence: { entries: [{ id: "e-1", kind: "evidence", ts: "2026-08-11T00:00:00Z", summary: "Queried model" }] },
    verification: { state: "unknown", criteria: [], notes: [] },
    approvals: [], artifacts: [], blockers: [], updated_at: "2026-08-11T00:00:00Z"
  });
  assert.equal(view.id, "goal:g-1");
  assert.equal(view._sourceRecordId, "g-1");
  assert.equal(view._assignmentPhase, "inspecting");
  assert.equal(view.work_items.length, 1);
  assert.equal(view.evidence_log.length, 1);
  assert.equal(policy.goalStatusPresentation(view).label, "Inspecting model");
});

test("assignment target and truth prevent stale or uncertain resume", async () => {
  const policy = await loadPolicy();
  const current = { available: true, document_fingerprint: "snowdon-hvac", document_title: "Snowdon Towers Sample HVAC" };
  const matching = {
    _projection: {
      target: { document_fingerprint: "snowdon-hvac", document_title: "Snowdon Towers Sample HVAC" },
      truth: { stale: false, outcome_uncertain: false, reconciliation_required: false }
    }
  };
  const verified = { ...policy.assignmentContextPresentation(matching, current) };
  assert.equal(verified.targetKnown, true);
  assert.equal(verified.wrongTarget, false);
  assert.equal(verified.selectableAsCurrent, true);
  assert.equal(verified.resumeBlocked, false);
  assert.equal(verified.reasons.length, 0);
  assert.equal(verified.label, "Target verified");

  const wrongModel = {
    _projection: {
      target: { document_fingerprint: "snowdon-architecture", document_title: "Snowdon Towers Sample Architecture" },
      truth: { stale: false, outcome_uncertain: false, reconciliation_required: false }
    }
  };
  const stale = { ...policy.assignmentContextPresentation(wrongModel, current) };
  assert.equal(stale.wrongTarget, true);
  assert.equal(stale.selectableAsCurrent, false);
  assert.equal(stale.resumeBlocked, true);
  assert.match(stale.reasons.join(" "), /does not match the assignment fingerprint/i);

  const unavailable = { ...policy.assignmentContextPresentation(matching, null) };
  assert.equal(unavailable.wrongTarget, false);
  assert.equal(unavailable.unverifiable, true);
  assert.equal(unavailable.selectableAsCurrent, false);
  assert.equal(unavailable.resumeBlocked, true);
  assert.equal(unavailable.label, "Target unverifiable");
  assert.match(unavailable.reasons.join(" "), /could not be verified/i);

  const wrongExecutor = {
    _projection: {
      target: { document_fingerprint: "snowdon-hvac", executor_id: "executor-old" },
      truth: {}
    }
  };
  const executorMismatch = { ...policy.assignmentContextPresentation(wrongExecutor, { ...current, executor_id: "executor-current" }) };
  assert.equal(executorMismatch.wrongTarget, true);
  assert.equal(executorMismatch.resumeBlocked, true);
  assert.match(executorMismatch.reasons.join(" "), /executor does not match/i);

  const uncertain = {
    _projection: {
      target: { document_fingerprint: "snowdon-hvac", document_title: "Snowdon Towers Sample HVAC" },
      truth: { stale: false, outcome_uncertain: true, reconciliation_required: true }
    }
  };
  const reconciliation = { ...policy.assignmentContextPresentation(uncertain, current) };
  assert.equal(reconciliation.selectableAsCurrent, true);
  assert.equal(reconciliation.resumeBlocked, true);
  assert.match(reconciliation.label, /reconciliation/i);
});

test("current assignment selection recognizes task phases and skips another model", async () => {
  const policy = await loadPolicy();
  const current = { available: true, document_fingerprint: "snowdon-hvac", document_title: "Snowdon Towers Sample HVAC" };
  const goals = [
    {
      id: "goal:old",
      status: "active",
      _assignmentPhase: "paused",
      _projection: { target: { document_fingerprint: "other-model" }, truth: {} }
    },
    {
      id: "task:current",
      status: "pending",
      _assignmentPhase: "applying",
      _projection: { target: { document_fingerprint: "snowdon-hvac" }, truth: {} }
    }
  ];
  assert.equal(policy.assignmentIsActionable(goals[1]), true);
  assert.equal(policy.chooseCurrentAssignment(goals, current).id, "task:current");
});

test("a newly completed verified assignment remains current ahead of older blocked history", async () => {
  const policy = await loadPolicy();
  const current = { available: true, document_fingerprint: "snowdon-hvac", document_title: "Snowdon Towers Sample HVAC" };
  const goals = [
    {
      id: "goal:new-complete",
      status: "complete",
      _assignmentPhase: "complete",
      _projection: { target: { document_fingerprint: "snowdon-hvac" }, truth: {} }
    },
    {
      id: "goal:old-blocked",
      status: "blocked",
      _assignmentPhase: "blocked",
      _projection: { target: { document_fingerprint: "snowdon-hvac" }, truth: {} }
    }
  ];
  assert.equal(policy.chooseCurrentAssignment(goals, current).id, "goal:new-complete");
});

test("a completed result stays visible after executor restart while resume remains stale", async () => {
  const policy = await loadPolicy();
  const current = {
    available: true,
    document_fingerprint: "snowdon-hvac",
    document_title: "Snowdon Towers Sample HVAC",
    executor_id: "executor-new"
  };
  const goals = [
    {
      id: "goal:new-complete",
      status: "complete",
      _assignmentPhase: "complete",
      _projection: { target: { document_fingerprint: "snowdon-hvac", executor_id: "executor-old" }, truth: {} }
    },
    {
      id: "goal:old-blocked",
      status: "blocked",
      _assignmentPhase: "blocked",
      _projection: { target: {}, truth: {} }
    }
  ];
  assert.equal(policy.assignmentContextPresentation(goals[0], current).resumeBlocked, true);
  assert.equal(policy.chooseCurrentAssignment(goals, current).id, "goal:new-complete");
});

test("a newer live result supersedes an older pinned history selection", async () => {
  const policy = await loadPolicy();
  const oldSelection = { id: "goal:old-blocked", updated_at: "2026-08-12T00:30:00Z" };
  const newResult = { id: "goal:new-complete", updated_at: "2026-08-12T02:30:00Z" };
  assert.equal(policy.assignmentIsNewer(newResult, oldSelection), true);
  assert.equal(policy.assignmentIsNewer(oldSelection, newResult), false);
});

test("assignment workspace is present, semantic, and progressively disclosed", async () => {
  const [html, source, css, server] = await Promise.all([
    readFile(path.join(appDir, "public", "index.html"), "utf8"),
    readFile(path.join(appDir, "public", "app.js"), "utf8"),
    readFile(path.join(appDir, "public", "styles.css"), "utf8"),
    readFile(path.join(appDir, "server.js"), "utf8")
  ]);

  assert.match(html, /id="runtimeProfileBadge"/);
  assert.match(html, /id="advancedPanel"[^>]*class="advancedPanel"/);
  assert.match(html, /id="assignmentPane"[^>]*aria-labelledby="assignmentHeading"/);
  assert.match(html, /id="assignmentContext"/);
  assert.match(html, /id="goalReturnCurrentButton"/);
  assert.match(html, /id="assignmentProgressBar"[^>]*role="progressbar"/);
  assert.match(html, /id="assignmentPlanList"/);
  assert.match(html, /id="verifiedWorkPacket"[^>]*aria-label="Verified work packet"/);
  assert.match(html, /id="verifiedWorkPacketContent"/);
  assert.match(html, /id="batchJobs"[^>]*aria-live="polite"/);
  assert.match(html, /id="evidenceDetails"[^>]*class="evidencePane"/);
  assert.match(html, /id="events"[^>]*role="log"[^>]*aria-live="polite"/);
  assert.match(html, /id="promptInput"[\s\S]{0,120}aria-label="Message Operator"/);
  assert.doesNotMatch(html, />YOLO</);

  assert.match(source, /scheduleGoalsPolling\(\)/);
  assert.match(source, /fetchJson\(`\/api\/assignments\?\$\{qs\.toString\(\)\}`\)/);
  assert.match(source, /syncVerifiedWorkPacket\(selectedGoal\(\)\)/);
  assert.match(source, /verified-work-packet/);
  assert.doesNotMatch(source, /qs\.set\("session_id", state\.sessionId\)/);
  assert.match(server, /app\.get\("\/api\/assignments"/);
  assert.match(server, /app\.get\("\/api\/assignments\/:assignmentId\/verified-work-packet"/);
  assert.match(server, /format === "markdown"/);
  assert.match(server, /readBackendJson\(`\/api\/assignments\?\$\{qs\.toString\(\)\}`/);
  assert.match(source, /void syncGoals\(\)\.catch/);
  assert.match(source, /void syncCaptureArtifacts\(\)\.catch/);
  assert.match(source, /state\.goalSelectionPinned = true/);
  assert.match(source, /execution\.requested_effect/);
  assert.match(source, /execution\.completion_mode === "verified_noop"/);
  assert.match(source, /verified no-op \(already satisfied\)/);
  assert.match(source, /chooseCurrentAssignment\(state\.goals, state\.assignmentRevitContext, state\.sessionId\)/);
  assert.match(source, /assignmentIsNewer\(current, explicit\)/);
  assert.match(source, /refreshAssignmentRevitContext\(\)/);
  assert.match(source, /refreshAssignmentDisplayContext\(state, fetchJson, assignmentRevitContextFromHealth, \{ cachedOnly \}\)/);
  assert.match(source, /const contextRefresh = refreshAssignmentRevitContext\(\{ cachedOnly: true \}\)/);
  assert.equal(await readFile(path.join(appDir,'public','assignment_display_context.mjs'),'utf8'),await readFile(path.join(appDir,'..','..','packages','operator-assistant-ui','assignment_display_context.mjs'),'utf8'));
  assert.match(source, /function scheduleBatchJobsPolling\(\)[\s\S]{0,520}if \(state\.streaming\) return;/);
  assert.match(source, /contextPresentation\.resumeBlocked/);
  assert.match(source, /projection\?\.truth/);
  assert.match(source, /projection\?\.target/);
  assert.match(source, /state\.activeGoalId = "";[\s\S]{0,120}state\.goalSelectionPinned = false/);
  assert.match(source, /const row = document\.createElement\("button"\)/);
  assert.match(source, /elements\.runProgressBar\.removeAttribute\("aria-valuenow"\)/);
  assert.doesNotMatch(source, /percent = 12/);

  assert.match(css, /\.assignmentCompact:not\(\[hidden\]\)/);
  assert.match(css, /\.assignmentPane\.quickAssignment/);
  assert.match(css, /\.verifiedWorkPacket/);
  assert.match(css, /\.workPacketTableWrap/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
});

test("restart recovery preserves the durable assignment session and resumes from its checkpoint", async () => {
  const source = await readFile(path.join(appDir, "public", "app.js"), "utf8");
  assert.match(source, /payload\.running \|\| state\.activeRunKind === "computer"/);
  assert.match(source, /Resume the active assignment from its durable checkpoint/);
  assert.match(source, /\/api\/chat\/stop/);
});
