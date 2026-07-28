export type OperatorRuntimeMode = "local" | "self_hosted" | "hosted" | "development" | "production";

const RUNTIME_MODES = new Set<OperatorRuntimeMode>([
  "local",
  "self_hosted",
  "hosted",
  "development",
  "production"
]);

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): OperatorRuntimeMode | null {
  const configured = (env.REVIT_OPERATOR_MODE ?? "").trim().toLowerCase();
  if (!configured) return null;
  if (!RUNTIME_MODES.has(configured as OperatorRuntimeMode)) {
    throw new Error(`Unsupported REVIT_OPERATOR_MODE: ${configured}`);
  }
  return configured as OperatorRuntimeMode;
}

function resolveHostedFlag(env: NodeJS.ProcessEnv): boolean {
  const configured = (env.OPERATOR_HOSTED_ENABLED ?? "").trim().toLowerCase();
  if (!configured || FALSE_VALUES.has(configured)) return false;
  if (TRUE_VALUES.has(configured)) return true;
  throw new Error(`Unsupported OPERATOR_HOSTED_ENABLED: ${configured}`);
}

export function isHostedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRuntimeMode(env) === "hosted" || resolveHostedFlag(env);
}
