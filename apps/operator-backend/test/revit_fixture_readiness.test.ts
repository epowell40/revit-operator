import assert from "node:assert/strict";
import test from "node:test";
import { waitForExactRevitFixtureHealth } from "../src/benchmark/revit_fixture_readiness.js";

function health(title = ""): Record<string, unknown> {
  return { context: { document: title ? { title } : null } };
}

function fakeTime() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (durationMs: number) => { value += durationMs; }
  };
}

test("fixture readiness retries no-document observations and returns exact identity", async () => {
  const time = fakeTime();
  const observations = [health(), health(), health("Snowdon Towers Sample HVAC")];
  const result = await waitForExactRevitFixtureHealth({
    expectedDocumentTitle: "Snowdon Towers Sample HVAC",
    timeoutMs: 5_000,
    pollIntervalMs: 500,
    readHealth: async () => observations.shift() || health(),
    ...time
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.health, health("Snowdon Towers Sample HVAC"));
});

test("fixture readiness retries transient transport errors", async () => {
  const time = fakeTime();
  let attempts = 0;
  const result = await waitForExactRevitFixtureHealth({
    expectedDocumentTitle: "Snowdon Towers Sample HVAC",
    timeoutMs: 5_000,
    readHealth: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("GET /api/revit/health returned 503: temporarily unavailable");
      return health("Snowdon Towers Sample HVAC");
    },
    ...time
  });
  assert.equal(result.attempts, 2);
});

test("fixture readiness fails immediately on a different active model", async () => {
  const time = fakeTime();
  let attempts = 0;
  await assert.rejects(
    waitForExactRevitFixtureHealth({
      expectedDocumentTitle: "Snowdon Towers Sample HVAC",
      timeoutMs: 5_000,
      readHealth: async () => {
        attempts += 1;
        return health("Snowdon Towers Sample Plumbing");
      },
      ...time
    }),
    /expected active Revit document.*HVAC.*Plumbing/i
  );
  assert.equal(attempts, 1);
});

test("fixture readiness remains bounded when Revit never reports a document", async () => {
  const time = fakeTime();
  await assert.rejects(
    waitForExactRevitFixtureHealth({
      expectedDocumentTitle: "Snowdon Towers Sample HVAC",
      timeoutMs: 2_500,
      pollIntervalMs: 1_000,
      readHealth: async () => health(),
      ...time
    }),
    /exceeded 2500ms.*Snowdon Towers Sample HVAC.*no active document/i
  );
});
