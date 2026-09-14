import fs from "node:fs";
import path from "node:path";

/** Locate an installed package; the native host still verifies its exact identity. */
export function resolveDynamicRuntimeInstallation(
  year: string, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
) {
  if (!["2023", "2024", "2025", "2026", "2027"].includes(year)) throw new Error("Unsupported Dynamic Runtime Revit year.");
  const configuredSupervisor = env.OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH?.trim();
  const configuredWorker = env.OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY?.trim();
  if (Boolean(configuredSupervisor) !== Boolean(configuredWorker)) {
    throw new Error("Configure both OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH and OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY, or use the installed RevitOperator package.");
  }
  const installed = !configuredSupervisor && platform === "win32" && env.APPDATA
    ? path.join(env.APPDATA, "Autodesk", "Revit", "Addins", year, "RevitOperator", "dynamic-runtime") : null;
  const supervisor = configuredSupervisor || (installed ? path.join(installed, "supervisor", "DynamicRevitSandboxSupervisor.exe") : "");
  const workerDirectory = configuredWorker || (installed ? path.join(installed, "worker") : "");
  const tokenFile = env.OPERATOR_TOKEN_FILE?.trim() || path.join(workspaceRoot, "operator_token.txt");
  if (!supervisor || !fs.statSync(supervisor, { throwIfNoEntry: false })?.isFile()
    || !workerDirectory || !fs.statSync(workerDirectory, { throwIfNoEntry: false })?.isDirectory()
    || (installed && !fs.statSync(path.join(workerDirectory, "DynamicRevitWorker.exe"), { throwIfNoEntry: false })?.isFile())) {
    throw new Error(`Generated Revit code requires the installed RevitOperator runtime for Revit ${year} on this MCP workstation. Install the local add-in or configure both runtime paths; discovery does not establish runtime readiness.`);
  }
  if (!fs.statSync(tokenFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Generated Revit code requires the workstation operator_token.txt or an explicit OPERATOR_TOKEN_FILE.");
  }
  return { supervisor: path.resolve(supervisor), workerDirectory: path.resolve(workerDirectory), tokenFile: path.resolve(tokenFile) };
}
