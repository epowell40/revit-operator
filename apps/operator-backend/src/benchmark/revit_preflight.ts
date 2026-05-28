type BridgeCheck = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

export type RevitBridgePreflightReport = {
  bridge_url: string;
  checked_bridge_urls?: string[];
  ping: BridgeCheck;
  context: BridgeCheck;
  local_port_owner?: unknown;
  ok: boolean;
  diagnosis: "ok" | "wrong_service" | "auth_or_endpoint_failure" | "unreachable";
  message: string;
  next_steps: string[];
};

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function looksLikeGeneric404(check: BridgeCheck): boolean {
  if (check.status !== 404) return false;
  const text = bodyText(check.body).toLowerCase();
  return text.includes("404 not found") || text.includes("requested url was not found") || text.includes("<html");
}

function isUnreachable(check: BridgeCheck): boolean {
  if (check.error) return true;
  return check.status === undefined && !check.ok;
}

export function buildRevitBridgePreflightReport(input: {
  bridgeUrl: string;
  ping: BridgeCheck;
  context: BridgeCheck;
  localPortOwner?: unknown;
  checkedBridgeUrls?: string[];
}): RevitBridgePreflightReport {
  const ok = input.ping.ok && input.context.ok;
  if (ok) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      local_port_owner: input.localPortOwner,
      ok: true,
      diagnosis: "ok",
      message: "Revit bridge preflight passed.",
      next_steps: [
        "Run discover-revit-demo to generate live benchmark request overrides.",
        "Run deterministic_skill_only live benchmarks with OPERATOR_BENCHMARK_USE_MOCKS=0."
      ]
    };
  }

  if (isUnreachable(input.ping) || isUnreachable(input.context)) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      local_port_owner: input.localPortOwner,
      ok: false,
      diagnosis: "unreachable",
      message: "The configured Revit bridge URL is not reachable.",
      next_steps: [
        "Start Revit with the Operator add-in loaded and open the demo model.",
        "Confirm REVIT_BRIDGE_URL points at the add-in bridge, usually http://localhost:5000.",
        "If another port is configured in the add-in, set REVIT_BRIDGE_URL to that exact URL."
      ]
    };
  }

  if (looksLikeGeneric404(input.ping) && looksLikeGeneric404(input.context)) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      local_port_owner: input.localPortOwner,
      ok: false,
      diagnosis: "wrong_service",
      message: "Something is listening at the configured URL, but it does not expose the Operator Revit bridge endpoints.",
      next_steps: [
        "Check which process owns the port and stop or move the non-bridge service if needed.",
        "Start Revit with the Operator add-in loaded so /revit/ping and /revit/context are served by the bridge.",
        "Set REVIT_BRIDGE_URL to the actual bridge URL before running discovery or live benchmarks."
      ]
    };
  }

  return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      local_port_owner: input.localPortOwner,
      ok: false,
    diagnosis: "auth_or_endpoint_failure",
    message: "The bridge URL responded, but required Operator Revit endpoints did not both pass.",
    next_steps: [
      "Verify the add-in and backend share the same Operator token.",
      "Inspect the ping/context status codes and response bodies for auth or route errors.",
      "Fix the bridge response before running live discovery or live benchmark batches."
    ]
  };
}
