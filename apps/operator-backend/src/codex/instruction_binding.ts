import { createHash } from "node:crypto";
import { benchmarkInstructionRuntime, type BenchmarkInstructionRuntime } from "./benchmark_instruction_runtime.js";

export type SuppliedInstructions = { baseInstructions?: string | null; developerInstructions?: string | null };
export type HostInstructionBinding = Readonly<{
  schema: "revit-operator.host-supplied-instructions/v1";
  source: "host_supplied_acknowledged";
  prompt_sha256: string;
  system_instruction_sha256: string;
  benchmark_runtime?: BenchmarkInstructionRuntime;
}>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function hostInstructionBinding(profile: SuppliedInstructions): HostInstructionBinding {
  const base = profile.baseInstructions ?? "";
  const developer = profile.developerInstructions ?? "";
  return Object.freeze({ schema: "revit-operator.host-supplied-instructions/v1", source: "host_supplied_acknowledged",
    prompt_sha256: hash(base), system_instruction_sha256: hash({ base, developer }) });
}

export class CodexInstructionBindingError extends Error {
  readonly code = "CODEX_INSTRUCTION_BINDING_MISMATCH";
  readonly phase = "pre_provider";
  readonly providerDispatched = false;
  constructor(message: string) { super(message); this.name = "CodexInstructionBindingError"; }
}

export function assertHostInstructionBinding(actual: HostInstructionBinding | undefined, expected: HostInstructionBinding): void {
  if (!actual || actual.prompt_sha256 !== expected.prompt_sha256
    || actual.system_instruction_sha256 !== expected.system_instruction_sha256) {
    throw new CodexInstructionBindingError("The loaded Codex thread has missing or different host-supplied instructions. No provider turn was started; the existing thread and task were preserved.");
  }
}

/** Only host configuration selects this file; request context cannot supply it. */
export function assertConfiguredBenchmarkInstructions(profile: SuppliedInstructions, env: NodeJS.ProcessEnv = process.env): BenchmarkInstructionRuntime | null {
  const runtime = benchmarkInstructionRuntime(env);
  if (runtime.status === "unset") return null;
  if (!runtime.configured) {
    throw new CodexInstructionBindingError("The host-configured benchmark instruction envelope is missing or invalid. No provider turn was started.");
  }
  const actual = hostInstructionBinding(profile);
  if (actual.prompt_sha256 !== runtime.prompt_sha256 || actual.system_instruction_sha256 !== runtime.system_instruction_sha256) {
    throw new CodexInstructionBindingError("The host-configured benchmark instructions differ from the supplied profile. No provider turn was started.");
  }
  return runtime;
}
