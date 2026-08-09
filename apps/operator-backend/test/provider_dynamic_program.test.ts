import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA,
  PROVIDER_DYNAMIC_PROGRAM_V1,
  executeProviderDynamicProgramLane,
  isTrustedDynamicProgramRunnerEnabled,
  normalizeProviderDynamicProgram,
  runTrustedProviderDynamicProgram,
  type ProviderDynamicProgramV1
} from "../src/dynamic_runtime/provider_dynamic_program.js";
import { decideAnthropic, decideGemini } from "../src/brains/external_provider_brain.js";
import { decideOpenAi } from "../src/brains/openai_brain.js";
import { guardGenericTeammateDecision } from "../src/teammate_loop_runtime.js";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse
} from "../src/contracts.js";

function request(id: string): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: `provider-dynamic-${id}`,
    message_id: "message-1",
    user_text: "Move the bounded mechanical set using a short custom loop."
  };
}

function program(overrides: Partial<ProviderDynamicProgramV1> = {}): ProviderDynamicProgramV1 {
  return {
    schema: PROVIDER_DYNAMIC_PROGRAM_V1,
    source: "using RevitOperator.DynamicRevitSdk; public sealed class Program { }",
    apply: false,
    category: "OST_MechanicalEquipment",
    parameters: ["Mark", "Comments"],
    limit: 120,
    operation_budget: 16,
    worker_deadline_ms: 10_000,
    apply_deadline_ms: 5_000,
    target_revit_year: "2024",
    ...overrides
  };
}

function strategy() {
  return {
    schema: "revit-operator.execution-strategy-evidence.v1" as const,
    selected_substrate: "dynamic_revit_program" as const,
    reason: "A bounded custom loop is clearer than a long typed composition."
  };
}

