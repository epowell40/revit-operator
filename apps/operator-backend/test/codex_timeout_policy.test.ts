import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CODEX_TURN_TIMEOUT_MS, resolveCodexTurnTimeoutMs } from "../src/codex/timeout_policy.js";

test("Codex turns default to a long-horizon budget while remaining bounded", () => {
  assert.equal(DEFAULT_CODEX_TURN_TIMEOUT_MS, 900_000);
  assert.equal(resolveCodexTurnTimeoutMs(undefined), 900_000);
  assert.equal(resolveCodexTurnTimeoutMs("not-a-number"), 900_000);
  assert.equal(resolveCodexTurnTimeoutMs("30000"), 60_000);
  assert.equal(resolveCodexTurnTimeoutMs("1200000"), 1_200_000);
  assert.equal(resolveCodexTurnTimeoutMs("3600000"), 1_800_000);
});
