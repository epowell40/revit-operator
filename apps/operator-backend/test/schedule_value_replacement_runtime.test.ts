import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse,
  type ToolResult
} from "../src/contracts.js";
import { PersistenceManager } from "../src/persistence/persistence_manager.js";
import {
  __testOnlyClearScheduleValueReplacementStates,
  maybeRunDeterministicScheduleValueReplacement,
  type ScheduleValueReplacementContinuationStore
} from "../src/deterministic/schedule_value_replacement_runtime.js";
import { parseDirectScheduleValueReplacement } from "../src/schedule_value_replacement_intent.js";

const bulkText = 'please rename any equipment that includes "-G-" in it\'s designation so that it instead reads "-0-", so, for example, "B3-G-IA-01" needs to be renamed "B3-0-IA-01". please review all the plumbing schedules on P6.01, P6.02, P6.03, thanks.';
const singleText = "Attempt a single safe test edit using the active Revit model: On sheet P6.03, identify one equipment/schedule source item whose displayed designation contains '-G-' (prefer the Pump Schedule row MWV-G-RP-1 if editable), change only that designation token to '-0-' (MWV-0-RP-1), then read back the value.";
const fireDamperText = "Update all fire damper elements whose designation (or tag/mark identification field used in the fire damper schedule) contains the exact token '-G-' by replacing that token with '-0-'. Example: B2-G-F.D.-20 must become B2-0-F.D.-20. Scope only fire dampers, not other equipment. Determine the relevant category/family and writable parameter from the model/schedule. Report the number updated, a concise list of old → new designation values, affected schedule sheet number(s), and verify no fire damper designations still contain '-G-'.";

function request(session: string, userText: string, toolResults?: ToolResult[]): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: session,
    message_id: session + "-" + (toolResults?.length ?? 0),
    user_text: toolResults ? "" : userText,
    tool_results: toolResults
  };
}

function actionId(
  response: ChatResponse | null,
  stage: "schedule-discovery" | "preflight" | "apply"
): string {
  const id = response?.actions.find(action =>
    action.action_id.includes("-" + stage + "-")
  )?.action_id ?? "";
  assert.match(id, new RegExp("^schedule-value-replacement-" + stage + "-"));
  return id;
}

function result(
  action_id: string,
  pathValue: "/revit/schedules" | "/revit/replace-schedule-values",
  result_json: unknown,
  status: "done" | "failed" = "done"
): ToolResult {
  return { action_id, method: "POST", path: pathValue, status, result_json };
}

test("issues 391 and 392 parse into bounded bulk and one-item schedule replacement intents", () => {
  const bulk = parseDirectScheduleValueReplacement(bulkText);
  assert.deepEqual(bulk?.sheet_numbers, ["P6.01", "P6.02", "P6.03"]);
  assert.deepEqual(bulk?.field_names, ["DESIG", "Designation"]);
  assert.equal(bulk?.find, "-G-");
  assert.equal(bulk?.replace, "-0-");
  assert.equal(bulk?.expected_value, null);
  assert.equal(bulk?.max_changes, null);

  const single = parseDirectScheduleValueReplacement(singleText);
  assert.deepEqual(single?.sheet_numbers, ["P6.03"]);
  assert.equal(single?.expected_value, "MWV-G-RP-1");
  assert.equal(single?.max_changes, 1);
});

test("issue 432 parses into a bounded fire-damper schedule discovery intent", () => {
  const intent = parseDirectScheduleValueReplacement(fireDamperText);
  assert.deepEqual(intent?.sheet_numbers, []);
  assert.equal(intent?.schedule_query, "damper");
  assert.deepEqual(intent?.schedule_name_all_terms, ["fire", "damper"]);
  assert.deepEqual(intent?.field_names, ["DESIG", "Designation", "Mark"]);
  assert.equal(intent?.find, "-G-");
  assert.equal(intent?.replace, "-0-");
  assert.equal(intent?.confidence.ambiguity, "none");
});

