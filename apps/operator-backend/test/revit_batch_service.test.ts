import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  claimNextRevitBatchItem,
  completeRevitBatchItem,
  createRevitBatchJob,
  getRevitBatchJob,
  resumeRevitBatchJob,
  retryFailedRevitBatchItems
} from "../src/revit_batch/service.js";

type AnyMap = Record<string, any>;

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-batch-fencing-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

function createJob(options: { readOnly?: boolean; maxClaimAttempts?: number; jobType?: string } = {}): AnyMap {
  return createRevitBatchJob({
    job_type: options.jobType || "delegated_revit_task_batch",
    title: "Fenced batch test",
    approval: { required: false },
    params: options.maxClaimAttempts ? { max_claim_attempts: options.maxClaimAttempts } : {},
    items: [{
      id: "item-1",
      index: 1,
      status: "pending",
      task_prompt: "Run the exact bounded item.",
      ...(options.readOnly === undefined ? {} : { read_only: options.readOnly })
    }]
  }) as AnyMap;
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
  const job = createJob({ readOnly: true });
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
  const job = createJob({ readOnly: true, maxClaimAttempts: 2 });
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
