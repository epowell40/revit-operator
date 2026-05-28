import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type JsonRpcRequest = { id: number; method: string; params: unknown };
type JsonRpcResponse =
  | { id: number; result: any }
  | { id: number; error: { code: number; message: string; data?: unknown } };
type JsonRpcNotification = { method: string; params?: any };

export type CodexNotificationEnvelope = {
  method: string;
  threadId?: string;
  params?: any;
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Set<(n: CodexNotificationEnvelope) => void>();
  private starting: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      cwd: string;
      codexHome: string;
      spawnEnv: NodeJS.ProcessEnv;
    }
  ) {}

  onNotification(handler: (n: CodexNotificationEnvelope) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async ensureStarted(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async _start(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...this.opts.spawnEnv,
      CODEX_HOME: this.opts.codexHome
    };

    // On Windows, `codex` is typically a .cmd shim. Using `shell: true` keeps this robust.
    const proc = spawn("codex", ["app-server"], {
      cwd: this.opts.cwd,
      env,
      shell: true,
      stdio: "pipe"
    });
    this.proc = proc;

    proc.on("exit", (code, signal) => {
      const err = new Error(`Codex app-server exited (code=${code ?? "null"} signal=${signal ?? "null"}).`);
      for (const [id, p] of this.pending.entries()) {
        this.pending.delete(id);
        p.reject(err);
      }
      this.proc = null;
      try {
        this.rl?.close();
      } catch {
        // ignore
      }
      this.rl = null;
    });

    const rl = readline.createInterface({ input: proc.stdout });
    this.rl = rl;

    rl.on("line", line => {
      const trimmed = (line ?? "").trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg && typeof msg === "object" && msg.id !== undefined) {
        const id = typeof msg.id === "number" ? msg.id : Number.parseInt(String(msg.id ?? ""), 10);
        if (!Number.isFinite(id)) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const resp = msg as JsonRpcResponse;
        if ("error" in resp && resp.error) {
          pending.reject(new Error(resp.error.message || `Codex JSON-RPC error (code=${(resp as any).code ?? "?"}).`));
        } else {
          pending.resolve((resp as any).result);
        }
        return;
      }

      if (msg && typeof msg === "object" && typeof msg.method === "string") {
        const n = msg as JsonRpcNotification;
        const env: CodexNotificationEnvelope = {
          method: n.method,
          params: n.params
        };

        // Convenience: hoist common fields used for routing.
        try {
          const p = n.params;
          if (p && typeof p === "object" && typeof p.threadId === "string") env.threadId = p.threadId;
        } catch {
          // ignore
        }

        for (const h of this.notificationHandlers) {
          try {
            h(env);
          } catch {
            // ignore
          }
        }
      }
    });

    // Initialize JSON-RPC session.
    await this.request("initialize", {
      clientInfo: { name: "revit-operator-backend", title: "Revit Operator Backend", version: "0.0.0" },
      capabilities: null
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const proc = this.proc;
    if (!proc) throw new Error("Codex app-server is not running.");

    const id = this.nextId++;
    const req: JsonRpcRequest = { id, method, params };
    const payload = JSON.stringify(req);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin.write(payload + "\n", "utf8");
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private async tryGetTurnStatus(threadId: string, turnId: string): Promise<{ status: string; errorMessage: string | null } | null> {
    const tryParse = (resp: any): { status: string; errorMessage: string | null } | null => {
      try {
        const status = String(resp?.turn?.status ?? resp?.status ?? "").trim().toLowerCase();
        if (!status) return null;
        const errorMessage =
          typeof resp?.turn?.error?.message === "string"
            ? resp.turn.error.message
            : typeof resp?.error?.message === "string"
              ? resp.error.message
              : null;
        return { status, errorMessage };
      } catch {
        return null;
      }
    };

    try {
      const r = await this.request("turn/get", { threadId, turnId });
      const parsed = tryParse(r);
      if (parsed) return parsed;
    } catch {
      // ignore
    }

    try {
      const r = await this.request("turn/status", { threadId, turnId });
      const parsed = tryParse(r);
      if (parsed) return parsed;
    } catch {
      // ignore
    }

    return null;
  }

  async waitForTurnCompleted(opts: { threadId: string; turnId: string; timeoutMs: number; abortSignal?: AbortSignal }): Promise<void> {
    const { threadId, turnId, timeoutMs, abortSignal } = opts;
    const deadline = Date.now() + Math.max(0, timeoutMs);

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let pollTimer: NodeJS.Timeout | null = null;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (pollTimer) clearInterval(pollTimer);
        try { abortSignal?.removeEventListener("abort", onAbort); } catch {}
        resolve();
      };
      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (pollTimer) clearInterval(pollTimer);
        try { abortSignal?.removeEventListener("abort", onAbort); } catch {}
        reject(err);
      };
      const onAbort = () => {
        try {
          off();
        } catch {
          // ignore
        }
        finishErr(new Error("Codex turn wait aborted."));
      };

      const off = this.onNotification(n => {
        if (n.method !== "turn/completed") return;
        const p = n.params;
        if (!p || typeof p !== "object") return;
        if (p.threadId !== threadId) return;
        if (p.turn?.id !== turnId) return;

        off();
        const status = (p.turn?.status ?? "").toString();
        if (status === "failed" || status === "error") {
          const msg = p.turn?.error?.message ? String(p.turn.error.message) : `Turn failed (status=${status}).`;
          finishErr(new Error(msg));
          return;
        }
        finishOk();
      });

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        try { abortSignal.addEventListener("abort", onAbort); } catch {}
      }

      timer = setInterval(() => {
        if (Date.now() < deadline) return;
        void (async () => {
          try {
            const status = await this.tryGetTurnStatus(threadId, turnId);
            if (status && (status.status === "completed" || status.status === "success" || status.status === "done")) {
              finishOk();
              return;
            }
            if (status && (status.status === "failed" || status.status === "error" || status.status === "cancelled")) {
              finishErr(new Error(status.errorMessage || `Turn failed (status=${status.status}).`));
              return;
            }
          } catch {
            // ignore fallback errors and report the timeout below
          }

          try {
            off();
          } catch {
            // ignore
          }
          finishErr(new Error("Timed out waiting for Codex turn completion."));
        })();
      }, 250);

      // Best-effort status polling in case notifications are dropped.
      pollTimer = setInterval(() => {
        void (async () => {
          if (settled) return;
          try {
            const status = await this.tryGetTurnStatus(threadId, turnId);
            if (!status) return;
            if (status.status === "completed" || status.status === "success" || status.status === "done") {
              finishOk();
              return;
            }
            if (status.status === "failed" || status.status === "error" || status.status === "cancelled") {
              finishErr(new Error(status.errorMessage || `Turn failed (status=${status.status}).`));
              return;
            }
          } catch {
            // ignore
          }
        })();
      }, 2_000);
    });
  }
}
