import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  assertToolExposure,
  assertCertifiedMoveOneToolExposure,
  canonicalToolExposureJson,
  evaluateToolExposure,
  filterRegistryEntriesForSearch,
  getToolExposureRuntimeDecision,
  isMcpToolAliasExposed,
  isKnownToolExposureRoute,
  loadToolExposurePolicy,
  ToolExposurePolicyError
} from "./toolExposurePolicy.js";
import { CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1 } from "./certifiedMoveOneRequestFamily.js";
import { clearCertifiedMoveTargetLedgerForTests, registerCertifiedSpatialObservation } from "./certifiedMoveTargetLedger.js";
import { TEST_NATIVE_EXECUTION_ATTESTATION } from "./certifiedMoveNativeAttestation.testSupport.js";

const sourcePolicyPath = process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH
  ? path.resolve(process.env.OPERATOR_TEST_TOOL_EXPOSURE_POLICY_PATH)
  : path.resolve(process.cwd(), "../operator-backend/config/tool_exposure_policy.v1.json");
const sourcePolicyHash = (JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8")) as { policy_hash: string }).policy_hash;

function testCanonical(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").normalize("NFC");
  if (Array.isArray(value)) return value.map(testCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.replace(/\r\n?/g, "\n").normalize("NFC"), item] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, testCanonical(item)]));
  }
  return value;
}

function testDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(testCanonical(value)), "utf8").digest("hex")}`;
}

function writePolicyVariant(mutate: (policy: any) => void): { policyPath: string; policyHash: string } {
  const policy = JSON.parse(fs.readFileSync(sourcePolicyPath, "utf8"));
  mutate(policy);
  for (const record of policy.records) {
    const { policy_record_hash: _oldRecordHash, ...recordPayload } = record;
    record.policy_record_hash = testDigest(recordPayload);
  }
  const { policy_hash: _oldPolicyHash, ...policyPayload } = policy;
  policy.policy_hash = testDigest(policyPayload);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-policy-variant-"));
  const policyPath = path.join(root, "tool_exposure_policy.v1.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { policyPath, policyHash: policy.policy_hash };
}

function policyVariantEnv(variant: { policyPath: string; policyHash: string }): NodeJS.ProcessEnv {
  return {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: variant.policyPath,
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: variant.policyHash
  };
}

function certifiedEnv(policyPath = sourcePolicyPath): NodeJS.ProcessEnv {
  return {
    REVIT_OPERATOR_MODE: "hosted",
    OPERATOR_TOOL_EXPOSURE_POLICY_PATH: policyPath,
    OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: sourcePolicyHash
  };
}

test("runtime modes default hosted/production/development closed and expose only an explicit development laboratory escape", () => {
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "hosted" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "production", OPERATOR_TOOL_EXPOSURE_MODE: "laboratory" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "development" }).mode, "certified");
  const developmentLab = getToolExposureRuntimeDecision({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
  });
  assert.equal(developmentLab.mode, "laboratory");
  assert.equal(developmentLab.explicitLaboratory, true);
  assert.match(developmentLab.reason, /explicit development laboratory escape/i);
  for (const env of [
    { REVIT_OPERATOR_MODE: "Development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: " development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development ", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: " laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory " },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "LABORATORY" },
    { REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }
  ]) {
    const decision = getToolExposureRuntimeDecision(env);
    assert.equal(decision.mode, "certified", `non-exact escape must fail closed: ${JSON.stringify(env)}`);
    assert.equal(decision.certified, true, `non-exact escape must remain certified: ${JSON.stringify(env)}`);
    assert.equal(decision.explicitLaboratory, false, `non-exact escape must not be explicit: ${JSON.stringify(env)}`);
  }
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "local" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "self_hosted" }).mode, "certified");
  assert.equal(getToolExposureRuntimeDecision({ REVIT_OPERATOR_MODE: "future" }).mode, "certified");
});

test("cross-runtime canonical JSON fixture has fixed NFC bytes and SHA-256", () => {
  const canonical = canonicalToolExposureJson({
    z: "Cafe\u0301\r\nline",
    a: { "β": "x", a: 1 }
  });
  // This is a protocol vector, generated independently with .NET UTF-8 and
  // SHA256. Do not replace the literal with a same-helper recomputation.
  assert.equal(canonical, "{\"a\":{\"a\":1,\"β\":\"x\"},\"z\":\"Café\\nline\"}");
  assert.equal(
    `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    "sha256:aa81e774360d35186e0e5eed2858ca2704f7b0da9e7a146ed34db47f2b576a9c"
  );
});

