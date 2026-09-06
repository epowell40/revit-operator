import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
import { GeneralRevitExportIsolation, assertGeneralRevitCaseSettled, assertGeneralRevitExportIsolationPolicy, retainedGeneralRevitExportIsolation } from "../src/benchmark/general_revit_export_isolation.js";

test("quiescent unknown print effect stops case advancement and preserves live evidence and originals", t => {
  const f = fixture(t), isolation = new GeneralRevitExportIsolation(f.workspace, f.retained);
  isolation.begin("b02_print_sheet");
  fs.writeFileSync(path.join(f.prints, "partial.pdf"), "unverified bytes");
  const settled = { schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA, quiescent: true, terminal: true, current_binding: { session_id: "exact-session" },
    in_flight_operation_ids: [], in_flight_provider_call_ids: [], unresolved_unknown_operation_ids: [] };
  const trace = (snapshot: unknown, session: unknown = "exact-session", extra: unknown[] = []) => ({ case_id: "b02_print_sheet",
    context_supplied: { session_id: session }, tool_results: { durable_assignment_kernel_v2: { assignments: [{ snapshot }, ...extra] } } });
  assert.doesNotThrow(() => assertGeneralRevitCaseSettled(trace(settled)));
  for (const change of [{ unresolved_unknown_operation_ids: ["print-operation"] }, { unresolved_unknown_operation_ids: undefined },
    { in_flight_operation_ids: ["pending"] }, { in_flight_provider_call_ids: ["provider"] }, { quiescent: false }, { terminal: false }, { schema: undefined }])
    assert.throws(() => assertGeneralRevitCaseSettled(trace({ ...settled, ...change })), /requires_exact_settled/);
  assert.throws(() => assertGeneralRevitCaseSettled(trace(settled, "another-session")), /requires_exact_settled/);
  assert.throws(() => assertGeneralRevitCaseSettled(trace(settled, "exact-session", [{}])), /requires_exact_settled/);
  assert.throws(() => isolation.begin("next_case"), /identity_invalid/);
  assert.throws(() => isolation.restore(), /requires_recovery/);
  assert.equal(fs.readFileSync(path.join(f.prints, "partial.pdf"), "utf8"), "unverified bytes");
  assert.equal(fs.readFileSync(path.join(f.retained, "originals", "prints", "original.pdf"), "utf8"), "original user file");
});

test("execution honors the frozen isolation policy while rescoring preserves retained evidence without file operations", () => {
  assert.doesNotThrow(() => assertGeneralRevitExportIsolationPolicy(false, undefined, false));
  assert.doesNotThrow(() => assertGeneralRevitExportIsolationPolicy(true, true, false));
  assert.throws(() => assertGeneralRevitExportIsolationPolicy(true, undefined, false), /policy must match/);
  assert.throws(() => assertGeneralRevitExportIsolationPolicy(false, true, false), /policy must match/);
  assert.doesNotThrow(() => assertGeneralRevitExportIsolationPolicy(false, true, true));
  const retained = { enabled: true, retained: "original-campaign/export-isolation", originals_restored: true };
  assert.deepEqual(retainedGeneralRevitExportIsolation(retained, true), retained);
  assert.equal(retainedGeneralRevitExportIsolation(retained, false), null);
  assert.equal(retainedGeneralRevitExportIsolation(undefined, true), null);
});

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-export-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), retained = path.join(root, "retained");
  const prints = path.join(workspace, "artifacts", "prints");
  fs.mkdirSync(prints, { recursive: true });
  fs.writeFileSync(path.join(prints, "original.pdf"), "original user file");
  return { root, workspace, retained, prints };
}

test("fresh export folders prevent cross-case file reuse and preserve originals and exact case bytes", t => {
  const f = fixture(t), isolation = new GeneralRevitExportIsolation(f.workspace, f.retained);
  isolation.begin("first");
  assert.deepEqual(fs.readdirSync(f.prints), []);
  fs.writeFileSync(path.join(f.prints, "M000.pdf"), "first PDF");
  assert.throws(() => isolation.finish("first", false), /quiescent/);
  assert.throws(() => isolation.restore(), /active_case/);
  const first = isolation.finish("first", true);
  isolation.begin("second");
  assert.deepEqual(fs.readdirSync(f.prints), []);
  fs.writeFileSync(path.join(f.prints, "M000.pdf"), "different second PDF");
  const second = isolation.finish("second", true);
  assert.notEqual(first.files[0]!.sha256, second.files[0]!.sha256);
  assert.equal(fs.readFileSync(first.files[0]!.retained_path, "utf8"), "first PDF");
  assert.equal(fs.readFileSync(second.files[0]!.retained_path, "utf8"), "different second PDF");
  isolation.restore();
  assert.deepEqual(fs.readdirSync(f.prints), ["original.pdf"]);
  assert.equal(fs.readFileSync(path.join(f.prints, "original.pdf"), "utf8"), "original user file");
  assert.throws(() => new GeneralRevitExportIsolation(f.workspace, f.retained), /already_exists/);
});

test("unsafe paths, reused cases, late writes and linked output trees stop isolation without overwriting files", t => {
  const f = fixture(t);
  assert.throws(() => new GeneralRevitExportIsolation(f.workspace, path.join(f.prints, "retained")), /inside_live_root/);
  const isolation = new GeneralRevitExportIsolation(f.workspace, f.retained);
  assert.throws(() => isolation.begin("../escape"), /identity_invalid/);
  isolation.begin("first"); isolation.finish("first", true);
  assert.throws(() => isolation.begin("first"), /identity_invalid/);
  fs.writeFileSync(path.join(f.prints, "late.pdf"), "late output");
  assert.throws(() => isolation.begin("second"), /start_not_empty/);
  assert.throws(() => isolation.restore(), /would_overwrite/);
  assert.equal(fs.readFileSync(path.join(f.prints, "late.pdf"), "utf8"), "late output");
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.prints, "linked"), "junction");
  assert.throws(() => new GeneralRevitExportIsolation(f.workspace, path.join(f.root, "another")), /link_rejected/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
