import { canonicalJson, sha256Value } from "../src/canonical_json_hash.js";
import { canonicalJson as protocolCanonicalJson, sha256Value as protocolSha256Value } from "../src/benchmark/protocol_v2_hash.js";
import { createGeneralRevitRequest } from "../src/benchmark/general_revit_request.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { benchmarkInstructionRuntime } from "../src/codex/benchmark_instruction_runtime.js";
import { hostInstructionBinding } from "../src/codex/instruction_binding.js";
import { assertGeneralRevitInstructionRuntime, benchmarkInstructionExpectation, loadCaseInstructionTurns } from "../src/benchmark/general_revit_instruction_preflight.js";

test("scored preflight requires matching process-bound configured envelope before any provider work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instruction-readiness-"));
  const file = path.join(root, "private-envelope.json");
  const draft = { schema: "revit-operator.benchmark-run-envelope/v2", identity: { run_id: "run-a" },
    instruction_bundle_hashes: hostInstructionBinding({ baseInstructions: "private prompt", developerInstructions: "private skills" }) };
  const expected = benchmarkInstructionExpectation(draft);
  let providerCalls = 0;
  const admit = (health: unknown) => { assertGeneralRevitInstructionRuntime(health, expected); providerCalls++; };
  try {
    const unset = benchmarkInstructionRuntime({});
    assert.equal(unset.configured, false);
    for (const health of [{}, { backend: { benchmark_instruction_runtime: unset } }, { backend: { benchmark_instruction_runtime: expected } }]) {
      assert.throws(() => admit(health), /stopped before scored provider work/);
    }
    assert.equal(providerCalls, 0);
    fs.writeFileSync(file, JSON.stringify(draft));
    const configured = benchmarkInstructionRuntime({ OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH: file });
    admit({ backend: { benchmark_instruction_runtime: configured } });
    assert.equal(providerCalls, 1);
    assert.ok(configured.backend_instance_id && configured.process_id > 0);
    assert.doesNotMatch(JSON.stringify(configured), /private prompt|private skills|private-envelope|instruction-readiness/);
    fs.writeFileSync(file, JSON.stringify({ ...draft, identity: { run_id: "run-b" } }));
    const changed = benchmarkInstructionRuntime({ OPERATOR_BENCHMARK_INSTRUCTION_ENVELOPE_PATH: file });
    assert.equal(changed.backend_instance_id, configured.backend_instance_id);
    assert.notEqual(changed.envelope_sha256, configured.envelope_sha256);
    assert.throws(() => admit({ backend: { benchmark_instruction_runtime: changed } }), /stopped before scored provider work/);
    assert.equal(providerCalls, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("case collection is scoped to exact session and start time and reports incomplete reads honestly", async () => {
  const startedAt = "2026-09-07T00:00:00.000Z";
  const turns = [{ session_id: "session-a", turn_id: "turn-a" }];
  const result = await loadCaseInstructionTurns("http://sidecar", "session-a", startedAt, async (_base, route) => {
    const url = new URL(route, "http://sidecar");
    assert.equal(url.pathname, "/api/codex/instruction-bindings");
    assert.equal(url.searchParams.get("session_id"), "session-a");
    assert.equal(url.searchParams.get("started_at"), startedAt);
    return { session_id: "session-a", turns, complete: true };
  });
  assert.deepEqual(result, { host_instruction_turns: turns, host_instruction_turns_complete: true });
  for (const response of [{ session_id: "other", turns, complete: true }, { session_id: "session-a", turns, complete: false }, {}]) {
    assert.equal((await loadCaseInstructionTurns("http://sidecar", "session-a", startedAt, async () => response)).host_instruction_turns_complete, false);
  }
  assert.equal((await loadCaseInstructionTurns("http://sidecar", "session-a", startedAt, async () => { throw new Error("offline"); })).host_instruction_turns_complete, false);
});

test("actual request adapter rechecks instruction runtime before interactive continuation and fixture provider work", async () => {
  const expected = { envelope_sha256: "a".repeat(64), run_id: "run", prompt_sha256: "b".repeat(64), system_instruction_sha256: "c".repeat(64) };
  let configured = true;
  let paidPosts = 0;
  const request = createGeneralRevitRequest(() => expected, async input => {
      const url = new URL(String(input));
      if (url.pathname === "/api/backend/health") return new Response(JSON.stringify({ backend: { benchmark_instruction_runtime: {
        ...expected, schema: "revit-operator.benchmark-instruction-runtime/v1", configured, status: configured ? "configured" : "unset",
        backend_instance_id: "12345678-1234-1234-1234-123456789abc", process_id: 123
      } } }));
      paidPosts++;
      return new Response("{}");
  });
  await request("http://sidecar", "/api/computer/run", { method: "POST", body: "{}" });
  assert.equal(paidPosts, 1);
  configured = false;
  for (const route of ["/api/computer/run", "/api/chat", "/api/chat/stream"]) {
    await assert.rejects(request("http://sidecar", route, { method: "POST", body: "{}" }), /stopped before scored provider work/);
  }
  assert.equal(paidPosts, 1, "backend restart without configured identity must not admit continuation");
});

test("shared runtime hashing preserves protocol identity and nested canonical ordering", () => {
  const value = { z: [3, { b: 2, a: 1 }], a: { d: "text", c: null } };
  assert.equal(canonicalJson, protocolCanonicalJson);
  assert.equal(sha256Value, protocolSha256Value);
  assert.equal(canonicalJson(value), '{"a":{"c":null,"d":"text"},"z":[3,{"a":1,"b":2}]}');
  assert.equal(sha256Value(value), "8023d3411df5144878f5ea360648a920d9e8ac0f7e7b1415d5e4c3ecda0c9a19");
  assert.equal(sha256Value({ a: { c: null, d: "text" }, z: [3, { a: 1, b: 2 }] }), sha256Value(value));
  assert.notEqual(sha256Value({ ...value, z: [{ a: 1, b: 2 }, 3] }), sha256Value(value));
});