test("assertToolExposure returns the exact certified record provenance and bound alias", () => {
  const variant = writePolicyVariant(policy => {
    const ping = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/ping");
    ping.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  });
  const decision = assertToolExposure({
    method: "GET",
    path: "/revit/ping",
    channel: "typed_mcp",
    alias: "revit_ping",
    env: policyVariantEnv(variant)
  });
  const record = JSON.parse(fs.readFileSync(variant.policyPath, "utf8")).records.find((item: any) => item.method === "GET" && item.path === "/revit/ping");
  assert.equal(decision.allowed, true);
  assert.equal(decision.policyHash, variant.policyHash);
  assert.equal(decision.policyRecordHash, record.policy_record_hash);
  assert.equal(decision.evidenceRecordHash, record.evidence_record_hash);
  assert.equal(decision.policyTrustSource, "deployment");
  assert.equal(decision.alias, "revit_ping");
  assert.equal(decision.workflow, undefined);
});

test("current policy validates all record hashes and exposes only the certified typed context alias", () => {
  const { policy, policyPath } = loadToolExposurePolicy(certifiedEnv());
  assert.equal(policyPath, sourcePolicyPath);
  assert.equal(policy.records.length * 4, 100);
  const decisions = policy.records.flatMap(record => Object.values(record.channels));
  assert.equal(decisions.length, 100);
  const exposed = policy.records.flatMap(record =>
    Object.entries(record.channels)
      .filter(([, decision]) => decision.exposed)
      .map(([channel]) => ({ record, channel }))
  );
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0]?.record.method, "GET");
  assert.equal(exposed[0]?.record.path, "/revit/context");
  assert.equal(exposed[0]?.channel, "typed_mcp");
  assert.equal(isMcpToolAliasExposed("revit_get_context", certifiedEnv()), true);
  assert.equal(isMcpToolAliasExposed("revit_call_tool", certifiedEnv()), false);
  const safeRead = policy.records.find(record => record.path === "/revit/certified/sheets/count");
  assert.deepEqual(safeRead?.execution_surface, {
    kind: "standalone_executor",
    executor_id: "revit-operator.safe-read-host.v1",
    route_id: "safe_read.sheet_count.v1",
    transport: "direct_loopback"
  });
  assert.equal(isMcpToolAliasExposed("revit_count_sheets_certified", certifiedEnv()), false);
});

test("standalone policy records cannot be promoted onto bridge, search, or courier channels", () => {
  for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
    const variant = writePolicyVariant(policy => {
      const safeRead = policy.records.find((record: any) => record.path === "/revit/certified/sheets/count");
      safeRead.channels[channel] = { exposed: true, required_level: channel === "search" ? "L3" : "L4", reason_codes: ["CERTIFIED"] };
    });
    assert.throws(
      () => loadToolExposurePolicy(policyVariantEnv(variant)),
      (error: unknown) => error instanceof ToolExposurePolicyError
        && error.code === "TOOL_EXPOSURE_POLICY_INVALID"
        && error.message.includes(`cannot expose the ${channel} channel`)
    );
  }

  const stripped = writePolicyVariant(policy => {
    const safeRead = policy.records.find((record: any) => record.path === "/revit/certified/sheets/count");
    delete safeRead.execution_surface;
    for (const channel of ["search", "generic_call", "deterministic_workflow"] as const) {
      safeRead.channels[channel] = {
        exposed: true,
        required_level: channel === "search" ? "L3" : "L4",
        reason_codes: ["CERTIFIED"]
      };
    }
  });
  assert.throws(
    () => loadToolExposurePolicy(policyVariantEnv(stripped)),
    (error: unknown) => error instanceof ToolExposurePolicyError
      && error.code === "TOOL_EXPOSURE_POLICY_INVALID"
      && error.message.includes("require the exact standalone execution_surface")
  );
});

