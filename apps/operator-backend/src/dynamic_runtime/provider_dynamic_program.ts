import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import type { RecordedExecutionStrategyEvidence } from "../execution_strategy.js";
import { buildTeammateTurnContract } from "../teammate_loop_runtime.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { normalizeProviderSupervisorEvidence } from "./provider_supervisor_evidence.js";
import { computeDynamicRuntimePackageDirectoryIdentity } from "./runtime_package_directory_identity.js";

export const PROVIDER_DYNAMIC_PROGRAM_V1 = "revit-operator.provider-dynamic-program.v1" as const;
export const PROVIDER_DYNAMIC_PROGRAM_EXECUTION_RECEIPT_V1 =
  "revit-operator.provider-dynamic-program-execution-receipt.v1" as const;

const EXACT_PROGRAM_FIELDS = [
  "schema",
  "source",
  "apply",
  "category",
  "parameters",
  "limit",
  "operation_budget",
  "worker_deadline_ms",
  "apply_deadline_ms",
  "target_revit_year"
] as const;

const MAX_SOURCE_UTF8_BYTES = 64 * 1024;
const MAX_SUPERVISOR_OUTPUT_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

export type ProviderDynamicProgramV1 = {
  schema: typeof PROVIDER_DYNAMIC_PROGRAM_V1;
  source: string;
  apply: boolean;
  category: string | null;
  parameters: string[];
  limit: number;
  operation_budget: number;
  worker_deadline_ms: number;
  apply_deadline_ms: number;
  target_revit_year: "2023" | "2024" | "2025";
};

export const PROVIDER_DYNAMIC_PROGRAM_RESPONSE_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [...EXACT_PROGRAM_FIELDS],
  properties: {
    schema: { type: "string", enum: [PROVIDER_DYNAMIC_PROGRAM_V1] },
    source: { type: "string", minLength: 1, maxLength: MAX_SOURCE_UTF8_BYTES },
    apply: { type: "boolean" },
    category: { type: ["string", "null"], minLength: 1, maxLength: 128 },
    parameters: {
      type: "array",
      maxItems: 16,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 }
    },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    operation_budget: { type: "integer", minimum: 1, maximum: 256 },
    worker_deadline_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    apply_deadline_ms: { type: "integer", minimum: 100, maximum: 5000 },
    target_revit_year: { type: "string", enum: ["2023", "2024", "2025"] }
  }
} as const;

export type ProviderDynamicProgramExecutionReceipt = {
  schema: typeof PROVIDER_DYNAMIC_PROGRAM_EXECUTION_RECEIPT_V1;
  status: "completed" | "failed" | "blocked";
  apply_requested: boolean;
  supervisor_exit_code: number | null;
  evidence_path: string | null;
  evidence_sha256: string | null;
  authority: "trusted_supervisor_receipt";
  provider_prose_authorized: false;
  failure: string | null;
  supervisor_executable_sha256?: string | null;
  supervisor_package_sha256?: string | null;
  worker_runtime_package_sha256?: string | null;
  evidence_binding_sha256?: string | null;
  target_revit_year?: "2023" | "2024" | "2025" | null;
};

type SupervisorExecution = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
};

export type TrustedDynamicProgramRunner = (
  req: ChatRequest,
  program: ProviderDynamicProgramV1
) => Promise<ChatResponse>;

export type DynamicProgramRunnerDependencies = {
  env?: NodeJS.ProcessEnv;
  runsSessionsDirectory?: string;
  executeSupervisor?: (
    executable: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
  ) => Promise<SupervisorExecution>;
  beforeSupervisorLaunch?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("dynamic_program must be an object or null");
  const keys = Object.keys(value).sort();
  const expected = [...EXACT_PROGRAM_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("dynamic_program contains unexpected or missing fields");
  }
  return value;
}

