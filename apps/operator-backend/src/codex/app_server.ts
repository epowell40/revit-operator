import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { evaluateCodexCliVersion, resolveCodexExecutable, type CodexVersionCompatibility } from "./app_server_compatibility.js";

type JsonRpcId = number | string;
type JsonRpcRequest = { id: number; method: string; params: unknown };
type JsonRpcResponse =
  | { id: number; result: any }
  | { id: number; error: { code: number; message: string; data?: unknown } };
type JsonRpcNotification = { method: string; params?: any };
export type CodexServerRequest = { id: JsonRpcId; method: string; params?: any };

export type CodexNotificationEnvelope = {
  method: string;
  threadId?: string;
  params?: any;
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

async function probeCodexVersion(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, ["--version"], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let settled = false;
    let output = "";
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const append = (chunk: Buffer | string) => {
      if (output.length < 16_384) output += chunk.toString();
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", error => finish(error));
    proc.on("exit", code => finish(code === 0 ? null : new Error(`Codex version probe exited with code ${code ?? "null"}: ${output.trim()}`)));
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      finish(new Error("Timed out probing the Codex CLI version."));
    }, 5_000);
  });
}

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Set<(n: CodexNotificationEnvelope) => void>();
  private serverRequestHandler: ((request: CodexServerRequest) => Promise<unknown>) | null = null;
  private starting: Promise<void> | null = null;
  private versionCompatibility: CodexVersionCompatibility | null = null;
  private initializeResponse: unknown = null;
  private stderrTail = "";

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

  setServerRequestHandler(handler: ((request: CodexServerRequest) => Promise<unknown>) | null): void {
    this.serverRequestHandler = handler;
  }

  getCompatibilityReceipt(): { version: CodexVersionCompatibility | null; initialize_response: unknown; stderr_tail: string | null } {
    return { version: this.versionCompatibility, initialize_response: this.initializeResponse, stderr_tail: this.stderrTail || null };
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    try { this.rl?.close(); } catch {}
    this.rl = null;
    try { proc?.kill(); } catch {}
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

    const codexBin = resolveCodexExecutable(env.OPERATOR_CODEX_BIN, process.platform, env);
    const versionOutput = await probeCodexVersion(codexBin, this.opts.cwd, env);
    this.versionCompatibility = evaluateCodexCliVersion(versionOutput, env);

    // Resolve the Windows npm shim to the packaged native executable so arguments are never shell-concatenated.
    const proc = spawn(codexBin, ["app-server", "--strict-config"], {
      cwd: this.opts.cwd,
      env,
      shell: false,
      stdio: "pipe"
    });
    this.proc = proc;
    this.stderrTail = "";
    proc.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-16_384);
    });

    proc.on("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      const err = new Error(`Codex app-server exited (code=${code ?? "null"} signal=${signal ?? "null"}).${detail ? ` stderr: ${detail}` : ""}`);
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
    proc.on("error", error => {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        pending.reject(error);
      }
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

      if (msg && typeof msg === "object" && msg.id !== undefined && typeof msg.method === "string") {
        void this.handleServerRequest({ id: msg.id as JsonRpcId, method: msg.method, params: msg.params });
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
    this.initializeResponse = await this.request("initialize", {
      clientInfo: { name: "revit-operator-backend", title: "Revit Operator Backend", version: "0.0.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  private writeMessage(message: unknown): void {
    const proc = this.proc;
    if (!proc) throw new Error("Codex app-server is not running.");
    proc.stdin.write(JSON.stringify(message) + "\n", "utf8");
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    try {
      let result: unknown;
      if (this.serverRequestHandler) {
        result = await this.serverRequestHandler(request);
      } else if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
        result = { decision: "decline" };
      } else if (request.method === "mcpServer/elicitation/request") {
        result = { action: "decline", content: null, _meta: null };
      } else if (request.method === "item/tool/requestUserInput") {
        result = { answers: {} };
      } else if (request.method === "currentTime/read") {
        result = { currentTimeAt: Math.floor(Date.now() / 1000) };
      } else {
        throw new Error(`Unsupported Codex server request: ${request.method}`);
      }
      this.writeMessage({ id: request.id, result });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ method, params });
  }

  request(method: string, params: unknown): Promise<any> {
    const proc = this.proc;
    if (!proc) throw new Error("Codex app-server is not running.");

    const id = this.nextId++;
    const req: JsonRpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeMessage(req);
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
