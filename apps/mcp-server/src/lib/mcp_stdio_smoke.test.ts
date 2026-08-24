import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  NATIVE_TRANSPORT_ALGORITHM,
  NATIVE_TRANSPORT_CONTENT_TYPE,
  NATIVE_TRANSPORT_PATH,
  NATIVE_TRANSPORT_VERSION
} from "./nativeTransport.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";

const certifiedPolicyPath = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
  ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
  : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");
const certifiedPolicyHash = (JSON.parse(fs.readFileSync(certifiedPolicyPath, "utf8")) as { policy_hash: string }).policy_hash;
const certifiedSafeNonRevitAliases = [
  "audit_lpd",
  "check_photometrics",
  "fire_damper_audit",
  "operator_discover_capabilities",
  "operator_plan_semantic_mep_route",
  "operator_record_execution_strategy",
  "operator_retrieve_evidence",
  "operator_submit_read_completion",
  "operator_runtime_probe",
  "print_sheets",
  "read_excel",
  "read_pdf_text",
  "read_word",
  "revit_get_context",
  "validate_ies_files",
  "web_fetch_evidence",
  "workspace_pdf_merge",
  "workspace_pdf_reorder",
  "workspace_rename_file",
  "write_excel"
].sort();
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6nS7sAAAAASUVORK5CYII=", "base64");

function smokeCanonical(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").normalize("NFC");
  if (Array.isArray(value)) return value.map(smokeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.replace(/\r\n?/g, "\n").normalize("NFC"), item] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, smokeCanonical(item)]));
  }
  return value;
}

function smokeDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(smokeCanonical(value)), "utf8").digest("hex")}`;
}

function nativeKeys(token: string, epoch: string, direction: "request" | "response") {
  const epochBytes = Buffer.from(epoch, "base64url");
  const prk = createHmac("sha512", epochBytes).update(token, "utf8").digest();
  const info = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "utf8");
  const okm = createHmac("sha512", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return { mac: okm.subarray(0, 32), enc: okm.subarray(32, 64) };
}

function nativeTag(key: Buffer, epoch: string, direction: "request" | "response", iv: Buffer, ciphertext: Buffer): Buffer {
  const aad = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\n${NATIVE_TRANSPORT_ALGORITHM}\n${epoch}\n${direction}\nPOST\n${NATIVE_TRANSPORT_PATH}`, "utf8");
  const bits = Buffer.alloc(8);
  bits.writeBigUInt64BE(BigInt(aad.length) * 8n);
  return createHmac("sha512", key).update(Buffer.concat([aad, iv, ciphertext, bits])).digest().subarray(0, 32);
}

function protectedSmokeResponse(requestEnvelopeJson: string, token: string, statusCode: number, bodyJson: string): string {
  const envelope = JSON.parse(requestEnvelopeJson);
  assert.equal(envelope.v, NATIVE_TRANSPORT_VERSION);
  assert.equal(envelope.alg, NATIVE_TRANSPORT_ALGORITHM);
  assert.equal(envelope.dir, "request");
  const requestIv = Buffer.from(envelope.iv, "base64url");
  const requestCiphertext = Buffer.from(envelope.ciphertext, "base64url");
  const requestKeys = nativeKeys(token, envelope.epoch, "request");
  const requestTag = Buffer.from(envelope.tag, "base64url");
  assert.equal(timingSafeEqual(requestTag, nativeTag(requestKeys.mac, envelope.epoch, "request", requestIv, requestCiphertext)), true);
  const decipher = createDecipheriv("aes-256-cbc", requestKeys.enc, requestIv);
  const request = JSON.parse(Buffer.concat([decipher.update(requestCiphertext), decipher.final()]).toString("utf8"));

  const responseInner = Buffer.from(JSON.stringify({
    request_id: request.request_id,
    request_nonce: request.request_nonce,
    issued_at_unix_ms: Date.now(),
    status_code: statusCode,
    body_json: bodyJson
  }), "utf8");
  const responseIv = randomBytes(16);
  const responseKeys = nativeKeys(token, envelope.epoch, "response");
  const cipher = createCipheriv("aes-256-cbc", responseKeys.enc, responseIv);
  const responseCiphertext = Buffer.concat([cipher.update(responseInner), cipher.final()]);
  return JSON.stringify({
    v: NATIVE_TRANSPORT_VERSION,
    alg: NATIVE_TRANSPORT_ALGORITHM,
    epoch: envelope.epoch,
    dir: "response",
    iv: responseIv.toString("base64url"),
    ciphertext: responseCiphertext.toString("base64url"),
    tag: nativeTag(responseKeys.mac, envelope.epoch, "response", responseIv, responseCiphertext).toString("base64url")
  });
}

