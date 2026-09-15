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
  "operator_discover_capabilities",
  "operator_evaluate_assignment_criteria",
  "operator_request_assignment_input",
  "operator_plan_semantic_mep_route",
  "operator_record_execution_strategy",
  "operator_request_clarification",
  "operator_retrieve_evidence",
  "operator_submit_noop_completion",
  "operator_submit_read_completion",
  "operator_runtime_probe",
  "read_excel",
  "read_pdf_text",
  "read_word",
  "revit_get_context",
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
  assert.equal(laboratoryNames.length, 93, "Exact development laboratory mode must preserve the supported catalog, excluding retired prototype workflows, plus V2 criterion evaluation, trusted-binding input request, legacy clarification, evidence retrieval, legacy completion, bootstrap discovery, strategy evidence, Dynamic Runtime, observation, target readback, laboratory SafeRead, and bounded move-family aliases.");
  assert.equal(laboratoryNames.filter(name => name.startsWith("revit_")).length, 74, "Exact development laboratory mode must preserve retained Revit aliases plus observation, target readback, laboratory SafeRead, and the bounded move-family alias.");
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
          { method: "POST", path: "/revit/create-view", group: "Test", risk: "medium", title: "Test Write", description: "Smoke write" }
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
    if (requestUrl.pathname === "/revit/export-view-frame") {
      res.end(JSON.stringify({frameId:"frame-stdio-1",path:observationImagePath,viewId:42,widthPx:1200,heightPx:675,
        mapping:{mode:"2d_affine",topLeftXyz:[0,10,0],topRightXyz:[10,10,0],bottomLeftXyz:[0,0,0]}}));
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
    if (requestUrl.pathname === "/revit/create-view") {
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
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
      OPERATOR_UNSAFE_LEGACY_PLAINTEXT_REVIT_TRANSPORT: "1"
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
  assert.equal(tools.tools.length, 93, "Laboratory mode must preserve the supported catalog, excluding retired prototype workflows, plus V2 criterion evaluation, trusted-binding input request, legacy clarification, evidence retrieval, legacy completion, bootstrap discovery, strategy evidence, Dynamic Runtime, observation, target readback, SafeRead, and bounded move-family aliases.");
  assert.equal([...names].filter(name => name.startsWith("revit_")).length, 74, "Laboratory mode must preserve retained revit_ aliases plus observation, target readback, SafeRead, and the bounded move-family alias.");
  assert.equal(names.has("revit_observe_model"), true, "Laboratory tools/list must include the typed spatial observation alias.");
  // Retirement must remove discovery and executable aliases before either transport.
  const retiredPrototypeAliases = [
    "revit_place_vavs", "revit_run_thermal_zoning", "revit_run_load_calc", "revit_run_code_check"
  ];
  const requestsBeforeRetiredCalls = { backend: backendRequests, bridge: bridgeRequests.length };
  for (const name of retiredPrototypeAliases) {
    assert.equal(names.has(name), false, `Retired prototype must not be advertised: ${name}`);
    const denied = await withTimeout(client.callTool({ name, arguments: { query: "Level 1", levelName: "Level 1" } }), `rejecting retired alias ${name}`);
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /not found/i);
  }
  assert.deepEqual({ backend: backendRequests, bridge: bridgeRequests.length }, requestsBeforeRetiredCalls,
    "Retired aliases must fail before backend or native transport, without fallback execution.");
  for (const retained of ["revit_query_elements", "revit_place_families", "revit_get_parameters", "revit_set_parameters"])
    assert.equal(names.has(retained), true, `General primitive must survive wrapper retirement: ${retained}`);

  assert.equal(names.has("titleblock_update_text"), false, "Laboratory mode cannot restore an excluded composite alias.");
  for (const name of [
    "operator_runtime_probe",
    "operator_plan_semantic_mep_route",
    "operator_record_execution_strategy",
    "operator_request_clarification",
    "operator_evaluate_assignment_criteria",
    "operator_request_assignment_input",
    "operator_retrieve_evidence",
    "operator_submit_noop_completion",
    "operator_submit_read_completion",
    "operator_run_dynamic_revit_program",
    "revit_list_schedules",
    "revit_get_parameters",
    "revit_count_sheets_certified",
    "revit_update_schedule_cell",
    "revit_set_parameters"
  ]) {
    assert.equal(names.has(name), true, `Missing MCP tool: ${name}`);
  }
  const sheetTool = tools.tools.find(tool => tool.name === "revit_list_sheets");
  const retrievalTool = tools.tools.find(tool => tool.name === "operator_retrieve_evidence")!;
  assert.match(retrievalTool.description!, /pagination.next_start/);
  assert.match(retrievalTool.description!, /projection.key_counts/);
  assert.match(retrievalTool.description!, /missing_fields/);
  const generatedTool = tools.tools.find(tool => tool.name === "operator_run_dynamic_revit_program")!;
  // Code-mode clients can discard descriptions on schema properties. Discovery
  // must still contain everything needed to write the first valid program.
  assert.match(generatedTool.description!, /IDynamicRevitProgram/);
  assert.match(generatedTool.description!, /DynamicProgramResult Execute\(DynamicRevitContext c\)/);
  assert.match(generatedTool.description!, /category=OST_DuctCurves/);
  assert.match(generatedTool.description!, /public sealed class SampleReport/);
  assert.match(generatedTool.description!, /print text\(result\) directly/);
  assert.match(generatedTool.description!, /operation_budget at its default/);
  assert.match(generatedTool.description!, /snapshot_limit is 1\.\.1000/);
  assert.match(generatedTool.description!, /path:\["report","Inspected"\]/);
  assert.match(generatedTool.description!, /prioritized assessment with evidence_indices/);
  assert.match(generatedTool.description!, /Missing parameter keys do not establish missing model relationships/);
  for (const limit of [0, 1001, 3000, 5000]) {
    const denied = await client.callTool({ name: generatedTool.name,
      arguments: { mode: "read", source: "public class Program {}", category: "OST_DuctCurves", snapshot_limit: limit } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Input validation error/);
    assert.match(JSON.stringify(denied.content), /snapshot_limit/);
  }
  const invalidGenerated = await client.callTool({ name: generatedTool.name,
    arguments: { mode: "read", source: "public class Program {}", category: "duct sample summary by type" } });
  assert.equal(invalidGenerated.isError, true);
  assert.match(JSON.stringify(invalidGenerated.content), /category/);
  assert.match(JSON.stringify(invalidGenerated.content), /Input validation error/);
  const safeReadTool = tools.tools.find(tool => tool.name === "revit_count_sheets_certified");
  const getParametersTool = tools.tools.find(tool => tool.name === "revit_get_parameters");
  const findTextNotesTool = tools.tools.find(tool => tool.name === "revit_find_text_notes");
  const schedulesTool = tools.tools.find(tool => tool.name === "revit_list_schedules");
  const v2CriteriaTool = tools.tools.find(tool => tool.name === "operator_evaluate_assignment_criteria");
  const v2InputTool = tools.tools.find(tool => tool.name === "operator_request_assignment_input");
  assert.equal((v2InputTool?.inputSchema as any)?.properties?.newVariableIds?.maxItems, 1);
  assert.match(v2InputTool!.description!, /newVariableIds/);
  for (const newVariableIds of [["bad-name"], ["floor_name", "corner_definition"]]) {
    const denied = await client.callTool({ name: "operator_request_assignment_input", arguments: {
      clarificationId: "new-floor", variableIds: ["floor_name"], newVariableIds, question: "Which floor?" } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /Input validation error/);
  }
  for (const tool of [v2CriteriaTool, v2InputTool]) {
    const properties = (tool?.inputSchema as any)?.properties ?? {};
    for (const lifecycleField of ["assignmentId", "runId", "generation", "sessionId", "principalId"]) {
      assert.equal(Object.hasOwn(properties, lifecycleField), false, `${tool?.name} must receive ${lifecycleField} only from trusted request metadata.`);
    }
  }
  assert.deepEqual((sheetTool?.inputSchema as any)?.properties?.action?.enum, ["list", "count"]);
  assert.deepEqual((safeReadTool?.inputSchema as any)?.properties, {});
  assert.equal((safeReadTool?.inputSchema as any)?.additionalProperties, false);
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.elementIds?.anyOf?.length, 2);
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.names?.items?.type, "string");
  assert.equal((getParametersTool?.inputSchema as any)?.properties?.limit?.maximum, 500);
  assert.deepEqual((findTextNotesTool?.inputSchema as any)?.required ?? [], []);
  assert.equal((findTextNotesTool?.inputSchema as any)?.properties?.elementIds?.items?.type, "integer");
  assert.equal((findTextNotesTool?.inputSchema as any)?.properties?.elementIds?.maxItems, 500);
  assert.equal((findTextNotesTool?.inputSchema as any)?.properties?.max?.minimum, 1);
  assert.equal((findTextNotesTool?.inputSchema as any)?.properties?.max?.maximum, 500);
  assert.equal((schedulesTool?.inputSchema as any)?.properties?.maxRows?.maximum, 500);
  assert.equal((schedulesTool?.inputSchema as any)?.properties?.maxColumns?.maximum, 100);
  const runtimeProbe = await withTimeout(client.callTool({ name: "operator_runtime_probe", arguments: {} }), "probing MCP runtime");
  assert.match((runtimeProbe as any).content[0].text, /operator\.mcp\.runtime\.v1/);
  const discovery = await withTimeout(client.callTool({
    name: "operator_discover_capabilities",
    arguments: { need: "inspect the current Revit context", maxResults: 4 }
  }), "discovering live laboratory capabilities");
  const discoveryPayload = JSON.parse((discovery as any).content[0].text);
  assert.equal(discoveryPayload.schemaVersion, "revit-operator.general-agent-capability-discovery.v2");
  assert.equal(discoveryPayload.exposureMode, "general");
  assert.equal(discoveryPayload.runtimeMode, "development");
  assert.equal(discoveryPayload.status, "available");
  assert.ok(discoveryPayload.capabilities.some((capability: any) =>
    capability.method === "GET" && capability.path === "/revit/context"));
  for (const name of ["revit_repair_mep_connectors", "revit_dry_run_repair_mep_connectors"]) {
    const denied = await client.callTool({ name, arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /disabled/i);
  }
  assert.equal(connectorRepairBodies.length, 0, "Excluded connector convenience tools cannot execute through laboratory mode.");

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

  const viewFrame = await withTimeout(client.callTool({
    name: "revit_export_view_frame", arguments: {viewId:42,imageSize:1200,includeMapping:true}
  }), "delivering the exported view image with its mapping over stdio");
  assert.equal((viewFrame as any).content.some((item:any)=>item.type==="image" && item.mimeType==="image/png"),true,
    "The exported Revit image must reach the model, not only its filename and mapping.");
  assert.match((viewFrame as any).content.find((item:any)=>item.type==="text").text,/frame-stdio-1/);

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
  assert.equal(scheduleReplacement.isError, true);
  assert.match(JSON.stringify(scheduleReplacement.content), /disabled/i);
  assert.equal(scheduleReplacementBodies.length, 0);

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
    arguments: { method: "POST", path: "/revit/create-view", body: { apply: true }, requireKnownPath: true }
  }), "calling a grant-backed generic bridge write over stdio");
  assert.match((write as any).content[0].text, /"applied": true/);
  assert.equal(bridgeRequests.every(request => request.token === "mcp-stdio-smoke-token"), true);
  assert.equal(bridgeRequests.some(request => request.path === "/revit/create-view" && request.grant === "grant-token"), true);

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

