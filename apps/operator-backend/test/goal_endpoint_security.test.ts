import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  authenticateRequest,
  isUnauthenticatedPrincipalRoute,
  requiresRequestAuthentication,
  resolveAuthMode
} from "../src/auth.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { createLocalGoalEvidenceAuthority } from "../src/goals/authority.js";
import {
  createPrincipalBoundSessionIdForRequest,
  getRequestAssignmentPrincipalId,
  requestMatchesAssignmentPrincipalId,
  type RequestContext,
  type RequestPrincipal
} from "../src/request_context.js";

const READINESS_DEADLINE_MS = 20_000;
const READINESS_FETCH_TIMEOUT_MS = 500;
const STDERR_TAIL_LIMIT = 8_192;
const childStderrTails = new WeakMap<ChildProcess, string>();

function captureChildDiagnostics(child: ChildProcess): void {
  childStderrTails.set(child, "");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const previous = childStderrTails.get(child) ?? "";
    childStderrTails.set(child, `${previous}${chunk}`.slice(-STDERR_TAIL_LIMIT));
  });
}

function childDiagnostics(child: ChildProcess): string {
  const stderr = childStderrTails.get(child)?.trim();
  return `exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)} stderrTail=${stderr || "<empty>"}`;
}

function signJwt(userId: string, secret: string, tenantId = "tenant-shared", roles = ["user"], expiresInSeconds = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const headerPart = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify({
    sub: userId,
    user_id: userId,
    tenant_id: tenantId,
    roles,
    iat: now - 5,
    exp: now + expiresInSeconds
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

async function availablePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>(resolve => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number };
      socket.close(() => resolve(address.port));
    });
  });
}

async function killAndWait(child: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      const signaled = child.kill(signal);
      if (!signaled && (child.exitCode !== null || child.signalCode !== null)) finish(true);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (await killAndWait(child, "SIGTERM", 2_000)) return;
  if (await killAndWait(child, "SIGKILL", 2_000)) return;
  throw new Error(`Spawned backend process ${child.pid ?? "unknown"} did not exit after SIGTERM and SIGKILL.`);
}

