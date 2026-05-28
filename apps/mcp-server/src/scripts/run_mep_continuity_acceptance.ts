import fs from "node:fs";
import path from "node:path";
import { callRevit } from "../lib/revitClient.js";

type Scenario = {
  name: string;
  request: Record<string, unknown>;
  assertions: {
    requirePostConditionOk?: boolean;
    maxOpenConnectors?: number;
    maxDisconnectedTouched?: number;
    maxContinuityOverlaps?: number;
  };
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const k = a.slice(2).trim();
    const next = argv[i + 1] ?? "";
    if (!k) continue;
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function firstNumber(obj: any, paths: string[]): number | null {
  for (const p of paths) {
    const parts = p.split(".");
    let cur: any = obj;
    let ok = true;
    for (const part of parts) {
      if (!cur || typeof cur !== "object" || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (!ok) continue;
    if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  }
  return null;
}

function firstBoolean(obj: any, paths: string[]): boolean | null {
  for (const p of paths) {
    const parts = p.split(".");
    let cur: any = obj;
    let ok = true;
    for (const part of parts) {
      if (!cur || typeof cur !== "object" || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (!ok) continue;
    if (typeof cur === "boolean") return cur;
  }
  return null;
}

function resolveScenarioPath(input: string): string {
  if (path.isAbsolute(input)) return input;
  return path.resolve(process.cwd(), input);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarioArg = typeof args.scenario === "string" ? args.scenario : "mcp-server/eval/scenarios/mep_resize_room_301_supply_8_to_10.json";
  const scenarioPath = resolveScenarioPath(scenarioArg);
  if (!fs.existsSync(scenarioPath)) throw new Error(`Scenario file not found: ${scenarioPath}`);

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as Scenario;
  if (!scenario || !scenario.request || !scenario.assertions) throw new Error(`Invalid scenario: ${scenarioPath}`);

  console.log(`Running acceptance scenario: ${scenario.name}`);
  console.log(`Scenario file: ${scenarioPath}`);

  const res = await callRevit<any>("/revit/resize-ductwork-by-scope", "POST", scenario.request);

  const failures: string[] = [];
  const checks: string[] = [];

  if (scenario.assertions.requirePostConditionOk) {
    const ok = firstBoolean(res, ["postCondition.ok", "continuityAudit.ok", "verify.ok"]);
    checks.push(`postConditionOk=${String(ok)}`);
    if (ok !== true) failures.push("postCondition.ok was not true");
  }

  if (Number.isFinite(scenario.assertions.maxOpenConnectors)) {
    const actual = firstNumber(res, [
      "continuityAudit.openConnectorCount",
      "counts.continuityOpenConnectors",
      "postCondition.openConnectorCount"
    ]);
    checks.push(`openConnectors=${actual === null ? "n/a" : actual}`);
    if (actual === null || actual > Number(scenario.assertions.maxOpenConnectors)) {
      failures.push(`open connectors exceeded threshold (${actual} > ${scenario.assertions.maxOpenConnectors})`);
    }
  }

  if (Number.isFinite(scenario.assertions.maxDisconnectedTouched)) {
    const actual = firstNumber(res, [
      "continuityAudit.disconnectedTouchedCount",
      "counts.continuityDisconnectedTouched",
      "postCondition.disconnectedTouchedCount"
    ]);
    checks.push(`disconnectedTouched=${actual === null ? "n/a" : actual}`);
    if (actual === null || actual > Number(scenario.assertions.maxDisconnectedTouched)) {
      failures.push(`disconnected touched exceeded threshold (${actual} > ${scenario.assertions.maxDisconnectedTouched})`);
    }
  }

  if (Number.isFinite(scenario.assertions.maxContinuityOverlaps)) {
    const actual = firstNumber(res, [
      "continuityAudit.overlapCount",
      "postCondition.overlapCount",
      "counts.continuityOverlaps"
    ]);
    checks.push(`continuityOverlaps=${actual === null ? "n/a" : actual}`);
    if (actual === null || actual > Number(scenario.assertions.maxContinuityOverlaps)) {
      failures.push(`continuity overlaps exceeded threshold (${actual} > ${scenario.assertions.maxContinuityOverlaps})`);
    }
  }

  console.log("Checks:");
  for (const c of checks) console.log(`- ${c}`);

  if (failures.length > 0) {
    console.error("Acceptance FAILED:");
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
    return;
  }

  console.log("Acceptance PASSED.");
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Acceptance run failed: ${msg}`);
  process.exitCode = 1;
});
