import fs from "node:fs";
import path from "node:path";

function installedRuntimeRoot(year: string, env: NodeJS.ProcessEnv): string | null {
  const machineRoot = year === "2027" ? env.ProgramFiles ?? env.PROGRAMFILES : env.ProgramData ?? env.PROGRAMDATA;
  const roots = [env.APPDATA, machineRoot].filter((root): root is string => Boolean(root))
    .map(root => path.join(root, "Autodesk", "Revit", "Addins", year));
  const manifest = roots.map(root => path.join(root, "RevitBridge.addin"))
    .find(candidate => fs.existsSync(candidate));
  if (!manifest) return env.APPDATA ? path.join(roots[0]!, "RevitOperator", "dynamic-runtime") : null;

  // Follow the installed add-in's release. A leftover per-user runtime from
  // a previous installer cannot authenticate against a different Revit host.
  const xml = fs.readFileSync(manifest, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const applications = [...xml.matchAll(/<AddIn\s+Type=["']Application["']\s*>([\s\S]*?)<\/AddIn>/gi)];
  const operator = applications.filter(([, block]) => /<Name>\s*RevitOperator\s*<\/Name>/i.test(block!)
    && /<FullClassName>\s*RevitBridge\.App\s*<\/FullClassName>/i.test(block!)
    && /<AddInId>\s*B2883307-2852-4740-9833-281048674F77\s*<\/AddInId>/i.test(block!));
  const assembly = operator.length === 1 ? operator[0]![1]!.match(/<Assembly>\s*([^<>]+?)\s*<\/Assembly>/i)?.[1]
    ?.replace(/&quot;/g, "\"").replace(/&amp;/g, "&") : null;
  if (!assembly || !path.isAbsolute(assembly) || path.basename(assembly).toLowerCase() !== "revitbridge.dll"
    || !fs.statSync(assembly, {throwIfNoEntry:false})?.isFile()) {
    throw new Error("The registered RevitOperator add-in manifest could not identify its installed release. Repair the installation before running generated Revit code.");
  }
  return path.join(path.dirname(assembly), "dynamic-runtime");
}

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
  const installed = !configuredSupervisor && platform === "win32" ? installedRuntimeRoot(year, env) : null;
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