async function waitForServer(base: string, headers: Record<string, string>, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Backend exited before readiness: ${childDiagnostics(child)}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(READINESS_FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
    );
    let onExit: (() => void) | undefined;
    try {
      const exited = new Promise<never>((_resolve, reject) => {
        onExit = () => reject(new Error(`Backend exited before readiness: ${childDiagnostics(child)}`));
        child.once("exit", onExit);
      });
      const response = await Promise.race([
        fetch(`${base}/health`, { headers, signal: controller.signal }),
        exited
      ]);
      lastStatus = response.status;
      if (response.ok) return true;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Backend exited before readiness: ${childDiagnostics(child)}`);
      }
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      clearTimeout(timeout);
      if (onExit) child.off("exit", onExit);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `Backend did not become ready within ${READINESS_DEADLINE_MS}ms ` +
    `(lastStatus=${String(lastStatus)} lastError=${lastError ?? "<none>"} ${childDiagnostics(child)}).`
  );
}

test("generic JWT mode resolves a tenant principal while shared-token no-principal behavior remains intact", () => {
  const previousMode = process.env.OPERATOR_AUTH_MODE;
  const previousSecret = process.env.OPERATOR_JWT_SECRET;
  const previousIssuer = process.env.OPERATOR_JWT_ISSUER;
  const previousAudience = process.env.OPERATOR_JWT_AUDIENCE;
  try {
    process.env.OPERATOR_AUTH_MODE = "principal_jwt";
    process.env.OPERATOR_JWT_SECRET = "goal-auth-unit-secret";
    delete process.env.OPERATOR_JWT_ISSUER;
    delete process.env.OPERATOR_JWT_AUDIENCE;
    assert.equal(resolveAuthMode(), "principal_jwt");
    const token = signJwt("alice", process.env.OPERATOR_JWT_SECRET);
    const authenticated = authenticateRequest(
      { headers: { authorization: `Bearer ${token}` } } as any,
      { mode: "principal_jwt", requireAuth: true, sharedToken: "" }
    );
    assert.equal(authenticated.ok, true);
    if (authenticated.ok) {
      assert.equal(authenticated.principal?.user_id, "alice");
      assert.equal(authenticated.principal?.tenant_id, "tenant-shared");
      assert.equal(authenticated.backend_auth?.mode, "principal_jwt");
      assert.equal(authenticated.backend_auth?.credential, token);
    }

    const missing = authenticateRequest({ headers: {} } as any, { mode: "principal_jwt", requireAuth: true, sharedToken: "" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);

    const local = authenticateRequest({ headers: {} } as any, { mode: "shared_token", requireAuth: false, sharedToken: "" });
    assert.equal(local.ok, true);
    if (local.ok) assert.equal(local.principal, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.OPERATOR_AUTH_MODE;
    else process.env.OPERATOR_AUTH_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.OPERATOR_JWT_SECRET;
    else process.env.OPERATOR_JWT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.OPERATOR_JWT_ISSUER;
    else process.env.OPERATOR_JWT_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.OPERATOR_JWT_AUDIENCE;
    else process.env.OPERATOR_JWT_AUDIENCE = previousAudience;
  }
});

test("authenticated backend transport preserves the declared mode and fails closed for invalid principal credentials", () => {
  const previousSecret = process.env.OPERATOR_JWT_SECRET;
  const previousBase = process.env.OPERATOR_API_BASE_URL;
  try {
    process.env.OPERATOR_JWT_SECRET = "internal-backend-auth-secret";
    process.env.OPERATOR_API_BASE_URL = "https://operator.example/path-is-not-authority";
    const valid = signJwt("alice", process.env.OPERATOR_JWT_SECRET);
    const principal = authenticateRequest(
      { headers: { authorization: `Bearer ${valid}`, "x-operator-token": "must-not-win" } } as any,
      { mode: "principal_jwt", requireAuth: true, sharedToken: "must-not-win" }
    );
    assert.equal(principal.ok, true);
    if (principal.ok) {
      assert.equal(principal.backend_auth?.mode, "principal_jwt");
      assert.equal(principal.backend_auth?.credential, valid);
      assert.equal(principal.backend_auth?.allowed_origin, "https://operator.example");
    }

    const shared = authenticateRequest(
      { headers: { authorization: `Bearer ${valid}`, "x-operator-token": "local-token" } } as any,
      { mode: "shared_token", requireAuth: true, sharedToken: "local-token" }
    );
    assert.equal(shared.ok, true);
    if (shared.ok) {
      assert.equal(shared.backend_auth?.mode, "shared_token");
      assert.equal(shared.backend_auth?.credential, "local-token");
    }

    const malformed = authenticateRequest(
      { headers: { authorization: "Bearer malformed" } } as any,
      { mode: "principal_jwt", requireAuth: true, sharedToken: "" }
    );
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.error, /invalid bearer token format/i);

    const expired = authenticateRequest(
      { headers: { authorization: `Bearer ${signJwt("alice", process.env.OPERATOR_JWT_SECRET, "tenant-shared", ["user"], -120)}` } } as any,
      { mode: "principal_jwt", requireAuth: true, sharedToken: "" }
    );
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.match(expired.error, /expired/i);
  } finally {
    if (previousSecret === undefined) delete process.env.OPERATOR_JWT_SECRET;
    else process.env.OPERATOR_JWT_SECRET = previousSecret;
    if (previousBase === undefined) delete process.env.OPERATOR_API_BASE_URL;
    else process.env.OPERATOR_API_BASE_URL = previousBase;
  }
});

test("principal route inventory is default-deny with one explicit unauthenticated liveness route", () => {
  assert.equal(isUnauthenticatedPrincipalRoute("GET", "/health"), true);
  assert.equal(isUnauthenticatedPrincipalRoute("POST", "/health"), false);

  for (const [method, pathname] of [
    ["GET", "/"],
    ["GET", "/environment/profile"],
    ["GET", "/memory/project-profile"],
    ["GET", "/ui/tool-host-demo"],
    ["GET", "/artifacts/download-shared/example"],
    ["GET", "/new-state-route-not-yet-in-an-inventory"],
    ["POST", "/session/new"]
  ]) {
    assert.equal(requiresRequestAuthentication({
      mode: "principal_jwt",
      method,
      pathname,
      sharedTokenRouteProtected: false
    }), true, `${method} ${pathname} must require a principal`);
  }

  assert.equal(requiresRequestAuthentication({
    mode: "principal_jwt",
    method: "GET",
    pathname: "/health",
    sharedTokenRouteProtected: true
  }), false);
  assert.equal(requiresRequestAuthentication({
    mode: "shared_token",
    method: "GET",
    pathname: "/environment/profile",
    sharedTokenRouteProtected: false
  }), false);
});

test("hosted runtime defaults to principal auth while local and self-hosted runtimes keep shared-token behavior", () => {
  const previousAuthMode = process.env.OPERATOR_AUTH_MODE;
  const previousRuntimeMode = process.env.REVIT_OPERATOR_MODE;
  const previousHostedEnabled = process.env.OPERATOR_HOSTED_ENABLED;
  try {
    delete process.env.OPERATOR_AUTH_MODE;
    delete process.env.OPERATOR_HOSTED_ENABLED;
    process.env.REVIT_OPERATOR_MODE = "hosted";
    assert.equal(resolveAuthMode(), "principal_jwt");

    process.env.REVIT_OPERATOR_MODE = "local";
    assert.equal(resolveAuthMode(), "shared_token");
    process.env.REVIT_OPERATOR_MODE = "self_hosted";
    assert.equal(resolveAuthMode(), "shared_token");

    process.env.OPERATOR_AUTH_MODE = "unexpected_mode";
    assert.throws(() => resolveAuthMode(), /Unsupported OPERATOR_AUTH_MODE/);
  } finally {
    if (previousAuthMode === undefined) delete process.env.OPERATOR_AUTH_MODE;
    else process.env.OPERATOR_AUTH_MODE = previousAuthMode;
    if (previousRuntimeMode === undefined) delete process.env.REVIT_OPERATOR_MODE;
    else process.env.REVIT_OPERATOR_MODE = previousRuntimeMode;
    if (previousHostedEnabled === undefined) delete process.env.OPERATOR_HOSTED_ENABLED;
    else process.env.OPERATOR_HOSTED_ENABLED = previousHostedEnabled;
  }
});

test("goal endpoints authenticate generic JWT callers and isolate principals, workspaces, and sessions", async t => {
  const port = await availablePort();
  const secret = "goal-endpoint-security-secret";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goal-security-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "principal_jwt",
      OPERATOR_JWT_SECRET: secret,
      OPERATOR_JWT_ISSUER: "",
      OPERATOR_JWT_AUDIENCE: "",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_BRAIN: "rule"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  captureChildDiagnostics(child);
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const aliceAuth = `Bearer ${signJwt("alice", secret)}`;
  const bobAuth = `Bearer ${signJwt("bob", secret)}`;
  const headers = (authorization: string) => ({ authorization, "content-type": "application/json" });
  assert.equal(await waitForServer(base, { authorization: aliceAuth }, child), true, "backend must report ready");

  const publicHealth = await fetch(`${base}/health`);
  assert.equal(publicHealth.status, 200);
  assert.deepEqual(await publicHealth.json(), {
    status: "ok",
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    auth_mode: "principal_jwt",
    authentication_required: true
  });

  for (const [method, pathname] of [
    ["GET", "/environment/profile"],
    ["GET", "/memory/project-profile"],
    ["GET", "/ui/tool-host-demo"],
    ["GET", "/artifacts/download-shared/example"],
    ["GET", "/unregistered-state-route"]
  ]) {
    const denied = await fetch(`${base}${pathname}`, { method });
    assert.equal(denied.status, 401, `${method} ${pathname} must fail closed`);
  }

  const unauthenticated = await fetch(`${base}/api/agent-goal?session_id=unknown`);
  assert.equal(unauthenticated.status, 401);

  const aliceSessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: { authorization: aliceAuth } });
  assert.equal(aliceSessionResponse.status, 200);
  const aliceSession = (await aliceSessionResponse.json() as { session_id: string }).session_id;
  const aliceGoalResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      session_id: aliceSession,
      objective: "Alice-only goal",
      success_criteria: ["Alice evidence exists."],
      created_by: "forged-owner"
    })
  });
  assert.equal(aliceGoalResponse.status, 200);
  const aliceGoal = (await aliceGoalResponse.json() as { goal: { id: string; created_by: string } }).goal;
  assert.equal(aliceGoal.created_by, "alice");

  const bobReadsAliceSession = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(aliceSession)}`, { headers: { authorization: bobAuth } });
  assert.equal(bobReadsAliceSession.status, 403);
  const bobMutatesAliceSession = await fetch(`${base}/api/agent-goal/progress`, {
    method: "POST",
    headers: headers(bobAuth),
    body: JSON.stringify({ session_id: aliceSession, summary: "Forged progress" })
  });
  assert.equal(bobMutatesAliceSession.status, 403);
  const forgedValidator = await fetch(`${base}/api/goals/${encodeURIComponent(aliceGoal.id)}/validations`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      summary: "Alice claims a trusted validator passed.",
      evidence: {
        kind: "validator",
        criterion: "Alice evidence exists.",
        validator: { identity: "trusted-validator", method: "npm test", status: "pass" }
      }
    })
  });
  assert.equal(forgedValidator.status, 400);
  assert.match(await forgedValidator.text(), /caller-provided identity or status is not accepted/i);
  const forgedApproval = await fetch(`${base}/api/goals/${encodeURIComponent(aliceGoal.id)}/evidence`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      summary: "Alice claims an administrator approved.",
      evidence: {
        kind: "human_approval",
        criterion: "Alice evidence exists.",
        approval: { approver_identity: "administrator", approver_role: "administrator", method: "manual review", status: "approved" }
      }
    })
  });
  assert.equal(forgedApproval.status, 400);
  assert.match(await forgedApproval.text(), /caller-provided identity or status is not accepted/i);
  const callerOnlyCompletion = await fetch(`${base}/api/agent-goal/complete`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({ session_id: aliceSession, evidence_summary: "The caller says every criterion passed." })
  });
  assert.equal(callerOnlyCompletion.status, 400);
  assert.match(await callerOnlyCompletion.text(), /completion audit passes/i);

  const bobSessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: { authorization: bobAuth } });
  assert.equal(bobSessionResponse.status, 200);
  const bobSession = (await bobSessionResponse.json() as { session_id: string }).session_id;
  const bobGoalResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers: headers(bobAuth),
    body: JSON.stringify({ session_id: bobSession, objective: "Bob-only goal", success_criteria: ["Bob evidence exists."] })
  });
  assert.equal(bobGoalResponse.status, 200);
  const bobGoal = (await bobGoalResponse.json() as { goal: { id: string } }).goal;

  const aliceList = await fetch(`${base}/api/goals`, { headers: { authorization: aliceAuth } });
  const bobList = await fetch(`${base}/api/goals`, { headers: { authorization: bobAuth } });
  assert.deepEqual((await aliceList.json() as { goals: Array<{ id: string }> }).goals.map(goal => goal.id), [aliceGoal.id]);
  assert.deepEqual((await bobList.json() as { goals: Array<{ id: string }> }).goals.map(goal => goal.id), [bobGoal.id]);

  const aliceReadsBobGoal = await fetch(`${base}/api/goals/${encodeURIComponent(bobGoal.id)}`, { headers: { authorization: aliceAuth } });
  assert.equal(aliceReadsBobGoal.status, 404);
  const wrongSessionLookup = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(bobSession)}`, { headers: { authorization: aliceAuth } });
  assert.equal(wrongSessionLookup.status, 403);

  const unboundGoalResponse = await fetch(`${base}/api/goals`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({ title: "Unbound Alice goal", objective: "Bind only to Alice sessions.", acceptance_criteria: ["Binding is authorized."] })
  });
  assert.equal(unboundGoalResponse.status, 201);
  const unboundGoal = (await unboundGoalResponse.json() as { goal: { id: string } }).goal;
  const bindToBobSession = await fetch(`${base}/api/goals/${encodeURIComponent(unboundGoal.id)}`, {
    method: "PATCH",
    headers: headers(aliceAuth),
    body: JSON.stringify({ related_session_id: bobSession })
  });
  assert.equal(bindToBobSession.status, 403);

  const sidecarSessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: { authorization: aliceAuth } });
  const sidecarSession = (await sidecarSessionResponse.json() as { session_id: string }).session_id;
  const sidecarGoalResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      session_id: sidecarSession,
      title: "Operator Desktop execution",
      objective: "Execute and verify one local outer-agent task.",
      acceptance_criteria: ["The task is complete."],
      work_budget: { mode: "sidecar_computer", source: "operator_desktop" },
      work_items: [{ id: "sidecar.requested-work", title: "Complete and verify the requested work", status: "in_progress" }],
      start_assignment_run: true,
      assignment_run_id: "sidecar-run-alice",
      assignment_run_actor: "operator_desktop_outer_agent"
    })
  });
  assert.equal(sidecarGoalResponse.status, 200);
  const sidecarStart = await sidecarGoalResponse.json() as {
    assignment_run: { assignment_id: string; run_id: string; generation: number };
  };
  assert.equal(sidecarStart.assignment_run.run_id, "sidecar-run-alice");
  assert.equal(sidecarStart.assignment_run.generation, 1);
  const foreignPrincipalCompletion = await fetch(`${base}/api/assignments/read-completion-claims`, {
    method: "POST",
    headers: headers(bobAuth),
    body: JSON.stringify({
      schema: "revit-operator.assignment-read-completion-claim/v1",
      assignment_id: sidecarStart.assignment_run.assignment_id,
      run_id: sidecarStart.assignment_run.run_id,
      generation: sidecarStart.assignment_run.generation,
      session_id: sidecarSession,
      criteria: [{ criterion: "The task is complete.", assertion_ids: ["foreign"] }],
      result: {
        kind: "inventory",
        assertions: [{
          assertion_id: "foreign",
          attempt_id: "foreign-attempt",
          evidence_id: `ev1_${"f".repeat(32)}`,
          operation: "field_equals",
          path: "count",
          expected: 1
        }]
      }
    })
  });
  assert.equal(foreignPrincipalCompletion.status, 403);
  const boundChat = await fetch(`${base}/chat`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sidecarSession,
      message_id: "sidecar-bound-r01",
      user_text: "Replace the outdated selected note with the current issue wording without creating a duplicate.",
      assignment_id: sidecarStart.assignment_run.assignment_id,
      assignment_run_id: sidecarStart.assignment_run.run_id,
      assignment_generation: sidecarStart.assignment_run.generation
    })
  });
  assert.equal(boundChat.status, 200);
  const sidecarGoalsResponse = await fetch(`${base}/api/goals?session_id=${encodeURIComponent(sidecarSession)}`, {
    headers: { authorization: aliceAuth }
  });
  const sidecarGoals = (await sidecarGoalsResponse.json() as { goals: Array<{ id: string }> }).goals;
  assert.deepEqual(sidecarGoals.map(goal => goal.id), [sidecarStart.assignment_run.assignment_id]);
  const staleBoundChat = await fetch(`${base}/chat`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sidecarSession,
      message_id: "sidecar-stale-r01",
      user_text: "Continue the same Revit note edit.",
      assignment_id: sidecarStart.assignment_run.assignment_id,
      assignment_run_id: sidecarStart.assignment_run.run_id,
      assignment_generation: sidecarStart.assignment_run.generation + 1
    })
  });
  assert.equal(staleBoundChat.status, 500);
  assert.match(JSON.stringify(await staleBoundChat.json()), /assignment_binding_stale_or_mismatched/);
  const bobSidecarSettlement = await fetch(`${base}/api/agent-goal/sidecar-settle`, {
    method: "POST",
    headers: headers(bobAuth),
    body: JSON.stringify({ session_id: sidecarSession, outcome: "complete", turn_id: "forged-bob-turn", assistant_summary: "forged" })
  });
  assert.equal(bobSidecarSettlement.status, 403);
  const aliceSidecarSettlement = await fetch(`${base}/api/agent-goal/sidecar-settle`, {
    method: "POST",
    headers: headers(aliceAuth),
    body: JSON.stringify({
      session_id: sidecarSession,
      outcome: "complete",
      turn_id: "alice-sidecar-turn",
      assistant_summary: "The authenticated Sidecar completed the task.",
      successful_tools: 1,
      verification_kind: "sidecar_turn_receipts",
      assignment_run_id: sidecarStart.assignment_run.run_id,
      assignment_generation: sidecarStart.assignment_run.generation,
      evidence: { tool_name: "inspect_revit_context", status: "success" }
    })
  });
  assert.equal(aliceSidecarSettlement.status, 200);
  const settledSidecarGoal = (await aliceSidecarSettlement.json() as { goal: { status: string; completion_audit: { complete: boolean } } }).goal;
  assert.equal(settledSidecarGoal.status, "active");
  assert.equal(settledSidecarGoal.completion_audit.complete, false);
});

test("principal auto-goals bind ownership to the requester so approval authority rejects self-approval", async t => {
  const port = await availablePort();
  const jwtSecret = "auto-goal-owner-endpoint-secret";
  const authoritySecret = "auto-goal-authority-secret-32-bytes-minimum";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-auto-goal-owner-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "principal_jwt",
      OPERATOR_JWT_SECRET: jwtSecret,
      OPERATOR_JWT_ISSUER: "",
      OPERATOR_JWT_AUDIENCE: "",
      OPERATOR_GOAL_AUTHORITY_SECRET: authoritySecret,
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_BRAIN: "rule"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  captureChildDiagnostics(child);
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const aliceAuth = `Bearer ${signJwt("alice", jwtSecret, "tenant-shared", ["user", "goal_approver"])}`;
  const headers = { authorization: aliceAuth, "content-type": "application/json" };
  assert.equal(await waitForServer(base, { authorization: aliceAuth }, child), true, "backend must report ready");

  const sessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: { authorization: aliceAuth } });
  assert.equal(sessionResponse.status, 200);
  const sessionId = (await sessionResponse.json() as { session_id: string }).session_id;
  const chatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "auto-goal-owner-message",
      user_text: "Update all marked receptacles and verify the completed model changes.",
      context: {
        revit: {
          courier_executor_id: "snowdon-executor",
          document: {
            title: "Snowdon Towers Sample HVAC",
            path: "C:\\Models\\Snowdon Towers Sample HVAC.rvt",
            projectIdentity: { fingerprint: "snowdon-hvac-fingerprint" }
          }
        }
      }
    })
  });
  assert.equal(chatResponse.status, 200);

  const goalResponse = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { authorization: aliceAuth }
  });
  assert.equal(goalResponse.status, 200);
  const goal = (await goalResponse.json() as {
    goal: {
      id: string;
      related_session_id: string;
      created_by: string;
      acceptance_criteria: string[];
      work_budget: {
        mode: string;
        source: string;
        source_user_request: string;
        executor_id: string;
        document_fingerprint: string;
        document_title: string;
        document_path: string;
      };
    };
  }).goal;
  assert.equal(goal.created_by, "alice");
  assert.equal(goal.work_budget.mode, "auto_goal");
  assert.equal(goal.work_budget.source, "chat");
  assert.equal(goal.work_budget.source_user_request, "Update all marked receptacles and verify the completed model changes.");
  assert.equal(goal.work_budget.executor_id, "snowdon-executor");
  assert.equal(goal.work_budget.document_fingerprint, "snowdon-hvac-fingerprint");
  assert.equal(goal.work_budget.document_title, "Snowdon Towers Sample HVAC");
  assert.equal(goal.work_budget.document_path, "C:\\Models\\Snowdon Towers Sample HVAC.rvt");

  const authority = createLocalGoalEvidenceAuthority({ secret: authoritySecret });
  const context = {
    goal_id: goal.id,
    session_id: goal.related_session_id,
    criterion: goal.acceptance_criteria[0]!,
    goal_owner_principal_id: goal.created_by
  };
  assert.throws(() => authority.issueHumanApproval({
    ...context,
    authenticated_principal: { principal_id: "alice", roles: ["goal_approver"] },
    method: "authenticated endpoint review",
    status: "approved"
  }), /owners cannot approve their own goal completion/i);

  const distinctApproval = authority.issueHumanApproval({
    ...context,
    authenticated_principal: { principal_id: "bob", roles: ["goal_approver"] },
    method: "authenticated endpoint review",
    status: "approved"
  });
  const verified = authority.verifyHumanApproval(distinctApproval, context);
  assert.equal(verified.approver_principal_id, "bob");
  assert.equal(verified.status, "approved");
});

test("principal-bound session ids cannot be shadowed or claimed by another tenant after restart", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-session-restart-"));
  const secret = "session-restart-isolation-secret";
  const start = async (port: number): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
      env: {
        ...process.env,
        OPERATOR_BACKEND_PORT: String(port),
        OPERATOR_AUTH_MODE: "principal_jwt",
        OPERATOR_JWT_SECRET: secret,
        OPERATOR_WORKSPACE_ROOT: workspace,
        OPERATOR_BRAIN: "rule"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    captureChildDiagnostics(child);
    assert.equal(await waitForServer(`http://127.0.0.1:${port}`, {}, child), true, "backend must report ready");
    return child;
  };

  const firstPort = await availablePort();
  const first = await start(firstPort);
  const aliceAuth = { authorization: `Bearer ${signJwt("alice", secret, "tenant-a")}` };
  const createdResponse = await fetch(`http://127.0.0.1:${firstPort}/session/new`, { method: "POST", headers: aliceAuth });
  assert.equal(createdResponse.status, 200);
  const sessionId = (await createdResponse.json() as { session_id: string }).session_id;
  assert.match(sessionId, /^ps1_[A-Za-z0-9_-]{20}_[0-9a-f-]{36}$/i);
  await stop(first);

  const secondPort = await availablePort();
  const second = await start(secondPort);
  t.after(async () => stop(second));
  const base = `http://127.0.0.1:${secondPort}`;
  const bobAuth = { authorization: `Bearer ${signJwt("bob", secret, "tenant-b")}` };

  const bobShadowAttempt = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(sessionId)}`, { headers: bobAuth });
  assert.equal(bobShadowAttempt.status, 403);
  assert.match(await bobShadowAttempt.text(), /not bound to this principal/i);

  const unboundLegacyId = "00000000-0000-4000-8000-000000000001";
  const aliceLegacyClaim = await fetch(`${base}/api/agent-goal?session_id=${unboundLegacyId}`, { headers: aliceAuth });
  assert.equal(aliceLegacyClaim.status, 403);

  const aliceResume = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(sessionId)}`, { headers: aliceAuth });
  assert.equal(aliceResume.status, 200);
});

