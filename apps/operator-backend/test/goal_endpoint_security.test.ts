import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { authenticateRequest, resolveAuthMode } from "../src/auth.js";

function signJwt(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const headerPart = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payloadPart = Buffer.from(JSON.stringify({
    sub: userId,
    user_id: userId,
    license_id: "license-shared",
    roles: ["user"],
    tier: "pro",
    iat: now - 5,
    exp: now + 300
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

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

async function waitForServer(base: string, headers: Record<string, string>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { headers });
      if (response.ok) return;
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Backend did not become ready.");
}

test("JWT mode resolves a verified principal while shared-token no-principal behavior remains intact", () => {
  const previousMode = process.env.OPERATOR_AUTH_MODE;
  const previousSecret = process.env.OPERATOR_CLASHPILOT_JWT_SECRET;
  const previousIssuer = process.env.OPERATOR_CLASHPILOT_JWT_ISSUER;
  const previousAudience = process.env.OPERATOR_CLASHPILOT_JWT_AUDIENCE;
  try {
    process.env.OPERATOR_AUTH_MODE = "clashpilot_jwt";
    process.env.OPERATOR_CLASHPILOT_JWT_SECRET = "goal-auth-unit-secret";
    delete process.env.OPERATOR_CLASHPILOT_JWT_ISSUER;
    delete process.env.OPERATOR_CLASHPILOT_JWT_AUDIENCE;
    assert.equal(resolveAuthMode(), "clashpilot_jwt");
    const token = signJwt("alice", process.env.OPERATOR_CLASHPILOT_JWT_SECRET);
    const authenticated = authenticateRequest(
      { headers: { authorization: `Bearer ${token}` } } as any,
      { mode: "clashpilot_jwt", requireAuth: true, sharedToken: "" }
    );
    assert.equal(authenticated.ok, true);
    if (authenticated.ok) {
      assert.equal(authenticated.principal?.user_id, "alice");
      assert.equal(authenticated.principal?.license_id, "license-shared");
    }

    const missing = authenticateRequest({ headers: {} } as any, { mode: "clashpilot_jwt", requireAuth: true, sharedToken: "" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);

    const local = authenticateRequest({ headers: {} } as any, { mode: "shared_token", requireAuth: false, sharedToken: "" });
    assert.equal(local.ok, true);
    if (local.ok) assert.equal(local.principal, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.OPERATOR_AUTH_MODE;
    else process.env.OPERATOR_AUTH_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.OPERATOR_CLASHPILOT_JWT_SECRET;
    else process.env.OPERATOR_CLASHPILOT_JWT_SECRET = previousSecret;
    if (previousIssuer === undefined) delete process.env.OPERATOR_CLASHPILOT_JWT_ISSUER;
    else process.env.OPERATOR_CLASHPILOT_JWT_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.OPERATOR_CLASHPILOT_JWT_AUDIENCE;
    else process.env.OPERATOR_CLASHPILOT_JWT_AUDIENCE = previousAudience;
  }
});

test("goal endpoints authenticate JWT callers and isolate principals, workspaces, and sessions", async t => {
  const port = await availablePort();
  const secret = "goal-endpoint-security-secret";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-goal-security-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "index.js")], {
    env: {
      ...process.env,
      OPERATOR_BACKEND_PORT: String(port),
      OPERATOR_AUTH_MODE: "clashpilot_jwt",
      OPERATOR_CLASHPILOT_JWT_SECRET: secret,
      OPERATOR_CLASHPILOT_JWT_ISSUER: "",
      OPERATOR_CLASHPILOT_JWT_AUDIENCE: "",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_BRAIN: "rule"
    },
    stdio: "ignore"
  });
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const aliceAuth = `Bearer ${signJwt("alice", secret)}`;
  const bobAuth = `Bearer ${signJwt("bob", secret)}`;
  const headers = (authorization: string) => ({ authorization, "content-type": "application/json" });
  await waitForServer(base, { authorization: aliceAuth });

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
    stdio: "ignore"
  });
  t.after(async () => stop(child));

  const base = `http://127.0.0.1:${port}`;
  const tokenHeaders = { "x-operator-token": token };
  const jsonHeaders = { ...tokenHeaders, "content-type": "application/json" };
  await waitForServer(base, tokenHeaders);
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
});