test("compiled MCP preserves native result selections and rejects malformed read delivery", async (t) => {
  const requests: any[] = [];
  const backend = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(backend);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-result-delivery-stdio-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist", "server.js")], cwd: process.cwd(),
    env: { ...env, OPERATOR_API_BASE_URL: `http://127.0.0.1:${port}`, OPERATOR_AUTH_MODE: "shared_token", OPERATOR_TOKEN: "test-only",
      OPERATOR_WORKSPACE_ROOT: workspace, REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "result-delivery-stdio", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await closeServer(backend); fs.rmSync(workspace, { recursive: true, force: true }); });
  await withTimeout(client.connect(transport), "connecting result delivery MCP");
  const binding = { assignment_id: "read-assignment", run_id: "read-run", session_id: "read-session", generation: 1, principal_id: "test" };
  const _meta = { "revit-operator/assignment-kernel-binding-v2": binding };
  const claims = [{ criterionId: "read-result", observationIds: ["native-observation"] }];
  const resultItems = [{ label: "System", observationId: "native-observation", path: ["items", 0, "parameters", "System Name"] }];
  const result = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims, resultItems }, _meta });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests, [{ path: "/api/assignments/v2/criteria/evaluate", body: {
    assignment_id: binding.assignment_id, run_id: binding.run_id, session_id: binding.session_id, generation: 1,
    claims: [{ criterion_id: "read-result", observation_ids: ["native-observation"] }],
    result_items: [{ label: "System", observation_id: "native-observation", path: ["items", 0, "parameters", "System Name"] }]
  } }]);
  for (const pathValue of [[], ["items", -1], ["items", 1.5]]) {
    const denied = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims,
      resultItems: [{ ...resultItems[0], path: pathValue }] }, _meta });
    assert.equal(denied.isError, true);
  }
  assert.equal(requests.length, 1, "invalid selectors must not reach the backend");
  const assessment = { overview: "Review system sizing.", findings: [{ priority: "high", title: "Confirm demand", text: "Check the branch against the design demand.", evidence_indices: [1] }], limitations: ["Demand is not known."], questions: ["What load should it serve?"] };
  const reviewed = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims, resultItems, assessment }, _meta });
  assert.notEqual(reviewed.isError, true); assert.deepEqual((requests[1].body as any).assessment, assessment);
  assert.deepEqual(requests[1].body.result_items, requests[0].body.result_items);
  for (const invalid of [{ ...assessment, authority: "native-host" }, { ...assessment, questions: ["1", "2", "3", "4"] },
    { ...assessment, findings: [{ ...assessment.findings[0], evidence_indices: [0] }] }]) {
    const denied = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims, resultItems, assessment: invalid }, _meta });
    assert.equal(denied.isError, true);
  }
  assert.equal(requests.length, 2, "malformed assessments must not reach the backend");
  const projected = [{ label: "Air devices", observationId: "native-observation", source: "deterministic_projection", path: ["key_counts", "inventory.total"] }];
  const projectionResult = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims, resultItems: projected }, _meta });
  assert.notEqual(projectionResult.isError, true);
  assert.deepEqual(requests[2].body.result_items, [{ label: "Air devices", observation_id: "native-observation", source: "deterministic_projection", path: ["key_counts", "inventory.total"] }]);
  for (const source of ["model_value", null, {}, "projection"]) {
    const denied = await client.callTool({ name: "operator_evaluate_assignment_criteria", arguments: { claims, resultItems: [{ ...projected[0], source }] }, _meta });
    assert.equal(denied.isError, true);
  }
  assert.equal(requests.length, 3, "unrecognized value sources cannot reach the backend");
});

