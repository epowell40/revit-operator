import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("feedback improvement jobs dedupe and keep GitHub issue linkage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-improvement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  delete process.env.AWS_EXECUTION_ENV;
  delete process.env.EC2_HOME;
  delete process.env.OPERATOR_AUTH_MODE;
  process.env.OPERATOR_DEV_MODE = "1";
  delete process.env.OPERATOR_FEEDBACK_DEV_AUTOFIX_ENABLED;

  const store = await import("../src/improvement/job_store.js");
  const worker = await import("../src/improvement/job_worker.js");
  store.__closeForTests();

  const first = worker.enqueueFeedbackImprovementJob({
    session_id: "s1",
    chat_id: "c1",
    rating: "failed",
    note: "Room audit missed the same element twice",
    created_at: "2026-03-06T11:00:00.000Z",
    dev_handoff: {
      latest_user_request: "Run the room audit again",
      run_bundle_rel: "runs/sessions/s1",
      issue_digest: [{ key: "RoomAuditMissedElement", count: 2, tools: ["revit_room_audit"], sample: "missed element" }],
      recommendations: ["Persist issue fingerprints"],
      signals: ["tool failed twice"]
    } as any
  });

  const second = worker.enqueueFeedbackImprovementJob({
    session_id: "s2",
    chat_id: "c2",
    rating: "failed",
    note: "Room audit missed the same element twice",
    created_at: "2026-03-06T12:00:00.000Z",
    dev_handoff: {
      latest_user_request: "Run the room audit again",
      run_bundle_rel: "runs/sessions/s2",
      issue_digest: [{ key: "RoomAuditMissedElement", count: 1, tools: ["revit_room_audit"], sample: "missed element again" }],
      recommendations: ["Persist issue fingerprints"],
      signals: ["tool failed again"]
    } as any
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job?.occurrence_count, 2);
  assert.equal(second.job?.signal_sources.includes("feedback"), true);
  assert.equal(second.job?.operator_profile?.allowed_branches.includes("codex/*"), true);

  const linked = worker.attachGitHubIssueToImprovementJob({
    fingerprint: second.job?.fingerprint ?? "",
    repo: "epowell40/revit-operator-private",
    issue_number: 555,
    issue_url: "https://github.com/epowell40/revit-operator-private/issues/555"
  });

  assert.equal(linked?.job?.github_issue_number, 555);
  assert.equal(linked?.job?.occurrence_count, 2);
});

test("github issue fingerprint reuses the feedback improvement fingerprint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-improvement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_DEV_MODE = "1";
  process.env.OPERATOR_FEEDBACK_GITHUB_ISSUES_ENABLED = "1";
  process.env.OPERATOR_FEEDBACK_GITHUB_TOKEN = "dummy-token";
  process.env.OPERATOR_FEEDBACK_GITHUB_REPO = "epowell40/revit-operator-private";

  const store = await import("../src/improvement/job_store.js");
  const worker = await import("../src/improvement/job_worker.js");
  const github = await import("../src/feedback/github_issue.js");
  store.__closeForTests();

  const args = {
    session_id: "s-shared",
    chat_id: "c-shared",
    rating: "partial",
    note: "The planner looped without new information",
    created_at: "2026-03-12T14:00:00.000Z",
    dev_handoff: {
      latest_user_request: "Please provide backend feedback for this loop.",
      issue_digest: [{ key: "RepeatedToolLoop", count: 1, tools: ["assistant"], sample: "looped" }],
      recommendations: ["Add duplicate-call loop protection"],
      signals: ["Assistant identified a repeated-tool loop in the planner."]
    } as any
  };

  const queued = worker.enqueueFeedbackImprovementJob(args);
  assert.equal(queued.created, true);

  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ number: 901, html_url: "https://github.com/epowell40/revit-operator-private/issues/901" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    });

  try {
    const created = await github.createFeedbackGitHubIssue(args);
    assert.equal(created.ok, true);
    assert.equal(created.fingerprint, queued.job?.fingerprint);

    const linked = worker.attachGitHubIssueToImprovementJob({
      fingerprint: created.fingerprint ?? "",
      repo: "epowell40/revit-operator-private",
      issue_number: 901,
      issue_url: "https://github.com/epowell40/revit-operator-private/issues/901"
    });

    assert.equal(linked?.created, false);
    assert.equal(linked?.job?.github_issue_number, 901);
    assert.equal(store.listImprovementJobs({ limit: 10 }).length, 1);
  } finally {
    (globalThis as any).fetch = oldFetch;
    delete process.env.OPERATOR_FEEDBACK_GITHUB_ISSUES_ENABLED;
    delete process.env.OPERATOR_FEEDBACK_GITHUB_TOKEN;
    delete process.env.OPERATOR_FEEDBACK_GITHUB_REPO;
  }
});

test("nightly triage improvement jobs are queued and listed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-improvement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const store = await import("../src/improvement/job_store.js");
  const worker = await import("../src/improvement/job_worker.js");
  store.__closeForTests();

  const queued = worker.enqueueNightlyTriageImprovementJobs({
    report_path: "artifacts/reports/issues/2026.03.06_issues.txt",
    since_iso: "2026-03-06T00:00:00.000Z",
    until_iso: "2026-03-06T23:59:59.000Z",
    issues: [
      {
        key: "POST /revit/resize-duct-run :: timeout",
        count: 4,
        first_seen: "2026-03-06T08:00:00.000Z",
        last_seen: "2026-03-06T09:00:00.000Z",
        suggested_fix_area: "backend",
        examples: [{ ts: "2026-03-06T09:00:00.000Z", session_id: "s-duct", message_id: "m1", user_text: "Resize the duct run", tool: { method: "POST", path: "/revit/resize-duct-run" }, error: "timeout" }]
      }
    ]
  });

  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.job?.state, "triaged");

  const listed = store.listImprovementJobs({ limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.issue_keys[0], "POST /revit/resize-duct-run :: timeout");
});