function writeNativeReceipt(localAppData: string, url: string, epoch: string): void {
  const directory = path.join(localAppData, "RevitOperator");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "bridge_transport.v1.json"), JSON.stringify({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: epoch
  }), "utf8");
}

function writeSmokePolicyVariant(mutate: (policy: any) => void): { policyPath: string; policyHash: string; root: string } {
  const policy = JSON.parse(fs.readFileSync(certifiedPolicyPath, "utf8"));
  mutate(policy);
  for (const record of policy.records) {
    const { policy_record_hash: _oldRecordHash, ...recordPayload } = record;
    record.policy_record_hash = smokeDigest(recordPayload);
  }
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = smokeDigest(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-policy-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash, root };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out while ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine smoke-test backend port.");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listToolsForExposureEnv(exposureEnv: Record<string, string>): Promise<string[]> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-exposure-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      OPERATOR_API_BASE_URL: "http://127.0.0.1:1",
      REVIT_BRIDGE_URL: "http://127.0.0.1:1",
      OPERATOR_TOKEN: "mcp-exposure-stdio-token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: certifiedPolicyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: certifiedPolicyHash,
      ...exposureEnv
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "revit-operator-exposure-stdio-smoke", version: "1.0.0" }, { capabilities: {} });
  try {
    try {
      await withTimeout(client.connect(transport), `initializing MCP stdio server for ${JSON.stringify(exposureEnv)}`);
    } catch (error) {
      throw new Error(`${String(error)}\nMCP stderr:\n${stderr.join("")}`);
    }
    const tools = await withTimeout(client.listTools(), `listing MCP tools for ${JSON.stringify(exposureEnv)}`);
    return tools.tools.map(tool => tool.name).sort();
  } finally {
    try {
      await withTimeout(client.close(), "closing exposure MCP client", 5_000);
    } finally {
      await withTimeout(transport.close(), "closing exposure MCP child transport", 5_000);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

test("MCP tools/list opens the legacy catalog only for exact raw development laboratory values", async () => {
  const negativeCases = [
    { REVIT_OPERATOR_MODE: "Development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: " development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development ", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: " laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory " },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "LABORATORY" },
    { REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }
  ];
  for (const exposureEnv of negativeCases) {
    const names = await listToolsForExposureEnv(exposureEnv);
    assert.deepEqual(names, certifiedSafeNonRevitAliases, `non-exact escape must expose only certified-safe aliases: ${JSON.stringify(exposureEnv)}`);
    assert.equal(names.filter(name => name.startsWith("revit_")).length, 1, `non-exact escape exposed a Revit alias: ${JSON.stringify(exposureEnv)}`);
  }

  const laboratoryNames = await listToolsForExposureEnv({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
  });
  assert.equal(laboratoryNames.length, 131, "Exact development laboratory mode must preserve the complete catalog plus evidence retrieval, canonical read completion, bootstrap discovery, strategy evidence, Dynamic Runtime, observation, target readback, laboratory SafeRead, and bounded move-family aliases.");
  assert.equal(laboratoryNames.filter(name => name.startsWith("revit_")).length, 110, "Exact development laboratory mode must preserve all Revit aliases plus observation, target readback, laboratory SafeRead, and the bounded move-family alias.");
  assert.equal(laboratoryNames.includes("revit_observe_model"), true, "Laboratory mode must expose the typed spatial observation alias.");
  assert.equal(laboratoryNames.includes("operator_record_execution_strategy"), true, "Laboratory mode must expose non-authorizing strategy evidence.");
  assert.equal(laboratoryNames.includes("operator_run_dynamic_revit_program"), true, "Laboratory mode must expose the gated Dynamic Runtime launcher.");

  const hostedGeneralNames = await listToolsForExposureEnv({
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_BRAIN: "codex",
    OPERATOR_OPENAI_API_KEY: "test-provider-key"
  });
  assert.deepEqual(hostedGeneralNames, laboratoryNames, "Authenticated hosted General Agent mode must expose the complete typed Revit catalog, including project queries and writes.");
  for (const required of [
    "revit_search_tools",
    "revit_call_tool",
    "revit_query_elements",
    "revit_set_parameters",
    "revit_create_sheet",
    "revit_list_schedules"
  ]) assert.equal(hostedGeneralNames.includes(required), true, `Hosted General Agent catalog is missing ${required}.`);
});

test("MCP stdio server registers repaired tools and rejects semantic write controls before backend execution", async (t) => {
  let backendRequests = 0;
  const backend = http.createServer((_req, res) => {
    backendRequests += 1;
    res.statusCode = 500;
    res.end("unexpected backend request");
  });
  const backendPort = await listen(backend);
  const bridgeRequests: Array<{ method: string; path: string; token: string; grant: string }> = [];
  const connectorRepairBodies: any[] = [];
  const sheetBodies: any[] = [];
  const scheduleBodies: any[] = [];
  const scheduleCellBodies: any[] = [];
  const scheduleReplacementBodies: any[] = [];
  const setParameterBodies: any[] = [];
  const observationBodies: any[] = [];
  let observationImagePath = "";
  const bridge = http.createServer(async (req, res) => {
    const requestBody = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = String(req.headers["x-operator-token"] ?? "");
    const grant = String(req.headers["x-operator-write-grant"] ?? "");
    bridgeRequests.push({ method: req.method ?? "", path: requestUrl.pathname, token, grant });
    res.setHeader("Content-Type", "application/json");
    if (token !== "mcp-stdio-smoke-token") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "bad token" }));
      return;
    }
    if (requestUrl.pathname === "/revit/ping") {
      res.end(JSON.stringify({ status: "ok", source: "stdio-smoke" }));
      return;
    }
    if (requestUrl.pathname === "/revit/tool-registry") {
      res.end(JSON.stringify({
        version: "operator.tool_registry.v1",
        tools: [
          { method: "GET", path: "/revit/context", group: "Core", risk: "low", title: "Context", description: "Current context" },
          { method: "POST", path: "/revit/test-write", group: "Test", risk: "medium", title: "Test Write", description: "Smoke write" }
        ]
      }));
      return;
    }
    if (requestUrl.pathname === "/revit/context") {
      res.end(JSON.stringify({
        document: {
          title: "Snowdon",
          sessionId: "123e4567e89b42d3a456426614174000",
          projectIdentity: { fingerprint: "a".repeat(64) },
          activeView: { id: 42, name: "L4 - Power" }
        }
      }));
      return;
    }
    if (requestUrl.pathname === "/revit/export-visible-elements") {
      observationBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({
        frameId: "frame-stdio-1",
        path: observationImagePath,
        widthPx: 1200,
        heightPx: 675,
        viewId: 42,
        viewName: "L4 - Power",
        viewType: "FloorPlan",
        mapping: { mode: "2d_affine", topLeftXyz: [0, 10, 0], topRightXyz: [10, 10, 0], bottomLeftXyz: [0, 0, 0] },
        count: 1,
        scanned: 1,
        truncated: false,
        document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } },
        items: [{ elementId: 12, sourceScopedId: "host:12", anchor: { image: { normalizedX: 0.2, normalizedY: 0.3 } }, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }]
      }));
      return;
    }
    if (requestUrl.pathname === "/revit/sheets") {
      sheetBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({ action: "count", totalSheets: 345, total: 345 }));
      return;
    }
    if (requestUrl.pathname === "/revit/schedules") {
      scheduleBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({ items: [{ id: 4101, name: "Mechanical Equipment Schedule" }] }));
      return;
    }
    if (requestUrl.pathname === "/revit/update-schedule-cell") {
      scheduleCellBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({ status: "Dry Run", dryRun: true, applied: false, candidateCount: 1 }));
      return;
    }
    if (requestUrl.pathname === "/revit/replace-schedule-values") {
      scheduleReplacementBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({ status: "Dry Run", dryRun: true, applied: false, planHash: "abc" }));
      return;
    }
    if (requestUrl.pathname === "/revit/set-parameter") {
      setParameterBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({ status: "Dry Run", dryRun: true, applied: false, changedCount: 1 }));
      return;
    }
    if (requestUrl.pathname === "/revit/repair-mep-connectors") {
      connectorRepairBodies.push(JSON.parse(requestBody || "{}"));
      res.end(JSON.stringify({
        status: "DryRunReady",
        transactionGroupRolledBack: true,
        rollbackVerified: true
      }));
      return;
    }
    if (requestUrl.pathname === "/revit/test-write") {
      if (grant !== "grant-token") {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "missing grant" }));
        return;
      }
      res.end(JSON.stringify({ applied: true, source: "stdio-smoke" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  const bridgePort = await listen(bridge);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-stdio-"));
  observationImagePath = path.join(workspace, "frame-stdio-1.png");
  fs.writeFileSync(observationImagePath, tinyPng);
  fs.writeFileSync(path.join(workspace, "write_grant.json"), JSON.stringify({
    token: "grant-token",
    expires_at_utc: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      OPERATOR_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
      REVIT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      OPERATOR_TOKEN: "mcp-stdio-smoke-token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "revit-operator-stdio-smoke", version: "1.0.0" }, { capabilities: {} });

  t.after(async () => {
    try {
      await withTimeout(client.close(), "closing MCP client", 5_000);
    } finally {
      await withTimeout(transport.close(), "closing MCP child transport", 5_000);
      await closeServer(backend);
      await closeServer(bridge);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  try {
    await withTimeout(client.connect(transport), "initializing MCP stdio server");
  } catch (error) {
    throw new Error(`${String(error)}\nMCP stderr:\n${stderr.join("")}`);
  }

  const tools = await withTimeout(client.listTools(), "listing MCP tools");
  const names = new Set(tools.tools.map((tool) => tool.name));
  assert.equal(tools.tools.length, 131, "Laboratory mode must preserve the complete catalog plus evidence retrieval, canonical read completion, bootstrap discovery, strategy evidence, Dynamic Runtime, observation, target readback, SafeRead, and bounded move-family aliases.");
  assert.equal([...names].filter(name => name.startsWith("revit_")).length, 110, "Laboratory mode must preserve all revit_ aliases plus observation, target readback, SafeRead, and the bounded move-family alias.");
  assert.equal(names.has("revit_observe_model"), true, "Laboratory tools/list must include the typed spatial observation alias.");
  assert.equal(names.has("titleblock_update_text"), true, "Laboratory mode must preserve the legacy non-revit bridge alias.");
  for (const name of [
    "operator_runtime_probe",
    "operator_plan_semantic_mep_route",
    "operator_record_execution_strategy",
    "operator_retrieve_evidence",
    "operator_submit_read_completion",
    "operator_run_dynamic_revit_program",
    "fire_damper_audit",
    "validate_ies_files",
    "check_photometrics",
    "audit_lpd",
    "revit_repair_mep_connectors",
    "revit_dry_run_repair_mep_connectors",
    "revit_list_schedules",
    "revit_get_parameters",
    "revit_count_sheets_certified",
    "revit_update_schedule_cell",
    "revit_replace_schedule_values",
    "revit_set_parameters"
  ]) {
    assert.equal(names.has(name), true, `Missing MCP tool: ${name}`);
  }
  const connectorRepairTool = tools.tools.find(tool => tool.name === "revit_repair_mep_connectors");
  const dryConnectorRepairTool = tools.tools.find(tool => tool.name === "revit_dry_run_repair_mep_connectors");
  const sheetTool = tools.tools.find(tool => tool.name === "revit_list_sheets");
  const safeReadTool = tools.tools.find(tool => tool.name === "revit_count_sheets_certified");
  const getParametersTool = tools.tools.find(tool => tool.name === "revit_get_parameters");
  const schedulesTool = tools.tools.find(tool => tool.name === "revit_list_schedules");
  assert.deepEqual((sheetTool?.inputSchema as any)?.properties?.action?.enum, ["list", "count"]);
  assert.deepEqual((safeReadTool?.inputSchema as any)?.properties, {});
  assert.equal((safeReadTool?.inputSchema as any)?.additionalProperties, false);
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.elementIds?.anyOf?.length, 2);
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.names?.items?.type, "string");
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.limit?.maximum, 500);
  assert.equal((schedulesTool?.inputSchema as any)?.properties?.maxRows?.maximum, 500);
  assert.equal((schedulesTool?.inputSchema as any)?.properties?.maxColumns?.maximum, 100);
  for (const tool of [connectorRepairTool, dryConnectorRepairTool]) {
    const connectorRepairSchema = JSON.stringify(tool?.inputSchema ?? {});
    assert.doesNotMatch(connectorRepairSchema, /"\$ref"/);
    assert.doesNotMatch(connectorRepairSchema, /"anyOf"/);
    assert.doesNotMatch(connectorRepairSchema, /"items":\[/);
  }
  assert.equal(dryConnectorRepairTool?.annotations?.readOnlyHint, true);
  assert.equal(dryConnectorRepairTool?.annotations?.destructiveHint, false);
  assert.equal(connectorRepairTool?.annotations?.destructiveHint, true);
  const runtimeProbe = await withTimeout(client.callTool({ name: "operator_runtime_probe", arguments: {} }), "probing MCP runtime");
  assert.match((runtimeProbe as any).content[0].text, /operator\.mcp\.runtime\.v1/);
  const connectorRepair = await withTimeout(client.callTool({
    name: "revit_dry_run_repair_mep_connectors",
    arguments: {
      expectedModelPath: "C:\\benchmarks\\synthetic_mep_fixture.rvt",
      disconnectOnlyPairs: [{
        a: { elementId: 101, connectorId: 2, expectedOriginXyz: [1, 2, 3] },
        b: { elementId: 102, connectorId: 0, expectedOriginXyz: [1, 2, 3] }
      }],
      dryRun: true,
      verify: true
    }
  }), "calling typed connector repair");
  assert.match((connectorRepair as any).content[0].text, /DryRunReady/);
  assert.deepEqual(connectorRepairBodies[0].disconnectOnlyPairs[0], {
    first: { elementId: 101, connectorId: 2, expectedOriginXyz: [1, 2, 3] },
    second: { elementId: 102, connectorId: 0, expectedOriginXyz: [1, 2, 3] }
  });

  const ping = await withTimeout(client.callTool({ name: "revit_ping", arguments: {} }), "calling Revit ping over stdio");
  assert.match((ping as any).content[0].text, /stdio-smoke/);

  const search = await withTimeout(client.callTool({
    name: "revit_search_tools",
    arguments: { query: "context", method: "GET" }
  }), "searching bridge tools over stdio");
  assert.match((search as any).content[0].text, /\/revit\/context/);

  const context = await withTimeout(client.callTool({
    name: "revit_call_tool",
    arguments: { method: "GET", path: "/revit/context", requireKnownPath: true }
  }), "calling a generic bridge read over stdio");
  assert.match((context as any).content[0].text, /L4 - Power/);

  const observation = await withTimeout(client.callTool({
    name: "revit_observe_model",
    arguments: { imageSize: 1200, limit: 2, includeLinked: false }
  }), "observing a Revit frame over stdio");
  const observationText = (observation as any).content.find((item: any) => item.type === "text")?.text ?? "";
  assert.match(observationText, /"schemaVersion": "spatial-observation\/v1"/);
  assert.equal((observation as any).content.some((item: any) => item.type === "image" && item.mimeType === "image/png"), true);
  assert.deepEqual(observationBodies[0], { imageSize: 1200, includeLinked: false, limit: 2, includeMapping: true, includeGeometry: true });

  const sheetCount = await withTimeout(client.callTool({
    name: "revit_list_sheets",
    arguments: { action: "count" }
  }), "counting sheets over stdio");
  assert.match((sheetCount as any).content[0].text, /"totalSheets": 345/);
  assert.deepEqual(sheetBodies[0], { action: "count", exact: false });

  const schedules = await withTimeout(client.callTool({
    name: "revit_list_schedules",
    arguments: { action: "list", max: 10 }
  }), "listing schedules over stdio");
  assert.match((schedules as any).content[0].text, /Mechanical Equipment Schedule/);
  assert.deepEqual(scheduleBodies[0], { action: "list", exact: false, max: 10 });

  const scheduleCell = await withTimeout(client.callTool({
    name: "revit_update_schedule_cell",
    arguments: { rowKey: "AHU-1", targetField: "Supply Air", expectedValue: "10,000", value: "20,000 CFM" }
  }), "dry-running a schedule cell update over stdio");
  assert.match((scheduleCell as any).content[0].text, /Dry Run/);
  assert.equal(scheduleCellBodies[0].apply, false);
  assert.equal(scheduleCellBodies[0].dryRun, true);
  assert.equal(scheduleCellBodies[0].rowField, undefined);

  const scheduleReplacement = await withTimeout(client.callTool({
    name: "revit_replace_schedule_values",
    arguments: { sheetNumbers: ["P6.01"], fieldNames: ["DESIG"], valueContains: "-G-", replaceFrom: "-G-", replaceTo: "-0-" }
  }), "dry-running a schedule value replacement over stdio");
  assert.match((scheduleReplacement as any).content[0].text, /planHash/);
  assert.equal(scheduleReplacementBodies[0].apply, false);
  assert.equal(scheduleReplacementBodies[0].dryRun, true);

  const setParameter = await withTimeout(client.callTool({
    name: "revit_set_parameters",
    arguments: { changes: [{ elementId: 4978484, parameterName: "Sheet Name", value: "Preview", expectedOldValue: "Original" }] }
  }), "dry-running a parameter update over stdio");
  assert.match((setParameter as any).content[0].text, /Dry Run/);
  assert.equal(setParameterBodies[0].apply, false);
  assert.equal(setParameterBodies[0].dryRun, true);
  assert.equal(setParameterBodies[0].changes[0].expectedOldValue, "Original");

  const write = await withTimeout(client.callTool({
    name: "revit_call_tool",
    arguments: { method: "POST", path: "/revit/test-write", body: { apply: true }, requireKnownPath: true }
  }), "calling a grant-backed generic bridge write over stdio");
  assert.match((write as any).content[0].text, /"applied": true/);
  assert.equal(bridgeRequests.every(request => request.token === "mcp-stdio-smoke-token"), true);
  assert.equal(bridgeRequests.some(request => request.path === "/revit/test-write" && request.grant === "grant-token"), true);

  for (const writeControl of ["apply", "write"] as const) {
    const result = await withTimeout(client.callTool({
      name: "operator_plan_semantic_mep_route",
      arguments: { userText: "Extend piping from the main to that sink.", [writeControl]: true }
    }), `rejecting semantic ${writeControl} control`);
    assert.equal((result as any).isError, true, `${writeControl} must be rejected as an MCP InvalidParams input error.`);
    const text = (result as any).content.map((item: any) => item.text ?? "").join("\n");
    assert.match(text, /Input validation error: Invalid arguments for tool operator_plan_semantic_mep_route/i);
  }
  assert.equal(backendRequests, 0, "Invalid semantic planner controls must be rejected before any backend fetch.");
});

test("MCP stdio certified mode keeps diagnostics available and blocks every Revit route before bridge dispatch", async (t) => {
  let bridgeRequests = 0;
  const bridge = http.createServer((_req, res) => {
    bridgeRequests += 1;
    res.statusCode = 500;
    res.end("certification should have blocked this request");
  });
  const bridgePort = await listen(bridge);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-certified-stdio-"));
  fs.writeFileSync(path.join(workspace, "write_grant.json"), JSON.stringify({
    token: "grant-cannot-override-certification",
    expires_at_utc: new Date(Date.now() + 60_000).toISOString()
  }), "utf8");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      REVIT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      OPERATOR_TOKEN: "mcp-certified-stdio-token",
      OPERATOR_WORKSPACE_ROOT: workspace,
      REVIT_OPERATOR_MODE: "self_hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: certifiedPolicyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: certifiedPolicyHash,
      OPERATOR_TEST_REGISTER_UNBOUND_MCP_ALIAS: "1"
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "revit-operator-certified-stdio-smoke", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => {
    try {
      await withTimeout(client.close(), "closing certified MCP client", 5_000);
    } finally {
      await withTimeout(transport.close(), "closing certified MCP child transport", 5_000);
      await closeServer(bridge);
    }
  });

  try {
    await withTimeout(client.connect(transport), "initializing certified MCP stdio server");
  } catch (error) {
    throw new Error(`${String(error)}\nMCP stderr:\n${stderr.join("")}`);
  }

  const probe = await withTimeout(client.callTool({ name: "operator_runtime_probe", arguments: {} }), "probing certified MCP runtime");
  const probeText = (probe as any).content.map((item: any) => item.text ?? "").join("\n");
  assert.match(probeText, /"mode": "certified"/);
  assert.match(probeText, /"status": "loaded"/);
  assert.match(probeText, new RegExp(certifiedPolicyHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(probeText, /"trustSource": "deployment"/);

  const listed = await withTimeout(client.listTools(), "listing certified MCP tools");
  const listedNames = listed.tools.map(tool => tool.name).sort();
  assert.equal(listedNames.includes("operator_runtime_probe"), true);
  assert.deepEqual(listedNames, certifiedSafeNonRevitAliases, "Certified tools/list must expose exactly the declared safe local/diagnostic aliases.");
  assert.equal(listedNames.length, certifiedSafeNonRevitAliases.length);
  assert.deepEqual(
    listedNames.filter(name => name.startsWith("revit_")),
    ["revit_get_context"],
    "Only the certified typed context alias may be model-visible in tools/list."
  );
  assert.equal(listedNames.includes("titleblock_update_text"), false, "The non-revit bridge alias must not bypass certified visibility.");
  assert.equal(listedNames.includes("operator_test_unbound_mcp_alias"), false, "An unbound alias registered through registerTool must fail closed.");
  assert.equal(listedNames.includes("revit_observe_model"), false, "The laboratory-only observation alias must not leak into certified tools/list.");

  const blockedObservation = await withTimeout(client.callTool({
    name: "revit_observe_model",
    arguments: {}
  }), "blocking the hidden spatial observation alias in certified mode");
  assert.equal((blockedObservation as any).isError, true, "The hidden spatial observation alias must fail closed in certified mode.");
  assert.equal(bridgeRequests, 0, "A direct call to the hidden spatial observation alias must not reach the bridge.");

  const blockedCalls = [
    { name: "revit_ping", arguments: {} },
    { name: "revit_call_tool", arguments: { method: "GET", path: "/revit/not-certified", requireKnownPath: false } },
    { name: "revit_call_tool", arguments: { method: "POST", path: "/revit/schedules", body: { action: "list", max: 10, query: "" }, requireKnownPath: false } },
    { name: "revit_call_tool", arguments: { method: "POST", path: "/revit/update-schedule-cell", body: { apply: true }, requireKnownPath: false } },
    { name: "revit_search_tools", arguments: { query: "schedules", method: "POST" } },
    { name: "revit_tool_doc", arguments: { method: "POST", path: "/revit/schedules" } },
    { name: "revit_tool_examples", arguments: { method: "POST", path: "/revit/schedules" } }
  ];
  for (const input of blockedCalls) {
    const result = await withTimeout(client.callTool(input as any), `blocking ${input.name}`);
    assert.equal((result as any).isError, true, `${input.name} must fail closed in current certified policy.`);
  }
  assert.equal(bridgeRequests, 0, "No direct, generic, search, or grant-backed call may reach the bridge under the current policy.");
});

test("MCP stdio tools/list follows trusted aliases and cached registry data is re-filtered after revocation", async (t) => {
  const operatorToken = "mcp-cache-token-0123456789abcdef0";
  const serverEpoch = Buffer.alloc(32, 11).toString("base64url");
  const policyVariant = writeSmokePolicyVariant(policy => {
    const registry = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/tool-registry");
    registry.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
    registry.channels.search = { exposed: true, required_level: "L3", reason_codes: ["CERTIFIED"] };
    const context = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/context");
    context.channels.search = { exposed: true, required_level: "L3", reason_codes: ["CERTIFIED"] };
  });
  let bridgeRequests = 0;
  const bridge = http.createServer(async (req, res) => {
    bridgeRequests += 1;
    const requestBody = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    assert.equal(req.method, "POST");
    assert.equal(req.url, NATIVE_TRANSPORT_PATH);
    assert.equal(req.headers["x-operator-token"], undefined);
    assert.equal(req.headers["x-operator-write-grant"], undefined);
    const responseBody = JSON.stringify({
      version: "operator.tool_registry.v1",
      tools: [
        { method: "GET", path: "/revit/context", title: "Context" },
        { method: "GET", path: "/revit/uncertified", title: "Must stay hidden" }
      ]
    });
    res.setHeader("content-type", NATIVE_TRANSPORT_CONTENT_TYPE);
    res.end(protectedSmokeResponse(requestBody, operatorToken, 200, responseBody));
  });
  const bridgePort = await listen(bridge);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-cache-"));
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-cache-localappdata-"));
  writeNativeReceipt(localAppData, `http://127.0.0.1:${bridgePort}`, serverEpoch);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      REVIT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      OPERATOR_TOKEN: operatorToken,
      OPERATOR_WORKSPACE_ROOT: workspace,
      LOCALAPPDATA: localAppData,
      REVIT_OPERATOR_MODE: "self_hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policyVariant.policyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: policyVariant.policyHash
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "revit-operator-cache-smoke", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => {
    try {
      await withTimeout(client.close(), "closing cache MCP client", 5_000);
    } finally {
      await withTimeout(transport.close(), "closing cache MCP child transport", 5_000);
      await closeServer(bridge);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(policyVariant.root, { recursive: true, force: true });
    }
  });
  await withTimeout(client.connect(transport), "initializing cache MCP server");

  const listed = await withTimeout(client.listTools(), "listing trusted MCP aliases");
  const names = listed.tools.map(tool => tool.name);
  assert.equal(names.includes("revit_tool_registry"), true);
  assert.equal(names.includes("revit_get_context"), true);

  const first = await withTimeout(client.callTool({
    name: "revit_tool_registry",
    arguments: { limit: 10 }
  }), "reading certified registry");
  const firstText = (first as any).content.map((item: any) => item.text ?? "").join("\n");
  assert.match(firstText, /\/revit\/context/);
  assert.doesNotMatch(firstText, /\/revit\/uncertified/);
  assert.equal(bridgeRequests, 1);

  // A rollback/tamper after the raw registry has been cached must fail closed
  // instead of returning the formerly visible cached entry.
  fs.copyFileSync(certifiedPolicyPath, policyVariant.policyPath);
  const revoked = await withTimeout(client.callTool({
    name: "revit_tool_registry",
    arguments: { limit: 10 }
  }), "re-filtering cached registry after policy rollback");
  assert.equal((revoked as any).isError, true);
  assert.match((revoked as any).content[0].text, /disabled|TOOL_EXPOSURE_POLICY_ROLLBACK_REJECTED/i);
  assert.equal(bridgeRequests, 1, "Cached raw registry data should be re-filtered without another bridge dispatch.");
});

test("capability metadata is session-cached while explicit refresh remains available", () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), "src/server.ts"), "utf8");
  assert.match(serverSource, /OPERATOR_TOOL_REGISTRY_CACHE_MS \?\? "1800000"/);
  assert.match(serverSource, /function freshCachedToolRegistry/);
  assert.match(serverSource, /const cachedToolMetadata = new Map/);
  assert.match(serverSource, /callRevit\("\/revit\/tool-doc", "POST", args\)/);
  assert.match(serverSource, /callRevit\("\/revit\/tool-examples", "POST", args\)/);
  assert.match(serverSource, /!freshCachedToolRegistry\(\) && !args\.forceRefresh/);
});
