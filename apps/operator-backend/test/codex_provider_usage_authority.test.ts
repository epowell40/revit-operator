import assert from "node:assert/strict";
import test from "node:test";
import { CodexTurnCompletions } from "../src/codex/turn_completions.js";
import { CodexTurnFailedError } from "../src/codex/turn_error.js";

async function failed(turns: CodexTurnCompletions, id = "turn") {
  turns.observe("thread", id, "failed", { message: "Limit reached", codexErrorInfo: "usageLimitExceeded" });
  return turns.wait({ threadId: "thread", turnId: id, timeoutMs: 0 }).catch(error => error);
}

test("only a failure issued by this current completion transport is authoritative", async () => {
  const turns = new CodexTurnCompletions();
  const error = await failed(turns);
  assert.equal((turns as any).isCurrentFailure(error), true);
  assert.equal(Object.isFrozen(error), true);
  assert.equal((turns as any).isCurrentFailure(new CodexTurnFailedError("thread", "turn", {
    message: error.message, codexErrorInfo: "usageLimitExceeded"
  })), false, "a constructed lookalike is not an observed failure");
  assert.equal((new CodexTurnCompletions() as any).isCurrentFailure(error), false);
  assert.equal((turns as any).isCurrentFailure(new Error("usageLimitExceeded")), false);
});

test("reset and contradictory completion revoke an issued failure before hold admission", async () => {
  const turns = new CodexTurnCompletions();
  const prior = await failed(turns);
  turns.reset(new Error("transport replaced"));
  await failed(turns);
  assert.equal((turns as any).isCurrentFailure(prior), false, "same IDs in a replacement transport cannot revive old authority");
  const conflicting = await failed(turns, "conflict");
  turns.observe("thread", "conflict", "failed", { message: "Rate limit", codexErrorInfo: "rateLimitExceeded" });
  assert.equal((turns as any).isCurrentFailure(conflicting), false);
  turns.observe("thread", "conflict", "failed", { message: "Limit reached", codexErrorInfo: "usageLimitExceeded" });
  assert.equal((turns as any).isCurrentFailure(conflicting), false);
});

test("identical completion redelivery retains authority before admission and during settlement", async () => {
  const turns = new CodexTurnCompletions();
  const error = await failed(turns);
  turns.observe("thread", "turn", "failed", { message: "New diagnostic, same normalized code", codexErrorInfo: "usageLimitExceeded" });
  assert.equal(turns.isCurrentFailure(error), true, "redelivery before hold admission is still authoritative");
  await Promise.resolve();
  turns.observe("thread", "turn", "failed", { message: "Repeated during cleanup", codexErrorInfo: "usageLimitExceeded" });
  assert.equal(turns.isCurrentFailure(error), true, "redelivery during settlement cannot convert a hold to terminal failure");
  turns.observe("thread", "turn", "completed");
  assert.equal(turns.isCurrentFailure(error), false, "a status conflict still revokes authority");
});