test("issue 432 discovers only fire-damper schedules, hash-binds apply, and reports scope evidence", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const first = await maybeRunDeterministicScheduleValueReplacement(request("fire-damper", fireDamperText));
  const discoveryActionId = actionId(first, "schedule-discovery");
  assert.deepEqual(first?.actions[0]?.body, {
    action: "list",
    query: "damper",
    exact: false,
    max: 201
  });

  const second = await maybeRunDeterministicScheduleValueReplacement(request("fire-damper", fireDamperText, [
    result(discoveryActionId, "/revit/schedules", {
      status: "Ok",
      items: [
        { id: 701, name: "FIRE DAMPER SCHEDULE", categoryName: "Duct Accessories" },
        { id: 702, name: "SMOKE DAMPER SCHEDULE", categoryName: "Duct Accessories" },
        { id: 703, name: "FIRE/SMOKE DAMPER SCHEDULE", categoryName: "Duct Accessories" }
      ]
    })
  ]));
  const preflightActionId = actionId(second, "preflight");
  assert.deepEqual(second?.actions[0]?.body, {
    scheduleIds: [701, 703],
    fieldNames: ["DESIG", "Designation", "Mark"],
    valueContains: "-G-",
    replaceFrom: "-G-",
    replaceTo: "-0-",
    apply: false,
    dryRun: true,
    maxSchedules: 200,
    maxCandidates: 5000
  });

  const hash = "d".repeat(64);
  const third = await maybeRunDeterministicScheduleValueReplacement(request("fire-damper", fireDamperText, [
    result(preflightActionId, "/revit/replace-schedule-values", {
      status: "Dry Run",
      applied: false,
      planHash: hash,
      writableCandidateCount: 1
    })
  ]));
  const applyActionId = actionId(third, "apply");
  assert.deepEqual(third?.actions[0]?.body, {
    scheduleIds: [701, 703],
    fieldNames: ["DESIG", "Designation", "Mark"],
    valueContains: "-G-",
    replaceFrom: "-G-",
    replaceTo: "-0-",
    expectedPlanHash: hash,
    apply: true,
    dryRun: false,
    maxSchedules: 200,
    maxCandidates: 5000
  });

  const done = await maybeRunDeterministicScheduleValueReplacement(request("fire-damper", fireDamperText, [
    result(applyActionId, "/revit/replace-schedule-values", {
      status: "Applied and Verified",
      applied: true,
      verified: true,
      complete: true,
      changedCount: 1,
      remainingMatchCount: 0,
      verificationFailedCount: 0,
      changed: [{
        elementId: 4320,
        category: "Duct Accessories",
        familyName: "FIRE DAMPER",
        typeName: "14x14",
        parameterName: "DESIG.",
        before: "B2-G-F.D.-20",
        after: "B2-0-F.D.-20",
        schedules: [{ sheetNumber: "M6.01", sheetName: "FIRE DAMPER SCHEDULES", scheduleId: 701, scheduleName: "FIRE DAMPER SCHEDULE" }]
      }]
    })
  ]));
  assert.equal(done?.schedule_update_receipt?.status, "complete");
  assert.match(done?.assistant_message ?? "", /Category: Duct Accessories/);
  assert.match(done?.assistant_message ?? "", /Family: FIRE DAMPER/);
  assert.match(done?.assistant_message ?? "", /Parameter: DESIG\./);
  assert.match(done?.assistant_message ?? "", /Affected schedule sheets: M6\.01/);
  assert.match(done?.assistant_message ?? "", /B2-G-F\.D\.-20 -> B2-0-F\.D\.-20/);
  assert.match(done?.assistant_message ?? "", /Remaining '-G-' matches: 0/);
});