test("compiled MCP forwards a request-scoped principal JWT to completion without model or audit leakage", async (t) => {
  const credential = "compiled-stdio-principal-jwt";
  const requests: Array<{ path: string; authorization: string; shared: string; body: string }> = [];
  const backend = http.createServer(async (req, res) => {
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    requests.push({
      path: new URL(req.url ?? "/", origin).pathname,
      authorization: String(req.headers.authorization ?? ""),
      shared: String(req.headers["x-operator-token"] ?? ""),
      body
    });
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized (missing/invalid Authorization: Bearer token)." }));
      return;
    }
    res.statusCode = 202;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, claim_id: "claim-compiled", status: "accepted" }));
  });
  const port = await listen(backend);
  const origin = `http://127.0.0.1:${port}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-mcp-principal-stdio-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "server.js")],
    cwd: process.cwd(),
    env: {
      ...env,
      OPERATOR_API_BASE_URL: origin,
      OPERATOR_AUTH_MODE: "principal_jwt",
      OPERATOR_TOKEN: "shared-token-must-not-be-used",
      OPERATOR_WORKSPACE_ROOT: workspace,
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
    },
    stderr: "pipe"
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "principal-auth-stdio-test", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    await closeServer(backend);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  await withTimeout(client.connect(transport), "connecting principal auth MCP stdio");

  const authMeta = {
    "revit-operator/backend-auth": {
      schema: "revit-operator.operator-backend-auth/v1",
      mode: "principal_jwt",
      credential,
      allowed_origin: origin
    }
  };
  const result = await withTimeout(client.callTool({
    name: "operator_submit_read_completion",
    arguments: {
      assignmentId: "assignment-a",
      runId: "run-a",
      generation: 1,
      sessionId: "session-a",
      resultKind: "inventory",
      criteria: [{ criterion: "Return the requested inventory.", assertionIds: ["inventory"] }],
      assertions: [{
        assertionId: "inventory",
        attemptId: "attempt-a",
        evidenceId: `ev1_${"a".repeat(32)}`,
        operation: "array_count",
        path: "items",
        expectedCount: 1
      }]
    },
    _meta: authMeta
  }), "submitting principal-authenticated completion through compiled MCP");

  assert.equal((result as any).isError, undefined, stderr.join(""));
  const evidence = await withTimeout(client.callTool({
    name: "operator_retrieve_evidence",
    arguments: {
      evidenceId: `ev1_${"b".repeat(32)}`,
      sessionId: "session-a",
      assignmentId: "assignment-a",
      runId: "run-a",
      generation: 1,
      purpose: "Read one exact inventory count.",
      fields: ["count"],
      maxBytes: 4096
    },
    _meta: authMeta
  }), "retrieving principal-authenticated evidence through compiled MCP");
  assert.equal((evidence as any).isError, undefined, stderr.join(""));
  const targetedEvidence = await withTimeout(client.callTool({
    name: "operator_retrieve_evidence",
    arguments: {
      evidenceId: `ev1_${"c".repeat(32)}`,
      sessionId: "session-a",
      assignmentId: "assignment-a",
      runId: "run-a",
      generation: 1,
      purpose: "Read the one exact TextNote candidate selected by its native identity.",
      targetSubset: ["1478627"],
      maxBytes: 4096
    },
    _meta: authMeta
  }), "retrieving exact target-bound evidence through compiled MCP");
  assert.equal((targetedEvidence as any).isError, undefined, stderr.join(""));

  const requestCountBeforeConflict = requests.length;
  const ambiguousEvidence = await withTimeout(client.callTool({
    name: "operator_retrieve_evidence",
    arguments: {
      evidenceId: `ev1_${"d".repeat(32)}`,
      sessionId: "session-a",
      assignmentId: "assignment-a",
      runId: "run-a",
      generation: 1,
      purpose: "Reject an ambiguous focused-evidence request before transport.",
      fields: ["payload.items"],
      targetSubset: ["1478627"],
      maxBytes: 4096
    },
    _meta: authMeta
  }), "rejecting an ambiguous evidence selector through compiled MCP");
  assert.equal((ambiguousEvidence as any).isError, true);
  assert.match((ambiguousEvidence as any).content.map((item: any) => item.text ?? "").join("\n"), /exactly one active selector/);
  assert.equal(requests.length, requestCountBeforeConflict, "Ambiguous selectors must fail before backend transport.");

  const semantic = await withTimeout(client.callTool({
    name: "operator_plan_semantic_mep_route",
    arguments: { userText: "Route one bounded branch." },
    _meta: authMeta
  }), "planning a principal-authenticated semantic route through compiled MCP");
  assert.equal((semantic as any).isError, undefined, stderr.join(""));

  assert.deepEqual(requests.map(request => request.path), [
    "/api/assignments/read-completion-claims",
    "/evidence/retrieve",
    "/evidence/retrieve",
    "/tools/mep/semantic-route-plan"
  ]);
  assert.deepEqual(JSON.parse(requests[1]!.body).fields, ["count"]);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(requests[1]!.body), "target_subset"), false);
  assert.deepEqual(JSON.parse(requests[2]!.body).target_subset, ["1478627"]);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(requests[2]!.body), "fields"), false);
  for (const request of requests) {
    assert.equal(request.authorization, `Bearer ${credential}`);
    assert.equal(request.shared, "");
    assert.doesNotMatch(request.body, new RegExp(credential));
  }
  const auditPath = path.join(workspace, "logs", "mcp-server-audit.jsonl");
  assert.equal(fs.existsSync(auditPath), true);
  assert.doesNotMatch(fs.readFileSync(auditPath, "utf8"), new RegExp(credential));
  assert.doesNotMatch(stderr.join(""), new RegExp(credential));
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

test("reviewed typed verification reads propagate the exact kernel fulfillment grant", () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), "src/server.ts"), "utf8");
  for (const route of ["find-text-notes", "get-element-summary", "get-parameters"]) {
    const escaped = route.replace(/-/g, "\\-");
    assert.match(
      serverSource,
      new RegExp(`callRevit\\(\"/revit/${escaped}\", \"POST\",[\\s\\S]{0,220}assignmentFulfillmentRole: currentAssignmentKernelTaskFulfillmentRoleV2\\(\\)`),
      `The reviewed ${route} handler must preserve task/verification fulfillment at the native edge.`
    );
  }
});

