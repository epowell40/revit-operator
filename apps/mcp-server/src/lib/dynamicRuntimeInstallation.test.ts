import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDynamicRuntimeInstallation } from "./dynamicRuntimeInstallation.js";

test("installed runtime resolves the exact requested Revit year and existing workspace token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-installation-"));
  try {
    const runtime = path.join(root, "Autodesk", "Revit", "Addins", "2027", "RevitOperator", "dynamic-runtime");
    const supervisor = path.join(runtime, "supervisor", "DynamicRevitSandboxSupervisor.exe");
    const workerDirectory = path.join(runtime, "worker");
    fs.mkdirSync(path.dirname(supervisor), { recursive: true }); fs.mkdirSync(workerDirectory);
    fs.writeFileSync(supervisor, "fixture"); fs.writeFileSync(path.join(workerDirectory, "DynamicRevitWorker.exe"), "fixture");
    const tokenFile = path.join(root, "operator_token.txt"); fs.writeFileSync(tokenFile, "fixture");
    assert.deepEqual(resolveDynamicRuntimeInstallation("2027", root, { APPDATA: root }, "win32"), { supervisor, workerDirectory, tokenFile });
    assert.throws(() => resolveDynamicRuntimeInstallation("2024", root, { APPDATA: root }, "win32"), /requires the installed/);
    assert.throws(() => resolveDynamicRuntimeInstallation("../2027", root, { APPDATA: root }, "win32"), /Unsupported/);
    assert.throws(() => resolveDynamicRuntimeInstallation("2027", root, { APPDATA: root }, "linux"), /requires the installed/);
    fs.unlinkSync(path.join(workerDirectory, "DynamicRevitWorker.exe"));
    assert.throws(() => resolveDynamicRuntimeInstallation("2027", root, { APPDATA: root }, "win32"), /requires the installed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit paired runtime paths are preserved and incomplete configuration is not silently mixed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-configured-"));
  try {
    const supervisor = path.join(root, "custom-supervisor.exe"), workerDirectory = path.join(root, "custom-worker"), tokenFile = path.join(root, "custom-token");
    fs.mkdirSync(workerDirectory); fs.writeFileSync(supervisor, "fixture"); fs.writeFileSync(tokenFile, "fixture");
    const env = { OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor, OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: workerDirectory, OPERATOR_TOKEN_FILE: tokenFile };
    assert.deepEqual(resolveDynamicRuntimeInstallation("2024", root, env, "win32"), { supervisor, workerDirectory, tokenFile });
    assert.throws(() => resolveDynamicRuntimeInstallation("2024", root, { ...env, OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: undefined }, "win32"), /Configure both/);
    fs.unlinkSync(tokenFile);
    assert.throws(() => resolveDynamicRuntimeInstallation("2024", root, env, "win32"), /operator_token.txt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