test("sheet-scoped replacement preflights, hash-binds apply, and reports exact verified changes", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const first = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText));
  const preflightActionId = actionId(first, "preflight");
  assert.deepEqual(first?.actions[0]?.body, {
    sheetNumbers: ["P6.01", "P6.02", "P6.03"],
    fieldNames: ["DESIG", "Designation"],
    valueContains: "-G-",
    replaceFrom: "-G-",
    replaceTo: "-0-",
    apply: false,
    dryRun: true,
    maxSchedules: 200,
    maxCandidates: 5000
  });

  const hash = "a".repeat(64);
  const second = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText, [
    result(preflightActionId, "/revit/replace-schedule-values", {
      status: "Dry Run",
      applied: false,
      planHash: hash,
      candidateCount: 2,
      writableCandidateCount: 2,
      blockedCandidateCount: 0
    })
  ]));
  const applyActionId = actionId(second, "apply");
  assert.deepEqual(second?.actions[0]?.body, {
    sheetNumbers: ["P6.01", "P6.02", "P6.03"],
    fieldNames: ["DESIG", "Designation"],
    valueContains: "-G-",
    replaceFrom: "-G-",
    replaceTo: "-0-",
    expectedPlanHash: hash,
    apply: true,
    dryRun: false,
    maxSchedules: 200,
    maxCandidates: 5000
  });

  const done = await maybeRunDeterministicScheduleValueReplacement(request("replace-success", bulkText, [
    result(applyActionId, "/revit/replace-schedule-values", {
      status: "Applied and Verified",
      applied: true,
      verified: true,
      complete: true,
      planHash: hash,
      changedCount: 2,
      remainingMatchCount: 0,
      verificationFailedCount: 0,
      changed: [
        { elementId: 101, parameterName: "Designation", before: "A-G-1", after: "A-0-1" },
        { elementId: 202, parameterName: "DESIG", before: "B-G-2", after: "B-0-2" }
      ]
    })
  ]));
  assert.equal(done?.schedule_update_receipt?.status, "complete");
  assert.match(done?.assistant_message ?? "", /101 Designation: A-G-1 -> A-0-1/);
  assert.match(done?.assistant_message ?? "", /Remaining '-G-' matches: 0/);
  assert.match(done?.assistant_message ?? "", /did not save or synchronize/);
});

test("one-item request carries exact old-value and max-change guards", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const first = await maybeRunDeterministicScheduleValueReplacement(request("replace-one", singleText));
  const preflightActionId = actionId(first, "preflight");
  assert.deepEqual(first?.actions[0]?.body, {
    sheetNumbers: ["P6.03"],
    fieldNames: ["DESIG", "Designation"],
    valueContains: "-G-",
    expectedValue: "MWV-G-RP-1",
    replaceFrom: "-G-",
    replaceTo: "-0-",
    maxChanges: 1,
    apply: false,
    dryRun: true,
    maxSchedules: 200,
    maxCandidates: 5000
  });
  const blocked = await maybeRunDeterministicScheduleValueReplacement(request("replace-one", singleText, [
    result(preflightActionId, "/revit/replace-schedule-values", {
      status: "Dry Run",
      applied: false,
      planHash: "b".repeat(64),
      writableCandidateCount: 2
    })
  ]));
  assert.equal(blocked?.actions.length, 0);
  assert.match(blocked?.assistant_message ?? "", /permits 1 change, but 2 writable matches/);
});