function boundedString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`dynamic_program.${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars || normalized.includes("\0")) {
    throw new Error(`dynamic_program.${field} is outside its accepted bounds`);
  }
  return normalized;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`dynamic_program.${field} is outside its accepted bounds`);
  }
  return value as number;
}

export function normalizeProviderDynamicProgram(value: unknown): ProviderDynamicProgramV1 | null {
  if (value === null || value === undefined) return null;
  const raw = exactObject(value);
  if (raw.schema !== PROVIDER_DYNAMIC_PROGRAM_V1) {
    throw new Error(`dynamic_program.schema must be ${PROVIDER_DYNAMIC_PROGRAM_V1}`);
  }
  if (typeof raw.source !== "string" || !raw.source.trim() || raw.source.includes("\0")
    || Buffer.byteLength(raw.source, "utf8") > MAX_SOURCE_UTF8_BYTES) {
    throw new Error("dynamic_program.source must contain 1-65536 UTF-8 bytes");
  }
  if (typeof raw.apply !== "boolean") throw new Error("dynamic_program.apply must be a boolean");
  const category = raw.category === null ? null : boundedString(raw.category, "category", 128);
  if (category !== null && !/^OST_[A-Za-z0-9_]+$/.test(category)) {
    throw new Error("dynamic_program.category must be a BuiltInCategory token");
  }
  if (!Array.isArray(raw.parameters) || raw.parameters.length > 16) {
    throw new Error("dynamic_program.parameters must contain at most 16 strings");
  }
  const parameters = raw.parameters.map((entry, index) =>
    boundedString(entry, `parameters[${index}]`, 128));
  if (new Set(parameters).size !== parameters.length) {
    throw new Error("dynamic_program.parameters must be unique");
  }
  if (raw.target_revit_year !== "2023" && raw.target_revit_year !== "2024" && raw.target_revit_year !== "2025") {
    throw new Error("dynamic_program.target_revit_year is unsupported");
  }
  return {
    schema: PROVIDER_DYNAMIC_PROGRAM_V1,
    source: raw.source,
    apply: raw.apply,
    category,
    parameters,
    limit: boundedInteger(raw.limit, "limit", 1, 1000),
    operation_budget: boundedInteger(raw.operation_budget, "operation_budget", 1, 256),
    worker_deadline_ms: boundedInteger(raw.worker_deadline_ms, "worker_deadline_ms", 1000, 120000),
    apply_deadline_ms: boundedInteger(raw.apply_deadline_ms, "apply_deadline_ms", 100, 5000),
    target_revit_year: raw.target_revit_year
  };
}

export function isTrustedDynamicProgramRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory"
    && env.OPERATOR_DYNAMIC_REVIT_PROGRAM_RUNNER === "enabled"
    && /^sha256:[a-f0-9]{64}$/.test(env.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_EXECUTABLE_SHA256 ?? "")
    && /^sha256:[a-f0-9]{64}$/.test(env.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_DIRECTORY_SHA256 ?? "")
    && /^sha256:[a-f0-9]{64}$/.test(env.OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256 ?? "");
}

export function dynamicProgramProviderPrompt(
  env: NodeJS.ProcessEnv = process.env,
  requestEligible = true
): string {
  if (!requestEligible || !isTrustedDynamicProgramRunnerEnabled(env)) {
    return "Dynamic Revit provider runner: unavailable. Set dynamic_program=null. Selecting dynamic_revit_program does not authorize or dispatch anything.";
  }
  return [
    "Dynamic Revit provider runner: available only through the trusted development laboratory supervisor.",
    `When selected_substrate=dynamic_revit_program, return exactly one ${PROVIDER_DYNAMIC_PROGRAM_V1} value in dynamic_program and leave actions, workbench_actions, web_requests, and dev_actions empty.`,
    "The source is untrusted input. Model prose and strategy telemetry grant no authority; the supervisor owns snapshot, compile, admission, preview, fresh apply authorization, execution, and receipts."
  ].join("\n");
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return segment || "unknown";
}

function assertNoLinkComponents(configured: string, label: string): void {
  const absolute = path.resolve(configured);
  const root = path.parse(absolute).root;
  const relative = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of relative) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink or junction`);
  }
}

function trustedFile(raw: string | undefined, label: string): string {
  const configured = (raw ?? "").trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${label} must be an absolute configured path`);
  assertNoLinkComponents(configured, label);
  const stat = fs.lstatSync(configured);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link file`);
  return fs.realpathSync(configured);
}

function trustedDirectory(raw: string | undefined, label: string): string {
  const configured = (raw ?? "").trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${label} must be an absolute configured path`);
  assertNoLinkComponents(configured, label);
  const stat = fs.lstatSync(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-link directory`);
  return fs.realpathSync(configured);
}

