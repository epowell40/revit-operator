import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertEpic0437DiscardArchiveFacts, publishEpic0437DiscardArchive, resolveTrustedWindowsTasklist, type Epic0437DiscardArchiveFacts } from "./epic0437DiscardArchive.js";

const pristine = `sha256:${"5".repeat(64)}`;
function facts(): Epic0437DiscardArchiveFacts {
  const root = "C:\\Evidence\\DisposableModels";
  const model = `${root}\\${"a".repeat(32)}\\Snowdon Towers Sample HVAC.rvt`;
  const runs = "C:\\Repo\\artifacts\\certification\\epic-0437\\runs";
  const recovery = `${runs}\\run.recovery.json`;
  return {
    revitRunning: false, requestedRecoveryPath: recovery, recoveryRealPath: recovery, runsRootRealPath: runs,
    recoveryIsRegularFile: true, recoveryIsRedirect: false,
    disposableModelPath: model, disposableModelRealPath: model, disposableRootRealPath: root,
    disposableHasRedirectComponent: false, disposableSha256: pristine, expectedPristineSha256: pristine,
    state: { schema: "revit-operator.epic-0437-move-recovery.v2", state: "host_restart_discard_required",
      retryable: false, outcome_unknown: true, disposable_model_path: model, disposable_model_sha256: pristine }
  };
}

test("discard archive validator rejects running Revit, redirects, stale bytes, and wrong state", () => {
  assert.doesNotThrow(() => assertEpic0437DiscardArchiveFacts(facts()));
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), revitRunning: true }), /still running/);
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), recoveryIsRedirect: true }), /escapes or redirects/);
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), recoveryRealPath: "C:\\Repo\\elsewhere\\run.json" }), /escapes or redirects/);
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), disposableHasRedirectComponent: true }), /non-redirected/);
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), disposableSha256: `sha256:${"0".repeat(64)}` }), /exact pristine/);
  assert.throws(() => assertEpic0437DiscardArchiveFacts({ ...facts(), state: { ...facts().state, state: "restored" } }), /exact non-promotable/);
});

test("discard archive publication cannot overwrite and leaves recovery blocking on collision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic-0437-discard-"));
  const recovery = path.join(root, "run.recovery.json");
  const archive = path.join(root, "run.discarded.json");
  fs.writeFileSync(recovery, "recovery", "utf8");
  fs.writeFileSync(archive, "existing", "utf8");
  assert.throws(() => publishEpic0437DiscardArchive(recovery, archive), /already exists/);
  assert.equal(fs.readFileSync(recovery, "utf8"), "recovery");
  assert.equal(fs.readFileSync(archive, "utf8"), "existing");
  fs.unlinkSync(archive);
  publishEpic0437DiscardArchive(recovery, archive);
  assert.equal(fs.existsSync(recovery), false);
  assert.equal(fs.readFileSync(archive, "utf8"), "recovery");
});

test("trusted tasklist resolver is pinned to System32", { skip: process.platform !== "win32" }, () => {
  const resolved = resolveTrustedWindowsTasklist(process.env.SystemRoot);
  assert.equal(path.win32.basename(resolved).toLowerCase(), "tasklist.exe");
  assert.equal(path.win32.dirname(resolved).toLowerCase(), path.win32.join(process.env.SystemRoot!, "System32").toLowerCase());
});

test("trusted tasklist resolver fails closed without SystemRoot", () => {
  assert.throws(() => resolveTrustedWindowsTasklist(undefined), /SystemRoot is unavailable/);
});
