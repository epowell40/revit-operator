import assert from "node:assert/strict";
import test from "node:test";
import { settleTimedOutComputerRun } from "../src/benchmark/computer_run_settlement.js";

test("timed-out computer run is stopped and polled until it is idle", async () => {
  let stopped = false;
  let reads = 0;
  let clock = 0;
  const settlement = await settleTimedOutComputerRun({
    initialState: { running: true, messages: [{ id: "case-1" }] },
    stopRun: async () => { stopped = true; },
    readState: async () => ({ running: ++reads < 2, messages: [{ id: "case-1" }] }),
    settleTimeoutMs: 100,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (durationMs) => { clock += durationMs; }
  });
  assert.equal(stopped, true);
  assert.equal(settlement.stop_requested, true);
  assert.equal(settlement.became_idle, true);
  assert.equal(settlement.poll_count, 2);
  assert.deepEqual(settlement.state.messages, [{ id: "case-1" }]);
});

test("settlement reports an unquiesced run and stop/read errors without inventing idleness", async () => {
  let clock = 0;
  const settlement = await settleTimedOutComputerRun({
    initialState: { running: true },
    stopRun: async () => { throw new Error("stop unavailable"); },
    readState: async () => { throw new Error("state unavailable"); },
    settleTimeoutMs: 25,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (durationMs) => { clock += durationMs; }
  });
  assert.equal(settlement.became_idle, false);
  assert.equal(settlement.stop_error, "stop unavailable");
  assert.ok(settlement.state_errors.length >= 1);
  assert.equal(settlement.state.running, true);
});

test("already-idle state does not issue a stop request", async () => {
  let stopped = false;
  const settlement = await settleTimedOutComputerRun({
    initialState: { running: false },
    stopRun: async () => { stopped = true; },
    readState: async () => ({ running: false })
  });
  assert.equal(stopped, false);
  assert.equal(settlement.stop_requested, false);
  assert.equal(settlement.became_idle, true);
});

test("missing running state is not accepted as proof of idleness", async () => {
  let clock = 0;
  let stopped = false;
  const settlement = await settleTimedOutComputerRun({
    initialState: {},
    stopRun: async () => { stopped = true; },
    readState: async () => ({}),
    settleTimeoutMs: 25,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (durationMs) => { clock += durationMs; }
  });
  assert.equal(stopped, true);
  assert.equal(settlement.became_idle, false);
  assert.equal("running" in settlement.state, false);
});
