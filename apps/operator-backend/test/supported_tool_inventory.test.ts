import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { isAllowlisted } from "../src/allowlist.js";
import { sendNativeBridgeRequest } from "../src/brains/native_revit_transport.js";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";
import { SUPPORTED_NATIVE_ROUTES, SUPPORTED_MCP_ALIASES, SUPPORTED_TOOL_INVENTORY_HASH,
  isSupportedNativeTool, isSupportedNativeTransport, isSupportedToolRoute,
  UnsupportedProductToolError } from "../src/capabilities/supported_tool_inventory.js";

const root = findRepoRoot(process.cwd());
const apps = fs.existsSync(path.join(root, "apps")) ? path.join(root, "apps") : root;
const manifest = fs.readFileSync(path.join(apps, "revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs"), "utf8");
const implemented = [...manifest.matchAll(/new OperatorToolInfo\("[^"\r\n]+",\s*"(GET|POST)",\s*"([^"]+)"/g)]
  .map(match => ({ method: match[1] as "GET" | "POST", path: match[2]! }));

test("supported inventory rejects every excluded source route before transport despite caller allowlists and runtime modes", async () => {
  assert.equal(implemented.length, 216);
  assert.equal(SUPPORTED_NATIVE_ROUTES.length, 101);
  assert.equal(SUPPORTED_MCP_ALIASES.length, 93);
  const excluded = implemented.filter(route => !isSupportedNativeTool(route.method, route.path));
  assert.equal(excluded.length, 115);
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { requests++; throw new Error("Excluded tool reached network"); }) as typeof fetch;
  try {
    for (const route of excluded) {
      const callerAllowlist = { GET: new Set([route.path]), POST: new Set([route.path]) };
      assert.equal(isAllowlisted(route.method, route.path, callerAllowlist), false, route.path);
      for (const mode of ["development", "hosted", "production", "local"]) {
        await assert.rejects(sendNativeBridgeRequest(route.method, route.path, {}, {
          token: "test-only", baseUrl: "http://127.0.0.1:1",
          env: { REVIT_OPERATOR_MODE: mode, OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }
        }), error => error instanceof UnsupportedProductToolError && error.outcomeUnknown === false && error.requestDispatched === false);
      }
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("supported transport separates standalone and internal executors without authorizing either", () => {
  assert.equal(isSupportedToolRoute("POST", "/revit/certified/sheets/count"), true);
  assert.equal(isSupportedNativeTransport("POST", "/revit/certified/sheets/count"), false);
  assert.equal(isSupportedNativeTransport("POST", "/revit/dynamic-runtime/bootstrap"), true);
  assert.equal(isSupportedToolRoute("POST", "/revit/dynamic-runtime/bootstrap"), false);
  assert.equal(isSupportedNativeTransport("GET", "/revit/dynamic-runtime/bootstrap"), false);
  assert.equal(isSupportedNativeTransport("POST", "/revit/dynamic-runtime/arbitrary-new-route"), false);
  for (const route of ["create-view", "duplicate-sheet", "set-parameter", "get-parameters"])
    assert.equal(isAllowlisted("POST", `/revit/${route}`), true);
});

test("supported product inventory projections share an immutable authority hash", () => {
  const workspaceRoot = fs.existsSync(path.join(root, "contracts/supported-tool-inventory.v1.json")) ? root : path.dirname(root);
  const result = spawnSync(process.execPath, [path.join(workspaceRoot, "scripts/generate_supported_tool_inventory.mjs"), "--check"], { cwd: workspaceRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const native = fs.readFileSync(path.join(apps, "revit-bridge-addin/RevitBridge.Common/OperatorSupportedToolInventory.cs"), "utf8");
  const mcp = fs.readFileSync(path.join(apps, "mcp-server/src/lib/supportedToolInventory.ts"), "utf8");
  assert.ok(native.includes(SUPPORTED_TOOL_INVENTORY_HASH));
  assert.ok(mcp.includes(SUPPORTED_TOOL_INVENTORY_HASH));
});
