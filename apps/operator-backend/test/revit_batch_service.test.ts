import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  claimNextRevitBatchItem,
  cancelRevitBatchJob,
  completeRevitBatchItem,
  createRevitBatchJob,
  failRevitBatchItem,
  getRevitBatchJob,
  listRevitBatchJobs,
  pauseRevitBatchJob,
  resumeRevitBatchJob,
  retryFailedRevitBatchItems,
  type RevitBatchAccessContext
} from "../src/revit_batch/service.js";

type AnyMap = Record<string, any>;

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-batch-fencing-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

function createJob(options: {
  readOnly?: boolean;
  operationKind?: string;
  maxClaimAttempts?: number;
  jobType?: string;
  taskPrompt?: string;
  actions?: AnyMap[];
  replayContract?: AnyMap;
} = {}): AnyMap {
  return createRevitBatchJob({
    job_type: options.jobType || "delegated_revit_task_batch",
    title: "Fenced batch test",
    approval: { required: false },
    params: options.maxClaimAttempts ? { max_claim_attempts: options.maxClaimAttempts } : {},
    items: [{
      id: "item-1",
      index: 1,
      status: "pending",
      task_prompt: options.taskPrompt || "Run the exact bounded item.",
      ...(options.readOnly === undefined ? {} : { read_only: options.readOnly }),
      ...(options.operationKind === undefined ? {} : { operation_kind: options.operationKind }),
      ...(options.actions === undefined ? {} : { actions: options.actions }),
      ...(options.replayContract === undefined ? {} : { replay_contract: options.replayContract })
    }]
  }) as AnyMap;
}

const readOnlyActions = [{ action_id: "read-rooms", method: "POST", path: "/revit/rooms", body: { limit: 10 } }];

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

function boundAccess(user: string, session: string, executor: string, fingerprint: string): RevitBatchAccessContext {
  return {
    owner: { user_id: user, tenant_id: "tenant-1" },
    session_id: session,
    target: { executor_id: executor, project_fingerprint: fingerprint }
  };
}

function createBoundJob(access: RevitBatchAccessContext, itemIds = ["item-1"]): AnyMap {
  return createRevitBatchJob({
    job_type: "delegated_revit_task_batch",
    title: `Bound batch for ${access.owner?.user_id}`,
    approval: { required: false },
    items: itemIds.map((id, index) => ({ id, index: index + 1, status: "pending", task_prompt: `Set parameter ${id}.` }))
  }, access) as AnyMap;
}

function jobRecordPath(root: string, jobId: string): string {
  return path.join(root, "artifacts", "revit-batch", "jobs", jobId, "job.json");
}

function editStoredJob(root: string, jobId: string, edit: (job: AnyMap) => void): AnyMap {
  const filePath = jobRecordPath(root, jobId);
  const job = JSON.parse(fs.readFileSync(filePath, "utf8")) as AnyMap;
  edit(job);
  fs.writeFileSync(filePath, JSON.stringify(job, null, 2) + "\n", "utf8");
  return job;
}

