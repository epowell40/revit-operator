import assert from "node:assert/strict";
import test from "node:test";
import { CertifiedCapabilityProjectionError, projectCertifiedCapabilities } from "./certifiedCapabilityProjection.js";
import {
  assertDiscoveredCapability,
  discoverGeneralAgentCapabilities,
  discoverHostedGeneralAgentCapabilities
} from "./generalAgentCapabilityDiscovery.js";
import { loadToolExposurePolicy } from "./toolExposurePolicy.js";
import fs from "node:fs";
import { TOOL_SEARCH_RANKING_VERSION_V3 } from "./toolSearchRanking.js";
import { SUPPORTED_NATIVE_ROUTES } from "./supportedToolInventory.js";

const env = { REVIT_OPERATOR_MODE: "local" } as NodeJS.ProcessEnv;

function nativeCatalog() {
  const location = new URL("../../../revit-bridge-addin/RevitBridge/Operator/OperatorToolManifest.cs", import.meta.url);
  const source = fs.readFileSync(location, "utf8");
  const text = '"((?:[^"\\\\]|\\\\.)*)"';
  const pattern = new RegExp(`new OperatorToolInfo\\(${text},\\s*${text},\\s*${text},\\s*${text},\\s*OperatorActionRisk\\.(\\w+),\\s*${text},\\s*${text}\\)`, "g");
  const tools = [...source.matchAll(pattern)].map(match => {
    const decode = (n: number) => JSON.parse(`"${match[n]}"`) as string;
    return { group: decode(1), method: decode(2), path: decode(3), title: decode(4), risk: match[5]!.toLowerCase(), description: decode(6), example: decode(7) };
  });
  assert.ok(tools.length > 200, `Expected the actual catalog, found ${tools.length} tools`);
  const supported = tools.filter(tool => SUPPORTED_NATIVE_ROUTES.includes(`${tool.method} ${tool.path}`));
  assert.equal(supported.length, SUPPORTED_NATIVE_ROUTES.length);
  return { tools: supported };
}

test("C25 room workbook request discovers the existing Excel export across the real native catalog", async () => {
  const registry = nativeCatalog();
  const result = await discoverHostedGeneralAgentCapabilities({ need: "Read the complete Revit room and space inventory with HVAC load-calculation parameters, validate counts/units/missing values, and export a room-by-room Excel workbook artifact without changing the model." }, async () => registry);
  assert.equal(result.ranking_version, TOOL_SEARCH_RANKING_VERSION_V3);
  assert.ok(result.capabilities.some(tool => tool.path === "/revit/export-elements-xlsx"), JSON.stringify(result.capabilities.map(tool => [tool.path, tool.score])));
  const excel = result.capabilities.find(tool => tool.path === "/revit/export-elements-xlsx")!;
  assert.equal(excel.risk, "low"); assert.equal(excel.executionTool, "revit_call_tool");
  assert.match(excel.description, /elementIds/);
});

test("general discovery shares native ranking, ignores repeated prose and preserves neighboring export intents", async () => {
  const registry = nativeCatalog();
  for (const [need, expected] of [
    ["export element parameters to an Excel spreadsheet workbook", "/revit/export-elements-xlsx"],
    ["export schedule csv", "/revit/export-schedule-csv"],
    ["capture sheet region", "/revit/capture-sheet-region"]
  ]) {
    const result = await discoverHostedGeneralAgentCapabilities({ need: need!, maxResults: 1 }, async () => registry);
    assert.equal(result.capabilities[0]?.path, expected, need);
  }
  const tools = [{ method: "POST", path: "/revit/export-elements-xlsx", title: "Export Excel Workbook", risk: "low", description: "Export element parameters." },
    { method: "POST", path: "/revit/open-model", title: "Open Model", risk: "high", description: "Excel workbook export ".repeat(200), optional_fields: Array(200).fill("Excel workbook export") }];
  const result = await discoverHostedGeneralAgentCapabilities({ need: "export Excel workbook" }, async () => ({ tools }));
  assert.equal(result.capabilities[0]?.path, "/revit/export-elements-xlsx");
});

test("general-agent discovery adds exactly one concise non-authorizing dynamic substrate", () => {
  const result = discoverGeneralAgentCapabilities({ need: "complex geometry layout" }, env);
  assert.equal(result.executionSubstrates.length, 1);
  assert.equal(result.executionSubstrates[0]?.id, "dynamic_revit_program");
  assert.match(result.executionSubstrates[0]?.title ?? "", /Generate and preview a bounded task-specific Revit program/);
  assert.equal(result.executionSubstrates[0]?.semantics.previewBeforeCommit, true);
  assert.equal(result.executionSubstrates[0]?.semantics.machineAccess, "restricted");
  assert.equal(result.executionSubstrates[0]?.semantics.externalFileEffects, "explicit_capability_required");
  assert.equal(result.executionSubstrates[0]?.semantics.iterativeObservation, "bounded_needs_facts");
  assert.equal(result.executionSubstrates[0]?.semantics.semanticTrace, "exact_step_node_fact_binding");
  assert.equal(result.executionSubstrates[0]?.semantics.deterministicReplay, true);
  assert.equal(result.executionSubstrates[0]?.admission.state, "not_admitted_by_discovery");
  assert.equal(result.executionSubstrates[0]?.admission.authorizationGranted, false);
  assert.equal(result.executionSubstrates[0]?.execution.tool, "operator_run_dynamic_revit_program");
  assert.equal(result.executionSubstrates[0]?.execution.availability, "authenticated_general_agent_or_laboratory");
  assert.equal(result.executionSubstrates[0]?.execution.hostedGeneralAgentExposure, true);
  assert.equal(result.executionSubstrates[0]?.execution.certifiedProductionExposure, false);
});

test("dynamic affordance never enters certified policy membership or its discovery receipt", () => {
  const loaded = loadToolExposurePolicy(env);
  const projected = projectCertifiedCapabilities(loaded.policy);
  assert.equal(projected.some(capability => capability.id === "dynamic_revit_program"), false);
  assert.equal(projected.some(capability => capability.alias.includes("dynamic")), false);

  const result = discoverGeneralAgentCapabilities({ need: "context" }, env);
  assert.throws(
    () => assertDiscoveredCapability(result.receipt, "dynamic_revit_program", env),
    (error: unknown) => error instanceof CertifiedCapabilityProjectionError
      && error.code === "CAPABILITY_DISCOVERY_CAPABILITY_DENIED"
  );
});

test("hosted General Agent discovery ranks live project query and write registry primitives", async () => {
  const result = await discoverHostedGeneralAgentCapabilities({ need: "count air terminal equipment and change parameters", maxResults: 3 }, async () => ({
    tools: [
      { method: "POST", path: "/revit/query", title: "Query Elements", description: "Find and count elements by category including Air Terminals." },
      { method: "POST", path: "/revit/set-parameter", title: "Set Parameters", description: "Change equipment instance or type parameters." },
      { method: "GET", path: "/revit/context", title: "Context", description: "Current document and view." }
    ]
  }));
  assert.equal(result.exposureMode, "general");
  assert.equal(result.typedCatalogExposure, "full");
  assert.equal(result.status, "available");
  assert.deepEqual(new Set(result.capabilities.map(item => item.path)), new Set(["/revit/query", "/revit/set-parameter"]));
  assert.equal(result.capabilities.every(item => item.authorization === "general_agent_ready"), true);
});
