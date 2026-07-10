import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBenchmarkConfigBundle } from "../benchmark/config.js";
import { assertRunnableRevitWorkflowOverride, findBenchmarkOverridePlaceholders } from "../benchmark/environment.js";
import { backendRoot, repoRoot, writeJsonFile } from "../benchmark/files.js";
import { exportManualGradingSheet } from "../benchmark/grading.js";
import { writeBenchmarkReportArtifacts } from "../benchmark/report.js";
import { buildRevitDemoDiscoveryPayload, enrichExistingTagMoveFromVisibleElements, enrichReceptacleRedlineFromPlacementContext } from "../benchmark/revit_discovery.js";
import { collectLocalRevitHostEvidence } from "../benchmark/revit_host_evidence.js";
import { requiredLiveRevitEndpointPaths, selectedTasksNeedLiveRevitPreflight, selectedTasksRequireWriteGrant, textNoteReplaceDryRunProbeRequest } from "../benchmark/revit_live_guard.js";
import { buildRevitBridgePreflightReport, summarizeRevitBridgePreflightReport } from "../benchmark/revit_preflight.js";
import { loadPreflightRequestOverridesByTaskId, loadPreflightRequestOverridesForFlags } from "../benchmark/revit_preflight_request_overrides.js";
import { buildRevitBridgeHeaders, resolveRevitBridgeUrl, resolveRevitBridgeUrlCandidates } from "../benchmark/revit_workflows.js";
import { readRedlineHardeningInput, writeRedlineHardeningScorecard } from "../benchmark/redline_hardening_scorecard.js";
import { writeRedlineGroundingReport } from "../benchmark/redline_grounding_report.js";
import { writeRedlineGroundingFillPacket } from "../benchmark/redline_grounding_fill_packet.js";
import { hydrateRedlineAddFamilyInstanceTypes } from "../benchmark/redline_add_family_instance_hydration.js";
import { hydrateRedlineAddTagTypes } from "../benchmark/redline_add_tag_type_hydration.js";
import { hydrateRedlineFilterRuleTypes } from "../benchmark/redline_filter_rule_hydration.js";
import { hydrateRedlineTypeChangeTypes } from "../benchmark/redline_type_change_hydration.js";
import { mergeRedlineLivePromotionManifests, writeApprovedRedlineLivePromotionManifest, writeRedlineLivePromotionManifest, writeRedlineLiveReadinessReport } from "../benchmark/redline_live_readiness.js";
import { writeRedlineTagMoveEvidenceReview } from "../benchmark/redline_tag_move_evidence_review.js";
import { writeRedlineFamilyAvailabilityReport } from "../benchmark/redline_family_availability.js";
import { writeRedlineModelAvailabilityReport } from "../benchmark/redline_model_availability.js";
import { buildRedlineSessionAudit } from "../benchmark/redline_session_audit.js";
import { runRedlineRoutingReadiness } from "../benchmark/redline_routing_readiness.js";
import { writeRevitStartupDiagnostics } from "../benchmark/revit_startup_diagnostics.js";
import { runBenchmarkBatch, runDefaultExperimentPlan } from "../benchmark/runner.js";
import { loadBenchmarkTasks } from "../benchmark/tasks.js";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1] ?? "";
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function flagList(flags: Record<string, string | boolean>, key: string): string[] {
  const value = flags[key];
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function usage(): string {
  return [
    "Usage:",
    "  npm run benchmark -- list-tasks",
    "  npm run benchmark -- list-configs",
    "  npm run benchmark -- run --task <task_id> --config <config_id> [--repeat 1] [--resume] [--skip-revit-preflight]",
    "  npm run benchmark -- run --task <task_id> --all-configs [--repeat 1]",
    "  npm run benchmark -- run --all-tasks --all-configs [--repeat 1]",
    "  npm run benchmark -- report --artifacts-dir <dir> [--output <file>]",
    "  npm run benchmark -- demo-readiness --artifacts-dir <dir>",
    "  npm run benchmark -- grade-sheet --artifacts-dir <dir> [--output <file>]",
    "  npm run benchmark -- preflight-revit [--task <task_id>|--tasks <task_id,...>] [--summary] [--output <file>]",
    "  npm run benchmark -- revit-startup-diagnostics [--revit-year 2024] [--output-dir <dir>]",
    "  npm run benchmark -- redline-routing-readiness",
    "  npm run benchmark -- redline-hardening-scorecard [--input <classification.json>] [--output-dir <dir>] [--confidence-threshold 0.55] [--promotion-manifest <file>] [--min-reviewed-promotions 2]",
    "  npm run benchmark -- redline-grounding-report --scorecard <redline_hardening_scorecard.json> --output-dir <dir> [--template-dir <dir>] [--model-availability <redline_model_availability.json>] [--limit 20]",
    "  npm run benchmark -- redline-grounding-fill-packet --report <redline_grounding_report.json> --output-dir <dir> [--rank 1 | --redline-id <id>]",
    "  npm run benchmark -- redline-model-availability --roots <dir,dir> --output-dir <dir> [--patterns B300,Duke,Mechanical,Mech,Plumb] [--max-scan-ms 10000] [--max-files-per-root 250000]",
    "  npm run benchmark -- redline-family-availability --roots <dir,dir> --output-dir <dir> [--patterns damper,duct accessory,pipe accessory,valve,accessory] [--extensions rfa,rft] [--max-scan-ms 10000] [--max-files-per-root 250000]",
    "  npm run benchmark -- redline-live-readiness --artifacts-dir <dir> [--output-dir <dir>] [--promotion-manifest <file>] [--min-reviewed-promotions 2]",
    "  npm run benchmark -- redline-live-promotion-manifest --artifacts-dir <dir> --output <file> [--reviewed-by <name>] [--review-notes <text>]",
    "  npm run benchmark -- redline-live-approve-promotion --candidate-manifest <file> --output <file> (--run-id <id> | --artifact-dir <dir>) --reviewed-by <name> --review-notes <text> --preflight-artifact <file> [--write-grant-status-artifact <file>]",
    "  npm run benchmark -- redline-live-merge-promotions --inputs <approved-a.json,approved-b.json> --output <merged.json>",
    "  npm run benchmark -- redline-tag-move-evidence-review --move-summary <redline_move_summary.json> --output <file> [--discovery <discover.json>] [--visual-gate <redline_move_visual_gate.json>] [--leader-preserved]",
    "  npm run benchmark -- redline-session-audit --session-dir <dir> [--max-tool-calls 25] [--max-assistant-messages 10]",
    "  npm run benchmark -- redline-session-audit --session-id <id> [--max-tool-calls 25] [--max-assistant-messages 10]",
    "  npm run benchmark -- discover-revit-demo [--output <file>]",
    "  npm run benchmark -- hydrate-redline-add-family-instance-types --input <file> --output <file>",
    "  npm run benchmark -- hydrate-redline-add-tag-types --input <file> --output <file>",
    "  npm run benchmark -- hydrate-redline-filter-rule-types --input <file> --output <file>",
    "  npm run benchmark -- hydrate-redline-type-change-types --input <file> --output <file>",
    "  npm run benchmark -- validate-revit-requests --input <file>",
    "  npm run benchmark -- default-plan [--include-broader-phase]"
  ].join("\n");
}

function revitPreflightFetchTimeoutMs(): number {
  const raw = Number(process.env.OPERATOR_REVIT_PREFLIGHT_FETCH_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1_000, Math.min(120_000, raw));
  }
  return 15_000;
}

