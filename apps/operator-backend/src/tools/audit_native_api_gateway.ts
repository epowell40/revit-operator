import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "./audit_tool_registry.js";
import { assertExactDevelopmentLaboratoryNativeTransport } from "../brains/native_revit_transport.js";

type NativeApiItem = {
  member_id?: string;
  namespace?: string;
  type?: string;
  name?: string;
  kind?: string;
  signature?: string;
  return_type?: string;
  is_static?: boolean;
  risk?: string;
  signature_supported?: boolean;
  target_reachable?: boolean;
  target_reachability?: string;
  chainable?: boolean;
  terminally_useful?: boolean | null;
  terminal_usefulness_evidence?: string;
  callable?: boolean;
  callable_deprecated?: boolean;
  allowed?: boolean;
  mutating_hint?: boolean;
  freeze_risk_hint?: boolean;
  blocked_reason?: string | null;
};

export type NativeApiGatewaySummary = {
  catalog_total: number;
  signature_supported: number;
  policy_allowed: number;
  static_signature_supported: number;
  constructor_signature_supported: number;
  direct_context_instance_signature_supported: number;
  always_directly_invocable_signature_upper_bound: number;
  other_instance_signature_supported_but_target_unproven: number;
  target_reachable: number;
  chainable: number;
  terminally_useful_verified: number;
  terminally_useful_unverified: number;
  legacy_callable_fallback: number;
  mutating_hint: number;
  freeze_risk_hint: number;
  high_risk: number;
};

const DIRECT_CONTEXT_TYPES = new Set([
  "Autodesk.Revit.UI.UIApplication",
  "Autodesk.Revit.UI.UIDocument",
  "Autodesk.Revit.DB.Document",
  "Autodesk.Revit.DB.View"
]);

export function summarizeNativeApiCatalog(items: NativeApiItem[]): NativeApiGatewaySummary {
  const supported = items.filter(item => item.signature_supported === true || (item.signature_supported === undefined && item.callable === true));
  const staticSupported = supported.filter(item => item.is_static === true);
  const constructorSupported = supported.filter(item => item.kind === "ctor");
  const contextSupported = supported.filter(item => item.is_static !== true && item.kind !== "ctor" && DIRECT_CONTEXT_TYPES.has(item.type ?? ""));
  const directlyInvocable = supported.filter(item => item.is_static === true || item.kind === "ctor" || DIRECT_CONTEXT_TYPES.has(item.type ?? ""));
  const otherInstanceSupported = supported.filter(item => item.is_static !== true && item.kind !== "ctor" && !DIRECT_CONTEXT_TYPES.has(item.type ?? ""));
  return {
    catalog_total: items.length,
    signature_supported: supported.length,
    policy_allowed: items.filter(item => item.allowed === true).length,
    static_signature_supported: staticSupported.length,
    constructor_signature_supported: constructorSupported.length,
    direct_context_instance_signature_supported: contextSupported.length,
    always_directly_invocable_signature_upper_bound: directlyInvocable.length,
    other_instance_signature_supported_but_target_unproven: otherInstanceSupported.length,
    target_reachable: items.filter(item => item.target_reachable === true).length,
    chainable: items.filter(item => item.chainable === true).length,
    terminally_useful_verified: items.filter(item => item.terminally_useful === true).length,
    terminally_useful_unverified: items.filter(item => item.terminally_useful === null || item.terminally_useful === undefined).length,
    legacy_callable_fallback: items.filter(item => item.signature_supported === undefined && item.callable !== undefined).length,
    mutating_hint: items.filter(item => item.mutating_hint === true).length,
    freeze_risk_hint: items.filter(item => item.freeze_risk_hint === true).length,
    high_risk: items.filter(item => String(item.risk).toLowerCase() === "high").length
  };
}

