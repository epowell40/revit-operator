import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot, writeJsonFile } from "./files.js";
import { collectLocalRevitHostEvidence } from "./revit_host_evidence.js";
import type { RevitHostEvidence } from "./revit_preflight.js";

export type RevitAddinManifestDiagnostic = {
  path: string;
  active: boolean;
  exists: boolean;
  assembly_path?: string;
  assembly_exists?: boolean;
  assembly_sha256?: string;
  assembly_last_write_time?: string;
  parse_error?: string;
};

export type RevitAddinRootDiagnostic = {
  path: string;
  exists: boolean;
  directory_write_access?: boolean;
  program_data_root: boolean;
  active_addin_count: number;
  active_addin_names: string[];
  revit_bridge_manifest_exists: boolean;
  isolation_note?: string;
};

export type RevitJournalDiagnostic = {
  path: string;
  last_write_time?: string;
  size_bytes?: number;
  interesting_lines: string[];
};

export type RevitStartupDiagnostics = {
  schema_version: 1;
  checked_at: string;
  platform: string;
  revit_year: string;
  diagnosis:
    | "ok"
    | "not_windows"
    | "addin_manifest_missing"
    | "addin_assembly_missing"
    | "duplicate_active_manifest_risk"
    | "revit_clr_startup_crash"
    | "revit_startup_crash"
    | "host_modal_blocker"
    | "bridge_not_running";
  message: string;
  addin_roots: string[];
  addin_root_diagnostics?: RevitAddinRootDiagnostic[];
  manifests: RevitAddinManifestDiagnostic[];
  all_active_addin_manifests?: RevitAddinManifestDiagnostic[];
  active_manifest_count: number;
  revit_bridge_manifest_active?: boolean;
  inactive_revit_bridge_manifest_count?: number;
  crash_without_active_revit_bridge_manifest?: boolean;
  all_active_addin_count?: number;
  deployed_assembly_path?: string;
  deployed_assembly_sha256?: string;
  operator_client_config?: {
    path: string;
    exists: boolean;
    backend_url?: string;
    backend_autostart?: boolean;
    auth_mode?: string;
    parse_error?: string;
  };
  host_evidence?: RevitHostEvidence;
  latest_revit_crash?: NonNullable<RevitHostEvidence["recent_crash_events"]>[number];
  latest_revit_journals?: RevitJournalDiagnostic[];
  next_steps: string[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sha256File(filePath: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
  } catch {
    return undefined;
  }
}

function fileLastWriteIso(filePath: string): string | undefined {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function fileSizeBytes(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function extractAssemblyPath(manifestPath: string): string | undefined {
  const xml = fs.readFileSync(manifestPath, "utf8");
  const match = xml.match(/<Assembly>\s*([^<]+?)\s*<\/Assembly>/i);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(manifestPath), raw);
}

function manifestDiagnostic(manifestPath: string, active: boolean): RevitAddinManifestDiagnostic {
  const diagnostic: RevitAddinManifestDiagnostic = {
    path: manifestPath,
    active,
    exists: fs.existsSync(manifestPath)
  };
  if (!diagnostic.exists) return diagnostic;
  try {
    const assemblyPath = extractAssemblyPath(manifestPath);
    if (assemblyPath) {
      diagnostic.assembly_path = assemblyPath;
      diagnostic.assembly_exists = fs.existsSync(assemblyPath);
      if (diagnostic.assembly_exists) {
        diagnostic.assembly_sha256 = sha256File(assemblyPath);
        diagnostic.assembly_last_write_time = fileLastWriteIso(assemblyPath);
      }
    }
  } catch (error) {
    diagnostic.parse_error = error instanceof Error ? error.message : String(error);
  }
  return diagnostic;
}

function listActiveAddinManifests(addinRoots: string[]): RevitAddinManifestDiagnostic[] {
  const manifests: RevitAddinManifestDiagnostic[] = [];
  for (const root of addinRoots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (!/\.addin$/i.test(entry)) continue;
      manifests.push(manifestDiagnostic(path.join(root, entry), true));
    }
  }
  return manifests.sort((a, b) => a.path.localeCompare(b.path));
}

function canWriteDirectory(directoryPath: string): boolean | undefined {
  if (!fs.existsSync(directoryPath)) return undefined;
  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isProgramDataRoot(root: string): boolean {
  const programData = envPath("ProgramData") ?? "C:\\ProgramData";
  const relative = path.relative(programData, root);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildAddinRootDiagnostics(addinRoots: string[]): RevitAddinRootDiagnostic[] {
  return addinRoots.map((root) => {
    const exists = fs.existsSync(root);
    const activeAddinNames = exists
      ? fs.readdirSync(root).filter((entry) => /\.addin$/i.test(entry)).sort((a, b) => a.localeCompare(b))
      : [];
    return {
      path: root,
      exists,
      directory_write_access: canWriteDirectory(root),
      program_data_root: isProgramDataRoot(root),
      active_addin_count: activeAddinNames.length,
      active_addin_names: activeAddinNames,
      revit_bridge_manifest_exists: fs.existsSync(path.join(root, "RevitBridge.addin")),
      isolation_note: isProgramDataRoot(root) && activeAddinNames.length > 0
        ? "ProgramData add-in isolation may require an elevated shell even when directory write access appears available."
        : undefined
    };
  });
}

function defaultRevitJournalRoot(revitYear: string): string | undefined {
  const localAppData = envPath("LOCALAPPDATA");
  if (!localAppData) return undefined;
  return path.join(localAppData, "Autodesk", "Revit", `Autodesk Revit ${revitYear}`, "Journals");
}

function readInterestingJournalLines(journalPath: string): string[] {
  const text = fs.readFileSync(journalPath, "utf8");
  const pattern = /API_ERROR|Assembly version conflict|Starting External|Added pushbutton|Replacing command|RevitBridge|ClashPilot|Rushforth|Jrn\.Command|DBG_(?:WARN|ERROR|INFO)|Exception|crash|error|Snowdon/i;
  const matches = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => pattern.test(line));
  if (matches.length <= 120) return matches;
  const selected = [...matches.slice(0, 60), ...matches.slice(-60)];
  return selected.filter((line, index) => selected.indexOf(line) === index);
}

function buildRevitJournalDiagnostics(revitYear: string, journalRoot = defaultRevitJournalRoot(revitYear)): RevitJournalDiagnostic[] {
  if (!journalRoot || !fs.existsSync(journalRoot)) return [];
  return fs.readdirSync(journalRoot)
    .filter((entry) => /^journal\.\d+\.txt$/i.test(entry))
    .map((entry) => path.join(journalRoot, entry))
    .sort((a, b) => (fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs))
    .slice(0, 3)
    .map((journalPath) => ({
      path: journalPath,
      last_write_time: fileLastWriteIso(journalPath),
      size_bytes: fileSizeBytes(journalPath),
      interesting_lines: readInterestingJournalLines(journalPath)
    }));
}

function latestRevitCrash(evidence: RevitHostEvidence | undefined): NonNullable<RevitHostEvidence["recent_crash_events"]>[number] | undefined {
  const events = evidence?.recent_crash_events ?? [];
  const revitEvents = events.filter((event) => {
    const text = `${event.provider_name ?? ""}\n${event.message ?? ""}`.toLowerCase();
    return text.includes("revit.exe") || text.includes("application: revit.exe");
  });
  return revitEvents.find((event) => event.faulting_module || event.exception_code || event.exit_code) ?? revitEvents[0];
}

function firstBlockingModal(evidence: RevitHostEvidence | undefined): string | undefined {
  return (evidence?.modal_windows ?? [])
    .map((entry) => entry.title.trim())
    .find((title) => title && !/^autodesk revit\b/i.test(title));
}

function readOperatorClientConfig(): RevitStartupDiagnostics["operator_client_config"] | undefined {
  const localAppData = envPath("LOCALAPPDATA");
  if (!localAppData) return undefined;
  const configPath = path.join(localAppData, "RevitOperator", "config", "operator-client.json");
  const result: NonNullable<RevitStartupDiagnostics["operator_client_config"]> = {
    path: configPath,
    exists: fs.existsSync(configPath)
  };
  if (!result.exists) return result;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof config.backend_url === "string") result.backend_url = config.backend_url;
    if (typeof config.backend_autostart === "boolean") result.backend_autostart = config.backend_autostart;
    if (typeof config.auth_mode === "string") result.auth_mode = config.auth_mode;
  } catch (error) {
    result.parse_error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function buildNextSteps(diagnosis: RevitStartupDiagnostics["diagnosis"]): string[] {
  if (diagnosis === "revit_clr_startup_crash" || diagnosis === "revit_startup_crash") {
    return [
      "Do not run live redline benchmarks or promote live evidence until Revit starts with the Operator add-in loaded.",
      "Compare the deployed RevitBridge.dll hash and manifest path against the last known working bundle.",
      "Inspect the latest Windows Application and .NET Runtime events plus the Revit journal for the add-in startup call stack.",
      "After the crash is fixed, rerun revit-startup-diagnostics and preflight-revit, then rerun the known passing Snowdon smoke tasks."
    ];
  }
  if (diagnosis === "duplicate_active_manifest_risk") {
    return [
      "Disable duplicate active RevitBridge.addin manifests outside the intended per-user Addins folder.",
      "Reinstall the selected drop-in bundle with scripts/deploy/install_revit_dropin_bundle.ps1.",
      "Restart Revit and rerun preflight-revit before live redline tests."
    ];
  }
  if (diagnosis === "addin_assembly_missing" || diagnosis === "addin_manifest_missing") {
    return [
      "Build and install a Revit drop-in bundle for the target year.",
      "Confirm the active RevitBridge.addin points to an existing RevitBridge.dll.",
      "Start Revit and rerun preflight-revit."
    ];
  }
  if (diagnosis === "host_modal_blocker") {
    return [
      "Resolve the blocking Revit modal dialog without applying unintended model changes.",
      "Confirm the target model remains open and the Operator add-in is loaded.",
      "Rerun preflight-revit before any mutating live benchmark."
    ];
  }
  return [
    "Start Revit with the target model and Operator add-in loaded.",
    "Run npm run benchmark -- preflight-revit --summary before any live redline benchmark.",
    "If preflight passes, rerun the known passing Snowdon smoke tasks before new live workflows."
  ];
}

export function buildRevitStartupDiagnostics(args: {
  revitYear?: string;
  hostEvidence?: RevitHostEvidence;
  checkedAt?: string;
  journalRoot?: string;
  addinRoots?: string[];
} = {}): RevitStartupDiagnostics {
  const revitYear = String(args.revitYear ?? "2024").trim() || "2024";
  const hostEvidence = args.hostEvidence ?? collectLocalRevitHostEvidence();
  // Tests and offline evidence review may supply a captured Windows host report
  // while running on another OS. Prefer that evidence platform when present;
  // live calls still use collectLocalRevitHostEvidence()/os.platform().
  const platform = hostEvidence?.platform || os.platform();
  const addinRoots = args.addinRoots ?? (platform === "win32"
    ? [
      path.join(envPath("APPDATA") ?? "", "Autodesk", "Revit", "Addins", revitYear),
      path.join(envPath("ProgramData") ?? "C:\\ProgramData", "Autodesk", "Revit", "Addins", revitYear)
    ].filter((entry) => entry && path.isAbsolute(entry))
    : []);
  const manifests: RevitAddinManifestDiagnostic[] = [];
  const allActiveAddinManifests = listActiveAddinManifests(addinRoots);
  const addinRootDiagnostics = buildAddinRootDiagnostics(addinRoots);
  const latestRevitJournals = platform === "win32" ? buildRevitJournalDiagnostics(revitYear, args.journalRoot) : [];
  for (const root of addinRoots) {
    const activePath = path.join(root, "RevitBridge.addin");
    manifests.push(manifestDiagnostic(activePath, true));
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (!/^RevitBridge\.addin\./i.test(entry)) continue;
        manifests.push(manifestDiagnostic(path.join(root, entry), false));
      }
    }
  }
  const activeManifests = manifests.filter((entry) => entry.active && entry.exists);
  const inactiveRevitBridgeManifestCount = manifests.filter((entry) => !entry.active && entry.exists).length;
  const primary = activeManifests.find((entry) => entry.assembly_exists) ?? activeManifests[0];
  const latestCrash = latestRevitCrash(hostEvidence);
  const blockingModal = firstBlockingModal(hostEvidence);
  const activeManifestCount = activeManifests.length;
  const crashWithoutActiveRevitBridgeManifest = Boolean(latestCrash && activeManifestCount === 0);
  let diagnosis: RevitStartupDiagnostics["diagnosis"] = "ok";
  let message = "No Revit startup blocker was detected in local diagnostics.";

  if (platform !== "win32") {
    diagnosis = "not_windows";
    message = "Revit startup diagnostics are only available on Windows.";
  } else if (latestCrash?.faulting_module?.toLowerCase() === "clr.dll" && latestCrash.exception_code?.toLowerCase() === "0xc0000005") {
    diagnosis = "revit_clr_startup_crash";
    message = crashWithoutActiveRevitBridgeManifest
      ? "Recent Windows Application evidence shows Revit crashed in clr.dll while no active RevitBridge.addin manifest was present."
      : "Recent Windows Application evidence shows Revit crashed in clr.dll before the bridge became ready.";
  } else if (latestCrash) {
    diagnosis = "revit_startup_crash";
    message = crashWithoutActiveRevitBridgeManifest
      ? "Recent Windows Application evidence shows Revit crashed while no active RevitBridge.addin manifest was present."
      : "Recent Windows Application evidence shows Revit crashed before the bridge became ready.";
  } else if (blockingModal) {
    diagnosis = "host_modal_blocker";
    message = `Revit appears blocked by a modal window: ${blockingModal}.`;
  } else if (activeManifestCount === 0) {
    diagnosis = "addin_manifest_missing";
    message = `No active RevitBridge.addin manifest was found for Revit ${revitYear}.`;
  } else if (activeManifestCount > 1) {
    diagnosis = "duplicate_active_manifest_risk";
    message = `Multiple active RevitBridge.addin manifests were found for Revit ${revitYear}.`;
  } else if (!primary?.assembly_exists) {
    diagnosis = "addin_assembly_missing";
    message = "The active RevitBridge.addin manifest does not point to an existing RevitBridge.dll.";
  } else if ((hostEvidence?.revit_processes ?? []).length === 0) {
    diagnosis = "bridge_not_running";
    message = "The add-in manifest and assembly are present, but no Revit process is currently running.";
  }

  return {
    schema_version: 1,
    checked_at: args.checkedAt ?? isoNow(),
    platform,
    revit_year: revitYear,
    diagnosis,
    message,
    addin_roots: addinRoots,
    addin_root_diagnostics: addinRootDiagnostics,
    manifests,
    all_active_addin_manifests: allActiveAddinManifests,
    active_manifest_count: activeManifestCount,
    revit_bridge_manifest_active: activeManifestCount > 0,
    inactive_revit_bridge_manifest_count: inactiveRevitBridgeManifestCount,
    crash_without_active_revit_bridge_manifest: crashWithoutActiveRevitBridgeManifest || undefined,
    all_active_addin_count: allActiveAddinManifests.length,
    deployed_assembly_path: primary?.assembly_path,
    deployed_assembly_sha256: primary?.assembly_sha256,
    operator_client_config: readOperatorClientConfig(),
    host_evidence: hostEvidence,
    latest_revit_crash: latestCrash,
    latest_revit_journals: latestRevitJournals,
    next_steps: buildNextSteps(diagnosis)
  };
}

