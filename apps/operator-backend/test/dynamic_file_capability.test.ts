import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DynamicExternalEffectCoordinator, DynamicFileCapabilityAuthority, DynamicPublicationAuthorizationAuthority } from "../src/dynamic_runtime/file_capability_authority.js";

const h = (value: string) => `sha256:${value.padEnd(64, value[0] || "0").slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, "a")}`;
const bindings = { task: h("1"), program: h("2"), document: h("3"), principal: h("4") };
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const authorizationKey = Buffer.alloc(32, 7);

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
    assert.throws(() => authority.createFile({ capability_id: capability.capability_id, relative_path: "x.pdf", expected_task_id_hash: h("9"), expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal, bytes: Buffer.from("x") }), /task binding/);
    assert.throws(() => authority.resolve({ capability_id: capability.capability_id, operation: "create", relative_path: "x.pdf", expected_task_id_hash: bindings.task, expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal }), /atomic create API/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file capabilities reject traversal, extensions, expiry, quotas, and use exhaustion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-deny-"));
  try {
    let time = 1000; const authority = new DynamicFileCapabilityAuthority(() => time); const capability = issue(authority, root, { maximum_output_count: 1, maximum_use_count: 1 });
    const base = { capability_id: capability.capability_id, expected_task_id_hash: bindings.task, expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal };
    assert.throws(() => authority.createFile({ ...base, relative_path: "..\\escape.pdf", bytes: Buffer.from("x") }), /escaped/);
    assert.throws(() => authority.createFile({ ...base, relative_path: "bad.exe", bytes: Buffer.from("x") }), /extension/);
    assert.equal(authority.createFile({ ...base, relative_path: "ok.pdf", bytes: Buffer.from("0123456789") }).bytes, 10);
    assert.throws(() => authority.createFile({ ...base, relative_path: "again.pdf", bytes: Buffer.from("x") }), /use count|quota/);
    time = 2000; assert.throws(() => authority.createFile({ ...base, relative_path: "late.pdf", bytes: Buffer.from("x") }), /expired/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file capability issuance rejects a junction or symlink root", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-reparse-")); const real = path.join(root, "real"); const junction = path.join(root, "junction");
  try {
    fs.mkdirSync(real); fs.symlinkSync(real, junction, "junction"); const authority = new DynamicFileCapabilityAuthority(() => 1000);
    assert.throws(() => issue(authority, junction), /reparse|symbolic/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("atomic create rejects an existing symlink leaf and cannot modify its outside target", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filecap-leaf-")); const destination = path.join(root, "inside"); const outside = path.join(root, "outside.pdf");
  try {
    fs.mkdirSync(destination); fs.writeFileSync(outside, "ORIGINAL"); fs.symlinkSync(outside, path.join(destination, "a.pdf"), "file");
    const authority = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(authority, destination);
    assert.throws(() => authority.createFile({ capability_id: capability.capability_id, relative_path: "a.pdf", expected_task_id_hash: bindings.task,
      expected_program_hash: bindings.program, expected_document_fingerprint: bindings.document, expected_principal_id_hash: bindings.principal,
      bytes: Buffer.from("PWN") }), /already exists/);
    assert.equal(fs.readFileSync(outside, "utf8"), "ORIGINAL");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function publicationAuthorization(authority: DynamicPublicationAuthorizationAuthority, effect: { effect_id: string; effect_class: "export" | "save_as" | "print"; manifest_hash: string | null }, capabilityId: string) {
  return authority.issue({ effect_id: effect.effect_id, effect_class: effect.effect_class, manifest_hash: effect.manifest_hash!,
    destination_capability_id_hash: sha256(capabilityId), bindings_hash: sha256(`${bindings.task}\n${bindings.program}\n${bindings.document}\n${bindings.principal}`),
    expires_unix_seconds: 1060 });
}

test("export uses plan-stage-inspect-authorize-publish-verify with exact receipts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-effect-")); const stage = path.join(root, "stage"); const destination = path.join(root, "out");
  try {
    fs.mkdirSync(destination); const authority = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(authority, destination);
    const auth = new DynamicPublicationAuthorizationAuthority(authorizationKey, () => 1000); const coordinator = new DynamicExternalEffectCoordinator(stage, authority, auth); const plan = coordinator.plan("export");
    coordinator.stage(plan.effect_id, [{ relative_path: "A101.pdf", bytes: Buffer.from("pdf-bytes") }]);
    const inspected = coordinator.inspect(plan.effect_id); assert.match(inspected.manifest_hash!, /^sha256:/);
    const wrong = auth.issue({ ...publicationAuthorization(auth, inspected, capability.capability_id), manifest_hash: h("wrong") });
    assert.throws(() => coordinator.authorize(plan.effect_id, wrong, capability.capability_id, bindings), /stale/);
    coordinator.authorize(plan.effect_id, publicationAuthorization(auth, inspected, capability.capability_id), capability.capability_id, bindings);
    const published = coordinator.publish(plan.effect_id, capability.capability_id, bindings); assert.equal(fs.readFileSync(path.join(destination, "A101.pdf"), "utf8"), "pdf-bytes");
    const verified = coordinator.verify(plan.effect_id, published.receipt_hash!); assert.equal(verified.state, "verified");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("publication rejects staged-byte tampering after inspection and creates no destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-tamper-")); const stage = path.join(root, "stage"); const destination = path.join(root, "out");
  try {
    fs.mkdirSync(destination); const files = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(files, destination);
    const auth = new DynamicPublicationAuthorizationAuthority(authorizationKey, () => 1000); const coordinator = new DynamicExternalEffectCoordinator(stage, files, auth);
    const plan = coordinator.plan("export"); coordinator.stage(plan.effect_id, [{ relative_path: "a.pdf", bytes: Buffer.from("AUTHORIZED") }]);
    const inspected = coordinator.inspect(plan.effect_id); coordinator.authorize(plan.effect_id, publicationAuthorization(auth, inspected, capability.capability_id), capability.capability_id, bindings);
    fs.writeFileSync(path.join(stage, plan.effect_id, "a.pdf"), "TAMPERED");
    assert.throws(() => coordinator.publish(plan.effect_id, capability.capability_id, bindings), /changed after inspection/);
    assert.equal(fs.existsSync(path.join(destination, "a.pdf")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("publication never overwrites an existing create-only destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-existing-")); const stage = path.join(root, "stage"); const destination = path.join(root, "out");
  try {
    fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "a.pdf"), "ORIGINAL");
    const files = new DynamicFileCapabilityAuthority(() => 1000); const capability = issue(files, destination);
    const auth = new DynamicPublicationAuthorizationAuthority(authorizationKey, () => 1000); const coordinator = new DynamicExternalEffectCoordinator(stage, files, auth);
    const plan = coordinator.plan("export"); coordinator.stage(plan.effect_id, [{ relative_path: "a.pdf", bytes: Buffer.from("NEW") }]);
    const inspected = coordinator.inspect(plan.effect_id); coordinator.authorize(plan.effect_id, publicationAuthorization(auth, inspected, capability.capability_id), capability.capability_id, bindings);
    assert.throws(() => coordinator.publish(plan.effect_id, capability.capability_id, bindings), /already exists/);
    assert.equal(fs.readFileSync(path.join(destination, "a.pdf"), "utf8"), "ORIGINAL");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("publication rechecks signed authorization expiry at the publish boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-expiry-")); const stage = path.join(root, "stage"); const destination = path.join(root, "out");
  try {
    let time = 1000; fs.mkdirSync(destination); const files = new DynamicFileCapabilityAuthority(() => time); const capability = issue(files, destination, { expires_unix_seconds: 1200 });
    const auth = new DynamicPublicationAuthorizationAuthority(authorizationKey, () => time); const coordinator = new DynamicExternalEffectCoordinator(stage, files, auth);
    const plan = coordinator.plan("export"); coordinator.stage(plan.effect_id, [{ relative_path: "a.pdf", bytes: Buffer.from("AUTHORIZED") }]);
    const inspected = coordinator.inspect(plan.effect_id); const receipt = auth.issue({ effect_id: inspected.effect_id, effect_class: inspected.effect_class,
      manifest_hash: inspected.manifest_hash!, destination_capability_id_hash: sha256(capability.capability_id),
      bindings_hash: sha256(`${bindings.task}\n${bindings.program}\n${bindings.document}\n${bindings.principal}`), expires_unix_seconds: 1005 });
    coordinator.authorize(plan.effect_id, receipt, capability.capability_id, bindings); time = 1006;
    assert.throws(() => coordinator.publish(plan.effect_id, capability.capability_id, bindings), /expired/);
    assert.equal(fs.existsSync(path.join(destination, "a.pdf")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v1 rejects nested and multi-file staging before publication can become partial", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-bounded-"));
  try {
    const coordinator = new DynamicExternalEffectCoordinator(path.join(root, "stage"), new DynamicFileCapabilityAuthority(() => 1000), new DynamicPublicationAuthorizationAuthority(authorizationKey, () => 1000));
    const nested = coordinator.plan("export");
    assert.throws(() => coordinator.stage(nested.effect_id, [{ relative_path: "nested/a.pdf", bytes: Buffer.from("a") }]), /direct leaf/);
    const multiple = coordinator.plan("export");
    assert.throws(() => coordinator.stage(multiple.effect_id, [{ relative_path: "a.pdf", bytes: Buffer.from("a") }, { relative_path: "b.pdf", bytes: Buffer.from("b") }]), /exactly one/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Save As and print remain denied until dedicated trusted adapters exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-denied-"));
  try {
    const coordinator = new DynamicExternalEffectCoordinator(path.join(root, "stage"), new DynamicFileCapabilityAuthority(() => 1000), new DynamicPublicationAuthorizationAuthority(authorizationKey, () => 1000));
    const saveAs = coordinator.plan("save_as"); assert.throws(() => coordinator.stage(saveAs.effect_id, [{ relative_path: "x.rvt", bytes: Buffer.from("x") }]), /remain denied/);
    const print = coordinator.plan("print"); assert.throws(() => coordinator.stage(print.effect_id, [{ relative_path: "print", bytes: Buffer.from("x") }]), /remain denied/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