test("exact body-aware policy decisions distinguish known uncertified, request mismatch, effect mismatch, and workflow-only raw access", () => {
  const env = certifiedEnv();
  const schedules = evaluateToolExposure({
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", exact: false, max: 10 },
    channel: "typed_mcp",
    alias: "revit_list_schedules",
    env
  });
  assert.equal(schedules.knownRoute, true);
  assert.equal(schedules.allowed, false);
  assert.match(schedules.reasonCodes.join(","), /CERT_EVIDENCE_GAP/);

  const bodyMismatch = evaluateToolExposure({
    method: "POST",
    path: "/revit/schedules",
    body: { action: "list", exact: false, max: 11 },
    channel: "typed_mcp",
    alias: "revit_list_schedules",
    env
  });
  assert.deepEqual(bodyMismatch.reasonCodes, ["CERT_REQUEST_HASH_MISMATCH"]);

  const effectMismatch = evaluateToolExposure({
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "Supply Air", value: "20000 CFM", apply: false, dryRun: true },
    channel: "deterministic_workflow",
    alias: "revit_update_schedule_cell",
    env
  });
  assert.deepEqual(effectMismatch.reasonCodes, ["CERT_EFFECT_HASH_MISMATCH"]);

  const workflowOnlyRaw = evaluateToolExposure({
    method: "POST",
    path: "/revit/update-schedule-cell",
    body: { rowKey: "AHU-1", targetField: "Supply Air", value: "20000 CFM", apply: false, dryRun: true },
    channel: "generic_call",
    alias: "revit_call_tool",
    workflow: "schedule_cell_update_runtime",
    env
  });
  assert.equal(workflowOnlyRaw.visibility, "workflow_only");
  assert.deepEqual(workflowOnlyRaw.reasonCodes, ["CERT_WORKFLOW_ONLY"]);
});

test("general exact evaluator rejects caller-authored request-family metadata", () => {
  const family = {
    schema: "revit-operator.certified-request-family.v1" as const,
    id: "revit-operator.certified-move-one.request-family.v1",
    validator_hash: `sha256:${"a".repeat(64)}`
  };
  const variant = writePolicyVariant(policy => {
    const record = policy.records.find((candidate: any) => candidate.method === "GET" && candidate.path === "/revit/ping");
    record.method = "POST";
    record.path = "/revit/move-elements";
    record.typed_mcp_aliases = ["revit_move_one_certified"];
    record.effect_hash = testDigest({ effect: { resolved_effect: "write" } });
    record.request_family = family;
    record.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  });
  const body = {
    ids: [4821], mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0,
    dryRun: false, behavior: "allOrNothing", moveTogether: false,
    options: { failOnPinned: true, unpinIfAllowed: false }
  };
  const callerAuthored = (evaluateToolExposure as unknown as (input: Record<string, unknown>) => any)({
    method: "POST", path: "/revit/move-elements", body, channel: "typed_mcp", alias: "revit_move_one_certified",
    requestFamily: family, requestInstanceHash: `sha256:${"b".repeat(64)}`, env: policyVariantEnv(variant)
  });
  assert.deepEqual(callerAuthored.reasonCodes, ["CERT_REQUEST_HASH_MISMATCH"]);
});

test("certified move-one entry point rejects forged admission paths and binds validated preview input", () => {
  clearCertifiedMoveTargetLedgerForTests();
  registerCertifiedSpatialObservation(
    { document: { sessionId: "123e4567e89b42d3a456426614174000", nativeExecutionAttestation: TEST_NATIVE_EXECUTION_ATTESTATION, projectIdentity: { fingerprint: "a".repeat(64) }, activeView: { id: 42 } } },
    { observationId: "frame_01", viewId: 42, items: [{ elementId: 4821, sourceScopedId: "host:4821", groundingStatus: "anchored", pinned: false, groupId: null, orientation: { locationKind: "point", locationPoint: { x: 1, y: 2, z: 3 } } }] }
  );
  const variant = writePolicyVariant(policy => {
    const record = policy.records.find((candidate: any) => candidate.method === "GET" && candidate.path === "/revit/ping");
    record.method = "POST";
    record.path = "/revit/move-elements";
    record.typed_mcp_aliases = ["revit_move_one_certified"];
    record.effect_hash = testDigest({ effect: { resolved_effect: "preview" } });
    record.request_family = {
      schema: "revit-operator.certified-request-family.v1",
      id: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
      validator_hash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH
    };
    record.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  });
  const result = assertCertifiedMoveOneToolExposure({
    request: {
      phase: "preview", elementId: 4821, observationId: "frame_01", vectorFeet: { x: 1, y: 0, z: 0 }, previewReceipt: undefined
    },
    alias: "revit_move_one_certified",
    env: policyVariantEnv(variant)
  });
  assert.equal(result.decision.allowed, true);
  assert.equal(result.admission.outboundBody.dryRun, true);
  assert.match(result.decision.requestInstanceHash ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => assertCertifiedMoveOneToolExposure({
    request: {
      phase: "preview", elementId: 4821, observationId: "frame_01", vectorFeet: { x: 3, y: 0, z: 0 }, previewReceipt: undefined
    },
    alias: "revit_move_one_certified",
    env: policyVariantEnv(variant)
  }), /MOVE_ONE_VECTOR_OUT_OF_BOUNDS/);
});