function sha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function supervisorEvidence(args: {
  source: string;
  supervisorPackageSha256: string;
  workerRuntimePackageSha256: string;
  targetRevitYear?: "2023" | "2024" | "2025";
}): Record<string, unknown> {
  const runtimeId = "runtime-1";
  const sessionId = "session-1";
  const fingerprint = `sha256:${"6".repeat(64)}`;
  const inputHash = `sha256:${"4".repeat(64)}`;
  const graphHash = `sha256:${"5".repeat(64)}`;
  const sourceHash = sha256(args.source);
  const programHash = `sha256:${"2".repeat(64)}`;
  const sdkHash = `sha256:${"3".repeat(64)}`;
  const registrationReceipt = JSON.stringify({
    schema: "dynamic-revit-runtime-registration-receipt/v0", ok: true,
    runtime_instance_id: runtimeId, expires_unix_seconds: 4_000_000_000
  });
  const snapshotReceipt = JSON.stringify({
    schema: "dynamic-revit-snapshot/v0", sdk: "dynamic-revit-sdk/v0", input_hash: inputHash,
    document: { ProjectFingerprint: fingerprint, SessionId: sessionId, Title: "Fixture", ActiveViewId: 1, ActiveViewName: "View" },
    snapshot_token: "fixture-token", elements: []
  });
  const workerOutput = {
    schema: "dynamic-revit-worker-output/v0", ok: true, sourceHash, programHash, sdkHash,
    graph: { schema: "dynamic-revit-operation-graph/v0", inputHash, operations: [{ kind: "fixture" }], graphHash },
    logs: [], report: {}, diagnostics: []
  };
  const admission = {
    schema: "dynamic-revit-worker-admission/v0", runtimeInstanceId: runtimeId,
    launcherExecutableHash: args.supervisorPackageSha256, workerExecutableHash: `sha256:${"7".repeat(64)}`,
    sandboxProfile: "windows-lpac-v1-zero-capabilities", workerProcessId: 10,
    startupNonceHash: `sha256:${"8".repeat(64)}`, taskDirectoryIdentity: `sha256:${"9".repeat(64)}`,
    sourceHash, programHash, sdkVersion: "dynamic-revit-sdk/v0", sdkHash, operationGraphHash: graphHash,
    documentFingerprint: fingerprint, documentSessionId: sessionId, correlationId: "correlation-1",
    expiresUnixSeconds: 4_000_000_000, signature: `hmac-sha256:${"a".repeat(64)}`
  };
  const previewReceipt = JSON.stringify({
    schema: "dynamic-revit-preview-receipt/v0", ok: true, preview_id: "preview-1",
    source_hash: sourceHash, program_hash: programHash, sdk_hash: sdkHash, input_hash: inputHash,
    graph_hash: graphHash, document_fingerprint: fingerprint, document_session_id: sessionId,
    worker_identity: admission, operation_count: 1, target_ids: ["target-1"],
    projected_changed_element_ids: [1], rollback_verified_element_ids: [1], change_tracking: {},
    projected_changes: [], failures: [], warnings: [], rollback_status: "rolled_back",
    rollback_truth: true, elapsed_milliseconds: 1
  });
  const authenticated = (purpose: string, raw: string) => JSON.stringify({
    schema: "dynamic-revit-authenticated-receipt/v0", runtime_instance_id: runtimeId, purpose,
    expires_unix_seconds: 4_000_000_000, receipt_hash: sha256(raw),
    host_receipt_mac: `hmac-sha256:${"b".repeat(64)}`, receipt: JSON.parse(raw)
  });
  const bootstrap = JSON.stringify({
    schema: "dynamic-revit-bootstrap-receipt/v0", ok: true, runtimeInstanceId: runtimeId,
    launcherProcessId: 20, revitProcessId: 30, expiresUnixSeconds: 4_000_000_000,
    launcherExecutableHash: args.supervisorPackageSha256, proofHash: `sha256:${"c".repeat(64)}`,
    hostProofMac: `hmac-sha256:${"d".repeat(64)}`
  });
  const target = args.targetRevitYear ?? "2024";
  const host = `C:\\Program Files\\Autodesk\\Revit ${target}\\Revit.exe`;
  return {
    schema: "dynamic-revit-phase2-live-evidence/v0", ok: true,
    startedUtc: "2026-08-09T10:00:00.000Z", completedUtc: "2026-08-09T10:00:01.000Z",
    sandboxProfile: "windows-lpac-v1-zero-capabilities", taskDirectory: "C:\\fixture\\task",
    registrationReceipt, snapshotReceipt, workerOutput, admission, previewReceipt,
    applyAuthorizationReceipt: null, v1Admission: null, applyReceipt: null,
    hostAuthenticationReceipts: [bootstrap, authenticated("snapshot-receipt", snapshotReceipt), authenticated("register-worker-receipt", registrationReceipt), authenticated("preview-receipt", previewReceipt)],
    replayEvidence: null, failure: null, runtimeImageDirectory: "C:\\fixture\\runtime",
    runtimeImageIdentity: args.workerRuntimePackageSha256, runtimeDependencyCount: 5,
    targetRevitYear: target, expectedHostExecutable: host, observedHostExecutable: host
  };
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("provider dynamic_program schema is exact and bounded", () => {
  assert.equal(PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    [...PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.required].sort(),
    [
      "schema", "source", "apply", "category", "parameters", "limit",
      "operation_budget", "worker_deadline_ms", "apply_deadline_ms", "target_revit_year"
    ].sort()
  );
  assert.equal(PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.properties.source.maxLength, 65_536);
  assert.equal(PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.properties.parameters.maxItems, 16);
  assert.equal(PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.properties.limit.maximum, 1000);
  assert.equal(PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA.properties.apply_deadline_ms.maximum, 5000);
  assert.deepEqual(normalizeProviderDynamicProgram(program()), program());
  assert.throws(
    () => normalizeProviderDynamicProgram({ ...program(), extra: true }),
    /unexpected or missing fields/
  );
  assert.throws(
    () => normalizeProviderDynamicProgram(program({ operation_budget: 257 })),
    /operation_budget/
  );
  assert.throws(() => normalizeProviderDynamicProgram(program({ category: "Mechanical Equipment" })), /BuiltInCategory/);
  assert.throws(() => normalizeProviderDynamicProgram(program({ limit: 1001 })), /limit/);
  assert.throws(() => normalizeProviderDynamicProgram(program({ apply_deadline_ms: 5001 })), /apply_deadline_ms/);
  assert.throws(() => normalizeProviderDynamicProgram(program({ parameters: Array.from({ length: 17 }, (_, i) => `P${i}`) })), /at most 16/);
});

test("dynamic provider runner requires exact development laboratory execution", () => {
  assert.equal(isTrustedDynamicProgramRunnerEnabled({ REVIT_OPERATOR_MODE: "production" }), false);
  assert.equal(isTrustedDynamicProgramRunnerEnabled({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
  }), false);
  assert.equal(isTrustedDynamicProgramRunnerEnabled({
    REVIT_OPERATOR_MODE: "local",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled"
  }), false);
  assert.equal(isTrustedDynamicProgramRunnerEnabled({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled"
  }), false);
  assert.equal(isTrustedDynamicProgramRunnerEnabled({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled",
    OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256: `sha256:${"1".repeat(64)}`,
    OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256: `sha256:${"2".repeat(64)}`
  }), true);
});

test("mixed native and dynamic lanes fail closed before invoking the runner", async () => {
  let invoked = false;
  const response = await executeProviderDynamicProgramLane({
    req: request("mixed"),
    selectedSubstrate: "dynamic_revit_program",
    dynamicProgram: program(),
    otherLaneItemCount: 1,
    runner: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(response?.actions.length, 0);
  assert.equal(response?.dynamic_program_execution_receipt?.status, "blocked");
  assert.equal(response?.dynamic_program_execution_receipt?.failure, "mixed_execution_lanes");
});

test("restricted certified request routes cannot enter the dynamic runner", async () => {
  let invoked = false;
  const response = await executeProviderDynamicProgramLane({
    req: request("restricted"),
    selectedSubstrate: "dynamic_revit_program",
    dynamicProgram: program(),
    otherLaneItemCount: 0,
    requestEligible: false,
    runner: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(response?.dynamic_program_execution_receipt?.failure, "dynamic_program_request_ineligible");
});

test("provider source cannot authorize apply when the user turn did not request a mutation", async () => {
  let invoked = false;
  const response = await executeProviderDynamicProgramLane({
    req: {
      ...request("no-user-write"),
      user_text: "Explain how a bounded custom loop could move this equipment, but do not change the model."
    },
    selectedSubstrate: "dynamic_revit_program",
    dynamicProgram: program({ apply: true }),
    otherLaneItemCount: 0,
    runner: async () => {
      invoked = true;
      throw new Error("must not run");
    }
  });
  assert.equal(invoked, false);
  assert.equal(response?.dynamic_program_execution_receipt?.failure, "dynamic_apply_not_authorized_by_user_turn");
});

test("trusted dynamic completion advances the teammate lifecycle without inventing native actions", () => {
  const req = request("teammate-receipt");
  const guarded = guardGenericTeammateDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "trusted supervisor receipt",
    actions: [],
    dynamic_program_execution_receipt: {
      schema: "revit-operator.provider-dynamic-program-execution-receipt.v1",
      status: "completed",
      apply_requested: true,
      supervisor_exit_code: 0,
      evidence_path: "evidence.json",
      evidence_sha256: "b".repeat(64),
      authority: "trusted_supervisor_receipt",
      provider_prose_authorized: false,
      failure: null
    }
  });
  assert.equal(guarded.actions.length, 0);
  assert.equal(guarded.teammate_loop_receipt?.apply_attempts, 1);
  assert.equal(guarded.teammate_loop_receipt?.verified, true);
  assert.equal(guarded.teammate_loop_receipt?.stage, "report");
});

test("trusted runner writes the exact LiveTaskConfig and invokes supervisor without a shell", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-dynamic-runner-"));
  const supervisor = path.join(root, "DynamicRevitSandboxSupervisor.exe");
  const workers = path.join(root, "workers");
  const token = path.join(root, "operator-token.txt");
  const runs = path.join(root, "runs");
  fs.mkdirSync(workers);
  fs.writeFileSync(supervisor, "test-supervisor");
  fs.writeFileSync(path.join(workers, "DynamicRevitWorker.exe"), "test-worker");
  fs.writeFileSync(token, "0123456789abcdef0123456789abcdef");
  let captured: any = null;
  let capturedArgs: string[] = [];
  let supervisorEnvironment: NodeJS.ProcessEnv = {};
  const supervisorPackageSha256 = sha256(fs.readFileSync(supervisor));
  const workerRuntimePackageSha256 = `sha256:${"e".repeat(64)}`;
  try {
    const selectedProgram = program({ apply: false });
    const response = await runTrustedProviderDynamicProgram(request("runner"), selectedProgram, {
      env: {
        REVIT_OPERATOR_MODE: "development",
        OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
        OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled",
        OPERATOR_DYNAMIC_REVIT_SUPERVISOR_PATH: supervisor,
        OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256: supervisorPackageSha256,
        OPERATOR_DYNAMIC_REVIT_WORKER_DIRECTORY: workers,
        OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256: workerRuntimePackageSha256,
        OPERATOR_DYNAMIC_REVIT_TOKEN_FILE: token,
        OPERATOR_DYNAMIC_REVIT_BRIDGE_URL: "http://127.0.0.1:5000",
        OPERATOR_OPENAI_API_KEY: "must-not-cross-supervisor-boundary"
      },
      runsSessionsDirectory: runs,
      executeSupervisor: async (_executable, args, options) => {
        capturedArgs = args;
        supervisorEnvironment = options.env;
        captured = JSON.parse(fs.readFileSync(args[1]!, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(String(captured.evidencePath), JSON.stringify(supervisorEvidence({
          source: selectedProgram.source,
          supervisorPackageSha256,
          workerRuntimePackageSha256
        })));
        return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, outputExceeded: false };
      }
    });
    assert.equal(capturedArgs[0], "--execute-task");
    assert.deepEqual(Object.keys(captured ?? {}).sort(), [
      "workerDirectory", "evidencePath", "bridgeUrl", "operatorTokenFile", "sourceFile",
      "targetRevitYear", "category", "limit", "parameters", "operationBudget",
      "workerDeadlineMs", "apply", "applyDeadlineMs"
    ].sort());
    assert.equal(captured?.apply, false);
    assert.equal(captured?.targetRevitYear, "2024");
    assert.equal(captured?.operationBudget, 16);
    assert.equal(supervisorEnvironment.OPERATOR_OPENAI_API_KEY, undefined);
    assert.equal(supervisorEnvironment.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256, undefined);
    assert.equal(supervisorEnvironment.OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256, undefined);
    assert.equal(response.dynamic_program_execution_receipt?.status, "completed");
    assert.match(response.dynamic_program_execution_receipt?.evidence_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(response.dynamic_program_execution_receipt?.provider_prose_authorized, false);
    assert.equal(response.dynamic_program_execution_receipt?.supervisor_package_sha256, supervisorPackageSha256);
    assert.equal(response.dynamic_program_execution_receipt?.worker_runtime_package_sha256, workerRuntimePackageSha256);
    assert.match(response.dynamic_program_execution_receipt?.evidence_binding_sha256 ?? "", /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider supervisor evidence rejects fake ok, wrong schema, target, apply, package, session, and embedded receipt tamper", async () => {
  const cases: Array<{ name: string; mutate: (evidence: Record<string, unknown>) => Record<string, unknown> }> = [
    { name: "fake ok", mutate: () => ({ ok: true }) },
    { name: "wrong schema", mutate: evidence => ({ ...evidence, schema: "test-evidence/v1" }) },
    { name: "wrong target", mutate: evidence => ({ ...evidence, targetRevitYear: "2025" }) },
    { name: "wrong apply", mutate: evidence => ({ ...evidence, schema: "dynamic-revit-live-evidence/v1" }) },
    { name: "wrong package", mutate: evidence => ({ ...evidence, runtimeImageIdentity: `sha256:${"f".repeat(64)}` }) },
    { name: "wrong session", mutate: evidence => {
      const snapshot = JSON.parse(String(evidence.snapshotReceipt)) as Record<string, any>;
      snapshot.document.SessionId = "other-session";
      return { ...evidence, snapshotReceipt: JSON.stringify(snapshot) };
    } },
    { name: "tampered embedded receipt", mutate: evidence => {
      const preview = JSON.parse(String(evidence.previewReceipt)) as Record<string, unknown>;
      preview.graph_hash = `sha256:${"f".repeat(64)}`;
      return { ...evidence, previewReceipt: JSON.stringify(preview) };
    } }
  ];
  for (const item of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-dynamic-evidence-"));
    const supervisor = path.join(root, "DynamicRevitSandboxSupervisor.exe");
    const workers = path.join(root, "workers");
    const token = path.join(root, "operator-token.txt");
    fs.mkdirSync(workers);
    fs.writeFileSync(supervisor, "test-supervisor");
    fs.writeFileSync(path.join(workers, "DynamicRevitWorker.exe"), "test-worker");
    fs.writeFileSync(token, "0123456789abcdef0123456789abcdef");
    const supervisorPackageSha256 = sha256(fs.readFileSync(supervisor));
    const workerRuntimePackageSha256 = `sha256:${"e".repeat(64)}`;
    const selectedProgram = program();
    try {
      const response = await runTrustedProviderDynamicProgram(request(`adversarial-${item.name}`), selectedProgram, {
        env: {
          REVIT_OPERATOR_MODE: "development",
          OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
          OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled",
          OPERATOR_DYNAMIC_REVIT_SUPERVISOR_PATH: supervisor,
          OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256: supervisorPackageSha256,
          OPERATOR_DYNAMIC_REVIT_WORKER_DIRECTORY: workers,
          OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256: workerRuntimePackageSha256,
          OPERATOR_DYNAMIC_REVIT_TOKEN_FILE: token,
          OPERATOR_DYNAMIC_REVIT_BRIDGE_URL: "http://127.0.0.1:5000"
        },
        runsSessionsDirectory: path.join(root, "runs"),
        executeSupervisor: async (_executable, supervisorArgs) => {
          const config = JSON.parse(fs.readFileSync(supervisorArgs[1]!, "utf8")) as Record<string, unknown>;
          const evidence = item.mutate(supervisorEvidence({
            source: selectedProgram.source,
            supervisorPackageSha256,
            workerRuntimePackageSha256
          }));
          fs.writeFileSync(String(config.evidencePath), JSON.stringify(evidence));
          return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, outputExceeded: false };
        }
      });
      assert.equal(response.dynamic_program_execution_receipt?.status, "blocked", item.name);
      assert.notEqual(response.dynamic_program_execution_receipt?.failure, null, item.name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("provider supervisor executable must match its explicit trusted package pin before launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-dynamic-pin-"));
  const supervisor = path.join(root, "DynamicRevitSandboxSupervisor.exe");
  const workers = path.join(root, "workers");
  const token = path.join(root, "operator-token.txt");
  fs.mkdirSync(workers);
  fs.writeFileSync(supervisor, "test-supervisor");
  fs.writeFileSync(path.join(workers, "DynamicRevitWorker.exe"), "test-worker");
  fs.writeFileSync(token, "0123456789abcdef0123456789abcdef");
  let invoked = false;
  try {
    const response = await runTrustedProviderDynamicProgram(request("wrong-pin"), program(), {
      env: {
        REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
        OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: "enabled", OPERATOR_DYNAMIC_REVIT_SUPERVISOR_PATH: supervisor,
        OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256: `sha256:${"0".repeat(64)}`,
        OPERATOR_DYNAMIC_REVIT_WORKER_DIRECTORY: workers,
        OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256: `sha256:${"e".repeat(64)}`,
        OPERATOR_DYNAMIC_REVIT_TOKEN_FILE: token
      },
      runsSessionsDirectory: path.join(root, "runs"),
      executeSupervisor: async () => {
        invoked = true;
        throw new Error("must not launch");
      }
    });
    assert.equal(invoked, false);
    assert.equal(response.dynamic_program_execution_receipt?.status, "blocked");
    assert.match(response.dynamic_program_execution_receipt?.failure ?? "", /does not match its trusted pin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Gemini structured response executes only the dynamic supervisor lane", async () => {
  const previous = {
    OPERATOR_GEMINI_API_KEY: process.env.OPERATOR_GEMINI_API_KEY,
    OPERATOR_GEMINI_AGENT_MODEL: process.env.OPERATOR_GEMINI_AGENT_MODEL
  };
  process.env.OPERATOR_GEMINI_API_KEY = "test-key";
  process.env.OPERATOR_GEMINI_AGENT_MODEL = "gemini-test";
  let requestedSchema: any;
  let invoked = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestedSchema = JSON.parse(String(init?.body)).generationConfig.responseJsonSchema;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      assistant_message: "I wrote a program, therefore it is authorized.",
      execution_strategy: strategy(),
      dynamic_program: program(),
      actions: [],
      workbench_actions: []
    }) }] } }] }), { status: 200 });
  }) as typeof fetch;
  const fakeRunner = async (): Promise<ChatResponse> => {
    invoked += 1;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "trusted supervisor receipt",
      actions: [],
      dynamic_program_execution_receipt: {
        schema: "revit-operator.provider-dynamic-program-execution-receipt.v1",
        status: "completed",
        apply_requested: false,
        supervisor_exit_code: 0,
        evidence_path: "evidence.json",
        evidence_sha256: "a".repeat(64),
        authority: "trusted_supervisor_receipt",
        provider_prose_authorized: false,
        failure: null
      }
    };
  };
  try {
    const response = await decideGemini(request("gemini"), { fetchImpl, dynamicProgramRunner: fakeRunner });
    assert.ok(requestedSchema.required.includes("dynamic_program"));
    assert.equal(requestedSchema.properties.dynamic_program.additionalProperties, false);
    assert.equal(invoked, 1);
    assert.equal(response.assistant_message, "trusted supervisor receipt");
    assert.equal(response.execution_strategy_evidence?.authority, "telemetry_only");
    assert.equal(response.dynamic_program_execution_receipt?.authority, "trusted_supervisor_receipt");
  } finally {
    restoreEnvironment(previous);
  }
});

