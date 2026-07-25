type DynamicToolCallParams = {
  threadId?: unknown;
  turnId?: unknown;
  tool?: unknown;
  arguments?: unknown;
};

export type RevitToolCallLease = {
  accepted: boolean;
  message: string | null;
  release: () => void;
};

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizedString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : fallback;
}

function noOpLease(): RevitToolCallLease {
  return { accepted: true, message: null, release: () => undefined };
}

/**
 * Rejects concurrent duplicate generic Revit calls inside one Codex turn.
 *
 * Codex app-server may dispatch a batch of dynamic tool requests before any one
 * result is available. That is useful for independent work, but it is unsafe for
 * search loops whose next request depends on inspecting the previous Revit
 * result. The guard leaves every tool available and permits independent paths;
 * it only rejects a second in-flight call to the same method/path in the same
 * thread and turn. A later call is accepted as soon as the first has completed.
 */
export class RevitToolParallelGuard {
  private readonly activeKeys = new Set<string>();

  tryAcquire(params: DynamicToolCallParams): RevitToolCallLease {
    if (normalizedString(params.tool, "") !== "revit_call_tool") return noOpLease();

    const args = parseObject(params.arguments);
    const path = normalizedString(args.path, "");
    if (!path.startsWith("/revit/")) return noOpLease();

    const method = normalizedString(args.method, "get");
    const threadId = normalizedString(params.threadId, "unknown-thread");
    const turnId = normalizedString(params.turnId, "unknown-turn");
    const key = `${threadId}\u0000${turnId}\u0000${method}\u0000${path}`;

    if (this.activeKeys.has(key)) {
      return {
        accepted: false,
        message:
          `[parallel_revit_call_blocked] Another ${method.toUpperCase()} ${path} call is already running in this Codex turn. ` +
          "Do not batch dependent Revit calls. Inspect the first result, then issue the next call only if it is still needed.",
        release: () => undefined
      };
    }

    this.activeKeys.add(key);
    let released = false;
    return {
      accepted: true,
      message: null,
      release: () => {
        if (released) return;
        released = true;
        this.activeKeys.delete(key);
      }
    };
  }
}
