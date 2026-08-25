import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSIGNMENT_PROJECTION_SCHEMA } from "../src/assignments/projection.js";

async function availablePort(): Promise<number> {
  return await new Promise<number>(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

test("assignment endpoints expose an authenticated read-only Goal/Task projection", async t => {
  const port = await availablePort();
  const token = "assignment-endpoint-test-token";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-assignments-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_TOKEN: token,
      OPERATOR_BRAIN: "rule",
      OPERATOR_MEMORY_AUTO_TURN_NOTES: "0",
      OPERATOR_WORKSPACE_ROOT: workspace
    },
    stdio: "ignore"
  });
  t.after(async () => {
    await stop(child);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-operator-token": token };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) break;
    } catch {
      // The child is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const unauthenticated = await fetch(`${base}/api/assignments`);
  assert.equal(unauthenticated.status, 401);

  const createdResponse = await fetch(`${base}/api/goals`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Count air devices",
      objective: "Count and classify all air devices in the project",
      acceptance_criteria: ["Report a verified total and type breakdown"],
      status: "active",
      current_phase: "planning",
      current_step: "Choose the authoritative schedule",
      work_items: [
        { id: "inspect", title: "Inspect model", status: "complete" },
        { id: "count", title: "Count by type", status: "in_progress" }
      ]
    })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { goal: { id: string } };

  const listResponse = await fetch(`${base}/api/assignments?lifecycle=planning`, { headers });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as {
    schema: string;
    assignments: Array<{ id: string; lifecycle: { phase: string }; progress: { determinate: boolean; total: number; completed: number } }>;
  };
  assert.equal(listed.schema, ASSIGNMENT_PROJECTION_SCHEMA);
  assert.equal(listed.assignments.length, 1);
  assert.equal(listed.assignments[0]?.id, `goal:${created.goal.id}`);
  assert.equal(listed.assignments[0]?.lifecycle.phase, "planning");
  assert.deepEqual(listed.assignments[0]?.progress, {
    determinate: true,
    total: 2,
    completed: 1,
    active: 1,
    pending: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    ratio: 0.5
  });

  const detailResponse = await fetch(`${base}/api/assignments/${encodeURIComponent(`goal:${created.goal.id}`)}`, { headers });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as { assignment: { source_record_id: string; truth: Record<string, unknown> } };
  assert.equal(detail.assignment.source_record_id, created.goal.id);
  assert.deepEqual(detail.assignment.truth, {
    stale: null,
    outcome_uncertain: null,
    reconciliation_required: null
  });

  const blockedResponse = await fetch(`${base}/api/goals/${encodeURIComponent(created.goal.id)}/block`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "The required fixture is unavailable." })
  });
  assert.equal(blockedResponse.status, 200);

  const packetPath = `/api/assignments/${encodeURIComponent(`goal:${created.goal.id}`)}/verified-work-packet`;
  const unauthenticatedPacket = await fetch(`${base}${packetPath}`);
  assert.equal(unauthenticatedPacket.status, 401);
  const packetResponse = await fetch(`${base}${packetPath}`, { headers });
  assert.equal(packetResponse.status, 200);
  const packet = await packetResponse.json() as { packet: { schema: string; status: string; identity: { assignment_id: string } }; json_path: string; markdown_path: string };
  assert.equal(packet.packet.schema, "revit-operator.verified-work-packet/v1");
  assert.equal(packet.packet.status, "blocked_truthfully");
  assert.equal(packet.packet.identity.assignment_id, created.goal.id);
  assert.match(packet.json_path, /verified-work-packets\/vwp1_/);

  const markdownResponse = await fetch(`${base}${packetPath}?format=markdown`, { headers });
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(await markdownResponse.text(), /Blocked Truthfully/);

  const missing = await fetch(`${base}/api/assignments/goal%3Amissing`, { headers });
  assert.equal(missing.status, 404);

  const interactionSession = "assignment-interaction-http-session";
  const interactionResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: interactionSession,
      title: "Replace selected note",
      objective: "Replace the outdated selected note with the current issue wording without creating a duplicate.",
      acceptance_criteria: ["Replace the selected note in place.", "Create no duplicate note."],
      requested_effect: "apply",
      work_budget: {
        requested_effect: "apply",
        source_user_request: "Replace the outdated selected note with the current issue wording without creating a duplicate."
      },
      start_assignment_run: true,
      assignment_run_id: "http-interaction-run",
      assignment_run_actor: "assignment_endpoint_test"
    })
  });
  assert.equal(interactionResponse.status, 200);
  const interaction = await interactionResponse.json() as {
    goal: { id: string };
    assignment_run: { assignment_id: string; run_id: string; generation: number };
  };
  assert.equal(interaction.assignment_run.assignment_id, interaction.goal.id);

  const clarificationResponse = await fetch(`${base}/api/assignments/clarifications`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema: "revit-operator.assignment-clarification/v1",
      assignment_id: interaction.goal.id,
      run_id: interaction.assignment_run.run_id,
      generation: interaction.assignment_run.generation,
      session_id: interactionSession,
      missing_fields: ["replacement_text"],
      question: "What exact replacement wording should I use?",
      reason: "desired_postcondition_missing",
      completed_work: ["Grounded the selected TextNote."],
      affected_subtasks: ["replace-selected-note"],
      primary_artifact_refs: ["revit-element:1478627"],
      criterion_states: [{
        criterion: "Replace the selected note in place.",
        state: "needs_input",
        reason: "Exact replacement wording is required."
      }]
    })
  });
  assert.equal(clarificationResponse.status, 202);
  const clarification = await clarificationResponse.json() as { clarification: { clarification_id: string }; outcome_state: string };
  assert.equal(clarification.outcome_state, "awaiting_user_input");

  const workReturnPath = `/api/assignments/${encodeURIComponent(`goal:${interaction.goal.id}`)}/work-return`;
  assert.equal((await fetch(`${base}${workReturnPath}`)).status, 401);
  const workReturnResponse = await fetch(`${base}${workReturnPath}`, { headers });
  assert.equal(workReturnResponse.status, 200);
  const workReturn = await workReturnResponse.json() as { work_return: { status: string; question: string | null; clarification_id: string | null } };
  assert.equal(workReturn.work_return.status, "awaiting_user_input");
  assert.equal(workReturn.work_return.clarification_id, clarification.clarification.clarification_id);
  assert.equal(workReturn.work_return.question, "What exact replacement wording should I use?");

  const resumeResponse = await fetch(`${base}/api/assignments/clarification-responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema: "revit-operator.assignment-clarification-response/v1",
      clarification_id: clarification.clarification.clarification_id,
      assignment_id: interaction.goal.id,
      run_id: interaction.assignment_run.run_id,
      generation: interaction.assignment_run.generation,
      session_id: interactionSession,
      response: "Use Current Issue Wording.",
      supplied_values: { replacement_text: "Current Issue Wording" }
    })
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = await resumeResponse.json() as { assignment_id: string; run_id: string; generation: number; outcome_state: string };
  assert.deepEqual({ assignment_id: resumed.assignment_id, run_id: resumed.run_id, generation: resumed.generation }, interaction.assignment_run);
  assert.equal(resumed.outcome_state, "active");
});
