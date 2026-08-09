import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DynamicExternalEffectCoordinator, DynamicFileCapabilityAuthority } from "../src/dynamic_runtime/file_capability_authority.js";

const h = (value: string) => `sha256:${value.padEnd(64, value[0] || "0").slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, "a")}`;
const bindings = { task: h("1"), program: h("2"), document: h("3"), principal: h("4") };

function issue(authority: DynamicFileCapabilityAuthority, root: string, overrides: Record<string, unknown> = {}) {
  return authority.issue({ kind: "export_destination", absolute_path: root, access: ["create"], scope: "directory", allowed_extensions: [".pdf"],
    maximum_output_count: 4, maximum_output_bytes: 1024, task_id_hash: bindings.task, program_hash: bindings.program,
    document_fingerprint: bindings.document, principal_id_hash: bindings.principal, expires_unix_seconds: 1060, maximum_use_count: 4, ...overrides });
}

test("file capabilities expose opaque IDs, not paths, and bind every trusted identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-"));
  try {
    const authority = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(authority, root);
    assert.equal(JSON.stringify(capability).includes(root), false); assert.equal(capability.raw_path_exposed, false);
    assert.throws(() => authority.resolve({ capability_id: capability.capability_id, operation: "create", relative_path: "x.pdf", expected_task_id_hash: h("9"), expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal, reserve_output_bytes: 1 }), /task binding/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file capabilities reject traversal, extensions, expiry, quotas, and use exhaustion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-deny-"));
  try {
    let time = 1000; const authority = new DynamicFileCapabilityAuthority(() => time); const capability = issue(authority, root, { maximum_output_count: 1, maximum_use_count: 1 });
    const base = { capability_id: capability.capability_id, operation: "create" as const, expected_task_id_hash: bindings.task, expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal };
    assert.throws(() => authority.resolve({ ...base, relative_path: "..\\escape.pdf", reserve_output_bytes: 1 }), /escaped/);
    assert.throws(() => authority.resolve({ ...base, relative_path: "bad.exe", reserve_output_bytes: 1 }), /extension/);
    assert.match(authority.resolve({ ...base, relative_path: "ok.pdf", reserve_output_bytes: 10 }), /ok\.pdf$/);
    assert.throws(() => authority.resolve({ ...base, relative_path: "again.pdf", reserve_output_bytes: 1 }), /use count|quota/);
    time = 2000; assert.throws(() => authority.resolve({ ...base, relative_path: "late.pdf", reserve_output_bytes: 1 }), /expired/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file capability issuance rejects a junction or symlink root", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-reparse-")); const real = path.join(root, "real"); const junction = path.join(root, "junction");
  try {
    fs.mkdirSync(real); fs.symlinkSync(real, junction, "junction"); const authority = new DynamicFileCapabilityAuthority(() => 1000);
    assert.throws(() => issue(authority, junction), /reparse|symbolic/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("export uses plan-stage-inspect-authorize-publish-verify with exact receipts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-effect-")); const stage = path.join(root, "stage"); const destination = path.join(root, "out");
  try {
    fs.mkdirSync(destination); const authority = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(authority, destination);
    const coordinator = new DynamicExternalEffectCoordinator(stage, authority); const plan = coordinator.plan("export");
    coordinator.stage(plan.effect_id, [{ relative_path: "A101.pdf", bytes: Buffer.from("pdf-bytes") }]);
    const inspected = coordinator.inspect(plan.effect_id); assert.match(inspected.manifest_hash!, /^sha256:/);
    assert.throws(() => coordinator.authorize(plan.effect_id, h("wrong"), h("auth")), /stale/);
    coordinator.authorize(plan.effect_id, inspected.manifest_hash!, h("auth"));
    const published = coordinator.publish(plan.effect_id, capability.capability_id, bindings); assert.equal(fs.readFileSync(path.join(destination, "A101.pdf"), "utf8"), "pdf-bytes");
    const verified = coordinator.verify(plan.effect_id, published.receipt_hash!); assert.equal(verified.state, "verified");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Save As and print remain denied until dedicated trusted adapters exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-denied-"));
  try {
    const coordinator = new DynamicExternalEffectCoordinator(path.join(root, "stage"), new DynamicFileCapabilityAuthority(() => 1000));
    const saveAs = coordinator.plan("save_as"); assert.throws(() => coordinator.stage(saveAs.effect_id, [{ relative_path: "x.rvt", bytes: Buffer.from("x") }]), /remain denied/);
    const print = coordinator.plan("print"); assert.throws(() => coordinator.stage(print.effect_id, [{ relative_path: "print", bytes: Buffer.from("x") }]), /remain denied/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
