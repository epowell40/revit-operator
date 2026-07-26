import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findActiveToolQuarantine } from "../codex/revit_tool_contract_memory.js";
import { findRepoRoot } from "./audit_tool_registry.js";

type JsonObject = Record<string, unknown>;

export type WriteProbeStrategy =
  | "read_only"
  | "plan_only"
  | "safe_read_action"
  | "dry_run_or_preview"
  | "rollback_transaction"
  | "state_restore"
  | "controlled_external_fixture"
  | "human_supervised"
  | "contract_only";

export type ToolDocument = {
  method?: unknown;
  path?: unknown;
  risk?: unknown;
  title?: unknown;
  description?: unknown;
  optional_fields?: unknown;
  enums?: unknown;
  request_schema?: unknown;
};

export type WriteProbePlanRow = {
  key: string;
  method: string;
  path: string;
  title: string;
  risk: string;
  quarantined: boolean;
  quarantine_reason: string | null;
  strategy: WriteProbeStrategy;
  model_requirement: "current_read_only" | "disposable_detached" | "controlled_external_fixture" | "human_supervised";
  autonomous_probe_allowed: boolean;
  supports_dry_run: boolean;
  supports_preview_only: boolean;
  safe_action: string | null;
  commit_acceptance_required: boolean;
  independent_readback_required: boolean;
  failure_receipt_required: boolean;
  instructions: string[];
};

export type WriteProbeQuarantineEvidence = { reason: string };

export type WriteProbePlan = {
  version: "revit-operator.write-probe-plan.v1";
  generated_at: string;
  registry_source: string;
  summary: Record<string, number>;
  tools: WriteProbePlanRow[];
};

const HUMAN_SUPERVISED = new Set([
  "POST /revit/close-doc",
  "POST /revit/computer-use-act",
  "POST /revit/open-model",
  "POST /revit/sync"
]);

const CONTROLLED_EXTERNAL_FIXTURE = new Set([
  "POST /revit/apply-family-evolution",
  "POST /revit/batch-job",
  "POST /revit/create-family-from-template",
  "POST /revit/edit-family-from-instance",
  "POST /revit/export-dimensioning-v2",
  "POST /revit/import-drawing-spec",
  "POST /revit/import-elements-xlsx-updates",
  "POST /revit/import-excel-table",
  "POST /revit/import-zippybim-geometry",
  "POST /revit/link-cad",
  "POST /revit/link-revit",
  "POST /revit/load-family",
  "POST /revit/load-family-doc",
  "POST /revit/open-family-doc",
  "POST /revit/place-image",
  "POST /revit/place-pdf-underlay",
  "POST /revit/print",
  "POST /revit/reload-family-edit-session",
  "POST /revit/save-as",
  "POST /revit/save-family-doc",
  "POST /revit/transfer-view-templates"
]);

const STATE_RESTORE = new Set([
  "POST /revit/computer-use-guard",
  "POST /revit/native-api-policy"
]);

const PLAN_ONLY = new Set([
  "POST /revit/transaction-plan",
  "POST /revit/transaction-validate"
]);

const ROLLBACK_TRANSACTION = new Set([
  "POST /revit/native-api-mutation-ops"
]);

const MEDIUM_MODEL_WRITES = new Set([
  "POST /revit/annotation-symbol-leaders",
  "POST /revit/create-dimension",
  "POST /revit/create-drafting-view",
  "POST /revit/create-filled-region",
  "POST /revit/create-revision-cloud",
  "POST /revit/create-text",
  "POST /revit/create-zone-visuals",
  "POST /revit/datums",
  "POST /revit/draw-detail-curves",
  "POST /revit/fire-alarm-visualizer",
  "POST /revit/keynotes",
  "POST /revit/quantify-visualize",
  "POST /revit/tag-elements",
  "POST /revit/visibility"
]);

