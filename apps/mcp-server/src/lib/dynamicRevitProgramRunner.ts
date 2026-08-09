import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspaceRoot } from "./workspace.js";

export const DYNAMIC_REVIT_PROGRAM_RUN_V1 = "revit-operator.dynamic-revit-program-run.v1" as const;

export type DynamicRevitProgramRunInput = {
  source: string;
  mode: "preview" | "apply";
  target_revit_year?: "2023" | "2024" | "2025";
  category?: string;
  parameters?: string[];
  snapshot_limit?: number;
  operation_budget?: number;
  worker_deadline_ms?: number;
  apply_deadline_ms?: number;
};

type Executor = (file: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Local/development only. The bridge independently enforces its exact laboratory-mode gate and write authority. */
export async function runDynamicRevitProgram(input: DynamicRevitProgramRunInput, env: NodeJS.ProcessEnv = process.env, execute: Executor = executeFile) {
  const mode = (env.REVIT_OPERATOR_MODE || "development").trim().toLowerCase();
  if (!new Set(["local", "development", "self_hosted"]).has(mode)) throw new Error("Dynamic Revit program execution is unavailable outside local/development/self-hosted mode.");
  if (!input || typeof input.source !== "string" || input.source.length < 1 || input.source.length > 200_000 || input.source.includes("\0")) throw new Error("Dynamic Revit program source is invalid or exceeds 200,000 characters.");
  if (input.mode !== "preview" && input.mode !== "apply") throw new Error("Dynamic Revit program mode must be preview or apply.");
  if (input.category !== undefined && !/^OST_[A-Za-z0-9_]{1,120}$/.test(input.category)) throw new Error("Dynamic snapshot category must be a bounded BuiltInCategory token.");
  const parameters = input.parameters ?? [];
  if (!Array.isArray(parameters) || parameters.length > 16 || parameters.some(value => typeof value !== "string" || value.length < 1 || value.length > 128)) throw new Error("Dynamic snapshot parameters are invalid.");
  const supervisor = requiredFile(env.OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH, "OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH");
  const workerDirectory = requiredDirectory(env.OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY, "OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY");
  const tokenFile = requiredFile(env.OPERATOR_TOKEN_FILE, "OPERATOR_TOKEN_FILE");
  const year = input.target_revit_year ?? boundedYear(env.OPERATOR_DYNAMIC_RUNTIME_REVIT_YEAR || "2024");
  const runId = `dynamic-${randomUUID().replaceAll("-", "")}`;
  const runRoot = path.join(getWorkspaceRoot(), "artifacts", "dynamic-runtime-runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const sourceFile = path.join(runRoot, "program.cs"); const configFile = path.join(runRoot, "task.json"); const evidenceFile = path.join(runRoot, "evidence.json");
  fs.writeFileSync(sourceFile, input.source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const config = {
    workerDirectory, evidencePath: evidenceFile, bridgeUrl: env.OPERATOR_REVIT_URL || "http://127.0.0.1:5000",
    operatorTokenFile: tokenFile, sourceFile, targetRevitYear: year, category: input.category ?? null,
    limit: boundedInteger(input.snapshot_limit, 1, 1000, 200), parameters, operationBudget: boundedInteger(input.operation_budget, 1, 256, 32),
    workerDeadlineMs: boundedInteger(input.worker_deadline_ms, 1000, 60_000, 15_000), apply: input.mode === "apply",
    applyDeadlineMs: boundedInteger(input.apply_deadline_ms, 100, 5000, 5000)
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const execution = await execute(supervisor, ["--execute-task", configFile], Math.max(config.workerDeadlineMs + 90_000, 120_000));
  if (!fs.existsSync(evidenceFile)) throw new Error(`Dynamic supervisor returned ${execution.exitCode} without bounded evidence: ${execution.stderr.slice(0, 2000)}`);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8")) as Record<string, unknown>;
  return {
    schema: DYNAMIC_REVIT_PROGRAM_RUN_V1, run_id: runId, requested_mode: input.mode, execution_ok: execution.exitCode === 0 && evidence.ok === true,
    evidence: { ...evidence, taskDirectory: "opaque:trusted-task", runtimeImageDirectory: "opaque:trusted-runtime" },
    diagnostics: execution.exitCode === 0 ? undefined : execution.stderr.slice(0, 4000)
  };
}

function executeFile(file: string, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0, stdout, stderr })));
}
function requiredFile(value: string | undefined, label: string): string { const resolved = value ? path.resolve(value) : ""; if (!resolved || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`${label} must identify an existing trusted file.`); return resolved; }
function requiredDirectory(value: string | undefined, label: string): string { const resolved = value ? path.resolve(value) : ""; if (!resolved || !fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} must identify an existing trusted directory.`); return resolved; }
function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error("Dynamic runtime numeric bound is invalid."); return result; }
function boundedYear(value: string): "2023" | "2024" | "2025" { if (value !== "2023" && value !== "2024" && value !== "2025") throw new Error("Dynamic runtime Revit year must be 2023, 2024, or 2025."); return value; }
