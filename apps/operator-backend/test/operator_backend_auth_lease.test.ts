import test from "node:test";
import assert from "node:assert/strict";
import { OperatorBackendAuthLeaseRegistry } from "../src/codex/operator_backend_auth_lease.js";
import { OPERATOR_BACKEND_AUTH_V1, type OperatorBackendAuthV1 } from "../src/operator_backend_auth.js";

function auth(credential: string): OperatorBackendAuthV1 {
  return {
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode: "principal_jwt",
    credential,
    allowed_origin: "https://operator.example"
  };
}

test("auth lease is available before provider tool dispatch and remains exact after turn binding", () => {
  const registry = new OperatorBackendAuthLeaseRegistry();
  const lease = registry.begin("session-a", auth("principal-a"));
  assert.equal(registry.resolve(undefined, "session-a").credential, "principal-a");
  registry.bindTurn(lease, "turn-a");
  assert.equal(registry.resolve("turn-a", "session-a").credential, "principal-a");
});

test("auth leases isolate sessions and turns and are unavailable after cleanup", () => {
  const registry = new OperatorBackendAuthLeaseRegistry();
  const alice = registry.begin("session-a", auth("principal-a"));
  const bob = registry.begin("session-b", auth("principal-b"));
  registry.bindTurn(alice, "turn-a");
  registry.bindTurn(bob, "turn-b");
  assert.throws(() => registry.resolve("turn-a", "session-b"), /session binding/);
  assert.equal(registry.resolve("turn-b", "session-b").credential, "principal-b");
  registry.end(alice);
  assert.throws(() => registry.resolve("turn-a", "session-a"), /not bound/);
});

test("ambiguous unbound leases fail closed instead of guessing a credential", () => {
  const registry = new OperatorBackendAuthLeaseRegistry();
  registry.begin("session-a", auth("first"));
  registry.begin("session-a", auth("second"));
  assert.throws(() => registry.resolve(undefined, "session-a"), /not bound/);
});