function runChild(root: string, body: string): Promise<AnyMap> {
  const serviceUrl = new URL("../src/revit_batch/service.js", import.meta.url).href;
  const script = `const service = await import(${JSON.stringify(serviceUrl)}); ${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, OPERATOR_WORKSPACE_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`Batch child exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim()) as AnyMap);
      } catch (error) {
        reject(new Error(`Invalid batch child output '${stdout}': ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

test("new claims require their exact fencing token and never persist an echoed token as result data", () => {
  mkWorkspace();
  const job = createJob();
  const claimed = claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-a" }) as AnyMap;
  const token = claimed.claim_token as string;
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(claimed.item.claim.fencing_token, token);
  assert.equal(claimed.item.claim.schema_version, 2);

  assert.throws(
    () => completeRevitBatchItem({ job_id: job.id, item_id: "item-1", executor_id: "worker-a" }),
    /claim_token is required/
  );
  assert.throws(
    () => completeRevitBatchItem({ job_id: job.id, item_id: "item-1", executor_id: "worker-a", claim_token: "stale-token" }),
    /Stale or invalid batch claim_token/
  );

  const settled = completeRevitBatchItem({
    job_id: job.id,
    item_id: "item-1",
    executor_id: "worker-a",
    result: { claim_token: token, result_summary: "verified" }
  }) as AnyMap;
  assert.equal(settled.item.status, "succeeded");
  assert.equal(settled.item.result_summary, "verified");
  assert.equal(settled.item.claim_token, undefined);
});

test("an expired mutating claim survives restart as reconciliation-required and is never replayed", async () => {
  const root = mkWorkspace();
  const job = createJob();
  const claimed = claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-a" }) as AnyMap;
  editStoredJob(root, job.id, (stored) => {
    stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
  });

  const restarted = await runChild(root, `process.stdout.write(JSON.stringify(service.getRevitBatchJob(${JSON.stringify(job.id)})));`);
  assert.equal(restarted.status, "failed");
  assert.equal(restarted.result.reconciliation_required, true);
  assert.deepEqual(restarted.result.unknown_outcome_item_ids, ["item-1"]);
  assert.equal(restarted.items[0].status, "failed");
  assert.equal(restarted.items[0].outcome, "unknown");
  assert.equal(restarted.items[0].reconciliation_required, true);
  assert.equal(restarted.items[0].retryable, false);

  const replay = claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-b" }) as AnyMap;
  assert.equal(replay.item, null);
  assert.throws(
    () => completeRevitBatchItem({
      job_id: job.id,
      item_id: "item-1",
      executor_id: "worker-a",
      claim_token: claimed.claim_token
    }),
    /requires reconciliation/
  );
  assert.throws(() => retryFailedRevitBatchItems(job.id), /requires mutation outcome reconciliation/);
});

test("server-classified structured routes are the only delegated source of replay authority", () => {
  mkWorkspace();
  const readJob = createJob({
    readOnly: false,
    operationKind: "mutating",
    taskPrompt: "This display text is deliberately not an effect contract.",
    actions: readOnlyActions,
    replayContract: { replayable: false, classification: "mutating" }
  });
  assert.equal(readJob.items[0].replay_contract.authority, "server_route_classification");
  assert.equal(readJob.items[0].replay_contract.classification, "read");
  assert.equal(readJob.items[0].replay_contract.replayable, true);
  assert.match(readJob.items[0].replay_contract.route_plan_sha256, /^[a-f0-9]{64}$/);

  const missingPlan = createJob({
    readOnly: true,
    operationKind: "read",
    replayContract: {
      schema: "operator.revit_batch.replay_effect.v1",
      authority: "server_route_classification",
      classification: "read",
      replayable: true
    }
  });
  assert.equal(missingPlan.items[0].replay_contract.classification, "unknown");
  assert.equal(missingPlan.items[0].replay_contract.replayable, false);

  const roomCapture = createJob({ jobType: "room_view_capture", readOnly: false, operationKind: "mutating" });
  assert.equal(roomCapture.items[0].replay_contract.source, "server_known_executor");
  assert.equal(roomCapture.items[0].replay_contract.classification, "read");
  assert.equal(roomCapture.items[0].replay_contract.replayable, true);
});

test("caller read-only metadata cannot replay rotate, mirror, duplicate, demolish, renumber, or unknown mutations", () => {
  const mutations = [
    ["Rotate the selected elements.", "/revit/rotate-elements"],
    ["Mirror the selected elements.", "/revit/mirror-elements"],
    ["Duplicate the selected view.", "/revit/duplicate-view"],
    ["Demolish the selected walls.", "/revit/demolish-elements"],
    ["Renumber the selected rooms.", "/revit/renumber-elements"],
    ["Run this mutating action.", "/revit/mutating-action"]
  ] as const;

  for (const [index, [taskPrompt, route]] of mutations.entries()) {
    const root = mkWorkspace();
    const job = createJob({
      readOnly: index % 2 === 0 ? true : undefined,
      operationKind: index % 2 === 1 ? "read" : undefined,
      taskPrompt,
      actions: [{ action_id: `mutation-${index}`, method: "POST", path: route, request_effect: "read" }]
    });
    assert.equal(job.items[0].replay_contract.classification, "conflicting", taskPrompt);
    assert.equal(job.items[0].replay_contract.replayable, false, taskPrompt);
    claimNextRevitBatchItem({ job_id: job.id, executor_id: `worker-${index}` });
    editStoredJob(root, job.id, (stored) => {
      stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
    });
    const recovered = getRevitBatchJob(job.id) as AnyMap;
    assert.equal(recovered.items[0].reconciliation_required, true, taskPrompt);
    assert.equal(recovered.items[0].retryable, false, taskPrompt);
    assert.equal(recovered.result.reason, "expired_mutating_claim", taskPrompt);
  }
});

test("unknown, conflicting, and tampered route contracts fail closed", () => {
  const failClosedCases: Array<Parameters<typeof createJob>[0]> = [
    { readOnly: true, operationKind: "read" },
    { actions: [{ action_id: "outside", method: "POST", path: "/not-revit/read", request_effect: "read" }] },
    { actions: [{ action_id: "conflict", method: "POST", path: "/revit/rooms", request_effect: "apply" }] },
    { actions: readOnlyActions }
  ];
  for (const options of failClosedCases) {
    const root = mkWorkspace();
    const job = createJob(options);
    claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker" });
    editStoredJob(root, job.id, (stored) => {
      stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
      if (stored.items[0].replay_contract.classification === "read") {
        stored.items[0].actions[0].path = "/revit/rotate-elements";
      }
    });
    const recovered = getRevitBatchJob(job.id) as AnyMap;
    assert.equal(recovered.items[0].reconciliation_required, true);
    assert.equal(recovered.items[0].outcome, "unknown");
  }
});

test("a mutating unknown outcome pauses a multi-item batch while an already-running sibling settles", () => {
  const root = mkWorkspace();
  const job = createRevitBatchJob({
    job_type: "delegated_revit_task_batch",
    title: "Multi-item fencing test",
    approval: { required: false },
    items: [
      { id: "mutation-a", index: 1, status: "pending", task_prompt: "Set parameter A." },
      { id: "mutation-b", index: 2, status: "pending", task_prompt: "Set parameter B." },
      { id: "mutation-c", index: 3, status: "pending", task_prompt: "Set parameter C." }
    ]
  }) as AnyMap;
  claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-a" });
  const sibling = claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-b" }) as AnyMap;
  editStoredJob(root, job.id, (stored) => {
    stored.items.find((item: AnyMap) => item.id === "mutation-a").claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
  });

  const paused = getRevitBatchJob(job.id) as AnyMap;
  assert.equal(paused.status, "paused");
  assert.equal(paused.result.reconciliation_required, true);
  const settledSibling = completeRevitBatchItem({
    job_id: job.id,
    item_id: "mutation-b",
    executor_id: "worker-b",
    claim_token: sibling.claim_token
  }) as AnyMap;
  assert.equal(settledSibling.job.status, "paused");
  assert.equal(settledSibling.job.items.find((item: AnyMap) => item.id === "mutation-c").status, "pending");
  assert.equal((claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-c" }) as AnyMap).item, null);
  assert.throws(() => resumeRevitBatchJob(job.id), /requires mutation outcome reconciliation/);
});

test("a stale read-only lease cannot settle the newer claim even when the executor id is reused", () => {
  const root = mkWorkspace();
  const job = createJob({ readOnly: true, actions: readOnlyActions });
  const first = claimNextRevitBatchItem({ job_id: job.id, executor_id: "stable-worker-id" }) as AnyMap;
  editStoredJob(root, job.id, (stored) => {
    stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
  });

  const second = claimNextRevitBatchItem({ job_id: job.id, executor_id: "stable-worker-id" }) as AnyMap;
  assert.notEqual(second.claim_token, first.claim_token);
  assert.equal(second.item.claim.attempt, 2);
  assert.throws(
    () => completeRevitBatchItem({
      job_id: job.id,
      item_id: "item-1",
      executor_id: "stable-worker-id",
      claim_token: first.claim_token
    }),
    /Stale or invalid batch claim_token/
  );
  const settled = completeRevitBatchItem({
    job_id: job.id,
    item_id: "item-1",
    executor_id: "stable-worker-id",
    claim_token: second.claim_token
  }) as AnyMap;
  assert.equal(settled.item.status, "succeeded");
});

test("read-only automatic retries are bounded", () => {
  const root = mkWorkspace();
  const job = createJob({ readOnly: true, maxClaimAttempts: 2, actions: readOnlyActions });
  claimNextRevitBatchItem({ job_id: job.id, executor_id: "reader" });
  editStoredJob(root, job.id, (stored) => {
    stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
  });
  claimNextRevitBatchItem({ job_id: job.id, executor_id: "reader" });
  editStoredJob(root, job.id, (stored) => {
    stored.items[0].claim.lease_expires_at = "2000-01-01T00:00:00.000Z";
  });

  const recovered = getRevitBatchJob(job.id) as AnyMap;
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.items[0].status, "failed");
  assert.equal(recovered.items[0].claim_attempts, 2);
  assert.equal(recovered.items[0].retryable, false);
  assert.equal(recovered.items[0].reconciliation_required, false);
  assert.match(recovered.items[0].error, /automatic retries are exhausted/);
});

test("competing cross-process claims have exactly one winner", async () => {
  const root = mkWorkspace();
  const job = createJob();
  const body = `const result = service.claimNextRevitBatchItem({ job_id: ${JSON.stringify(job.id)}, executor_id: process.env.WORKER_ID }); process.stdout.write(JSON.stringify(result));`;
  const [a, b] = await Promise.all([
    runChild(root, body.replace("process.env.WORKER_ID", JSON.stringify("worker-a"))),
    runChild(root, body.replace("process.env.WORKER_ID", JSON.stringify("worker-b")))
  ]);
  const winners = [a, b].filter((result) => result.item !== null);
  assert.equal(winners.length, 1);
  assert.match(winners[0].claim_token, /^[a-f0-9]{32}$/);
  const stored = getRevitBatchJob(job.id) as AnyMap;
  assert.equal(stored.item_summary.running, 1);
  assert.equal(stored.items[0].claim.executor_id, winners[0].item.claim.executor_id);
});

test("a genuinely legacy stored claim without fencing metadata remains settleable by its executor", () => {
  const root = mkWorkspace();
  const job = createJob();
  claimNextRevitBatchItem({ job_id: job.id, executor_id: "legacy-worker" });
  editStoredJob(root, job.id, (stored) => {
    delete stored.items[0].claim.fencing_token;
    delete stored.items[0].claim.schema_version;
    delete stored.items[0].claim.attempt;
  });

  const settled = completeRevitBatchItem({
    job_id: job.id,
    item_id: "item-1",
    executor_id: "legacy-worker",
    result: { result_summary: "legacy completion" }
  }) as AnyMap;
  assert.equal(settled.item.status, "succeeded");
});

test("a schema-v2 stored claim with a missing token fails closed", () => {
  const root = mkWorkspace();
  const job = createJob();
  claimNextRevitBatchItem({ job_id: job.id, executor_id: "worker-a" });
  editStoredJob(root, job.id, (stored) => {
    delete stored.items[0].claim.fencing_token;
  });
  assert.throws(
    () => completeRevitBatchItem({ job_id: job.id, item_id: "item-1", executor_id: "worker-a" }),
    /missing its stored token/
  );
});

test("bound jobs are isolated by authenticated principal, session, executor, and document", () => {
  mkWorkspace();
  const aliceA = boundAccess("alice", "session-alice-a", "executor-a", fingerprintA);
  const aliceB = boundAccess("alice", "session-alice-b", "executor-b", fingerprintB);
  const bobA = boundAccess("bob", "session-bob-a", "executor-a", fingerprintA);
  const jobA = createBoundJob(aliceA);
  const jobB = createBoundJob(aliceB);

  assert.deepEqual((listRevitBatchJobs(20, aliceA) as AnyMap[]).map(job => job.id), [jobA.id]);
  assert.deepEqual((listRevitBatchJobs(20, aliceB) as AnyMap[]).map(job => job.id), [jobB.id]);
  assert.deepEqual(listRevitBatchJobs(20, bobA), []);
  assert.equal(getRevitBatchJob(jobA.id, bobA), null);
  assert.equal(getRevitBatchJob(jobA.id, aliceB), null);
  assert.throws(() => pauseRevitBatchJob(jobA.id, bobA), /access context mismatch/);

  const polled = claimNextRevitBatchItem({ executor_id: "executor-a", access: aliceA }) as AnyMap;
  assert.equal(polled.job.id, jobA.id);
  assert.equal(polled.item.claim.owner.user_id, "alice");
  assert.equal(polled.item.claim.session_id, "session-alice-a");
  assert.equal(polled.item.claim.target_context.project_fingerprint, fingerprintA);
  assert.throws(
    () => claimNextRevitBatchItem({ job_id: jobB.id, executor_id: "executor-a", access: aliceA }),
    /access context mismatch/
  );

  const forgedInput = {
    job_type: "delegated_revit_task_batch",
    title: "Forged owner input",
    approval: { required: false },
    owner: { user_id: "mallory", tenant_id: "tenant-evil" },
    session_id: "forged-session",
    target_context: { executor_id: "executor-evil", project_fingerprint: fingerprintB },
    items: [{ id: "forged-item", index: 1, status: "pending", task_prompt: "Set parameter." }]
  };
  const trusted = createRevitBatchJob(forgedInput as any, aliceA) as AnyMap;
  assert.deepEqual(trusted.owner, aliceA.owner);
  assert.equal(trusted.session_id, aliceA.session_id);
  assert.deepEqual(trusted.target_context, aliceA.target);
});

test("claim and settlement reject wrong executor, principal, document, and claim context", () => {
  const root = mkWorkspace();
  const access = boundAccess("alice", "session-alice", "executor-a", fingerprintA);
  const wrongPrincipal = boundAccess("bob", "session-alice", "executor-a", fingerprintA);
  const wrongDocument = boundAccess("alice", "session-alice", "executor-a", fingerprintB);
  const wrongExecutor = boundAccess("alice", "session-alice", "executor-b", fingerprintA);
  const job = createBoundJob(access);

  assert.throws(
    () => claimNextRevitBatchItem({ job_id: job.id, executor_id: "executor-b", access }),
    /trusted target executor/
  );
  assert.throws(
    () => claimNextRevitBatchItem({ job_id: job.id, executor_id: "executor-b", access: wrongExecutor }),
    /access context mismatch/
  );

  const claim = claimNextRevitBatchItem({ job_id: job.id, executor_id: "executor-a", access }) as AnyMap;
  for (const invalid of [wrongPrincipal, wrongDocument, wrongExecutor]) {
    assert.throws(
      () => completeRevitBatchItem({
        job_id: job.id,
        item_id: "item-1",
        executor_id: invalid.target!.executor_id,
        claim_token: claim.claim_token,
        access: invalid
      }),
      /access context mismatch|not claimed by this executor/
    );
  }

  editStoredJob(root, job.id, (stored) => {
    stored.items[0].claim.target_context.project_fingerprint = fingerprintB;
  });
  assert.throws(
    () => completeRevitBatchItem({
      job_id: job.id,
      item_id: "item-1",
      executor_id: "executor-a",
      claim_token: claim.claim_token,
      access
    }),
    /claim context no longer matches/
  );
});

test("local shared-token jobs bind session, executor, and document without a principal owner", () => {
  mkWorkspace();
  const access: RevitBatchAccessContext = {
    session_id: "local-session-a",
    target: { executor_id: "local-executor-a", project_fingerprint: fingerprintA }
  };
  const job = createRevitBatchJob({
    job_type: "delegated_revit_task_batch",
    title: "Local bound batch",
    approval: { required: false },
    items: [{ id: "local-item", index: 1, status: "pending", task_prompt: "Run locally." }]
  }, access) as AnyMap;
  assert.equal(job.owner, null);
  assert.equal(job.session_id, "local-session-a");
  assert.equal(job.target_context.executor_id, "local-executor-a");
  assert.deepEqual(listRevitBatchJobs(20, access).map((row: AnyMap) => row.id), [job.id]);
  assert.deepEqual(listRevitBatchJobs(20, {
    session_id: "local-session-b",
    target: { executor_id: "local-executor-b", project_fingerprint: fingerprintB }
  }), []);
  const claim = claimNextRevitBatchItem({ job_id: job.id, executor_id: "local-executor-a", access }) as AnyMap;
  const completed = completeRevitBatchItem({
    job_id: job.id,
    item_id: "local-item",
    executor_id: "local-executor-a",
    claim_token: claim.claim_token,
    result: { result_summary: "done" },
    access
  }) as AnyMap;
  assert.equal(completed.item.status, "succeeded");
});

test("identical completion settlement is idempotent while conflicting duplicates fail closed", () => {
  mkWorkspace();
  const access = boundAccess("alice", "settlement-session", "executor-a", fingerprintA);
  const job = createBoundJob(access);
  const claim = claimNextRevitBatchItem({ job_id: job.id, executor_id: "executor-a", access }) as AnyMap;
  const input = {
    job_id: job.id,
    item_id: "item-1",
    executor_id: "executor-a",
    claim_token: claim.claim_token,
    result: { result_summary: "effect committed", request_effect: "apply" },
    access
  };
  const first = completeRevitBatchItem(input) as AnyMap;
  assert.equal(first.item.status, "succeeded");
  const repeated = completeRevitBatchItem(input) as AnyMap;
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.item.status, "succeeded");
  assert.throws(
    () => completeRevitBatchItem({ ...input, result: { result_summary: "different" } }),
    /already settled with a different outcome or payload/
  );
  assert.throws(
    () => failRevitBatchItem({ ...input, error: "late failure" }),
    /already settled with a different outcome or payload/
  );
  assert.throws(
    () => completeRevitBatchItem({ ...input, claim_token: "stolen-token" }),
    /already settled with a different outcome or payload/
  );
});

test("pause and cancel become stable after the last active item settles while pending items remain", () => {
  mkWorkspace();
  const pauseJob = createBoundJob(boundAccess("alice", "pause-session", "executor-a", fingerprintA), ["pause-active", "pause-pending"]);
  const pauseAccess = boundAccess("alice", "pause-session", "executor-a", fingerprintA);
  const pauseClaim = claimNextRevitBatchItem({ job_id: pauseJob.id, executor_id: "executor-a", access: pauseAccess }) as AnyMap;
  assert.equal((pauseRevitBatchJob(pauseJob.id, pauseAccess) as AnyMap).status, "pausing");
  const paused = completeRevitBatchItem({
    job_id: pauseJob.id,
    item_id: "pause-active",
    executor_id: "executor-a",
    claim_token: pauseClaim.claim_token,
    access: pauseAccess
  }) as AnyMap;
  assert.equal(paused.job.status, "paused");
  assert.equal(paused.job.items.find((item: AnyMap) => item.id === "pause-pending").status, "pending");

  const cancelAccess = boundAccess("alice", "cancel-session", "executor-a", fingerprintA);
  const cancelJob = createBoundJob(cancelAccess, ["cancel-active", "cancel-pending"]);
  const cancelClaim = claimNextRevitBatchItem({ job_id: cancelJob.id, executor_id: "executor-a", access: cancelAccess }) as AnyMap;
  assert.equal((cancelRevitBatchJob(cancelJob.id, cancelAccess) as AnyMap).status, "cancelling");
  const cancelled = completeRevitBatchItem({
    job_id: cancelJob.id,
    item_id: "cancel-active",
    executor_id: "executor-a",
    claim_token: cancelClaim.claim_token,
    access: cancelAccess
  }) as AnyMap;
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.items.find((item: AnyMap) => item.id === "cancel-pending").status, "skipped");
  assert.equal(cancelled.job.item_summary.pending, 0);
});