test("compiled typed task handlers preserve native fulfillment while previews and documentation stay control", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-typed-fulfillment-"));
  const binding = { assignment_id: "typed-assignment", run_id: "typed-run", session_id: "typed-session", generation: 1, principal_id: "test" };
  let parent: any;
  const children: any[] = [];
  const settlements: any[] = [];
  const nativeRequests: string[] = [];
  const backend = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/assignments/v2/operations/children") {
      children.push(input);
      res.end(JSON.stringify({ operation_lease_v2: { ...parent, operation_id: `child-${children.length}`,
        parent_operation_id: parent.operation_id, root_operation_id: parent.operation_id, operation_role: "child",
        capability_id: input.capability_id, requested_effect: input.classified_effect,
        purpose: input.fulfillment_role === "delegated_task_execution" ? "work" : "discovery",
        fulfillment_role: input.fulfillment_role, eligible_criterion_ids: input.eligible_criterion_ids,
        delegation_authority_id: input.delegation_authority_id,
        request_identity: { capability_id: input.capability_id, method: input.method, path: input.path, request_signature: `request-${children.length}` }
      } }));
    } else if (req.url === "/api/assignments/v2/operations/results") {
      settlements.push(input); res.end(JSON.stringify({ settled: true }));
    } else if (req.url === "/api/assignments/v2/operations/dispatch") {
      res.end(JSON.stringify({ ok: true }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected backend route" })); }
  });
  const bridge = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    nativeRequests.push(req.url!);
    const write = req.url === "/revit/set-parameter" || req.url === "/revit/replace-text-note";
    const preview = write && input.apply !== true;
    const payload = req.url === "/revit/set-parameter"
      ? { status: preview ? "Dry Run" : "Applied and Verified", dryRun: preview, changedCount: 1, verifiedCount: preview ? 0 : 1,
          verificationPerformed: !preview, verificationFailedCount: 0, writeFailedCount: 0, changedElementIds: [1380354],
          diffs: [{ elementId: 1380354, parameterName: "Comments", ok: true, changed: true,
            before: { value: null }, after: { value: "UI CHECK" } }] }
      : req.url === "/revit/replace-text-note" ? { elementId: 42, updated: true, newText: "Coordination issue" }
      : req.url === "/revit/sheets" ? { items: [{ id: 42, number: "M001" }], total: 1 }
      : { path: "/revit/set-parameter", request: { changes: [] } };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...payload, canonical_attempt_settlement: {
      attempt_id: `native-${nativeRequests.length}`, requested_effect: write ? preview ? "preview" : "apply" : "read",
      effect_state: write && !preview ? "applied" : "none", request_dispatched: true,
      affected_target_identities: write ? [req.url === "/revit/set-parameter" ? "element_id:1380354" : "element_id:42"] : []
    } }));
  });
  const backendPort = await listen(backend);
  const bridgePort = await listen(bridge);
  fs.writeFileSync(path.join(workspace, "write_grant.json"), JSON.stringify({ token: "test-only", expires_at_utc: new Date(Date.now()+60_000).toISOString() }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), "dist", "server.js")], cwd: process.cwd(),
    env: { ...env, OPERATOR_API_BASE_URL: `http://127.0.0.1:${backendPort}`, REVIT_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      OPERATOR_AUTH_MODE: "shared_token", OPERATOR_TOKEN: "test-only", OPERATOR_WORKSPACE_ROOT: workspace,
      REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory", OPERATOR_UNSAFE_LEGACY_PLAINTEXT_REVIT_TRANSPORT: "1" }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "typed-fulfillment-stdio", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); await closeServer(backend); await closeServer(bridge); fs.rmSync(workspace,{recursive:true,force:true}); });
  await withTimeout(client.connect(transport), "connecting typed fulfillment MCP");
  const scenarios = [
    { tool: "revit_set_parameters", effect: "apply", role: "delegated_task_execution", args: { apply: true, changes: [{ elementId: 1380354, parameterName: "Comments", value: "UI CHECK", expectedOldValue: "" }] } },
    { tool: "revit_replace_text_note", effect: "apply", role: "delegated_task_execution", args: { elementId: 42, newText: "Coordination issue", apply: true } },
    { tool: "revit_list_sheets", effect: "read", role: "delegated_task_execution", args: { action: "list" } },
    { tool: "revit_set_parameters", effect: "preview", role: "supporting_control", args: { dryRun: true, changes: [{ elementId: 1380354, parameterName: "Comments", value: "UI CHECK" }] } },
    { tool: "revit_tool_doc", effect: "read", role: "supporting_control", args: { method: "POST", path: "/revit/set-parameter" } }
  ];
  for (const scenario of scenarios) {
    const countBefore = nativeRequests.length;
    parent = { schema: "revit-operator.assignment-kernel-operation-context/v2", assignment_id: binding.assignment_id, binding,
      operation_id: `parent-${countBefore}`, root_operation_id: `parent-${countBefore}`, capability_id: scenario.tool,
      requested_effect: scenario.effect, purpose: scenario.role === "supporting_control" ? "discovery" : "work",
      operation_role: "root", blocks_parent_settlement: false, fulfillment_role: scenario.role,
      ...(scenario.role === "delegated_task_execution" ? { delegation_authority_id: `delegation-${countBefore}` } : {}),
      eligible_criterion_ids: scenario.role === "delegated_task_execution" ? ["requested-task"] : [],
      request_identity: { capability_id: scenario.tool, request_signature: `parent-request-${countBefore}` },
      opened_at: new Date().toISOString(), deadline_at: new Date(Date.now()+60_000).toISOString() };
    const result = await client.callTool({ name: scenario.tool, arguments: scenario.args, _meta: { "revit-operator/assignment-kernel-v2": parent } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(nativeRequests.length, countBefore+1, "one typed call must dispatch its native action exactly once");
    assert.equal(children.at(-1).fulfillment_role, scenario.role, scenario.tool);
    assert.deepEqual(children.at(-1).eligible_criterion_ids, parent.eligible_criterion_ids);
    const observation = settlements.at(-1).mcp_result.structuredContent.observation;
    assert.equal(observation.evidence_class, scenario.role === "delegated_task_execution" ? "task_result" : "control", scenario.tool);
    assert.equal(observation.semantic_facts.some((fact: any) => fact.fact_id === "task.result_available"), scenario.role === "delegated_task_execution");
    const rootResult = (result.structuredContent as any).operation_result_v2;
    if (scenario.tool === "revit_tool_doc") {
      assert.notEqual(rootResult.authority, "native-host", "durable documentation is an adapter result, not another native dispatch");
      assert.equal((result.structuredContent as any).observation.evidence_class, "control");
    } else {
      assert.equal(rootResult.status, "completed_without_native_dispatch", "the abstract parent cannot invent another native action");
    }
  }
});