test("no matches is a verified no-op while unresolved matches prevent a completion claim", async () => {
  __testOnlyClearScheduleValueReplacementStates();
  const noneFirst = await maybeRunDeterministicScheduleValueReplacement(request("replace-none", bulkText));
  const nonePreflight = actionId(noneFirst, "preflight");
  const none = await maybeRunDeterministicScheduleValueReplacement(request("replace-none", bulkText, [
    result(nonePreflight, "/revit/replace-schedule-values", {
      status: "No Matches",
      verified: true,
      remainingMatchCount: 0
    })
  ]));
  assert.equal(none?.schedule_update_receipt?.status, "complete");
  assert.match(none?.assistant_message ?? "", /found no exact '-G-' matches/);

  __testOnlyClearScheduleValueReplacementStates();
  const partialFirst = await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText));
  const partialPreflight = actionId(partialFirst, "preflight");
  const partialApplyResponse = await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText, [
    result(partialPreflight, "/revit/replace-schedule-values", {
      status: "Dry Run",
      applied: false,
      planHash: "c".repeat(64),
      writableCandidateCount: 1
    })
  ]));
  const partialApply = actionId(partialApplyResponse, "apply");
  const partial = await maybeRunDeterministicScheduleValueReplacement(request("replace-partial", bulkText, [
    result(partialApply, "/revit/replace-schedule-values", {
      status: "Applied and Verified With Unresolved Matches",
      applied: true,
      verified: true,
      complete: false,
      changedCount: 1,
      remainingMatchCount: 3,
      verificationFailedCount: 0
    })
  ]));
  assert.equal(partial?.schedule_update_receipt?.status, "failed");
  assert.match(partial?.assistant_message ?? "", /3 matching schedule-backed values remain unresolved/);
});