test("certified route lookup is exact and search filtering exposes no currently uncertified route", () => {
  const env = certifiedEnv();
  assert.equal(isKnownToolExposureRoute("POST", "/revit/schedules", env), true);
  assert.equal(isKnownToolExposureRoute("POST", "/revit/schedules/", env), false);
  assert.equal(isKnownToolExposureRoute("POST", "/revit/not-certified", env), false);
  assert.deepEqual(filterRegistryEntriesForSearch([
    { method: "POST", path: "/revit/schedules" },
    { method: "POST", path: "/revit/update-schedule-cell" }
  ], env), []);
});

test("missing, malformed, and hash-mismatched certified policies fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tool-exposure-policy-"));
  for (const [name, contents, code] of [
    ["missing.json", null, "TOOL_EXPOSURE_POLICY_UNAVAILABLE"],
    ["malformed.json", "{", "TOOL_EXPOSURE_POLICY_INVALID"],
    ["mismatched.json", fs.readFileSync(sourcePolicyPath, "utf8").replace(/sha256:[0-9a-f]{64}/, `sha256:${"0".repeat(64)}`), "TOOL_EXPOSURE_POLICY_INVALID"]
  ] as const) {
    const policyPath = path.join(root, name);
    if (contents !== null) fs.writeFileSync(policyPath, contents, "utf8");
    assert.throws(
      () => loadToolExposurePolicy(certifiedEnv(policyPath)),
      (error: unknown) => error instanceof ToolExposurePolicyError && error.code === code
    );
  }
});

test("explicit policy paths require an independently supplied expected hash and reject rollback", () => {
  assert.throws(
    () => loadToolExposurePolicy({
      REVIT_OPERATOR_MODE: "hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: sourcePolicyPath
    }),
    (error: unknown) => error instanceof ToolExposurePolicyError
      && error.code === "TOOL_EXPOSURE_POLICY_TRUST_ANCHOR_REQUIRED"
  );
  assert.throws(
    () => loadToolExposurePolicy({
      REVIT_OPERATOR_MODE: "hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: sourcePolicyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: `sha256:${"0".repeat(64)}`
    }),
    (error: unknown) => error instanceof ToolExposurePolicyError
      && error.code === "TOOL_EXPOSURE_POLICY_ROLLBACK_REJECTED"
  );
  const loaded = loadToolExposurePolicy(certifiedEnv());
  assert.equal(loaded.trustedPolicyHash, sourcePolicyHash);
  assert.equal(loaded.trustSource, "deployment");
});

test("bundled policy is pinned by the compiled canonical hash and malformed anchors/paths fail closed", () => {
  const bundled = loadToolExposurePolicy({ REVIT_OPERATOR_MODE: "local" });
  assert.equal(bundled.policy.policy_hash, sourcePolicyHash);
  assert.equal(bundled.trustedPolicyHash, sourcePolicyHash);
  assert.equal(bundled.trustSource, "bundled");
  assert.throws(
    () => loadToolExposurePolicy({
      REVIT_OPERATOR_MODE: "hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: sourcePolicyPath,
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: "D620"
    }),
    (error: unknown) => error instanceof ToolExposurePolicyError
      && error.code === "TOOL_EXPOSURE_POLICY_TRUST_ANCHOR_INVALID"
  );
  assert.throws(
    () => loadToolExposurePolicy({
      REVIT_OPERATOR_MODE: "hosted",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: sourcePolicyPath.replace(/\.json$/, ".txt"),
      OPERATOR_TOOL_EXPOSURE_POLICY_SHA256: sourcePolicyHash
    }),
    /must name a JSON file/
  );
});