export function renderRevitStartupDiagnosticsMarkdown(report: RevitStartupDiagnostics): string {
  const lines: string[] = [
    "# Revit Startup Diagnostics",
    "",
    `- Checked: ${report.checked_at}`,
    `- Revit year: ${report.revit_year}`,
    `- Diagnosis: ${report.diagnosis}`,
    `- Message: ${report.message}`,
    `- Active manifest count: ${report.active_manifest_count}`,
    `- RevitBridge manifest active: ${report.revit_bridge_manifest_active === true ? "yes" : "no"}`,
    `- Inactive RevitBridge manifest count: ${report.inactive_revit_bridge_manifest_count ?? 0}`,
    `- Crash without active RevitBridge manifest: ${report.crash_without_active_revit_bridge_manifest === true ? "yes" : "no"}`,
    `- All active .addin count: ${report.all_active_addin_count ?? "(not recorded)"}`,
    `- Deployed assembly: ${report.deployed_assembly_path ?? "(none)"}`,
    `- Deployed assembly SHA256: ${report.deployed_assembly_sha256 ?? "(none)"}`,
    ""
  ];
  if (report.latest_revit_crash) {
    lines.push(
      "## Latest Crash",
      "",
      `- Time: ${report.latest_revit_crash.time_created ?? "(unknown)"}`,
      `- Provider: ${report.latest_revit_crash.provider_name ?? "(unknown)"}`,
      `- Event id: ${report.latest_revit_crash.id ?? "(unknown)"}`,
      `- Faulting module: ${report.latest_revit_crash.faulting_module ?? "(unknown)"}`,
      `- Exception code: ${report.latest_revit_crash.exception_code ?? "(unknown)"}`,
      `- Exit code: ${report.latest_revit_crash.exit_code ?? "(unknown)"}`,
      ""
    );
  }
  if (report.addin_root_diagnostics?.length) {
    lines.push("", "## Add-in Roots", "", "| Exists | Directory Write Access | ProgramData | Active .addin Count | RevitBridge.addin | Path | Active .addin Names | Note |", "|---:|---:|---:|---:|---:|---|---|---|");
    for (const root of report.addin_root_diagnostics) {
      lines.push(`| ${root.exists ? "yes" : "no"} | ${root.directory_write_access === true ? "yes" : root.directory_write_access === false ? "no" : ""} | ${root.program_data_root ? "yes" : "no"} | ${root.active_addin_count} | ${root.revit_bridge_manifest_exists ? "yes" : "no"} | ${root.path} | ${root.active_addin_names.join(", ")} | ${root.isolation_note ?? ""} |`);
    }
  }
  if (report.latest_revit_journals?.length) {
    lines.push("", "## Latest Revit Journals", "");
    for (const journal of report.latest_revit_journals) {
      lines.push(
        `### ${path.basename(journal.path)}`,
        "",
        `- Path: ${journal.path}`,
        `- Last write: ${journal.last_write_time ?? "(unknown)"}`,
        `- Size bytes: ${journal.size_bytes ?? "(unknown)"}`,
        "",
        "```text",
        ...journal.interesting_lines.slice(-40),
        "```",
        ""
      );
    }
  }
  lines.push("## Manifests", "", "| Active | Exists | Assembly Exists | Path | Assembly | SHA256 |", "|---|---:|---:|---|---|---|");
  for (const manifest of report.manifests) {
    lines.push(`| ${manifest.active ? "yes" : "no"} | ${manifest.exists ? "yes" : "no"} | ${manifest.assembly_exists === true ? "yes" : manifest.assembly_exists === false ? "no" : ""} | ${manifest.path} | ${manifest.assembly_path ?? ""} | ${manifest.assembly_sha256 ?? ""} |`);
  }
  if (report.all_active_addin_manifests?.length) {
    lines.push("", "## All Active Add-ins", "", "| Exists | Assembly Exists | Path | Assembly | SHA256 |", "|---:|---:|---|---|---|");
    for (const manifest of report.all_active_addin_manifests) {
      lines.push(`| ${manifest.exists ? "yes" : "no"} | ${manifest.assembly_exists === true ? "yes" : manifest.assembly_exists === false ? "no" : ""} | ${manifest.path} | ${manifest.assembly_path ?? ""} | ${manifest.assembly_sha256 ?? ""} |`);
    }
  }
  lines.push("", "## Next Steps", "");
  for (const step of report.next_steps) lines.push(`- ${step}`);
  lines.push("");
  return lines.join("\n");
}

export function writeRevitStartupDiagnostics(args: {
  revitYear?: string;
  outputDir?: string;
  hostEvidence?: RevitHostEvidence;
} = {}): { report: RevitStartupDiagnostics; json_path: string; markdown_path: string } {
  const outputDir = args.outputDir ?? path.join(repoRoot(), "local-work", "redline-hardening-eval", "revit-startup-diagnostics");
  fs.mkdirSync(outputDir, { recursive: true });
  const report = buildRevitStartupDiagnostics({ revitYear: args.revitYear, hostEvidence: args.hostEvidence });
  const jsonPath = path.join(outputDir, "revit_startup_diagnostics.json");
  const markdownPath = path.join(outputDir, "revit_startup_diagnostics.md");
  writeJsonFile(jsonPath, report);
  fs.writeFileSync(markdownPath, renderRevitStartupDiagnosticsMarkdown(report), "utf8");
  return { report, json_path: jsonPath, markdown_path: markdownPath };
}
