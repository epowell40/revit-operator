import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NATIVE_TRANSPORT_ALGORITHM,
  NATIVE_TRANSPORT_CONTENT_TYPE,
  NATIVE_TRANSPORT_PATH,
  NATIVE_TRANSPORT_VERSION,
  NativeTransportReplayCache,
  openNativeTransportRequest,
  protectNativeTransportResponse
} from "../secure_native_transport.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPERATOR_TOKEN = "listener-secret-must-not-leak-32-bytes";
const SERVER_EPOCH = Buffer.alloc(32, 0x4c).toString("base64url");

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listenerIdentity(url, overrides = {}) {
  return {
    pid: 4242,
    port: Number(new URL(url).port),
    process_name: "Revit.exe",
    executable_path: "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
    created_utc: "2026-07-29T12:00:00.000Z",
    owner_sid: "S-1-5-21-1000",
    current_sid: "S-1-5-21-1000",
    owner_matches_current_user: true,
    signature_status: "Valid",
    signer_subject: "CN=Autodesk, Inc., O=Autodesk, Inc., C=US",
    ...overrides
  };
}

function transportReceipt(url, overrides = {}) {
  return Object.freeze({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: SERVER_EPOCH,
    ...overrides,
    identity: Object.freeze({
      content_sha256: "c".repeat(64),
      dev: "10",
      ino: "11",
      size: "256",
      mtimeNs: "12",
      ctimeNs: "12",
      ...(overrides.identity || {})
    })
  });
}

async function encryptedBridge({ responseBody = '{"ok":true,"bridge":"bound"}' } = {}) {
  const outerRequests = [];
  const innerRequests = [];
  const replayCache = new NativeTransportReplayCache();
  const fixture = await listen(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const envelope = Buffer.concat(chunks);
    outerRequests.push({ url: request.url, headers: request.headers, body: envelope.toString("utf8") });
    const opened = openNativeTransportRequest({
      operatorToken: OPERATOR_TOKEN,
      serverEpoch: SERVER_EPOCH,
      envelopeBytes: envelope,
      replayCache
    });
    innerRequests.push(opened);
    const protectedBody = protectNativeTransportResponse({
      operatorToken: OPERATOR_TOKEN,
      request: opened,
      statusCode: 200,
      bodyJson: responseBody
    });
    response.writeHead(200, { "content-type": NATIVE_TRANSPORT_CONTENT_TYPE }).end(protectedBody);
  });
  return { ...fixture, outerRequests, innerRequests };
}

async function loadDesktop(t, backendUrl, bridgeUrl) {
  const keys = [
    "OPERATOR_DESKTOP_NO_LISTEN",
    "OPERATOR_BACKEND_URL",
    "OPERATOR_TOKEN",
    "REVIT_BRIDGE_URL",
    "LOCALAPPDATA",
    "REVIT_OPERATOR_MODE",
    "OPERATOR_TOOL_EXPOSURE_PROFILE"
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const isolatedLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "operator-desktop-listener-"));
  t.after(() => fs.rmSync(isolatedLocalAppData, { recursive: true, force: true }));
  Object.assign(process.env, {
    OPERATOR_DESKTOP_NO_LISTEN: "1",
    OPERATOR_BACKEND_URL: backendUrl,
    OPERATOR_TOKEN,
    REVIT_BRIDGE_URL: bridgeUrl,
    LOCALAPPDATA: isolatedLocalAppData,
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "certified"
  });
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  return import(`${pathToFileURL(path.join(appDir, "server.js")).href}?listener-identity=${Date.now()}-${Math.random()}`);
}