test("compiled package layout resolves and validates its sibling bundled policy", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-policy-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagedLib = path.join(root, "mcp-server", "dist", "lib");
  const packagedConfig = path.join(root, "operator-backend", "config");
  fs.mkdirSync(packagedLib, { recursive: true });
  fs.mkdirSync(packagedConfig, { recursive: true });
  for (const file of ["toolExposurePolicy.js", "revitRouteEffect.js", "safeReadDiscovery.js", "certifiedMoveOneRequestFamily.js", "certifiedMoveTargetLedger.js"]) {
    fs.copyFileSync(path.resolve(process.cwd(), "dist", "lib", file), path.join(packagedLib, file));
  }
  fs.copyFileSync(sourcePolicyPath, path.join(packagedConfig, "tool_exposure_policy.v1.json"));
  const packagedModule = await import(`${pathToFileURL(path.join(packagedLib, "toolExposurePolicy.js")).href}?package-test=${Date.now()}`);
  const loaded = packagedModule.loadToolExposurePolicy({ REVIT_OPERATOR_MODE: "production" });
  assert.equal(loaded.policyPath, path.join(packagedConfig, "tool_exposure_policy.v1.json"));
  assert.equal(loaded.policy.policy_hash, sourcePolicyHash);
  assert.equal(loaded.trustSource, "bundled");
});

test("laboratory decision is explicit and does not require an arbitrary policy file", () => {
  const decision = evaluateToolExposure({
    method: "POST",
    path: "/revit/unknown-laboratory-route",
    body: { apply: true },
    channel: "generic_call",
    env: {
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
      OPERATOR_TOOL_EXPOSURE_POLICY_PATH: "Z:\\missing\\policy.json"
    }
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasonCodes, ["LABORATORY_MODE_ACTIVE"]);
});

test("laboratory preserves JSON wire semantics for ordinary optional undefined values", () => {
  const body = { action: "list\r\nall", optional: undefined };
  const decision = evaluateToolExposure({
    method: "POST",
    path: "/revit/laboratory-json-wire",
    body,
    channel: "typed_mcp",
    env: {
      REVIT_OPERATOR_MODE: "development",
      OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
    }
  });
  assert.equal(decision.allowed, true);
  assert.equal(JSON.stringify(body), JSON.stringify({ action: "list\r\nall" }));
});

test("certified hashing rejects text normalization that would authorize a materially different wire body", () => {
  assert.throws(
    () => evaluateToolExposure({
      method: "POST",
      path: "/revit/schedules",
      body: { action: "list\r\nall" },
      channel: "typed_mcp",
      alias: "revit_list_schedules",
      env: certifiedEnv()
    }),
    /non-canonical text/
  );
});

test("typed and generic calls are bound to their actual invoked aliases", () => {
  const variant = writePolicyVariant(policy => {
    const ping = policy.records.find((record: any) => record.method === "GET" && record.path === "/revit/ping");
    ping.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
    ping.channels.generic_call = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  });
  const env = policyVariantEnv(variant);
  assert.equal(isMcpToolAliasExposed("revit_ping", env), true);
  assert.equal(isMcpToolAliasExposed("revit_call_tool", env), true);

  assert.equal(evaluateToolExposure({
    method: "GET",
    path: "/revit/ping",
    channel: "typed_mcp",
    alias: "revit_ping",
    env
  }).allowed, true);
  assert.deepEqual(evaluateToolExposure({
    method: "GET",
    path: "/revit/ping",
    channel: "typed_mcp",
    alias: "revit_get_context",
    env
  }).reasonCodes, ["CERT_TYPED_ALIAS_MISMATCH"]);
  assert.deepEqual(evaluateToolExposure({
    method: "GET",
    path: "/revit/ping",
    channel: "generic_call",
    alias: "revit_ping",
    env
  }).reasonCodes, ["CERT_GENERIC_ALIAS_REQUIRED"]);
  assert.equal(evaluateToolExposure({
    method: "GET",
    path: "/revit/ping",
    channel: "generic_call",
    alias: "revit_call_tool",
    env
  }).allowed, true);
});

test("an intentional multi-route typed alias is exposed only by conjunction", () => {
  const allRoutes = writePolicyVariant(policy => {
    for (const record of policy.records.filter((candidate: any) => candidate.typed_mcp_aliases.includes("revit_search_tools"))) {
      record.channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
    }
  });
  assert.equal(isMcpToolAliasExposed("revit_search_tools", policyVariantEnv(allRoutes)), true);

  const partial = writePolicyVariant(policy => {
    const records = policy.records.filter((candidate: any) => candidate.typed_mcp_aliases.includes("revit_search_tools"));
    records[0].channels.typed_mcp = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  });
  assert.equal(isMcpToolAliasExposed("revit_search_tools", policyVariantEnv(partial)), false);
});
