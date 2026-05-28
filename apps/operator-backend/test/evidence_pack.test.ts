import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function writeWorkspaceFile(root: string, rel: string, content = "x"): void {
  const full = path.join(root, rel.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

test("evidence pack: builds folder package with explicit files and share link", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  writeWorkspaceFile(root, "artifacts/captures/before.png", "img-before");
  writeWorkspaceFile(root, "artifacts/captures/after.png", "img-after");
  writeWorkspaceFile(root, "artifacts/prints/A101.pdf", "pdf");
  writeWorkspaceFile(root, "artifacts/reports/checks.csv", "a,b\n1,2\n");

  const mod = await import("../src/evidence/evidence_pack.js");
  const r = mod.buildEvidencePack({
    title: "Feature 3 test",
    run_label: "session3",
    verification_checklist: [
      { check: "Titleblock date updated", expected: "2026-02-28", observed: "2026-02-28" },
      { check: "Sheet count", expected: 2, observed: 2 }
    ],
    before_images: ["artifacts/captures/before.png"],
    after_images: ["artifacts/captures/after.png"],
    pdf_paths: ["artifacts/prints/A101.pdf"],
    artifact_paths: ["artifacts/reports/checks.csv"],
    include_feature2_diff: false,
    package_zip: false
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.equal(r.status, "built");
  assert.equal(r.verification.overall_pass, true);
  assert.equal(r.included.before_images.length, 1);
  assert.equal(r.included.after_images.length, 1);
  assert.equal(r.included.pdfs.length, 1);
  assert.ok(r.summary_markdown.includes("observed: 2026-02-28"));
  assert.ok(r.summary_markdown.includes(r.share.download_path));

  const outputFull = path.join(root, r.output_dir.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(outputFull), "output_dir should exist");
  const sharedFile = path.join(root, r.share.relative_path.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(sharedFile), "shared file should exist");
});

test("evidence pack: verification failures halt by default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const mod = await import("../src/evidence/evidence_pack.js");
  const r = mod.buildEvidencePack({
    title: "Should fail",
    verification_checklist: [{ check: "Value check", expected: "A", observed: "B" }]
  });

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, "verification_failed");
  assert.equal(r.verification.overall_pass, false);
  assert.ok(r.summary_markdown.includes("[FAIL] Value check"));
  assert.ok(r.summary_markdown.includes("observed: B"));
});

test("evidence pack: session fallback discovers before/after/pdf tool outputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  writeWorkspaceFile(root, "artifacts/captures/auto_before.png", "img-before");
  writeWorkspaceFile(root, "artifacts/captures/auto_after.png", "img-after");
  writeWorkspaceFile(root, "artifacts/prints/auto_clean.pdf", "pdf");

  const store = await import("../src/memory/sqlite_store.js");
  store.__closeForTests();
  store.ensureSessionRow("sess-1");

  store.upsertStepPlanned("sess-1", "m1", "before", [{ action_id: "a_before" }]);
  store.attachToolResultToPlannedStep("sess-1", {
    action_id: "a_before",
    method: "POST",
    path: "/revit/export-image",
    status: "done",
    attachments: [{ kind: "image", local_path: "artifacts/captures/auto_before.png" }]
  });

  store.upsertStepPlanned("sess-1", "m2", "after", [{ action_id: "a_after" }]);
  store.attachToolResultToPlannedStep("sess-1", {
    action_id: "a_after",
    method: "POST",
    path: "/revit/export-image",
    status: "done",
    attachments: [{ kind: "image", local_path: "artifacts/captures/auto_after.png" }]
  });

  store.upsertStepPlanned("sess-1", "m3", "pdf", [{ action_id: "a_pdf" }]);
  store.attachToolResultToPlannedStep("sess-1", {
    action_id: "a_pdf",
    method: "POST",
    path: "/revit/export-pdf",
    status: "done",
    result_json: { output_path: "artifacts/prints/auto_clean.pdf" }
  });

  const mod = await import("../src/evidence/evidence_pack.js");
  const r = mod.buildEvidencePack({
    session_id: "sess-1",
    verification_checklist: [{ check: "Auto discovery check", observed: true }],
    package_zip: false
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.included.before_images.length > 0, true);
  assert.equal(r.included.after_images.length > 0, true);
  assert.equal(r.included.pdfs.length > 0, true);
  assert.ok(["available", "empty", "unavailable", "skipped"].includes(r.change_summary.feature2_diff.status));
});