test("Windows PowerShell attestation ignores an inherited PowerShell 7 module path", async (t) => {
  const desktop = await loadDesktop(t, "https://operator.example.test", "http://127.0.0.1:5000");
  const environment = desktop.windowsPowerShellChildEnvironment({
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
    pSmOdUlEpAtH: "C:\\Users\\Eli\\Documents\\PowerShell\\Modules",
    OPERATOR_EXISTING: "kept"
  }, {
    OPERATOR_ATTEST_PORT: "5000"
  });

  assert.equal(environment.PSModulePath, undefined);
  assert.equal(environment.pSmOdUlEpAtH, undefined);
  assert.equal(environment.Path, "C:\\Windows\\System32");
  assert.equal(environment.OPERATOR_EXISTING, "kept");
  assert.equal(environment.OPERATOR_ATTEST_PORT, "5000");
});

test("hostile loopback GET and POST receive neither credential nor body before listener attestation", async (t) => {
  let admissionCalls = 0;
  const backend = await listen((_req, res) => {
    admissionCalls += 1;
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const captured = [];
  const hostile = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"sheet_id":999}');
  });
  t.after(() => Promise.all([close(backend.server), close(hostile.server)]));
  const desktop = await loadDesktop(t, backend.url, hostile.url);
  const selectedReceipt = transportReceipt(hostile.url);
  const inspect = async () => listenerIdentity(hostile.url, {
    process_name: "node.exe",
    executable_path: process.execPath,
    signature_status: "NotSigned",
    signer_subject: ""
  });

  for (const [pathname, options] of [
    ["/revit/capabilities", { method: "GET", __testHooks: { inspectRevitBridgeListener: inspect } }],
    ["/revit/create-sheet", {
      method: "POST",
      body: '{"sheetNumber":"SECRET-T001"}',
      __testHooks: { inspectRevitBridgeListener: inspect }
    }]
  ]) {
    await assert.rejects(
      desktop.fetchRevitBridge(pathname, {
        ...options,
        __testHooks: {
          inspectRevitBridgeListener: inspect,
          readNativeTransportReceipt: () => selectedReceipt,
          authorizeDirectRevitExecution: async () => {
            admissionCalls += 1;
            return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
          }
        }
      }),
      (error) => error?.code === "NATIVE_TRANSPORT_LISTENER_UNTRUSTED" && error?.request_dispatched === false
    );
  }
  assert.equal(admissionCalls, 0, "listener selection and ownership precede backend admission");
  assert.deepEqual(captured, [], "the hostile listener receives no request, token, grant, or action body");
});

test("Windows OS listener inspection rejects a real hostile Node loopback server before dispatch", {
  skip: process.platform !== "win32"
}, async (t) => {
  let admissionCalls = 0;
  const backend = await listen((_req, res) => {
    admissionCalls += 1;
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const captured = [];
  const hostile = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"sheet_id":999}');
  });
  t.after(() => Promise.all([close(backend.server), close(hostile.server)]));
  const desktop = await loadDesktop(t, backend.url, hostile.url);
  await assert.rejects(
    desktop.fetchRevitBridge("/revit/create-sheet", {
      method: "POST",
      body: '{"sheetNumber":"SECRET-OS-T001"}',
      __testHooks: {
        readNativeTransportReceipt: () => transportReceipt(hostile.url),
        authorizeDirectRevitExecution: async () => {
          admissionCalls += 1;
          return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
        }
      }
    }),
    (error) => error?.code === "NATIVE_TRANSPORT_LISTENER_UNTRUSTED" && error?.request_dispatched === false
  );
  assert.equal(admissionCalls, 0);
  assert.deepEqual(captured, []);
});

