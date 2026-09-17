/** Provider completion observations are scoped to one transport lifetime. */
export type ProviderTurnCompletion = { status: "completed" | "interrupted"; interrupted: boolean };
type Receipt = { status: "completed" | "interrupted" | "failed"; error: string | null };
type Waiter = { settle: (receipt: Receipt) => void; reject: (error: Error) => void };
const keyFor = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

export class CodexTurnCompletions {
  private readonly receipts = new Map<string, Receipt>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private pendingCount = 0;

  observe(threadId: unknown, turnId: unknown, status: unknown, errorMessage?: unknown): void {
    if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return;
    if (status !== "completed" && status !== "interrupted" && status !== "failed") return;
    const key = keyFor(threadId, turnId);
    const previous = this.receipts.get(key);
    const receipt: Receipt = previous && previous.status !== status
      ? { status: "failed", error: "Conflicting provider completion observations." }
      : { status, error: typeof errorMessage === "string" ? errorMessage.slice(0, 2048) : null };
    this.receipts.set(key, receipt);
    while (this.receipts.size > 1024) this.receipts.delete(this.receipts.keys().next().value!);
    for (const waiter of [...(this.waiters.get(key) ?? [])]) waiter.settle(receipt);
  }

  wait(opts: { threadId: string; turnId: string; timeoutMs: number; abortSignal?: AbortSignal }): Promise<ProviderTurnCompletion> {
    const { threadId, turnId, timeoutMs, abortSignal } = opts;
    if (!threadId || !turnId || !Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("Invalid Codex completion wait."));
    if (abortSignal?.aborted) return Promise.reject(new Error("Codex turn wait aborted."));
    if (this.pendingCount >= 512) return Promise.reject(new Error("Too many pending Codex completion waits."));
    const key = keyFor(threadId, turnId);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        const entries = this.waiters.get(key);
        if (entries?.delete(waiter)) this.pendingCount -= 1;
        if (entries?.size === 0) this.waiters.delete(key);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new Error("Codex turn wait aborted."));
      const waiter: Waiter = {
        reject: fail,
        settle: receipt => {
          if (settled) return;
          if (receipt.status === "failed") return fail(new Error(receipt.error || "Codex turn failed."));
          settled = true;
          cleanup();
          resolve({ status: receipt.status, interrupted: receipt.status === "interrupted" });
        }
      };
      const receipt = this.receipts.get(key);
      if (receipt) return waiter.settle(receipt);
      const entries = this.waiters.get(key) ?? new Set<Waiter>();
      entries.add(waiter);
      this.waiters.set(key, entries);
      this.pendingCount += 1;
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail(new Error("Timed out waiting for Codex turn completion.")), Math.min(timeoutMs, 2_147_483_647));
    });
  }

  reset(error: Error): void {
    this.receipts.clear();
    for (const entries of [...this.waiters.values()]) for (const waiter of [...entries]) waiter.reject(error);
  }
}
