import { CodexTurnFailedError, codexTurnErrorReceipt, type CodexTurnErrorReceipt } from "./turn_error.js";

/** Provider completion observations are scoped to one transport lifetime. */
export type ProviderTurnCompletion = { status: "completed" | "interrupted"; interrupted: boolean };
type Receipt = { status: "completed" | "interrupted" | "failed"; error: CodexTurnErrorReceipt; conflicted?: true };
type Waiter = { settle: (receipt: Receipt) => void; reject: (error: Error) => void; progress: () => void };
const keyFor = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

export class CodexTurnCompletions {
  private readonly receipts = new Map<string, Receipt>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly issuedFailures = new WeakMap<Error, Receipt>();
  private pendingCount = 0;

  hasCompleted(threadId: string, turnId: string): boolean {
    return this.receipts.has(keyFor(threadId, turnId));
  }

  /** Authority lasts only while this exact observed receipt remains current.
   * Constructor lookalikes, replaced transports and conflicts cannot create a hold. */
  isCurrentFailure(error: unknown): error is CodexTurnFailedError {
    if (!(error instanceof CodexTurnFailedError)) return false;
    const receipt = this.issuedFailures.get(error);
    return Boolean(receipt && !receipt.conflicted && receipt.status === "failed"
      && receipt === this.receipts.get(keyFor(error.threadId, error.turnId)));
  }

  observe(threadId: unknown, turnId: unknown, status: unknown, error?: unknown): void {
    if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return;
    if (status !== "completed" && status !== "interrupted" && status !== "failed") return;
    const key = keyFor(threadId, turnId);
    const previous = this.receipts.get(key);
    const parsedError = codexTurnErrorReceipt(status === "failed" ? error : null);
    // Conflicting failure codes are not authoritative even when both statuses are failed.
    // Once conflicting, later duplicate observations cannot restore a typed failure.
    const conflicted = previous && (previous.conflicted || previous.status !== status
      || (status === "failed" && JSON.stringify(previous.error.codexErrorInfo) !== JSON.stringify(parsedError.codexErrorInfo)));
    // Identical redelivery may refresh diagnostics, but preserves issued authority.
    if (previous && !conflicted) previous.error = parsedError;
    const receipt: Receipt = conflicted
      ? { status: "failed", error: { message: "Conflicting provider completion observations.", codexErrorInfo: null }, conflicted: true }
      : previous ?? { status, error: parsedError };
    this.receipts.set(key, receipt);
    while (this.receipts.size > 1024) this.receipts.delete(this.receipts.keys().next().value!);
    for (const waiter of [...(this.waiters.get(key) ?? [])]) waiter.settle(receipt);
  }

  observeProgress(threadId: unknown, turnId: unknown): void {
    if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return;
    for (const waiter of [...(this.waiters.get(keyFor(threadId, turnId)) ?? [])]) waiter.progress();
  }

  wait(opts: { threadId: string; turnId: string; timeoutMs: number; maxWallMs?: number; abortSignal?: AbortSignal }): Promise<ProviderTurnCompletion> {
    const { threadId, turnId, timeoutMs, maxWallMs, abortSignal } = opts;
    if (!threadId || !turnId || !Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("Invalid Codex completion wait."));
    if (maxWallMs !== undefined && (!Number.isFinite(maxWallMs) || maxWallMs < 0)) return Promise.reject(new Error("Invalid Codex completion wall limit."));
    if (abortSignal?.aborted) return Promise.reject(new Error("Codex turn wait aborted."));
    if (this.pendingCount >= 512) return Promise.reject(new Error("Too many pending Codex completion waits."));
    const key = keyFor(threadId, turnId);
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
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
      const armIdleTimer = () => {
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail(new Error("Timed out waiting for Codex turn completion after provider inactivity.")), Math.min(timeoutMs, 2_147_483_647));
      };
      const waiter: Waiter = {
        reject: fail,
        progress: armIdleTimer,
        settle: receipt => {
          if (settled) return;
          if (receipt.status === "failed") {
            const error = Object.freeze(new CodexTurnFailedError(threadId, turnId, receipt.error));
            this.issuedFailures.set(error, receipt);
            return fail(error);
          }
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
      armIdleTimer();
      if (maxWallMs !== undefined) wallTimer = setTimeout(() => fail(new Error("Timed out waiting for Codex turn completion at maximum duration.")), Math.min(maxWallMs, 2_147_483_647));
    });
  }

  reset(error: Error): void {
    this.receipts.clear();
    for (const entries of [...this.waiters.values()]) for (const waiter of [...entries]) waiter.reject(error);
  }
}
