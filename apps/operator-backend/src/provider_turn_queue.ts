/** Local scheduling only: a successor must not attach to its predecessor's
 * still-active provider turn. Native authority and settlement stay unchanged. */
const tails = new Map<string, Promise<void>>();

function waitForPredecessor(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal?.removeEventListener("abort", aborted);
      reject(new Error("Task continuation was cancelled while the previous provider turn was settling. No successor provider or native work was started."));
    };
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    previous.then(() => {
      signal?.removeEventListener("abort", aborted);
      if (signal?.aborted) return aborted();
      resolve();
    });
  });
}

export async function withSerializedProviderTurn<T>(args: {
  namespace: string; workspace: string; sessionId: string; signal?: AbortSignal; onWait?: () => void;
}, run: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([args.namespace, args.workspace, args.sessionId]);
  const existing = tails.get(key);
  const previous = existing ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  // A cancelled middle waiter cannot remove the predecessor from the chain.
  const tail = previous.then(() => done);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  try {
    if (existing) args.onWait?.();
    await waitForPredecessor(previous, args.signal);
    return await run();
  } finally {
    release();
  }
}