test("certified dispatch uses one selected receipt and sends only an authenticated ROSB envelope", async (t) => {
  const bridge = await encryptedBridge();
  t.after(() => close(bridge.server));
  const desktop = await loadDesktop(t, "https://operator.example.test", bridge.url);
  const selectedReceipt = transportReceipt(bridge.url);
  const response = await desktop.fetchRevitBridge("/revit/capabilities", {
    method: "GET",
    __testHooks: {
      readNativeTransportReceipt: () => selectedReceipt,
      inspectRevitBridgeListener: async () => listenerIdentity(bridge.url),
      authorizeDirectRevitExecution: async () => new Response('{"ok":true}', { status: 200 })
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, bridge: "bound" });
  assert.equal(bridge.outerRequests.length, 1);
  assert.equal(bridge.outerRequests[0].url, NATIVE_TRANSPORT_PATH);
  assert.equal(bridge.outerRequests[0].headers["content-type"], NATIVE_TRANSPORT_CONTENT_TYPE);
  assert.equal(bridge.outerRequests[0].headers["x-operator-token"], undefined);
  assert.doesNotMatch(bridge.outerRequests[0].body, /capabilities|listener-secret/i);
  assert.deepEqual({
    method: bridge.innerRequests[0].method,
    path: bridge.innerRequests[0].path,
    bodyJson: bridge.innerRequests[0].bodyJson
  }, { method: "GET", path: "/revit/capabilities", bodyJson: undefined });
});

test("PID and process-start races cannot dispatch an encrypted fabricated write", async (t) => {
  const bridge = await encryptedBridge({ responseBody: '{"ok":true,"sheet_id":999}' });
  t.after(() => close(bridge.server));
  const desktop = await loadDesktop(t, "https://operator.example.test", bridge.url);
  const selectedReceipt = transportReceipt(bridge.url);

  for (const changed of [
    listenerIdentity(bridge.url, { pid: 4343 }),
    listenerIdentity(bridge.url, { created_utc: "2026-07-29T12:00:01.000Z" })
  ]) {
    let inspections = 0;
    await assert.rejects(
      desktop.fetchRevitBridge("/revit/create-sheet", {
        method: "POST",
        body: '{"sheetNumber":"T999"}',
        __testHooks: {
          readNativeTransportReceipt: () => selectedReceipt,
          authorizeDirectRevitExecution: async () => new Response('{"ok":true}', { status: 200 }),
          inspectRevitBridgeListener: async () => {
            inspections += 1;
            return inspections === 1 ? listenerIdentity(bridge.url) : changed;
          }
        }
      }),
      (error) => {
        assert.equal(error.name, "RevitBridgeDispatchError");
        assert.equal(error.code, "NATIVE_TRANSPORT_LISTENER_UNTRUSTED");
        assert.equal(error.request_dispatched, false);
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.reconciliation_required, false);
        return true;
      }
    );
  }
  assert.equal(bridge.outerRequests.length, 0);
});

test("unchanged owner-attested Revit listener and exact ROSB request binding are accepted", async (t) => {
  const bridge = await encryptedBridge();
  t.after(() => close(bridge.server));
  const desktop = await loadDesktop(t, "https://operator.example.test", bridge.url);
  const selectedReceipt = transportReceipt(bridge.url);
  const response = await desktop.fetchRevitBridge("/revit/capabilities", {
    method: "GET",
    __testHooks: {
      readNativeTransportReceipt: () => selectedReceipt,
      inspectRevitBridgeListener: async () => listenerIdentity(bridge.url),
      authorizeDirectRevitExecution: async () => new Response('{"ok":true}', { status: 200 })
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, bridge: "bound" });
});

test("listener replacement during admission is rejected before the credential or action body is dispatched", async (t) => {
  const captured = [];
  const bridge = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  t.after(() => close(bridge.server));
  const desktop = await loadDesktop(t, "https://operator.example.test", bridge.url);
  const selectedReceipt = transportReceipt(bridge.url);
  let inspections = 0;
  await assert.rejects(
    desktop.fetchRevitBridge("/revit/create-sheet", {
      method: "POST",
      body: '{"sheetNumber":"T-RACE"}',
      __testHooks: {
        readNativeTransportReceipt: () => selectedReceipt,
        authorizeDirectRevitExecution: async () => new Response('{"ok":true}', { status: 200 }),
        inspectRevitBridgeListener: async () => {
          inspections += 1;
          return listenerIdentity(bridge.url, inspections === 1 ? {} : { pid: 5252 });
        }
      }
    }),
    (error) => error?.code === "NATIVE_TRANSPORT_LISTENER_UNTRUSTED" && error?.request_dispatched === false
  );
  assert.deepEqual(captured, []);
});