function inspectSourceContract(repoRoot: string): Record<string, boolean> {
  const appsLayout = fs.existsSync(path.join(repoRoot, "apps", "revit-bridge-addin"));
  const gatewayPath = appsLayout
    ? path.join(repoRoot, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs")
    : path.join(repoRoot, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs");
  const source = fs.readFileSync(gatewayPath, "utf8");
  return {
    persistent_object_handle_protocol: /(?:object[_ ]?handle|handle_id|HandleId)/i.test(source),
    ephemeral_result_reference_protocol: /ephemeral_handles|target must reference a prior result/i.test(source),
    property_member_catalog: /GetProperties\s*\(/.test(source),
    multi_operation_graph: /(?:operation[_ ]?graph|IReadOnlyList<[^>]*Operation|operations\s*\{)/i.test(source),
    explicit_transaction_envelope: /new\s+Transaction\s*\(/.test(source)
  };
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderCsv(items: NativeApiItem[]): string {
  const fields: Array<keyof NativeApiItem> = ["member_id", "type", "name", "kind", "signature", "return_type", "is_static", "risk", "signature_supported", "target_reachable", "target_reachability", "chainable", "terminally_useful", "terminal_usefulness_evidence", "callable", "callable_deprecated", "allowed", "mutating_hint", "freeze_risk_hint", "blocked_reason"];
  return `${[fields.join(","), ...items.map(item => fields.map(field => csvEscape(item[field])).join(","))].join("\n")}\n`;
}

function renderMarkdown(report: Record<string, unknown>, summary: NativeApiGatewaySummary, sourceContract: Record<string, boolean>): string {
  return [
    "# Reflected native API gateway audit",
    "",
    `Generated: ${String(report.generated_at)}`,
    `Live source: ${String(report.live_source)}`,
    "",
    "## Catalog summary",
    "",
    ...Object.entries(summary).map(([name, count]) => `- ${name}: ${count}`),
    "",
    "## Source protocol",
    "",
    ...Object.entries(sourceContract).map(([name, enabled]) => `- ${name}: ${enabled}`),
    "",
    "## Interpretation",
    "",
    summary.legacy_callable_fallback > 0
      ? "This live DLL still exposes legacy `callable`; the audit treats it only as a fallback for `signature_supported` and does not infer target reachability, chaining, or terminal usefulness."
      : "The catalog now separates signature support, direct target reachability, operation-graph chaining, and independently verified terminal usefulness. `callable` is retained only as a deprecated compatibility alias.",
    ""
  ].join("\n");
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

async function loadLiveCatalog(): Promise<{ source: string; policy: unknown; items: NativeApiItem[] }> {
  assertExactDevelopmentLaboratoryNativeTransport(process.env, "Native API gateway audit raw Revit transport");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; cannot discover the live bridge.");
  const bridgeUrl = fs.readFileSync(path.join(localAppData, "RevitOperator", "bridge_url.txt"), "utf8").trim().replace(/\/+$/, "");
  const token = fs.readFileSync(path.join(localAppData, "RevitOperator", "Workspace", "operator_token.txt"), "utf8").trim();
  const headers = { "content-type": "application/json", "x-operator-token": token };
  const policy = await fetchJson(`${bridgeUrl}/revit/native-api-policy`, { method: "GET", headers });
  const items: NativeApiItem[] = [];
  let total = 1;
  while (items.length < total) {
    const raw = await fetchJson(`${bridgeUrl}/revit/native-api-catalog`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offset: items.length, limit: 200 })
    }) as { total?: number; returned?: number; items?: NativeApiItem[] };
    total = Number(raw.total ?? 0);
    const page = Array.isArray(raw.items) ? raw.items : [];
    if (page.length === 0 && items.length < total) throw new Error(`Native API catalog stopped at ${items.length} of ${total}.`);
    items.push(...page);
  }
  return { source: `${bridgeUrl}/revit/native-api-catalog`, policy, items };
}

async function runCli(): Promise<void> {
  if (!process.argv.includes("--live")) throw new Error("audit:native-api-gateway requires --live");
  const repoRoot = findRepoRoot(process.cwd());
  const live = await loadLiveCatalog();
  const summary = summarizeNativeApiCatalog(live.items);
  const sourceContract = inspectSourceContract(repoRoot);
  const report = {
    version: "revit-operator.native-api-gateway-audit.v1",
    generated_at: new Date().toISOString(),
    live_source: live.source,
    policy: live.policy,
    summary,
    source_protocol: sourceContract,
    members: live.items
  };
  const outputArgIndex = process.argv.indexOf("--output-dir");
  const outputDir = path.resolve(outputArgIndex >= 0 && process.argv[outputArgIndex + 1] ? process.argv[outputArgIndex + 1]! : path.join(repoRoot, "local-work", "tool-registry-audit"));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "native_api_gateway_audit.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "native_api_gateway_catalog.csv"), renderCsv(live.items));
  fs.writeFileSync(path.join(outputDir, "native_api_gateway_audit.md"), renderMarkdown(report, summary, sourceContract));
  console.log(renderMarkdown(report, summary, sourceContract));
  console.log(`Artifacts: ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