test("shared-token local mode retains goal endpoint behavior without a multi-user principal", async t => {
  const port = await availablePort();
  const token = "local-goal-shared-token";
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_TOKEN: token,
      OPERATOR_WORKSPACE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goal-local-")),
      OPERATOR_BRAIN: "rule"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  captureChildDiagnostics(child);
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const tokenHeaders = { "x-operator-token": token };
  const jsonHeaders = { ...tokenHeaders, "content-type": "application/json" };
  assert.equal(await waitForServer(base, tokenHeaders, child), true, "backend must report ready");
  const sessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: tokenHeaders });
  assert.equal(sessionResponse.status, 200);
  const sessionId = (await sessionResponse.json() as { session_id: string }).session_id;
  const goalResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ session_id: sessionId, objective: "Local goal", success_criteria: ["Local behavior remains available."] })
  });
  assert.equal(goalResponse.status, 200);
  const readResponse = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(sessionId)}`, { headers: tokenHeaders });
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json() as { goal: { related_session_id: string } }).goal.related_session_id, sessionId);

  const autoSessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: tokenHeaders });
  assert.equal(autoSessionResponse.status, 200);
  const autoSessionId = (await autoSessionResponse.json() as { session_id: string }).session_id;
  const autoChatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: autoSessionId,
      message_id: "local-auto-goal-message",
      user_text: "Update all marked receptacles and verify the completed model changes."
    })
  });
  const autoChatBody = await autoChatResponse.text();
  assert.equal(autoChatResponse.status, 200, autoChatBody);
  const autoGoalResponse = await fetch(`${base}/api/agent-goal?session_id=${encodeURIComponent(autoSessionId)}`, { headers: tokenHeaders });
  assert.equal(autoGoalResponse.status, 200);
  const autoGoal = (await autoGoalResponse.json() as { goal: { created_by: string; work_budget: { source: string } } }).goal;
  assert.equal(autoGoal.created_by, "auto_goal:chat");
  assert.equal(autoGoal.work_budget.source, "chat");
});

test("hosted V2 principal identity is tenant-qualified while legacy matching remains session-fenced", () => {
  const principal = (tenant: string): RequestPrincipal => ({
    sub: "alice",
    user_id: "alice",
    tenant_id: tenant,
    license_id: tenant,
    roles: ["operator"],
    tier: null,
    claims: {}
  });
  const contextA: RequestContext = { principal: principal("tenant-a") };
  const contextB: RequestContext = { principal: principal("tenant-b") };
  const idA = getRequestAssignmentPrincipalId(contextA);
  const idB = getRequestAssignmentPrincipalId(contextB);
  assert.match(idA ?? "", /^ap1_[A-Za-z0-9_-]{43}$/);
  assert.match(idB ?? "", /^ap1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(idA, idB);
  assert.equal(requestMatchesAssignmentPrincipalId(idA!, contextA), true);
  assert.equal(requestMatchesAssignmentPrincipalId(idA!, contextB), false);

  const sessionA = createPrincipalBoundSessionIdForRequest(contextA.principal!, "legacy-v2-session");
  assert.equal(requestMatchesAssignmentPrincipalId("alice", contextA, sessionA), true);
  assert.equal(requestMatchesAssignmentPrincipalId("alice", contextB, sessionA), false);
});

test("shared-token local V2 checkpoint publishes the exact externally started Assignment", async t => {
  const port = await availablePort();
  const token = "local-v2-shared-token";
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "shared_token",
      OPERATOR_TOKEN: token,
      OPERATOR_WORKSPACE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goal-local-v2-")),
      OPERATOR_BRAIN: "rule",
      OPERATOR_ASSIGNMENT_KERNEL_V2: "1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  captureChildDiagnostics(child);
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const tokenHeaders = { "x-operator-token": token };
  const jsonHeaders = { ...tokenHeaders, "content-type": "application/json" };
  assert.equal(await waitForServer(base, tokenHeaders, child), true, "backend must report ready");
  const sessionResponse = await fetch(`${base}/session/new`, { method: "POST", headers: tokenHeaders });
  assert.equal(sessionResponse.status, 200);
  const sessionId = (await sessionResponse.json() as { session_id: string }).session_id;
  const goalResponse = await fetch(`${base}/api/agent-goal`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      session_id: sessionId,
      title: "Local V2 inventory",
      objective: "Return the requested inventory grouped by family and type.",
      success_criteria: ["The requested inventory is authoritatively returned."],
      work_budget: { requested_effect: "read" },
      start_assignment_run: true,
      assignment_run_id: "local-v2-http-run"
    })
  });
  const goalBody = await goalResponse.json() as { assignment_run?: { assignment_id: string; kernel_version: number } };
  assert.equal(goalResponse.status, 200, JSON.stringify(goalBody));
  assert.equal(goalBody.assignment_run?.kernel_version, 2);

  const v2IndexResponse = await fetch(`${base}/api/assignments/v2?session_id=${encodeURIComponent(sessionId)}`, { headers: tokenHeaders });
  assert.equal(v2IndexResponse.status, 200);
  const v2Index = await v2IndexResponse.json() as {
    assignment_kernel_v2_session_index: { assignments: Array<{ assignment_id: string; binding: { principal_id: string } }> };
  };
  assert.deepEqual(v2Index.assignment_kernel_v2_session_index.assignments.map(row => row.assignment_id), [goalBody.assignment_run?.assignment_id]);
  assert.equal(v2Index.assignment_kernel_v2_session_index.assignments[0]?.binding.principal_id, "local:shared-token");
  const exactV2Response = await fetch(
    `${base}/api/assignments/v2/${encodeURIComponent(v2Index.assignment_kernel_v2_session_index.assignments[0]!.assignment_id)}`,
    { headers: tokenHeaders }
  );
  assert.equal(exactV2Response.status, 200);
  assert.equal((await exactV2Response.json() as { assignment_kernel_v2: { snapshot: { current_binding: { principal_id: string } } } })
    .assignment_kernel_v2.snapshot.current_binding.principal_id, "local:shared-token");
});
