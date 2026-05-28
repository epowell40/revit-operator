import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadBenchmarkConfigBundle } from "../benchmark/config.js";
import { repoRoot, writeJsonFile } from "../benchmark/files.js";
import { exportManualGradingSheet } from "../benchmark/grading.js";
import { writeBenchmarkReportArtifacts } from "../benchmark/report.js";
import { buildRevitDemoDiscoveryPayload } from "../benchmark/revit_discovery.js";
import { selectedTasksNeedLiveRevitPreflight } from "../benchmark/revit_live_guard.js";
import { buildRevitBridgePreflightReport } from "../benchmark/revit_preflight.js";
import { buildRevitBridgeHeaders, resolveRevitBridgeUrl, resolveRevitBridgeUrlCandidates } from "../benchmark/revit_workflows.js";
import { buildRedlineSessionAudit } from "../benchmark/redline_session_audit.js";
import { runRedlineRoutingReadiness } from "../benchmark/redline_routing_readiness.js";
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
    "  npm run benchmark -- preflight-revit",
    "  npm run benchmark -- redline-routing-readiness",
    "  npm run benchmark -- redline-session-audit --session-dir <dir> [--max-tool-calls 25] [--max-assistant-messages 10]",
    "  npm run benchmark -- redline-session-audit --session-id <id> [--max-tool-calls 25] [--max-assistant-messages 10]",
    "  npm run benchmark -- discover-revit-demo [--output <file>]",
    "  npm run benchmark -- default-plan [--include-broader-phase]"
  ].join("\n");
}

async function fetchBridgeJson(pathname: string, method = "GET", body?: unknown, bridgeUrl = resolveRevitBridgeUrl()): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `${bridgeUrl}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: buildRevitBridgeHeaders(),
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) })
  });
  const text = await response.text();
  let parsedBody: unknown = text;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    parsedBody = text;
  }
  return { ok: response.ok, status: response.status, body: parsedBody };
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

  const payload = buildRevitDemoDiscoveryPayload({
    bridgeUrl,
    context: context.body,
    sheetsBody: sheetsResult.body,
    viewsBody: viewsResult.body,
    receptacleFindBody: receptacleFind.body,
    receptacleQuantifyBody: receptacleQuantify.body,
    userProfile: process.env.USERPROFILE
  });
  const tasks = payload.tasks as Record<string, { request?: Record<string, unknown> }>;
  const sheetNumbers = (tasks.demo_sheet_export?.request?.sheetNumbers as unknown[]) ?? [];
  const targetView = (payload._discovery.candidateTargetView ?? {}) as Record<string, unknown>;
  const targetViewId = Number(tasks.demo_redline_receptacles?.request?.viewId ?? 0);
  const redlinePlacements = tasks.demo_redline_receptacles?.request?.placements as Array<Record<string, unknown>> | undefined;
  const exemplarId = Number(redlinePlacements?.[0]?.exemplarElementId ?? 0);

  writeJsonFile(outputPath, payload);
  console.log(`Discovery override skeleton: ${outputPath}`);
  console.log(JSON.stringify({
    ok: true,
    bridge_url: bridgeUrl,
    output: outputPath,
    selected_sheet_numbers: sheetNumbers,
    selected_view: targetView,
    exemplar_element_id: exemplarId || null,
    review_required: !exemplarId || !targetViewId || sheetNumbers.length === 0
  }, null, 2));
}

async function runRevitPreflightReport(): Promise<ReturnType<typeof buildRevitBridgePreflightReport>> {
  let firstReport: ReturnType<typeof buildRevitBridgePreflightReport> | null = null;
  const checkedBridgeUrls = resolveRevitBridgeUrlCandidates();
  for (const bridgeUrl of checkedBridgeUrls) {
    const ping = await fetchBridgeJsonSafe("/revit/ping", "GET", undefined, bridgeUrl);
    const context = await fetchBridgeJsonSafe("/revit/context", "GET", undefined, bridgeUrl);
    const report = buildRevitBridgePreflightReport({
      bridgeUrl,
      checkedBridgeUrls,
      ping,
      context,
      localPortOwner: bridgeUrlLocalPortOwner(bridgeUrl)
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
    context: { ok: false, error: "No bridge URL candidates were available." }
  });
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
    const report = await runRevitPreflightReport();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "redline-routing-readiness") {
    const result = await runRedlineRoutingReadiness();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
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

  if (command === "discover-revit-demo") {
    await discoverRevitDemo(flags.output);
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
      const report = await runRevitPreflightReport();
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
      const report = await runRevitPreflightReport();
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