test("Anthropic mixed native and dynamic response is rejected before either lane runs", async () => {
  const previous = { OPERATOR_ANTHROPIC_API_KEY: process.env.OPERATOR_ANTHROPIC_API_KEY };
  process.env.OPERATOR_ANTHROPIC_API_KEY = "test-key";
  let invoked = false;
  const fetchImpl = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
    assistant_message: "run both",
    execution_strategy: strategy(),
    dynamic_program: program(),
    actions: [{ action_id: "native", method: "GET", path: "/revit/context", body_json: null }],
    workbench_actions: []
  }) }] }), { status: 200 })) as typeof fetch;
  try {
    const response = await decideAnthropic(request("anthropic"), {
      fetchImpl,
      dynamicProgramRunner: async () => {
        invoked = true;
        throw new Error("must not run");
      }
    });
    assert.equal(invoked, false);
    assert.equal(response.actions.length, 0);
    assert.equal(response.dynamic_program_execution_receipt?.failure, "mixed_execution_lanes");
  } finally {
    restoreEnvironment(previous);
  }
});

test("OpenAI contract carries dynamic_program and production-default execution stays blocked", { concurrency: false }, async () => {
  let requestSchema: any;
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requestSchema = requestBody.text.format.schema;
      const decision = {
        assistant_message: "The model claims this is safe.",
        execution_strategy: strategy(),
        dynamic_program: program(),
        actions: [],
        web_requests: [],
        dev_actions: [],
        workbench_actions: []
      };
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        id: "resp_dynamic",
        object: "response",
        status: "completed",
        model: "gpt-test",
        output: [{
          id: "msg_dynamic",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(decision), annotations: [] }]
        }]
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    OPERATOR_OPENAI_API_KEY: process.env.OPERATOR_OPENAI_API_KEY,
    OPERATOR_OPENAI_BASE_URL: process.env.OPERATOR_OPENAI_BASE_URL,
    OPERATOR_OPENAI_MODEL: process.env.OPERATOR_OPENAI_MODEL,
    OPERATOR_OPENAI_CONTINUATION_ROUNDS: process.env.OPERATOR_OPENAI_CONTINUATION_ROUNDS,
    REVIT_OPERATOR_MODE: process.env.REVIT_OPERATOR_MODE,
    OPERATOR_TOOL_EXPOSURE_PROFILE: process.env.OPERATOR_TOOL_EXPOSURE_PROFILE,
    OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER: process.env.OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER
  };
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_OPENAI_MODEL = "gpt-test";
    process.env.OPERATOR_OPENAI_CONTINUATION_ROUNDS = "0";
    process.env.REVIT_OPERATOR_MODE = "production";
    delete process.env.OPERATOR_TOOL_EXPOSURE_PROFILE;
    delete process.env.OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER;
    const response = await decideOpenAi(request("openai"));
    assert.ok(requestSchema.required.includes("dynamic_program"));
    assert.equal(requestSchema.properties.dynamic_program.additionalProperties, false);
    assert.equal(response.actions.length, 0);
    assert.equal(response.dynamic_program_execution_receipt?.status, "blocked");
    assert.equal(response.dynamic_program_execution_receipt?.failure, "trusted_runner_disabled");
    assert.doesNotMatch(response.assistant_message, /model claims/i);
  } finally {
    restoreEnvironment(previous);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