async function fetchBridgeJson(pathname: string, method = "GET", body?: unknown, bridgeUrl = resolveRevitBridgeUrl()): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${bridgeUrl}${pathname}`;
  const controller = new AbortController();
  const timeoutMs = revitPreflightFetchTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: buildRevitBridgeHeaders(),
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: controller.signal
    });
    const text = await response.text();
    let parsedBody: unknown = text;
    try {
      parsedBody = text ? JSON.parse(text) : {};
    } catch {
      parsedBody = text;
    }
    return { ok: response.ok, status: response.status, body: parsedBody };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Bridge ${pathname} timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBridgeJsonSafe(pathname: string, method = "GET", body?: unknown, bridgeUrl = resolveRevitBridgeUrl()): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  try {
    return await fetchBridgeJson(pathname, method, body, bridgeUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function bridgeUrlLocalPortOwner(bridgeUrl: string): unknown {
  if (os.platform() !== "win32") return undefined;
  let url: URL;
  try {
    url = new URL(bridgeUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($null -eq $c) { '{}' } else {",
    "  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue",
    "  [pscustomobject]@{ localAddress = $c.LocalAddress; localPort = $c.LocalPort; owningProcess = $c.OwningProcess; processName = $p.ProcessName; path = $p.Path } | ConvertTo-Json -Compress",
    "}"
  ].join("; ");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true
    }).trim();
    return output ? JSON.parse(output) : undefined;
  } catch {
    return undefined;
  }
}

async function discoverRevitDemo(outputFlag: unknown): Promise<void> {
  const outputPath =
    typeof outputFlag === "string" && outputFlag.trim()
      ? path.resolve(outputFlag)
      : path.join(repoRoot(), "local-work", "demo-live-requests.json");

  const preflight = await runRevitPreflightReport();
  const bridgeUrl = preflight.bridge_url;
  const ping = preflight.ping;
  const context = preflight.context;
  if (!ping.ok || !context.ok) {
    console.log(JSON.stringify(preflight, null, 2));
    throw new Error("Revit bridge is not ready. Start Revit with the Operator add-in loaded, open the demo model, then rerun discovery.");
  }
  process.env.REVIT_BRIDGE_URL = bridgeUrl;

  const sheetsResult = await fetchBridgeJson("/revit/sheets", "POST", { action: "list", max: 20 }, bridgeUrl);
  const viewsResult = await fetchBridgeJson("/revit/views", "GET", undefined, bridgeUrl);
  const receptacleFind = await fetchBridgeJson("/revit/find-elements", "POST", {
    category: "OST_ElectricalFixtures",
    typeNameContains: "recept",
    limit: 20
  }, bridgeUrl);
  const receptacleQuantify = await fetchBridgeJson("/revit/quantify", "POST", {
    intent: "count_and_list",
    scope: "host",
    categories: ["OST_ElectricalFixtures"],
    filters: { keywords_include: ["receptacle"] },
    group_by: ["Type", "Level", "Room"],
    room_resolution: true
  }, bridgeUrl);
  const mechanicalEquipmentQuantify = await fetchBridgeJson("/revit/quantify", "POST", {
    intent: "count_and_list",
    scope: "host",
    categories: ["OST_MechanicalEquipment"],
    filters: { keywords_include_any: ["VAV", "terminal", "box", "HRU"] },
    group_by: ["Category", "Type", "Level", "Room", "Space"],
    room_resolution: true
  }, bridgeUrl);

  const payload = buildRevitDemoDiscoveryPayload({
    bridgeUrl,
    context: context.body,
    sheetsBody: sheetsResult.body,
    viewsBody: viewsResult.body,
    receptacleFindBody: receptacleFind.body,
    receptacleQuantifyBody: receptacleQuantify.body,
    mechanicalEquipmentQuantifyBody: mechanicalEquipmentQuantify.body,
    userProfile: process.env.USERPROFILE
  });
  const tasks = payload.tasks as Record<string, { request?: Record<string, unknown> }>;
  const sheetNumbers = (tasks.demo_sheet_export?.request?.sheetNumbers as unknown[]) ?? [];
  const targetView = (payload._discovery.candidateTargetView ?? {}) as Record<string, unknown>;
  const targetViewId = Number(tasks.demo_redline_receptacles?.request?.viewId ?? 0);
  const redlinePlacements = tasks.demo_redline_receptacles?.request?.placements as Array<Record<string, unknown>> | undefined;
  const exemplarId = Number(redlinePlacements?.[0]?.exemplarElementId ?? 0);
  if (exemplarId > 0) {
    const placementContext = await fetchBridgeJsonSafe("/revit/get-placement-context", "POST", { elementId: exemplarId, viewId: targetViewId || undefined }, bridgeUrl);
    if (placementContext.ok) {
      enrichReceptacleRedlineFromPlacementContext(payload, placementContext.body);
    } else {
      payload._discovery.redlineReceptaclePlacementContext = {
        source: "/revit/get-placement-context",
        elementId: exemplarId,
        error: placementContext.error ?? placementContext.status ?? "unknown failure",
        note: "Review receptacle room/host placement manually before live redline runs."
      };
    }
  }
  if (targetViewId > 0) {
    const visibleElements = await fetchBridgeJsonSafe("/revit/export-visible-elements", "POST", {
      viewId: targetViewId,
      includeMapping: true,
      includeGeometry: true,
      includeParameters: true,
      imageSize: 1800,
      limit: 5000
    }, bridgeUrl);
    if (visibleElements.ok) {
      enrichExistingTagMoveFromVisibleElements(payload, visibleElements.body);
    } else {
      payload._discovery.candidateExistingTagMove = {
        status: "missing",
        source: "/revit/export-visible-elements",
        viewId: targetViewId,
        error: visibleElements.error ?? visibleElements.status ?? "unknown failure",
        note: "Existing-tag move redlines need visible tag inventory with tag id, category, text, and model point."
      };
    }
  }
  const parameterEditIds = Array.isArray(tasks.demo_parameter_edit?.request?.elementIds) ? tasks.demo_parameter_edit.request.elementIds : [];
  const documentationTag = tasks.demo_documentation_primitives?.request?.tag as Record<string, unknown> | undefined;
  const documentationTagIds = Array.isArray(documentationTag?.elementIds) ? documentationTag.elementIds : [];
  const routePointsNeedReview = (taskId: string) => {
    const routeRequest = tasks[taskId]?.request ?? {};
    const points = Array.isArray(routeRequest.points) ? routeRequest.points.map((point) => point as Record<string, unknown>) : [];
    return points.length < 2 || points.some((point) => Number(point.x ?? 0) === 0 && Number(point.y ?? 0) === 0);
  };
  const reviewRequired =
    !exemplarId ||
    !targetViewId ||
    sheetNumbers.length === 0 ||
    routePointsNeedReview("demo_redline_mep_route") ||
    routePointsNeedReview("demo_redline_mep_pipe_route") ||
    parameterEditIds.length === 0 ||
    documentationTagIds.length === 0;

  writeJsonFile(outputPath, payload);
  console.log(`Discovery override skeleton: ${outputPath}`);
  console.log(JSON.stringify({
    ok: true,
    bridge_url: bridgeUrl,
    output: outputPath,
    selected_sheet_numbers: sheetNumbers,
    selected_view: targetView,
    exemplar_element_id: exemplarId || null,
    editable_element_id: Number(parameterEditIds[0] ?? 0) || null,
    documentation_tag_element_id: Number(documentationTagIds[0] ?? 0) || null,
    generated_task_ids: Object.keys(tasks),
    review_required: reviewRequired,
    review_reasons: [
      ...(!exemplarId ? ["missing receptacle exemplar element id"] : []),
      ...(!targetViewId ? ["missing target view id"] : []),
      ...(sheetNumbers.length === 0 ? ["missing sheet numbers"] : []),
      ...(routePointsNeedReview("demo_redline_mep_route") ? ["duct route points are placeholders"] : []),
      ...(routePointsNeedReview("demo_redline_mep_pipe_route") ? ["pipe route points are placeholders"] : []),
      ...(parameterEditIds.length === 0 ? ["parameter edit element ids are missing"] : []),
      ...(documentationTagIds.length === 0 ? ["documentation tag element ids are missing"] : [])
    ]
  }, null, 2));
}

function validateRevitRequests(inputFlag: unknown): void {
  const inputPath =
    typeof inputFlag === "string" && inputFlag.trim()
      ? path.resolve(inputFlag)
      : path.resolve((process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON || "").trim());
  if (!inputPath) throw new Error("validate-revit-requests requires --input or OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON.");
  if (!fs.existsSync(inputPath)) throw new Error(`Revit benchmark request override file not found: ${inputPath}`);

  const root = JSON.parse(fs.readFileSync(inputPath, "utf8")) as unknown;
  const placeholders = findBenchmarkOverridePlaceholders(root);
  try {
    assertRunnableRevitWorkflowOverride(root, inputPath);
    console.log(JSON.stringify({
      ok: true,
      input: inputPath,
      placeholder_count: placeholders.length,
      message: "Request override is runnable by the benchmark environment."
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      input: inputPath,
      placeholder_count: placeholders.length,
      placeholder_paths: placeholders,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exitCode = 1;
  }
}

async function runRevitPreflightReport(
  requiredPaths: string[] = [],
  requireWriteGrant = false,
  textNoteReplaceProbeRequest?: Record<string, unknown>
): Promise<ReturnType<typeof buildRevitBridgePreflightReport>> {
  let firstReport: ReturnType<typeof buildRevitBridgePreflightReport> | null = null;
  const checkedBridgeUrls = resolveRevitBridgeUrlCandidates();
  const hostEvidence = collectLocalRevitHostEvidence();
  for (const bridgeUrl of checkedBridgeUrls) {
    const ping = await fetchBridgeJsonSafe("/revit/ping", "GET", undefined, bridgeUrl);
    const context = await fetchBridgeJsonSafe("/revit/context", "GET", undefined, bridgeUrl);
    const capabilities = requiredPaths.length > 0
      ? await fetchBridgeJsonSafe("/revit/capabilities", "GET", undefined, bridgeUrl)
      : undefined;
    const writeGrantStatus = requireWriteGrant
      ? await fetchBridgeJsonSafe("/revit/write-grant-status", "GET", undefined, bridgeUrl)
      : undefined;
    const cadLinkDryRunProbe = requiredPaths.includes("/revit/link-cad")
      ? await fetchBridgeJsonSafe("/revit/link-cad", "POST", {
        preflightOnly: true,
        dryRun: true
      }, bridgeUrl)
      : undefined;
    const textNoteReplaceDryRunProbe = requiredPaths.includes("/revit/replace-text-note") && textNoteReplaceProbeRequest
      ? await fetchBridgeJsonSafe("/revit/replace-text-note", "POST", textNoteReplaceProbeRequest, bridgeUrl)
      : undefined;
    const report = buildRevitBridgePreflightReport({
      bridgeUrl,
      checkedBridgeUrls,
      ping,
      context,
      writeGrantStatus,
      capabilities,
      cadLinkDryRunProbe,
      textNoteReplaceDryRunProbe,
      requiredPaths,
      requireWriteGrant,
      localPortOwner: bridgeUrlLocalPortOwner(bridgeUrl),
      hostEvidence
    });
    if (!firstReport) firstReport = report;
    if (report.ok) {
      process.env.REVIT_BRIDGE_URL = bridgeUrl;
      return report;
    }
  }
  return firstReport ?? buildRevitBridgePreflightReport({
    bridgeUrl: resolveRevitBridgeUrl(),
    checkedBridgeUrls,
    ping: { ok: false, error: "No bridge URL candidates were available." },
    context: { ok: false, error: "No bridge URL candidates were available." },
    requiredPaths,
    requireWriteGrant,
    hostEvidence
  });
}

async function hydrateRedlineAddFamilyInstanceTypesCommand(flags: Record<string, string | boolean>): Promise<void> {
  if (typeof flags.input !== "string" || !flags.input.trim()) {
    throw new Error("hydrate-redline-add-family-instance-types requires --input <file>.");
  }
  if (typeof flags.output !== "string" || !flags.output.trim()) {
    throw new Error("hydrate-redline-add-family-instance-types requires --output <file>.");
  }

  const preflight = await runRevitPreflightReport(["/revit/list-element-types"], false);
  if (!preflight.ok) {
    console.log(JSON.stringify(preflight, null, 2));
    throw new Error("Revit bridge preflight failed for add family-instance type hydration.");
  }
  const bridgeUrl = preflight.bridge_url;
  process.env.REVIT_BRIDGE_URL = bridgeUrl;

  const result = await hydrateRedlineAddFamilyInstanceTypes({
    inputPath: flags.input,
    outputPath: flags.output,
    discoverTypes: async (category) => {
      const response = await fetchBridgeJson("/revit/list-element-types", "POST", {
        category,
        limit: 100,
        cacheBust: true
      }, bridgeUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${typeof response.body === "string" ? response.body : JSON.stringify(response.body)}`);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      return Array.isArray(body.types) ? body.types as Array<Record<string, unknown>> : [];
    }
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function hydrateRedlineAddTagTypesCommand(flags: Record<string, string | boolean>): Promise<void> {
  if (typeof flags.input !== "string" || !flags.input.trim()) {
    throw new Error("hydrate-redline-add-tag-types requires --input <file>.");
  }
  if (typeof flags.output !== "string" || !flags.output.trim()) {
    throw new Error("hydrate-redline-add-tag-types requires --output <file>.");
  }

  const preflight = await runRevitPreflightReport(["/revit/list-element-types"], false);
  if (!preflight.ok) {
    console.log(JSON.stringify(preflight, null, 2));
    throw new Error("Revit bridge preflight failed for tag-type hydration.");
  }
  const bridgeUrl = preflight.bridge_url;
  process.env.REVIT_BRIDGE_URL = bridgeUrl;

  const result = await hydrateRedlineAddTagTypes({
    inputPath: flags.input,
    outputPath: flags.output,
    discoverTypes: async (category) => {
      const response = await fetchBridgeJson("/revit/list-element-types", "POST", {
        category,
        limit: 50,
        cacheBust: true
      }, bridgeUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${typeof response.body === "string" ? response.body : JSON.stringify(response.body)}`);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      return Array.isArray(body.types) ? body.types as Array<Record<string, unknown>> : [];
    }
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function hydrateRedlineFilterRuleTypesCommand(flags: Record<string, string | boolean>): void {
  if (typeof flags.input !== "string" || !flags.input.trim()) {
    throw new Error("hydrate-redline-filter-rule-types requires --input <file>.");
  }
  if (typeof flags.output !== "string" || !flags.output.trim()) {
    throw new Error("hydrate-redline-filter-rule-types requires --output <file>.");
  }
  const result = hydrateRedlineFilterRuleTypes({
    inputPath: flags.input,
    outputPath: flags.output
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function hydrateRedlineTypeChangeTypesCommand(flags: Record<string, string | boolean>): Promise<void> {
  if (typeof flags.input !== "string" || !flags.input.trim()) {
    throw new Error("hydrate-redline-type-change-types requires --input <file>.");
  }
  if (typeof flags.output !== "string" || !flags.output.trim()) {
    throw new Error("hydrate-redline-type-change-types requires --output <file>.");
  }

  const preflight = await runRevitPreflightReport(["/revit/list-element-types", "/revit/export-visible-elements", "/revit/get-parameters"], false);
  if (!preflight.ok) {
    console.log(JSON.stringify(preflight, null, 2));
    throw new Error("Revit bridge preflight failed for type-change hydration.");
  }
  const bridgeUrl = preflight.bridge_url;
  process.env.REVIT_BRIDGE_URL = bridgeUrl;

  const result = await hydrateRedlineTypeChangeTypes({
    inputPath: flags.input,
    outputPath: flags.output,
    discoverTypes: async (category) => {
      const response = await fetchBridgeJson("/revit/list-element-types", "POST", {
        category,
        limit: 100,
        cacheBust: true
      }, bridgeUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${typeof response.body === "string" ? response.body : JSON.stringify(response.body)}`);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      return Array.isArray(body.types) ? body.types as Array<Record<string, unknown>> : [];
    },
    discoverVisibleElements: async (viewId, elementIds, category) => {
      const response = await fetchBridgeJson("/revit/export-visible-elements", "POST", {
        viewId,
        elementIds,
        categories: category ? [category] : undefined,
        includeParameters: true,
        includeGeometry: false,
        imageSize: 900,
        limit: Math.max(100, elementIds.length)
      }, bridgeUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${typeof response.body === "string" ? response.body : JSON.stringify(response.body)}`);
      }
      const parameterResponse = await fetchBridgeJson("/revit/get-parameters", "POST", {
        elementIds,
        names: ["Type", "Family and Type", "Family", "Type Name", "Category", "Mark"]
      }, bridgeUrl);
      if (!parameterResponse.ok) return response.body;
      const visibleBody = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      const parameterBody = parameterResponse.body && typeof parameterResponse.body === "object" ? parameterResponse.body as Record<string, unknown> : {};
      return {
        ...visibleBody,
        items: [
          ...(Array.isArray(visibleBody.items) ? visibleBody.items : []),
          ...(Array.isArray(parameterBody.items) ? parameterBody.items : [])
        ]
      };
    }
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();

  if (command === "help") {
    console.log(usage());
    return;
  }

  if (command === "list-tasks") {
    for (const task of tasks) console.log(`${task.task_id}\t${task.name}`);
    return;
  }

  if (command === "list-configs") {
    for (const config of bundle.configs) {
      console.log(`${config.id}\t${config.mode}\t${config.planner_model}/${config.executor_model}`);
    }
    return;
  }

  if (command === "preflight-revit") {
    const { taskIds, requestOverridesByTaskId } = loadPreflightRequestOverridesForFlags(flags);
    const requiredPaths = taskIds.length > 0
      ? requiredLiveRevitEndpointPaths({ taskIds, allTasks: tasks, requestOverridesByTaskId })
      : [];
    const requireWriteGrant = taskIds.length > 0
      ? selectedTasksRequireWriteGrant({ taskIds, allTasks: tasks, requestOverridesByTaskId })
      : false;
    const textNoteReplaceProbeRequest = taskIds.length > 0
      ? textNoteReplaceDryRunProbeRequest({ taskIds, allTasks: tasks, requestOverridesByTaskId })
      : undefined;
    const report = await runRevitPreflightReport(requiredPaths, requireWriteGrant, textNoteReplaceProbeRequest);
    const outputPayload = flags.summary === true ? summarizeRevitBridgePreflightReport(report) : report;
    if (typeof flags.output === "string" && flags.output.trim()) {
      writeJsonFile(path.resolve(flags.output), outputPayload);
    }
    console.log(JSON.stringify(outputPayload, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "revit-startup-diagnostics") {
    const result = writeRevitStartupDiagnostics({
      revitYear: typeof flags["revit-year"] === "string" && flags["revit-year"].trim() ? flags["revit-year"] : undefined,
      outputDir: typeof flags["output-dir"] === "string" && flags["output-dir"].trim() ? path.resolve(flags["output-dir"]) : undefined
    });
    console.log(`Revit startup diagnostics json: ${result.json_path}`);
    console.log(`Revit startup diagnostics markdown: ${result.markdown_path}`);
    console.log(JSON.stringify({
      diagnosis: result.report.diagnosis,
      message: result.report.message,
      revit_year: result.report.revit_year,
      active_manifest_count: result.report.active_manifest_count,
      all_active_addin_count: result.report.all_active_addin_count,
      addin_roots: result.report.addin_root_diagnostics?.map((root) => ({
        path: root.path,
        active_addin_count: root.active_addin_count,
        program_data_root: root.program_data_root,
        isolation_note: root.isolation_note
      })),
      latest_revit_journals: result.report.latest_revit_journals?.map((journal) => ({
        path: journal.path,
        last_write_time: journal.last_write_time,
        interesting_line_count: journal.interesting_lines.length
      })),
      deployed_assembly_sha256: result.report.deployed_assembly_sha256,
      latest_revit_crash: result.report.latest_revit_crash ? {
        time_created: result.report.latest_revit_crash.time_created,
        provider_name: result.report.latest_revit_crash.provider_name,
        faulting_module: result.report.latest_revit_crash.faulting_module,
        exception_code: result.report.latest_revit_crash.exception_code,
        exit_code: result.report.latest_revit_crash.exit_code
      } : undefined
    }, null, 2));
    if (result.report.diagnosis !== "ok" && result.report.diagnosis !== "bridge_not_running") process.exitCode = 1;
    return;
  }

  if (command === "redline-routing-readiness") {
    const result = await runRedlineRoutingReadiness();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "redline-hardening-scorecard") {
    const inputPath = typeof flags.input === "string" && flags.input.trim()
      ? path.resolve(flags.input)
      : path.join(backendRoot(), "benchmark", "fixtures", "redline_hardening_sample_classification.json");
    const outputDir = typeof flags["output-dir"] === "string" && flags["output-dir"].trim()
      ? path.resolve(flags["output-dir"])
      : path.join(repoRoot(), "local-work", "redline-hardening-eval", new Date().toISOString().slice(0, 10));
    const confidenceThreshold = typeof flags["confidence-threshold"] === "string"
      ? Number.parseFloat(flags["confidence-threshold"])
      : undefined;
    const result = writeRedlineHardeningScorecard({
      inputPath,
      input: readRedlineHardeningInput(inputPath),
      benchmarkTasks: tasks,
      confidenceThreshold,
      promotionManifestPath: typeof flags["promotion-manifest"] === "string" && flags["promotion-manifest"].trim() ? path.resolve(flags["promotion-manifest"]) : undefined,
      minimumReviewedPromotionsPerWorkflow: typeof flags["min-reviewed-promotions"] === "string" ? Number.parseInt(flags["min-reviewed-promotions"], 10) : undefined,
      fixtureMode: !flags.input,
      outputDir
    });
    console.log(`Redline hardening scorecard json: ${result.json_path}`);
    console.log(`Redline hardening scorecard markdown: ${result.markdown_path}`);
    console.log(JSON.stringify(result.scorecard.metrics, null, 2));
    return;
  }

  if (command === "redline-grounding-report") {
    if (typeof flags.scorecard !== "string" || !flags.scorecard.trim()) {
      throw new Error("redline-grounding-report requires --scorecard <redline_hardening_scorecard.json>.");
    }
    if (typeof flags["output-dir"] !== "string" || !flags["output-dir"].trim()) {
      throw new Error("redline-grounding-report requires --output-dir <dir>.");
    }
    const limit = typeof flags.limit === "string" && flags.limit.trim()
      ? Number.parseInt(flags.limit, 10)
      : undefined;
    const result = writeRedlineGroundingReport({
      scorecardPath: path.resolve(flags.scorecard),
      outputDir: path.resolve(flags["output-dir"]),
      templateDir: typeof flags["template-dir"] === "string" && flags["template-dir"].trim() ? path.resolve(flags["template-dir"]) : undefined,
      modelAvailabilityReportPath: typeof flags["model-availability"] === "string" && flags["model-availability"].trim() ? path.resolve(flags["model-availability"]) : undefined,
      ...(Number.isFinite(limit) && Number(limit) > 0 ? { limit: Number(limit) } : {})
    });
    console.log(`Redline grounding report json: ${result.json_path}`);
    console.log(`Redline grounding report markdown: ${result.markdown_path}`);
    console.log(JSON.stringify({
      metrics: result.report.metrics,
      top_candidate: result.report.ranked_candidates[0] ?? null
    }, null, 2));
    return;
  }

  if (command === "redline-grounding-fill-packet") {
    if (typeof flags.report !== "string" || !flags.report.trim()) {
      throw new Error("redline-grounding-fill-packet requires --report <redline_grounding_report.json>.");
    }
    if (typeof flags["output-dir"] !== "string" || !flags["output-dir"].trim()) {
      throw new Error("redline-grounding-fill-packet requires --output-dir <dir>.");
    }
    const rank = typeof flags.rank === "string" && flags.rank.trim()
      ? Number.parseInt(flags.rank, 10)
      : undefined;
    const result = writeRedlineGroundingFillPacket({
      reportPath: path.resolve(flags.report),
      outputDir: path.resolve(flags["output-dir"]),
      redlineId: typeof flags["redline-id"] === "string" && flags["redline-id"].trim() ? flags["redline-id"] : undefined,
      ...(Number.isFinite(rank) && Number(rank) > 0 ? { rank: Number(rank) } : {})
    });
    console.log(`Redline grounding fill packet json: ${result.json_path}`);
    console.log(`Redline grounding fill packet markdown: ${result.markdown_path}`);
    console.log(JSON.stringify({
      selected_rank: result.packet.selected_rank,
      selected_redline_id: result.packet.selected_redline_id,
      placeholder_count: result.packet.placeholder_fill_entries.length,
      command_count: result.packet.command_sequence.length,
      guardrails: result.packet.guardrails
    }, null, 2));
    return;
  }

  if (command === "redline-model-availability") {
    const roots = flagList(flags, "roots").map((entry) => path.resolve(entry));
    if (roots.length === 0) {
      throw new Error("redline-model-availability requires --roots <dir,dir>.");
    }
    if (typeof flags["output-dir"] !== "string" || !flags["output-dir"].trim()) {
      throw new Error("redline-model-availability requires --output-dir <dir>.");
    }
    const result = writeRedlineModelAvailabilityReport({
      roots,
      patterns: flagList(flags, "patterns"),
      outputDir: path.resolve(flags["output-dir"]),
      maxScanMs: typeof flags["max-scan-ms"] === "string" ? Number.parseInt(flags["max-scan-ms"], 10) : undefined,
      maxFilesPerRoot: typeof flags["max-files-per-root"] === "string" ? Number.parseInt(flags["max-files-per-root"], 10) : undefined
    });
    console.log(`Redline model availability json: ${result.json_path}`);
    console.log(`Redline model availability markdown: ${result.markdown_path}`);
    console.log(JSON.stringify({
      metrics: result.report.metrics,
      top_match: result.report.matches[0] ?? null,
      recommendation: result.report.recommendation
    }, null, 2));
    return;
  }

  if (command === "redline-family-availability") {
    const roots = flagList(flags, "roots").map((entry) => path.resolve(entry));
    if (roots.length === 0) {
      throw new Error("redline-family-availability requires --roots <dir,dir>.");
    }
    if (typeof flags["output-dir"] !== "string" || !flags["output-dir"].trim()) {
      throw new Error("redline-family-availability requires --output-dir <dir>.");
    }
    const result = writeRedlineFamilyAvailabilityReport({
      roots,
      patterns: flagList(flags, "patterns"),
      extensions: flagList(flags, "extensions"),
      outputDir: path.resolve(flags["output-dir"]),
      maxScanMs: typeof flags["max-scan-ms"] === "string" ? Number.parseInt(flags["max-scan-ms"], 10) : undefined,
      maxFilesPerRoot: typeof flags["max-files-per-root"] === "string" ? Number.parseInt(flags["max-files-per-root"], 10) : undefined
    });
    console.log(`Redline family availability json: ${result.json_path}`);
    console.log(`Redline family availability markdown: ${result.markdown_path}`);
    console.log(JSON.stringify({
      metrics: result.report.metrics,
      top_match: result.report.matches[0] ?? null,
      recommendation: result.report.recommendation
    }, null, 2));
    return;
  }

  if (command === "redline-live-readiness") {
    if (typeof flags["artifacts-dir"] !== "string" || !flags["artifacts-dir"].trim()) {
      throw new Error("redline-live-readiness requires --artifacts-dir <dir>.");
    }
    const result = writeRedlineLiveReadinessReport({
      artifactsDir: path.resolve(flags["artifacts-dir"]),
      outputDir: typeof flags["output-dir"] === "string" && flags["output-dir"].trim() ? path.resolve(flags["output-dir"]) : undefined,
      promotionManifestPath: typeof flags["promotion-manifest"] === "string" && flags["promotion-manifest"].trim() ? path.resolve(flags["promotion-manifest"]) : undefined,
      minimumReviewedPromotionsPerWorkflow: typeof flags["min-reviewed-promotions"] === "string" ? Number.parseInt(flags["min-reviewed-promotions"], 10) : undefined
    });
    console.log(`Redline live readiness json: ${result.json_path}`);
    console.log(`Redline live readiness markdown: ${result.markdown_path}`);
    console.log(JSON.stringify(result.report.metrics, null, 2));
    return;
  }

  if (command === "redline-live-promotion-manifest") {
    if (typeof flags["artifacts-dir"] !== "string" || !flags["artifacts-dir"].trim()) {
      throw new Error("redline-live-promotion-manifest requires --artifacts-dir <dir>.");
    }
    if (typeof flags.output !== "string" || !flags.output.trim()) {
      throw new Error("redline-live-promotion-manifest requires --output <file>.");
    }
    const result = writeRedlineLivePromotionManifest({
      artifactsDir: path.resolve(flags["artifacts-dir"]),
      outputPath: path.resolve(flags.output),
      reviewedBy: typeof flags["reviewed-by"] === "string" ? flags["reviewed-by"] : undefined,
      reviewNotes: typeof flags["review-notes"] === "string" ? flags["review-notes"] : undefined
    });
    console.log(`Redline live promotion manifest: ${result.manifest_path}`);
    console.log(JSON.stringify({
      candidate_count: result.candidate_count,
      approved_count: result.approved_count
    }, null, 2));
    return;
  }

  if (command === "redline-live-approve-promotion") {
    if (typeof flags["candidate-manifest"] !== "string" || !flags["candidate-manifest"].trim()) {
      throw new Error("redline-live-approve-promotion requires --candidate-manifest <file>.");
    }
    if (typeof flags.output !== "string" || !flags.output.trim()) {
      throw new Error("redline-live-approve-promotion requires --output <file>.");
    }
    if (typeof flags["reviewed-by"] !== "string" || !flags["reviewed-by"].trim()) {
      throw new Error("redline-live-approve-promotion requires --reviewed-by <name>.");
    }
    if (typeof flags["review-notes"] !== "string" || !flags["review-notes"].trim()) {
      throw new Error("redline-live-approve-promotion requires --review-notes <text>.");
    }
    if (typeof flags["preflight-artifact"] !== "string" || !flags["preflight-artifact"].trim()) {
      throw new Error("redline-live-approve-promotion requires --preflight-artifact <file>.");
    }
    const result = writeApprovedRedlineLivePromotionManifest({
      candidateManifestPath: path.resolve(flags["candidate-manifest"]),
      outputPath: path.resolve(flags.output),
      runId: typeof flags["run-id"] === "string" ? flags["run-id"] : undefined,
      artifactDir: typeof flags["artifact-dir"] === "string" ? path.resolve(flags["artifact-dir"]) : undefined,
      reviewedBy: flags["reviewed-by"],
      reviewNotes: flags["review-notes"],
      preflightArtifact: path.resolve(flags["preflight-artifact"]),
      writeGrantStatusArtifact: typeof flags["write-grant-status-artifact"] === "string" && flags["write-grant-status-artifact"].trim()
        ? path.resolve(flags["write-grant-status-artifact"])
        : undefined
    });
    console.log(`Approved redline live promotion manifest: ${result.manifest_path}`);
    console.log(JSON.stringify({ approved_count: result.approved_count }, null, 2));
    return;
  }

  if (command === "redline-live-merge-promotions") {
    const inputs = flagList(flags, "inputs").map((inputPath) => path.resolve(inputPath));
    if (inputs.length === 0) {
      throw new Error("redline-live-merge-promotions requires --inputs <approved-a.json,approved-b.json>.");
    }
    if (typeof flags.output !== "string" || !flags.output.trim()) {
      throw new Error("redline-live-merge-promotions requires --output <file>.");
    }
    const result = mergeRedlineLivePromotionManifests({
      inputPaths: inputs,
      outputPath: path.resolve(flags.output)
    });
    console.log(`Merged redline live promotion manifest: ${result.manifest_path}`);
    console.log(JSON.stringify({ merged_count: result.merged_count }, null, 2));
    return;
  }

  if (command === "redline-session-audit") {
    const maxToolCalls = typeof flags["max-tool-calls"] === "string" ? Number.parseInt(flags["max-tool-calls"], 10) : undefined;
    const maxAssistantMessages = typeof flags["max-assistant-messages"] === "string" ? Number.parseInt(flags["max-assistant-messages"], 10) : undefined;
    const result = buildRedlineSessionAudit({
      sessionDir: typeof flags["session-dir"] === "string" ? flags["session-dir"] : undefined,
      sessionId: typeof flags["session-id"] === "string" ? flags["session-id"] : undefined,
      maxToolCalls,
      maxAssistantMessages
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "redline-tag-move-evidence-review") {
    if (typeof flags["move-summary"] !== "string" || !flags["move-summary"].trim()) {
      throw new Error("redline-tag-move-evidence-review requires --move-summary <redline_move_summary.json>.");
    }
    if (typeof flags.output !== "string" || !flags.output.trim()) {
      throw new Error("redline-tag-move-evidence-review requires --output <file>.");
    }
    const result = writeRedlineTagMoveEvidenceReview({
      moveSummaryPath: flags["move-summary"],
      outputPath: flags.output,
      discoveryPath: typeof flags.discovery === "string" && flags.discovery.trim() ? flags.discovery : undefined,
      visualGateArtifactPath: typeof flags["visual-gate"] === "string" && flags["visual-gate"].trim() ? flags["visual-gate"] : undefined,
      leaderPreserved: flags["leader-preserved"] === true ? true : undefined
    });
    console.log(JSON.stringify({
      ok: result.ok,
      status: result.readiness.status,
      ready_for_live_dry_run: result.readiness.ready_for_live_dry_run,
      ready_to_run: result.readiness.ready_to_run,
      missing_live_inputs: result.readiness.missing_live_inputs,
      output: path.resolve(flags.output)
    }, null, 2));
    return;
  }

  if (command === "discover-revit-demo") {
    await discoverRevitDemo(flags.output);
    return;
  }

  if (command === "hydrate-redline-add-family-instance-types") {
    await hydrateRedlineAddFamilyInstanceTypesCommand(flags);
    return;
  }

  if (command === "hydrate-redline-add-tag-types") {
    await hydrateRedlineAddTagTypesCommand(flags);
    return;
  }

  if (command === "hydrate-redline-filter-rule-types") {
    hydrateRedlineFilterRuleTypesCommand(flags);
    return;
  }

  if (command === "hydrate-redline-type-change-types") {
    await hydrateRedlineTypeChangeTypesCommand(flags);
    return;
  }

  if (command === "validate-revit-requests") {
    validateRevitRequests(flags.input);
    return;
  }

  if (command === "run") {
    const taskIds =
      flags["all-tasks"] === true
        ? tasks.map((task) => task.task_id)
        : flagList(flags, "tasks").length > 0
          ? flagList(flags, "tasks")
          : typeof flags.task === "string"
            ? [flags.task]
            : [];
    const configIds =
      flags["all-configs"] === true
        ? bundle.configs.map((config) => config.id)
        : flagList(flags, "configs").length > 0
          ? flagList(flags, "configs")
          : typeof flags.config === "string"
            ? [flags.config]
            : [];
    if (taskIds.length === 0 || configIds.length === 0) throw new Error("run requires at least one task and one config.");

    if (flags["skip-revit-preflight"] !== true && selectedTasksNeedLiveRevitPreflight({ taskIds, allTasks: tasks, useMocksEnv: process.env.OPERATOR_BENCHMARK_USE_MOCKS })) {
      const requestOverridesByTaskId = loadPreflightRequestOverridesByTaskId(undefined, taskIds);
      const textNoteReplaceProbeRequest = textNoteReplaceDryRunProbeRequest({ taskIds, allTasks: tasks, requestOverridesByTaskId });
      const report = await runRevitPreflightReport(
        requiredLiveRevitEndpointPaths({ taskIds, allTasks: tasks, requestOverridesByTaskId }),
        selectedTasksRequireWriteGrant({ taskIds, allTasks: tasks, requestOverridesByTaskId }),
        textNoteReplaceProbeRequest
      );
      if (!report.ok) {
        console.log(JSON.stringify(report, null, 2));
        throw new Error("Live Revit benchmark preflight failed. Fix the bridge or pass --skip-revit-preflight only for intentional failure testing.");
      }
      process.env.REVIT_BRIDGE_URL = report.bridge_url;
    }

    const repeatCount = Math.max(1, Number.parseInt(String(flags.repeat ?? "1"), 10) || 1);
    const result = await runBenchmarkBatch({
      batch_id: typeof flags["batch-id"] === "string" ? flags["batch-id"] : undefined,
      artifacts_root: typeof flags["artifacts-dir"] === "string" ? flags["artifacts-dir"] : undefined,
      task_ids: taskIds,
      config_ids: configIds,
      repeat_count: repeatCount,
      resume: flags.resume === true
    });
    console.log(`Batch manifest: ${result.batch_manifest_path}`);
    console.log(`Report: ${result.report_path}`);
    console.log(`Grading sheet: ${result.grading_sheet_path}`);
    return;
  }

  if (command === "default-plan") {
    if (flags["skip-revit-preflight"] !== true && selectedTasksNeedLiveRevitPreflight({ taskIds: bundle.default_phase1_task_ids, allTasks: tasks, useMocksEnv: process.env.OPERATOR_BENCHMARK_USE_MOCKS })) {
      const requestOverridesByTaskId = loadPreflightRequestOverridesByTaskId(undefined, bundle.default_phase1_task_ids);
      const report = await runRevitPreflightReport(
        requiredLiveRevitEndpointPaths({ taskIds: bundle.default_phase1_task_ids, allTasks: tasks, requestOverridesByTaskId }),
        selectedTasksRequireWriteGrant({ taskIds: bundle.default_phase1_task_ids, allTasks: tasks, requestOverridesByTaskId })
      );
      if (!report.ok) {
        console.log(JSON.stringify(report, null, 2));
        throw new Error("Live Revit benchmark preflight failed. Fix the bridge or pass --skip-revit-preflight only for intentional failure testing.");
      }
      process.env.REVIT_BRIDGE_URL = report.bridge_url;
    }

    const result = await runDefaultExperimentPlan({
      batch_id: typeof flags["batch-id"] === "string" ? flags["batch-id"] : undefined,
      artifacts_root: typeof flags["artifacts-dir"] === "string" ? flags["artifacts-dir"] : undefined,
      include_broader_phase: flags["include-broader-phase"] === true,
      resume: flags.resume === true
    });
    console.log(`Phase 1 report: ${result.phase1_batch.report_path}`);
    if (result.phase2_batch) console.log(`Phase 2 report: ${result.phase2_batch.report_path}`);
    return;
  }

  if (command === "report") {
    const artifactsDir = typeof flags["artifacts-dir"] === "string" ? flags["artifacts-dir"] : "";
    if (!artifactsDir) throw new Error("report requires --artifacts-dir.");
    const output = typeof flags.output === "string" ? flags.output : undefined;
    const result = writeBenchmarkReportArtifacts(artifactsDir, bundle, output);
    console.log(`Report markdown: ${result.markdown_path}`);
    console.log(`Report json: ${result.json_path}`);
    return;
  }

  if (command === "demo-readiness") {
    const artifactsDir = typeof flags["artifacts-dir"] === "string" ? flags["artifacts-dir"] : "";
    if (!artifactsDir) throw new Error("demo-readiness requires --artifacts-dir.");
    const result = writeBenchmarkReportArtifacts(artifactsDir, bundle);
    const passed = result.report.demo_readiness_gates.length > 0 && result.report.demo_readiness_gates.every((entry) => entry.passed);
    console.log(JSON.stringify({
      ok: passed,
      report: result.markdown_path,
      gates: result.report.demo_readiness_gates
    }, null, 2));
    if (!passed) process.exitCode = 1;
    return;
  }

  if (command === "grade-sheet") {
    const artifactsDir = typeof flags["artifacts-dir"] === "string" ? flags["artifacts-dir"] : "";
    if (!artifactsDir) throw new Error("grade-sheet requires --artifacts-dir.");
    const output = typeof flags.output === "string" ? flags.output : undefined;
    const csvPath = exportManualGradingSheet(artifactsDir, output);
    console.log(`Manual grading sheet: ${csvPath}`);
    return;
  }

  throw new Error(`Unknown benchmark command '${command}'.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