const SAFE_ACTION_ORDER = [
  "list",
  "analyze",
  "audit",
  "validate",
  "inspect",
  "preview",
  "status",
  "get",
  "plan",
  "read",
  "count",
  "discover",
  "preflight"
];

function objectAt(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeMethod(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizePath(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requestProperties(tool: ToolDocument): JsonObject {
  return objectAt(objectAt(tool.request_schema).properties);
}

function hasRequestField(tool: ToolDocument, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(requestProperties(tool), field) || strings(tool.optional_fields).includes(field);
}

function actionValues(tool: ToolDocument): string[] {
  const schemaValues = strings(objectAt(requestProperties(tool).action).enum);
  const docValues = strings(objectAt(tool.enums).action);
  return [...new Set([...schemaValues, ...docValues].map(value => value.trim()).filter(Boolean))];
}

function safeActionFor(tool: ToolDocument): string | null {
  const values = actionValues(tool);
  for (const preferred of SAFE_ACTION_ORDER) {
    const exact = values.find(value => value.toLowerCase() === preferred);
    if (exact) return exact;
  }
  return values.find(value => /^(list|analy[sz]e|audit|validate|inspect|preview|status|get|plan|read|count|discover|preflight)(?:_|$)/i.test(value)) ?? null;
}

function commitAcceptanceRequired(key: string, risk: string, strategy: WriteProbeStrategy): boolean {
  if (["read_only", "plan_only", "state_restore", "human_supervised"].includes(strategy)) return false;
  return risk === "high" || MEDIUM_MODEL_WRITES.has(key);
}

export function planToolProbe(tool: ToolDocument, quarantine: WriteProbeQuarantineEvidence | null = null): WriteProbePlanRow {
  const method = normalizeMethod(tool.method);
  const routePath = normalizePath(tool.path);
  const key = `${method} ${routePath}`.trim();
  const title = typeof tool.title === "string" ? tool.title.trim() : key;
  const risk = typeof tool.risk === "string" ? tool.risk.trim().toLowerCase() : "unknown";
  const supportsDryRun = hasRequestField(tool, "dryRun");
  const supportsPreviewOnly = hasRequestField(tool, "previewOnly");
  const safeAction = safeActionFor(tool);
  let strategy: WriteProbeStrategy;
  if (method === "GET" || risk === "low") strategy = "read_only";
  else if (HUMAN_SUPERVISED.has(key)) strategy = "human_supervised";
  else if (CONTROLLED_EXTERNAL_FIXTURE.has(key)) strategy = "controlled_external_fixture";
  else if (STATE_RESTORE.has(key)) strategy = "state_restore";
  else if (ROLLBACK_TRANSACTION.has(key)) strategy = "rollback_transaction";
  else if (PLAN_ONLY.has(key)) strategy = "plan_only";
  else if (supportsDryRun || supportsPreviewOnly) strategy = "dry_run_or_preview";
  else if (safeAction) strategy = "safe_read_action";
  else strategy = "contract_only";

  const requiresCommit = commitAcceptanceRequired(key, risk, strategy);

  const modelRequirement = strategy === "read_only" || strategy === "plan_only" || strategy === "safe_read_action"
    ? "current_read_only"
    : strategy === "controlled_external_fixture"
      ? "controlled_external_fixture"
      : strategy === "human_supervised"
        ? "human_supervised"
        : "disposable_detached";
  const quarantined = Boolean(quarantine);
  const autonomousProbeAllowed = !quarantined && ["read_only", "plan_only", "safe_read_action", "dry_run_or_preview", "rollback_transaction"].includes(strategy);
  const instructions: string[] = [];

  if (strategy === "read_only") instructions.push("Run a bounded read with an explicit item/time cap; retain structural result and timing receipts.");
  if (strategy === "plan_only") instructions.push("Run only the documented planning/validation path; do not submit a transaction apply request.");
  if (strategy === "safe_read_action" && safeAction) instructions.push(`Call the documented non-writing action '${safeAction}' with bounded result limits.`);
  if (strategy === "dry_run_or_preview") instructions.push(supportsDryRun ? "Set dryRun:true." : "Set previewOnly:true.", "Verify the response explicitly reports no committed model change.");
  if (strategy === "rollback_transaction") instructions.push("Use transaction.mode:'rollback' with a small affected-element cap and exact allowed existing IDs.", "Require native affected-ID and rollback status evidence.");
  if (strategy === "state_restore") instructions.push("Capture the exact current state first, apply one bounded change, restore the captured state, and independently verify restoration.");
  if (strategy === "controlled_external_fixture") instructions.push("Use a disposable detached model plus a controlled local fixture/output path; never use a production central model, printer, or user file as the probe target.");
  if (strategy === "human_supervised") instructions.push("Do not invoke autonomously. Require an action-time human decision and capture the resulting application state.");
  if (strategy === "contract_only") instructions.push("Do not invoke autonomously. Validate schema/docs only until a route-specific safe fixture or rollback contract exists.");
  if (requiresCommit && strategy === "controlled_external_fixture") instructions.push("Planning success is not operational usefulness: perform one bounded real operation against the controlled fixture, then verify the resulting model or output artifact and restore or discard the fixture.");
  else if (requiresCommit) instructions.push("Dry-run or rollback success is not write usefulness: perform one bounded committed probe in a disposable detached copy, then independently read back and restore or discard the copy.");
  if (quarantined) instructions.push(`Active quarantine blocks autonomous execution: ${quarantine!.reason}`);

  return {
    key,
    method,
    path: routePath,
    title,
    risk,
    quarantined,
    quarantine_reason: quarantine?.reason ?? null,
    strategy,
    model_requirement: modelRequirement,
    autonomous_probe_allowed: autonomousProbeAllowed,
    supports_dry_run: supportsDryRun,
    supports_preview_only: supportsPreviewOnly,
    safe_action: safeAction,
    commit_acceptance_required: requiresCommit,
    independent_readback_required: requiresCommit || strategy === "state_restore" || strategy === "rollback_transaction",
    failure_receipt_required: true,
    instructions
  };
}

export function buildWriteProbePlan(registry: unknown, registrySource = "unknown", quarantines: ReadonlyMap<string, WriteProbeQuarantineEvidence> = new Map()): WriteProbePlan {
  const root = objectAt(registry);
  const rawTools = Array.isArray(root.tools) ? root.tools : [];
  const tools = rawTools.map(item => {
    const tool = objectAt(item) as ToolDocument;
    const key = `${normalizeMethod(tool.method)} ${normalizePath(tool.path)}`.trim();
    return planToolProbe(tool, quarantines.get(key) ?? null);
  }).sort((a, b) => a.key.localeCompare(b.key));
  const duplicateKeys = tools.length - new Set(tools.map(item => item.key)).size;
  if (duplicateKeys > 0) throw new Error(`Write-probe plan contains ${duplicateKeys} duplicate tool keys.`);
  if (tools.some(item => !item.method || !item.path.startsWith("/"))) throw new Error("Write-probe plan contains an invalid tool identity.");
  const mutating = tools.filter(item => item.risk === "high" || item.risk === "medium");
  const summary: Record<string, number> = {
    total_tools: tools.length,
    low_risk: tools.filter(item => item.risk === "low").length,
    medium_risk: tools.filter(item => item.risk === "medium").length,
    high_risk: tools.filter(item => item.risk === "high").length,
    non_low_tools: mutating.length,
    non_low_autonomous_probe_allowed: mutating.filter(item => item.autonomous_probe_allowed).length,
    active_quarantines: tools.filter(item => item.quarantined).length,
    commit_acceptance_required: tools.filter(item => item.commit_acceptance_required).length
  };
  for (const strategy of [...new Set(tools.map(item => item.strategy))].sort()) {
    summary[`strategy_${strategy}`] = tools.filter(item => item.strategy === strategy).length;
  }
  return { version: "revit-operator.write-probe-plan.v1", generated_at: new Date().toISOString(), registry_source: registrySource, summary, tools };
}

export function renderWriteProbePlanMarkdown(plan: WriteProbePlan): string {
  const lines = [
    "# Revit Operator write-probe plan",
    "",
    `Generated: ${plan.generated_at}`,
    `Registry: ${plan.registry_source}`,
    "",
    "## Summary",
    "",
    ...Object.entries(plan.summary).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Non-low-risk matrix",
    "",
    "| Tool | Risk | Strategy | Autonomous | Quarantined | Dry run | Safe action | Commit proof | Model lane |",
    "|---|---|---|---|---|---|---|---|---|"
  ];
  for (const item of plan.tools.filter(tool => tool.risk !== "low")) {
    lines.push(`| ${item.key} | ${item.risk} | ${item.strategy} | ${item.autonomous_probe_allowed} | ${item.quarantined} | ${item.supports_dry_run || item.supports_preview_only} | ${item.safe_action ?? ""} | ${item.commit_acceptance_required} | ${item.model_requirement} |`);
  }
  lines.push(
    "",
    "## Evidence rules",
    "",
    "- A dry-run or preview receipt proves only that the bounded planning path completed; it never proves committed write usefulness.",
    "- A committed-write claim requires a disposable detached model, exact affected IDs, independent readback, and either restoration or disposal of the copy.",
    "- Controlled external-fixture and human-supervised routes are never autonomous probes.",
    "- Every failure must retain a classified receipt. Quarantine requires a reproducible defect or unacceptable safety behavior, not merely missing live evidence.",
    ""
  );
  return lines.join("\n");
}

async function loadRegistry(inputPath: string | null): Promise<{ raw: unknown; source: string }> {
  if (inputPath) return { raw: JSON.parse(fs.readFileSync(inputPath, "utf8")), source: path.resolve(inputPath) };
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; pass --registry <tool-registry.json>.");
  const bridgeUrl = fs.readFileSync(path.join(localAppData, "RevitOperator", "bridge_url.txt"), "utf8").trim().replace(/\/+$/, "");
  const token = fs.readFileSync(path.join(localAppData, "RevitOperator", "Workspace", "operator_token.txt"), "utf8").trim();
  const response = await fetch(`${bridgeUrl}/revit/tool-registry`, { headers: { "x-operator-token": token }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Live tool registry failed: HTTP ${response.status}`);
  return { raw: await response.json(), source: `${bridgeUrl}/revit/tool-registry` };
}

async function runCli(): Promise<void> {
  const registryIndex = process.argv.indexOf("--registry");
  const registryPath = registryIndex >= 0 ? process.argv[registryIndex + 1] ?? null : null;
  const outputIndex = process.argv.indexOf("--output-dir");
  const repoRoot = findRepoRoot(process.cwd());
  const outputDir = path.resolve(outputIndex >= 0 && process.argv[outputIndex + 1] ? process.argv[outputIndex + 1]! : path.join(repoRoot, "local-work", "tool-registry-audit"));
  const registry = await loadRegistry(registryPath);
  const quarantines = new Map<string, WriteProbeQuarantineEvidence>();
  for (const item of (Array.isArray(objectAt(registry.raw).tools) ? objectAt(registry.raw).tools as unknown[] : [])) {
    const tool = objectAt(item) as ToolDocument;
    const method = normalizeMethod(tool.method);
    const routePath = normalizePath(tool.path);
    const active = findActiveToolQuarantine("revit_call_tool", { method, path: routePath });
    if (active) quarantines.set(`${method} ${routePath}`, { reason: active.reason });
  }
  const plan = buildWriteProbePlan(registry.raw, registry.source, quarantines);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "write_probe_plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outputDir, "write_probe_plan.md"), renderWriteProbePlanMarkdown(plan), "utf8");
  console.log(renderWriteProbePlanMarkdown(plan));
  console.log(`Artifacts: ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
