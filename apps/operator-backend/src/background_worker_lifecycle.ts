/** Stop errors must not retain a stale worker or prevent replacement. Callers
 * assign this null before starting the replacement, including when start throws. */
export function stopBackgroundWorker(worker:{stop:()=>void}|null):null {
  try {worker?.stop();} catch { /* Existing best-effort teardown semantics. */ }
  return null;
}
