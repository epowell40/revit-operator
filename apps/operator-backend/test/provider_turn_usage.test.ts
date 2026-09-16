import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderUsageCoverageV1 as coverage, createProviderUsageLedgerV1, parseProviderTurnUsageV1,
  PROVIDER_TURN_USAGE_V1_SCHEMA as schema } from "@revitoperator/assignment-kernel-v2-contracts/provider-turn-usage";

const usage = (message = "message-a", turn = "turn-a", ids = ["response-a"]) => ({
  schema, session_id: "session-a", message_id: message, thread_id: "thread-a",
  turn_id: turn, disposition: "interrupted", raw_response_ids: ids
});
const attempt = (value: ReturnType<typeof usage> | null = usage(), message = "message-a") => ({
  session_id: "session-a", message_id: message, provider_turn_usage: value
});
const receipt = { provider: "openai", route: "codex_agent", call_id: "response-a", turn_id: "turn-a" };

test("host attempt ledger preserves transport loss, recovers exact metadata and quarantines contradictions", () => {
  const ledger = createProviderUsageLedgerV1();
  ledger.observe("session-a", "message-a", { provider_turn_usage: usage() });
  assert.equal(ledger.snapshot([receipt]).request_count, 0);
  ledger.begin("session-a", "message-a");
  ledger.observe("session-a", "message-a", new Error("connection lost"));
  assert.equal(ledger.snapshot([receipt]).complete, false);
  ledger.observe("session-a", "message-a", { provider_turn_usage: usage() });
  ledger.observe("session-a", "message-a", { provider_turn_usage: usage() });
  assert.equal(ledger.snapshot([receipt]).complete, true);
  ledger.observe("session-a", "message-a", { provider_turn_usage: usage("message-a", "wrong-turn") });
  ledger.observe("session-a", "message-a", { provider_turn_usage: usage() });
  assert.equal(ledger.snapshot([receipt]).complete, false);
  assert.equal(ledger.snapshot([receipt]).attempts[0]!.conflicted, true);
});

test("interrupted turn coverage retains exact receipts and cannot hide a later lost response", () => {
  assert.equal(coverage([attempt()], [receipt]).complete, true);
  const missing = coverage([attempt(), attempt(null, "message-b")], [receipt]);
  assert.equal(missing.complete, false);
  assert.equal(missing.request_count, 2);
  assert.equal(missing.attempts[0]!.complete, true);
  assert.equal(missing.attempts[1]!.complete, false);
  assert.equal(coverage([attempt(usage("message-a", "turn-a", []))], []).complete, false);
});

test("provider coverage rejects wrong identities, duplicate turns, conflicts and unassigned receipts", () => {
  for (const row of [attempt(usage("wrong")), { ...attempt(), conflicted: true }, attempt(null)]) {
    assert.equal(coverage([row], [receipt]).complete, false);
  }
  assert.equal(coverage([attempt(), attempt()], [receipt]).complete, false);
  assert.equal(coverage([attempt()], [{ ...receipt, turn_id: "wrong" }]).complete, false);
  assert.equal(coverage([attempt()], [{ ...receipt, provider: "wrong" }]).complete, false);
  assert.equal(coverage([attempt()], [receipt, { ...receipt, call_id: "unassigned" }]).complete, false);
  assert.deepEqual(coverage([attempt()], []).attempts[0]!.missing_raw_response_ids, ["response-a"]);
});

test("only explicit bound no-start records support no provider invocation; absent history is unknown", () => {
  const stopped = { ...usage(), disposition: "not_started", thread_id: null, turn_id: null, raw_response_ids: [] };
  const row = { session_id: "session-a", message_id: "message-a", provider_turn_usage: stopped };
  assert.equal(coverage([row], []).no_provider_invocation, true);
  assert.equal(coverage([], []).complete, false);
  assert.equal(coverage([row], undefined).complete, false);
  assert.equal(coverage([row], [receipt]).complete, false);
  assert.throws(() => parseProviderTurnUsageV1({ ...stopped, raw_response_ids: ["invented"] }));
  assert.throws(() => parseProviderTurnUsageV1({ ...usage(), raw_response_ids: ["same", "same"] }));
  assert.throws(() => parseProviderTurnUsageV1({ ...usage(), message_id: "bad\nidentity" }));
  assert.equal(coverage(Array.from({ length: 1001 }, () => row), []).complete, false);
});