function trustedHashPin(raw: string | undefined, label: string): string {
  const value = (raw ?? "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be an explicit canonical sha256 pin`);
  return value;
}

function stableDirectoryIdentity(directory: string, label: string): string {
  assertNoLinkComponents(directory, label); const stat = fs.statSync(directory, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`${label} must remain a regular directory`);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

type HeldStableRegularFile = { bytes: Buffer; hash: string; fileIdentity: string; descriptor: number; close: () => void };

function holdStableRegularFile(filePath: string, trustedRoot: string, label: string, maximumBytes = 256 * 1024 * 1024,
  expectedRootIdentity?: string): HeldStableRegularFile {
  const relative = path.relative(trustedRoot, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escaped its private trusted root`);
  assertNoLinkComponents(trustedRoot, label); assertNoLinkComponents(filePath, label);
  if (expectedRootIdentity !== undefined && stableDirectoryIdentity(trustedRoot, label) !== expectedRootIdentity) throw new Error(`${label} private root changed before read`);
  let descriptor: number | undefined; let retained = false;
  try {
    descriptor = fs.openSync(filePath, "r");
    const before = fs.fstatSync(descriptor, { bigint: true }); const leafBefore = fs.statSync(filePath, { bigint: true });
    if (!before.isFile() || before.dev !== leafBefore.dev || before.ino !== leafBefore.ino || before.size > BigInt(maximumBytes)) throw new Error(`${label} must remain a bounded regular file`);
    const bytes = fs.readFileSync(descriptor); const after = fs.fstatSync(descriptor, { bigint: true });
    assertNoLinkComponents(filePath, label); const leafAfter = fs.statSync(filePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || BigInt(bytes.length) !== after.size
      || after.dev !== leafAfter.dev || after.ino !== leafAfter.ino) throw new Error(`${label} changed while it was being read`);
    if (expectedRootIdentity !== undefined && stableDirectoryIdentity(trustedRoot, label) !== expectedRootIdentity) throw new Error(`${label} private root changed during read`);
    retained = true; const heldDescriptor = descriptor;
    return { bytes, hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, fileIdentity: `${after.dev}:${after.ino}:${after.birthtimeNs}`,
      descriptor: heldDescriptor, close: () => fs.closeSync(heldDescriptor) };
  } finally { if (!retained && descriptor !== undefined) fs.closeSync(descriptor); }
}

function stableRegularFile(filePath: string, trustedRoot: string, label: string, maximumBytes = 256 * 1024 * 1024,
  expectedRootIdentity?: string): { bytes: Buffer; hash: string; fileIdentity: string } {
  const held = holdStableRegularFile(filePath, trustedRoot, label, maximumBytes, expectedRootIdentity);
  try { return { bytes: held.bytes, hash: held.hash, fileIdentity: held.fileIdentity }; }
  finally { held.close(); }
}

function windowsSystemTool(name: "whoami.exe" | "icacls.exe"): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot) || path.parse(systemRoot).root === systemRoot) {
    throw new Error("Trusted Windows system tool directory is unavailable");
  }
  const tool = path.join(systemRoot, "System32", name);
  const stat = fs.statSync(tool);
  if (!stat.isFile()) throw new Error(`Trusted Windows system tool is unavailable: ${name}`);
  return tool;
}

function stageVerifiedSupervisorDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const directories = [destination]; const visit = (sourceDirectory: string, destinationDirectory: string) => {
    assertNoLinkComponents(sourceDirectory, "Dynamic Revit supervisor package");
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDirectory, entry.name); const destinationPath = path.join(destinationDirectory, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("Dynamic Revit supervisor package contains a symlink or junction");
      if (stat.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: false, mode: 0o700 }); directories.push(destinationPath); visit(sourcePath, destinationPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL); fs.chmodSync(destinationPath, 0o500);
      } else throw new Error("Dynamic Revit supervisor package contains an unsupported filesystem object");
    }
    assertNoLinkComponents(sourceDirectory, "Dynamic Revit supervisor package");
  };
  visit(source, destination);
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o500);
  if (process.platform === "win32") {
    const whoami = spawnSync(windowsSystemTool("whoami.exe"), [], { encoding: "utf8", windowsHide: true, shell: false });
    const identity = whoami.status === 0 ? whoami.stdout.trim() : "";
    if (!identity) throw new Error("Dynamic Revit staged package write-denial identity could not be established");
    const icacls = windowsSystemTool("icacls.exe");
    const grant = spawnSync(icacls, [destination, "/grant:r", `${identity}:(RX)`, "/T", "/C", "/Q"],
      { encoding: "utf8", windowsHide: true, shell: false });
    const stripInheritance = grant.status === 0
      ? spawnSync(icacls, [destination, "/inheritance:r", "/T", "/C", "/Q"], { encoding: "utf8", windowsHide: true, shell: false })
      : null;
    if (grant.status !== 0 || stripInheritance?.status !== 0) throw new Error("Dynamic Revit staged package deny-write ACL could not be established");
  }
}

function removeStagedSupervisorDirectory(destination: string): void {
  if (!fs.existsSync(destination)) return;
  if (process.platform === "win32") {
    const icacls = windowsSystemTool("icacls.exe");
    const inherited = spawnSync(icacls, [destination, "/inheritance:e", "/T", "/C", "/Q"],
      { encoding: "utf8", windowsHide: true, shell: false });
    const reset = inherited.status === 0
      ? spawnSync(icacls, [destination, "/reset", "/T", "/C", "/Q"], { encoding: "utf8", windowsHide: true, shell: false })
      : null;
    if (inherited.status !== 0 || reset?.status !== 0) throw new Error("Dynamic Revit staged package ACL could not be restored for cleanup");
  } else {
    const makeWritable = (directory: string) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name); if (entry.isDirectory()) makeWritable(candidate); else fs.chmodSync(candidate, 0o600);
      }
    };
    makeWritable(destination);
  }
  fs.rmSync(destination, { recursive: true, force: true });
}

function loopbackBridgeUrl(raw: string | undefined): string {
  const value = (raw ?? "http://127.0.0.1:5000").trim();
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipKind = net.isIP(host);
  const loopback = host === "localhost"
    || (ipKind === 4 && host.split(".")[0] === "127")
    || (ipKind === 6 && (host === "::1" || host.startsWith("::ffff:127.")));
  if (!loopback || url.protocol !== "http:" || !url.port || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Dynamic Revit bridge URL must be an exact loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

async function spawnSupervisor(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<SupervisorExecution> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: SupervisorExecution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SUPERVISOR_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", chunk => append(stdout, Buffer.from(chunk)));
    child.stderr?.on("data", chunk => append(stderr, Buffer.from(chunk)));
    child.once("error", error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", code => finish({
      exitCode: code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      timedOut,
      outputExceeded
    }));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
  });
}

function sanitizedSupervisorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot", "WINDIR", "COMSPEC", "SystemDrive", "PATH", "PATHEXT",
    "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "USERPROFILE",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "DOTNET_ROOT", "DOTNET_ROOT_X64"
  ];
  const sanitized: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = env[name];
    if (typeof value === "string" && value) sanitized[name] = value;
  }
  return sanitized;
}

function receipt(args: Partial<ProviderDynamicProgramExecutionReceipt> & Pick<ProviderDynamicProgramExecutionReceipt, "status" | "apply_requested">): ProviderDynamicProgramExecutionReceipt {
  return {
    schema: PROVIDER_DYNAMIC_PROGRAM_EXECUTION_RECEIPT_V1,
    status: args.status,
    apply_requested: args.apply_requested,
    supervisor_exit_code: args.supervisor_exit_code ?? null,
    evidence_path: args.evidence_path ?? null,
    evidence_sha256: args.evidence_sha256 ?? null,
    authority: "trusted_supervisor_receipt",
    provider_prose_authorized: false,
    failure: args.failure ?? null,
    ...(args.supervisor_executable_sha256 !== undefined ? { supervisor_executable_sha256: args.supervisor_executable_sha256 } : {}),
    ...(args.supervisor_package_sha256 !== undefined ? { supervisor_package_sha256: args.supervisor_package_sha256 } : {}),
    ...(args.worker_runtime_package_sha256 !== undefined ? { worker_runtime_package_sha256: args.worker_runtime_package_sha256 } : {}),
    ...(args.evidence_binding_sha256 !== undefined ? { evidence_binding_sha256: args.evidence_binding_sha256 } : {}),
    ...(args.target_revit_year !== undefined ? { target_revit_year: args.target_revit_year } : {})
  };
}

function executionResponse(
  message: string,
  result: ProviderDynamicProgramExecutionReceipt,
  strategy?: RecordedExecutionStrategyEvidence
): ChatResponse {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: message,
    actions: [],
    ...(strategy ? { execution_strategy_evidence: strategy } : {}),
    dynamic_program_execution_receipt: result
  };
}

export async function runTrustedProviderDynamicProgram(
  req: ChatRequest,
  program: ProviderDynamicProgramV1,
  dependencies: DynamicProgramRunnerDependencies = {}
): Promise<ChatResponse> {
  const env = dependencies.env ?? process.env;
  if (!isTrustedDynamicProgramRunnerEnabled(env)) {
    return executionResponse(
      "Dynamic Revit execution is unavailable outside the explicitly enabled development laboratory runner.",
      receipt({ status: "blocked", apply_requested: program.apply, failure: "trusted_runner_disabled" })
    );
  }

  let stagedPackageForCleanup: string | null = null;
  try {
    const supervisorPath = trustedFile(env.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_EXECUTABLE_PATH, "Dynamic Revit supervisor executable");
    const supervisorDirectory = trustedDirectory(path.dirname(supervisorPath), "Dynamic Revit supervisor directory");
    const supervisorExecutablePin = trustedHashPin(env.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_EXECUTABLE_SHA256, "Dynamic Revit supervisor executable");
    const supervisorPackagePin = trustedHashPin(env.OPERATOR_DYNAMIC_REVIT_SUPERVISOR_DIRECTORY_SHA256, "Dynamic Revit supervisor directory");
    const originalDirectoryFilesystemIdentity = stableDirectoryIdentity(supervisorDirectory, "Dynamic Revit supervisor directory");
    const originalExecutable = stableRegularFile(supervisorPath, supervisorDirectory, "Dynamic Revit supervisor executable");
    if (originalExecutable.hash !== supervisorExecutablePin) {
      throw new Error("Dynamic Revit supervisor executable does not match its trusted pin");
    }
    if (computeDynamicRuntimePackageDirectoryIdentity(supervisorDirectory) !== supervisorPackagePin) {
      throw new Error("Dynamic Revit supervisor directory does not match its trusted pin");
    }
    const workerRuntimePackagePin = trustedHashPin(env.OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256, "Dynamic Revit worker runtime package");
    const workerDirectory = trustedDirectory(env.OPERATOR_DYNAMIC_REVIT_WORKER_DIRECTORY, "Dynamic Revit worker directory");
    const tokenFile = trustedFile(env.OPERATOR_DYNAMIC_REVIT_TOKEN_FILE, "Operator token file");
    trustedFile(path.join(workerDirectory, "DynamicRevitWorker.exe"), "Dynamic Revit worker executable");
    const tokenStat = fs.statSync(tokenFile);
    if (tokenStat.size < 16 || tokenStat.size > 64 * 1024) throw new Error("Operator token file size is invalid");

    const runDirectory = path.join(
      dependencies.runsSessionsDirectory ?? ensureWorkspaceLayout().runsSessions,
      safeSegment(req.session_id),
      "dynamic-programs",
      `${safeSegment(req.message_id)}-${randomUUID()}`
    );
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 }); assertNoLinkComponents(runDirectory, "Dynamic Revit private run root");
    fs.chmodSync(runDirectory, 0o700);
    const runDirectoryFilesystemIdentity = stableDirectoryIdentity(runDirectory, "Dynamic Revit private run root");
    const sourceFile = path.join(runDirectory, "program.cs");
    const evidencePath = path.join(runDirectory, "supervisor-evidence.json");
    const configPath = path.join(runDirectory, "live-task.json");
    const stagedPackages = path.join(runDirectory, "supervisor-packages"); fs.mkdirSync(stagedPackages, { mode: 0o700 });
    const stagedSupervisorDirectory = path.join(stagedPackages, supervisorPackagePin.slice("sha256:".length));
    stagedPackageForCleanup = stagedSupervisorDirectory;
    stageVerifiedSupervisorDirectory(supervisorDirectory, stagedSupervisorDirectory);
    const stagedSupervisorPath = path.join(stagedSupervisorDirectory, path.basename(supervisorPath));
    const stagedDirectoryFilesystemIdentity = stableDirectoryIdentity(stagedSupervisorDirectory, "Staged Dynamic Revit supervisor directory");
    const stagedExecutable = stableRegularFile(stagedSupervisorPath, stagedSupervisorDirectory, "Staged Dynamic Revit supervisor executable");
    if (computeDynamicRuntimePackageDirectoryIdentity(stagedSupervisorDirectory) !== supervisorPackagePin
      || stagedExecutable.hash !== supervisorExecutablePin) {
      throw new Error("Staged Dynamic Revit supervisor package does not match its trusted pins");
    }
    fs.writeFileSync(sourceFile, program.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const liveTaskConfig = {
      workerDirectory,
      evidencePath,
      bridgeUrl: loopbackBridgeUrl(env.OPERATOR_DYNAMIC_REVIT_BRIDGE_URL),
      operatorTokenFile: tokenFile,
      sourceFile,
      targetRevitYear: program.target_revit_year,
      category: program.category,
      limit: program.limit,
      parameters: program.parameters,
      operationBudget: program.operation_budget,
      workerDeadlineMs: program.worker_deadline_ms,
      apply: program.apply,
      applyDeadlineMs: program.apply_deadline_ms
    };
    fs.writeFileSync(configPath, JSON.stringify(liveTaskConfig), { encoding: "utf8", mode: 0o600, flag: "wx" });

    const timeoutMs = Math.min(300_000, program.worker_deadline_ms + program.apply_deadline_ms + 30_000);
    dependencies.beforeSupervisorLaunch?.();
    if (stableDirectoryIdentity(runDirectory, "Dynamic Revit private run root") !== runDirectoryFilesystemIdentity) {
      throw new Error("Dynamic Revit private run root changed before launch");
    }
    const originalExecutableBeforeLaunch = stableRegularFile(supervisorPath, supervisorDirectory, "Dynamic Revit supervisor executable");
    if (computeDynamicRuntimePackageDirectoryIdentity(supervisorDirectory) !== supervisorPackagePin
      || originalExecutableBeforeLaunch.hash !== supervisorExecutablePin || originalExecutableBeforeLaunch.fileIdentity !== originalExecutable.fileIdentity
      || stableDirectoryIdentity(supervisorDirectory, "Dynamic Revit supervisor directory") !== originalDirectoryFilesystemIdentity) {
      throw new Error("Original Dynamic Revit supervisor package changed before launch");
    }
    const stagedExecutableBeforeLaunch = holdStableRegularFile(stagedSupervisorPath, stagedSupervisorDirectory, "Staged Dynamic Revit supervisor executable");
    let launched!: SupervisorExecution;
    try {
      if (computeDynamicRuntimePackageDirectoryIdentity(stagedSupervisorDirectory) !== supervisorPackagePin
        || stagedExecutableBeforeLaunch.hash !== supervisorExecutablePin || stagedExecutableBeforeLaunch.fileIdentity !== stagedExecutable.fileIdentity
        || stableDirectoryIdentity(stagedSupervisorDirectory, "Staged Dynamic Revit supervisor directory") !== stagedDirectoryFilesystemIdentity) {
        throw new Error("Staged Dynamic Revit supervisor package changed before launch");
      }
      launched = await (dependencies.executeSupervisor ?? spawnSupervisor)(
        stagedSupervisorPath,
        ["--execute-task", configPath],
        { cwd: stagedSupervisorDirectory, timeoutMs, env: sanitizedSupervisorEnvironment(env) }
      );
    } finally { stagedExecutableBeforeLaunch.close(); }
    if (launched.timedOut) throw new Error("trusted supervisor deadline exceeded");
    if (launched.outputExceeded) throw new Error("trusted supervisor output exceeded its bound");
    if (!fs.existsSync(evidencePath)) {
      throw new Error(`trusted supervisor returned exit ${launched.exitCode ?? "unknown"} without evidence`);
    }
    const evidenceRead = stableRegularFile(evidencePath, runDirectory, "Trusted supervisor evidence", MAX_EVIDENCE_BYTES, runDirectoryFilesystemIdentity);
    const evidence = evidenceRead.bytes;
    if (!evidence.length) throw new Error("trusted supervisor evidence size is invalid");
    if (launched.exitCode !== 0) throw new Error(`trusted supervisor returned exit ${launched.exitCode ?? "unknown"}`);
    const normalizedEvidence = normalizeProviderSupervisorEvidence(evidence, {
      applyRequested: program.apply,
      targetRevitYear: program.target_revit_year,
      source: program.source,
      supervisorPackageSha256: supervisorPackagePin,
      workerRuntimePackageSha256: workerRuntimePackagePin
    });
    const evidenceHash = evidenceRead.hash.slice("sha256:".length);
    return executionResponse(
      `The pinned Dynamic Revit supervisor completed the bounded ${program.apply ? "apply" : "preview"}; its normalized receipt chain is authoritative, not provider prose.`,
      receipt({
        status: "completed",
        apply_requested: program.apply,
        supervisor_exit_code: launched.exitCode,
        evidence_path: evidencePath,
        evidence_sha256: evidenceHash,
        failure: null,
        supervisor_executable_sha256: supervisorExecutablePin,
        supervisor_package_sha256: normalizedEvidence.supervisor_package_sha256,
        worker_runtime_package_sha256: normalizedEvidence.worker_runtime_package_sha256,
        evidence_binding_sha256: normalizedEvidence.binding_sha256,
        target_revit_year: normalizedEvidence.target_revit_year
      })
    );
  } catch (error) {
    return executionResponse(
      "Dynamic Revit execution was blocked before a trusted completion receipt was established.",
      receipt({
        status: "blocked",
        apply_requested: program.apply,
        failure: error instanceof Error ? error.message : String(error)
      })
    );
  } finally { if (stagedPackageForCleanup) removeStagedSupervisorDirectory(stagedPackageForCleanup); }
}

export async function executeProviderDynamicProgramLane(args: {
  req: ChatRequest;
  selectedSubstrate: string | null | undefined;
  dynamicProgram: unknown;
  otherLaneItemCount: number;
  strategyEvidence?: RecordedExecutionStrategyEvidence;
  runner?: TrustedDynamicProgramRunner;
  requestEligible?: boolean;
}): Promise<ChatResponse | null> {
  let program: ProviderDynamicProgramV1 | null;
  try {
    program = normalizeProviderDynamicProgram(args.dynamicProgram);
  } catch (error) {
    return executionResponse(
      `Dynamic Revit execution was blocked because the structured program contract was invalid: ${error instanceof Error ? error.message : String(error)}`,
      receipt({ status: "blocked", apply_requested: false, failure: "invalid_dynamic_program_contract" }),
      args.strategyEvidence
    );
  }

  const selectedDynamic = args.selectedSubstrate === "dynamic_revit_program";
  if (!selectedDynamic && !program) return null;
  if (args.requestEligible === false) {
    return executionResponse(
      "Dynamic Revit execution is not eligible on this restricted request route.",
      receipt({ status: "blocked", apply_requested: program?.apply ?? false, failure: "dynamic_program_request_ineligible" }),
      args.strategyEvidence
    );
  }
  if (!selectedDynamic && program) {
    return executionResponse(
      "Dynamic Revit execution was blocked because dynamic_program was supplied without selecting dynamic_revit_program.",
      receipt({ status: "blocked", apply_requested: program.apply, failure: "strategy_program_mismatch" }),
      args.strategyEvidence
    );
  }
  if (!program) {
    return executionResponse(
      "Dynamic Revit execution was not dispatched because the selected dynamic substrate omitted its exact dynamic_program value.",
      receipt({ status: "blocked", apply_requested: false, failure: "dynamic_program_missing" }),
      args.strategyEvidence
    );
  }
  const turnContract = buildTeammateTurnContract(args.req);
  if (program.apply && (!turnContract.write_authorized || turnContract.no_write)) {
    return executionResponse(
      "Dynamic Revit apply was blocked because the authoritative user turn did not grant mutation intent. A provider program or explanation cannot supply that authority.",
      receipt({ status: "blocked", apply_requested: true, failure: "dynamic_apply_not_authorized_by_user_turn" }),
      args.strategyEvidence
    );
  }
  if (args.otherLaneItemCount !== 0) {
    return executionResponse(
      "The provider mixed a Dynamic Revit program with another execution lane. I stopped before dispatching any of them.",
      receipt({ status: "blocked", apply_requested: program.apply, failure: "mixed_execution_lanes" }),
      args.strategyEvidence
    );
  }
  const response = await (args.runner ?? runTrustedProviderDynamicProgram)(args.req, program);
  return args.strategyEvidence && !response.execution_strategy_evidence
    ? { ...response, execution_strategy_evidence: args.strategyEvidence }
    : response;
}
