import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexWorkerIdentity } from "../src/brains/codex_worker_identity.js";
import type { AgentModelSettings } from "../src/speed_config.js";

const settings: AgentModelSettings = { model: "gpt-6-astra", reasoning_effort: "medium" };
function fixture(run: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "operator-worker-identity-"));
  try { run(home); } finally {
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("operator-worker-identity-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
const write = (home: string, value: unknown) => fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(value));

test("worker identity reads only exact configured login discriminator and never claims authenticated status", () => fixture(home => {
  for (const [auth_mode, expected] of [["chatgpt", "chatgpt"], ["apikey", "api_key"]]) {
    write(home, { auth_mode, OPENAI_API_KEY: "fixture-key-secret", tokens: { access_token: "fixture-token-secret", account_id: "fixture-account-secret" }, email: "fixture@example.invalid" });
    const identity = readCodexWorkerIdentity({ codexHome: home, settings });
    assert.deepEqual(identity, { provider: "openai_codex", configured_billing_mode: expected,
      requested_model: "gpt-6-astra", requested_reasoning_effort: "medium", reported_model: null, reported_model_source: null });
    assert.ok(Object.isFrozen(identity));
    const serialized = JSON.stringify(identity);
    for (const forbidden of [home, "fixture-key-secret", "fixture-token-secret", "fixture-account-secret", "fixture@example.invalid", "auth.json", "authenticated"]) {
      assert.ok(!serialized.includes(forbidden));
    }
  }
}));

test("worker identity never infers billing from token or key presence, nested metadata, or approximate auth labels", () => fixture(home => {
  for (const auth of [{ OPENAI_API_KEY: "fixture-key" }, { tokens: { access_token: "fixture-token" } },
    { auth: { auth_mode: "chatgpt" } }, { auth_mode: "CHATGPT" }, { auth_mode: "api_key" }, { auth_mode: "chatgpt " },
    { auth_mode: null }, { auth_mode: { mode: "chatgpt" } }, ["chatgpt"], null, "chatgpt"]) {
    write(home, auth);
    assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "unknown");
  }
}));

test("worker identity fails closed for missing malformed oversized or non-file auth metadata", () => fixture(home => {
  const file = path.join(home, "auth.json");
  assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "unknown");
  fs.writeFileSync(file, '{"auth_mode":"chatgpt", "token":broken');
  assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "unknown");
  write(home, { auth_mode: "chatgpt", padding: "x".repeat(65_536) });
  assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "unknown");
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "unknown");
  assert.equal(readCodexWorkerIdentity({ codexHome: ".", settings }).configured_billing_mode, "unknown");
}));

test("worker identity uses the exact selected profile and refreshes only a newly captured attempt", () => fixture(home => {
  const other = path.join(home, "other"); fs.mkdirSync(other);
  write(home, { auth_mode: "chatgpt" }); write(other, { auth_mode: "apikey" });
  const selected = readCodexWorkerIdentity({ codexHome: home, settings });
  const alternate = readCodexWorkerIdentity({ codexHome: other, settings });
  assert.equal(selected.configured_billing_mode, "chatgpt"); assert.equal(alternate.configured_billing_mode, "api_key");
  write(home, { auth_mode: "apikey" });
  assert.equal(selected.configured_billing_mode, "chatgpt");
  assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "api_key");
}));

test("worker identity ignores unrelated environment credentials and billing selectors", () => fixture(home => {
  const prior = { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPERATOR_BRAIN: process.env.OPERATOR_BRAIN };
  try {
    process.env.CODEX_HOME = path.join(home, "unselected"); process.env.OPENAI_API_KEY = "fixture-key-env"; process.env.OPERATOR_BRAIN = "other";
    write(home, { auth_mode: "chatgpt" });
    assert.equal(readCodexWorkerIdentity({ codexHome: home, settings }).configured_billing_mode, "chatgpt");
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

test("worker identity is a copied request snapshot with no provider attestation or malformed metadata spill", () => fixture(home => {
  write(home, { auth_mode: "chatgpt" });
  const mutable: AgentModelSettings = { model: " gpt-6-astra ", reasoning_effort: "medium" };
  const snapshot = readCodexWorkerIdentity({ codexHome: home, settings: mutable });
  mutable.model = "gpt-5.6-sol"; mutable.reasoning_effort = "low";
  assert.equal(snapshot.requested_model, "gpt-6-astra"); assert.equal(snapshot.requested_reasoning_effort, "medium");
  assert.equal(snapshot.reported_model, null); assert.equal(snapshot.reported_model_source, null);
  for (const malformed of [{ model: "C:\\credential\\path", reasoning_effort: "fixture-token-secret" },
    { model: "fixture@example.invalid", reasoning_effort: "ultra" }, { model: "x".repeat(129), reasoning_effort: null }]) {
    const identity = readCodexWorkerIdentity({ codexHome: home, settings: malformed as unknown as AgentModelSettings });
    assert.equal(identity.requested_model, null); assert.equal(identity.requested_reasoning_effort, null);
  }
}));