test("schedule replacement rehydrates after a persistence-manager replacement", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-value-replacement-restart-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const first = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-restart", bulkText),
      undefined,
      new PersistenceManager()
    );
    const preflight = actionId(first, "preflight");
    const second = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-restart", bulkText, [
        result(preflight, "/revit/replace-schedule-values", {
          status: "Dry Run",
          applied: false,
          planHash: "e".repeat(64),
          writableCandidateCount: 2
        })
      ]),
      undefined,
      new PersistenceManager()
    );
    const apply = actionId(second, "apply");
    const done = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-restart", bulkText, [
        result(apply, "/revit/replace-schedule-values", {
          status: "Applied and Verified",
          applied: true,
          verified: true,
          complete: true,
          planHash: "e".repeat(64),
          changedCount: 2,
          remainingMatchCount: 0,
          verificationFailedCount: 0
        })
      ]),
      undefined,
      new PersistenceManager()
    );
    assert.equal(done?.schedule_update_receipt?.status, "complete");
    assert.equal(
      fs.existsSync(path.join(root, "runs", "sessions", "schedule-value-restart", "mutation_continuations", "schedule-value-replacement.json")),
      false
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and expired persisted replacements fail closed", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-value-replacement-invalid-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const store = new PersistenceManager();
    store.writeMutationContinuation({
      sessionId: "schedule-value-malformed",
      operationId: "schedule-value-replacement",
      kind: "revit.schedule-value-replacement",
      expiresAt: Date.now() + 60_000,
      state: {}
    });
    const malformed = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-malformed", bulkText, [
        result("schedule-value-replacement-preflight", "/revit/replace-schedule-values", {})
      ]),
      undefined,
      new PersistenceManager()
    );
    assert.equal(malformed?.schedule_update_receipt?.status, "failed");
    assert.match(malformed?.assistant_message ?? "", /quarantined/i);
    assert.equal(
      store.readMutationContinuation<{ stage?: string }>({
        sessionId: "schedule-value-malformed",
        operationId: "schedule-value-replacement"
      })?.state.stage,
      "quarantined"
    );

    const unreadablePath = path.join(
      root,
      "runs",
      "sessions",
      "schedule-value-unreadable",
      "mutation_continuations",
      "schedule-value-replacement.json"
    );
    fs.mkdirSync(path.dirname(unreadablePath), { recursive: true });
    fs.writeFileSync(unreadablePath, "{", "utf8");
    const unreadable = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-unreadable", bulkText, [
        result("schedule-value-replacement-preflight", "/revit/replace-schedule-values", {})
      ]),
      undefined,
      new PersistenceManager()
    );
    assert.equal(unreadable?.schedule_update_receipt?.status, "failed");
    assert.match(unreadable?.assistant_message ?? "", /quarantined/i);
    assert.equal(
      store.readMutationContinuation<{ stage?: string }>({
        sessionId: "schedule-value-unreadable",
        operationId: "schedule-value-replacement"
      })?.state.stage,
      "quarantined"
    );

    const expiredSeed = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-expired", bulkText),
      undefined,
      store
    );
    const expiredPreflight = actionId(expiredSeed, "preflight");
    const seeded = store.readMutationContinuation<Record<string, unknown>>({
      sessionId: "schedule-value-expired",
      operationId: "schedule-value-replacement"
    });
    assert.ok(seeded);
    store.writeMutationContinuation({
      sessionId: "schedule-value-expired",
      operationId: "schedule-value-replacement",
      kind: "revit.schedule-value-replacement",
      expiresAt: Date.now() - 1,
      state: { ...(seeded.state as Record<string, unknown>), expires_at: Date.now() - 1 }
    });
    const expired = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-expired", bulkText, [
        result(expiredPreflight, "/revit/replace-schedule-values", {})
      ]),
      undefined,
      new PersistenceManager()
    );
    assert.equal(expired?.schedule_update_receipt?.status, "failed");
    assert.match(expired?.assistant_message ?? "", /expired or was lost/i);
    assert.equal(
      store.readMutationContinuation({
        sessionId: "schedule-value-expired",
        operationId: "schedule-value-replacement"
      }),
      null
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("schedule replacement action ids reject overlap and delayed prior results", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-value-replacement-correlation-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const first = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText));
    const firstPreflight = actionId(first, "preflight");
    const overlap = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText));
    assert.equal(overlap?.schedule_update_receipt?.status, "blocked");
    const firstApplyResponse = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText, [
      result(firstPreflight, "/revit/replace-schedule-values", {
        status: "Dry Run",
        applied: false,
        planHash: "f".repeat(64),
        writableCandidateCount: 1
      })
    ]));
    const firstApply = actionId(firstApplyResponse, "apply");
    const firstDone = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText, [
      result(firstApply, "/revit/replace-schedule-values", {
        status: "Applied and Verified",
        applied: true,
        verified: true,
        complete: true,
        planHash: "f".repeat(64),
        changedCount: 1,
        remainingMatchCount: 0,
        verificationFailedCount: 0
      })
    ]));
    assert.equal(firstDone?.schedule_update_receipt?.status, "complete");

    const second = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText));
    const secondPreflight = actionId(second, "preflight");
    assert.notEqual(secondPreflight, firstPreflight);
    const stale = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText, [
      result(firstPreflight, "/revit/replace-schedule-values", {
        status: "Dry Run",
        applied: false,
        planHash: "1".repeat(64),
        writableCandidateCount: 1
      })
    ]));
    assert.equal(stale?.schedule_update_receipt, undefined);
    assert.match(stale?.assistant_message ?? "", /non-terminal/i);
    assert.match(stale?.assistant_message ?? "", /unexpected continuation/i);

    const valid = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText, [
      result(secondPreflight, "/revit/replace-schedule-values", {
        status: "Dry Run",
        applied: false,
        planHash: "2".repeat(64),
        writableCandidateCount: 1
      })
    ]));
    const secondApply = actionId(valid, "apply");
    const secondDone = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-correlation", bulkText, [
      result(secondApply, "/revit/replace-schedule-values", {
        status: "Applied and Verified",
        applied: true,
        verified: true,
        complete: true,
        planHash: "2".repeat(64),
        changedCount: 1,
        remainingMatchCount: 0,
        verificationFailedCount: 0
      })
    ]));
    assert.equal(secondDone?.schedule_update_receipt?.status, "complete");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent schedule replacement requests have one owner and one terminal completion", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-value-replacement-concurrent-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const [first, second] = await Promise.all([
      maybeRunDeterministicScheduleValueReplacement(request("schedule-value-concurrent", bulkText)),
      maybeRunDeterministicScheduleValueReplacement(request("schedule-value-concurrent", bulkText))
    ]);
    const owners = [first, second].filter(item => (item?.actions.length ?? 0) > 0);
    assert.equal(owners.length, 1);
    assert.equal([first, second].filter(item => item?.schedule_update_receipt?.status === "blocked").length, 1);
    const preflight = actionId(owners[0] ?? null, "preflight");
    const applyResponse = await maybeRunDeterministicScheduleValueReplacement(request("schedule-value-concurrent", bulkText, [
      result(preflight, "/revit/replace-schedule-values", {
        status: "Dry Run",
        applied: false,
        planHash: "3".repeat(64),
        writableCandidateCount: 1
      })
    ]));
    const apply = actionId(applyResponse, "apply");
    const [done, duplicate] = await Promise.all([
      maybeRunDeterministicScheduleValueReplacement(request("schedule-value-concurrent", bulkText, [
        result(apply, "/revit/replace-schedule-values", {
          status: "Applied and Verified",
          applied: true,
          verified: true,
          complete: true,
          planHash: "3".repeat(64),
          changedCount: 1,
          remainingMatchCount: 0,
          verificationFailedCount: 0
        })
      ])),
      maybeRunDeterministicScheduleValueReplacement(request("schedule-value-concurrent", bulkText, [
        result(apply, "/revit/replace-schedule-values", {
          status: "Applied and Verified",
          applied: true,
          verified: true,
          complete: true,
          planHash: "3".repeat(64),
          changedCount: 1,
          remainingMatchCount: 0,
          verificationFailedCount: 0
        })
      ]))
    ]);
    assert.equal([done, duplicate].filter(item => item?.schedule_update_receipt?.status === "complete").length, 1);
    assert.equal([done, duplicate].filter(item => item?.schedule_update_receipt?.status === "failed").length, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed continuation cleanup quarantines instead of allowing replay", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-value-replacement-quarantine-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const inner = new PersistenceManager();
    const store: ScheduleValueReplacementContinuationStore = {
      createMutationContinuation: inner.createMutationContinuation.bind(inner),
      replaceMutationContinuation: inner.replaceMutationContinuation.bind(inner),
      readMutationContinuation: inner.readMutationContinuation.bind(inner),
      deleteMutationContinuation: () => {
        throw new Error("delete denied");
      },
      quarantineMalformedMutationContinuation: inner.quarantineMalformedMutationContinuation.bind(inner)
    };
    const first = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-quarantine", singleText),
      undefined,
      store
    );
    const preflight = actionId(first, "preflight");
    const failed = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-quarantine", singleText, [
        result(preflight, "/revit/replace-schedule-values", {
          status: "Ambiguous",
          applied: false,
          blockedReason: "ambiguous"
        })
      ]),
      undefined,
      store
    );
    assert.equal(failed?.schedule_update_receipt?.status, "failed");
    const replay = await maybeRunDeterministicScheduleValueReplacement(
      request("schedule-value-quarantine", singleText, [
        result(preflight, "/revit/replace-schedule-values", {
          status: "Ambiguous",
          applied: false,
          blockedReason: "ambiguous"
        })
      ]),
      undefined,
      store
    );
    assert.equal(replay?.schedule_update_receipt?.status, "failed");
    assert.match(replay?.assistant_message ?? "", /quarantined/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary sheet detail results cannot revive an unrelated MEP redline attachment", async () => {
  const { __testOnlyIsMepRouteContinuationToolResult } = await import("../src/deterministic/mep_route_redline.js");
  assert.equal(__testOnlyIsMepRouteContinuationToolResult({
    action_id: "sheet_p601",
    method: "POST",
    path: "/revit/sheets",
    status: "done",
    result_json: { action: "detail", sheetNumber: "P6.01" }
  }), false);
  assert.equal(__testOnlyIsMepRouteContinuationToolResult({
    action_id: "mep-route-sheet-123",
    method: "POST",
    path: "/revit/sheets",
    status: "done",
    result_json: { action: "detail", sheetNumber: "M104" }
  }), true);
});
