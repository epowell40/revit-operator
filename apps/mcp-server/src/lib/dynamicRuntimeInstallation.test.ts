import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDynamicRuntimeInstallation } from "./dynamicRuntimeInstallation.js";

function makeInstalledRuntime(root: string) {
  const runtime = path.join(root, "dynamic-runtime");
  const supervisor = path.join(runtime, "supervisor", "DynamicRevitSandboxSupervisor.exe");
  const workerDirectory = path.join(runtime, "worker");
  fs.mkdirSync(path.dirname(supervisor), {recursive:true});
  fs.mkdirSync(workerDirectory, {recursive:true});
  fs.writeFileSync(supervisor, "fixture supervisor");
  fs.writeFileSync(path.join(workerDirectory, "DynamicRevitWorker.exe"), "fixture worker");
  return {supervisor, workerDirectory};
}

test("the registered release wins over the legacy Dynamic Runtime copy", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dynamic-release-"));
  try {
    const addins=path.join(root,"Autodesk","Revit","Addins","2024");
    const stale=makeInstalledRuntime(path.join(addins,"RevitOperator"));
    const release=path.join(root,"Release & Candidate","revit-operator-2024");
    const installed=makeInstalledRuntime(release);
    const assembly=path.join(release,"RevitBridge.dll");
    fs.writeFileSync(assembly,"fixture add-in");
    const tokenFile=path.join(root,"operator_token.txt");
    fs.writeFileSync(tokenFile,"fixture");
    const manifest=path.join(addins,"RevitBridge.addin");
    fs.writeFileSync(manifest,`<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns><AddIn Type="Application"><Name>RevitOperator</Name>
<Assembly>${assembly.replace(/&/g,"&amp;")}</Assembly><FullClassName>RevitBridge.App</FullClassName>
<AddInId>B2883307-2852-4740-9833-281048674F77</AddInId><VendorId>com.revitoperator</VendorId></AddIn></RevitAddIns>`);
    assert.notEqual(installed.supervisor,stale.supervisor);
    assert.deepEqual(resolveDynamicRuntimeInstallation("2024", root, {APPDATA:root}, "win32"),{...installed,tokenFile});
    fs.unlinkSync(path.join(installed.workerDirectory,"DynamicRevitWorker.exe"));
    assert.throws(()=>resolveDynamicRuntimeInstallation("2024",root,{APPDATA:root},"win32"),/requires the installed/);
    const validManifest = fs.readFileSync(manifest,"utf8");
    fs.writeFileSync(manifest,validManifest.replace("RevitBridge.App","OtherVendor.App"));
    assert.throws(()=>resolveDynamicRuntimeInstallation("2024",root,{APPDATA:root},"win32"),/registered RevitOperator/);
    fs.writeFileSync(manifest,`<!-- ${validManifest} -->`);
    assert.throws(()=>resolveDynamicRuntimeInstallation("2024",root,{APPDATA:root},"win32"),/registered RevitOperator/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

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
