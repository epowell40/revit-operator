/** Execution belongs to the Sidecar, not to one browser response. This registry
 * describes transport activity only; canonical task evidence determines outcome.
 * Authorize the session before calling any method that reads or changes a run. */
export function createTaskRunRegistry({ now = Date.now, retained = 100 } = {}) {
  const runs = new Map();
  const key = (sessionId, messageId) => JSON.stringify([sessionId, messageId]);
  const valid = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 240;
  const copy = run => ({ session_id: run.sessionId, message_id: run.messageId, state: run.state,
    started_at: new Date(run.startedAt).toISOString(), finished_at: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    progress: run.progress, observers: run.observers });
  const prune = () => {
    const finished = [...runs.entries()].filter(([,run]) => run.finishedAt !== null).sort((a,b) => a[1].finishedAt - b[1].finishedAt);
    for (const [id] of finished.slice(0, Math.max(0, finished.length - retained))) runs.delete(id);
  };
  return {
    begin({ sessionId, messageId }) {
      if (!valid(sessionId) || !valid(messageId)) throw Error('A valid conversation and message are required');
      const id = key(sessionId, messageId);
      if (runs.has(id)) throw Object.assign(Error('This request already has a run. Reopen its conversation to view it.'), { code: 'TASK_RUN_EXISTS', status: 409 });
      if ([...runs.values()].some(run => run.sessionId === sessionId && run.finishedAt === null)) throw Object.assign(Error('This conversation is already working. Pause it or send a direction.'), { code: 'TASK_SESSION_BUSY', status: 409 });
      if ([...runs.values()].filter(run => run.finishedAt === null).length >= 32) throw Object.assign(Error('Operator is busy. Try again after current work settles.'), { status: 429 });
      const run = { sessionId, messageId, state: 'running', startedAt: now(), finishedAt: null, progress: '', observers: 0, onStop: null };
      runs.set(id, run);
      return Object.freeze({
        snapshot: () => copy(run),
        onStop(handler) { run.onStop = handler; },
        // Detaching an observer never interrupts the run or changes its outcome.
        attach() { run.observers++; let attached = true; return () => { if (attached) { attached = false; run.observers--; } }; },
        progress(text) { if (run.finishedAt === null && typeof text === 'string') run.progress = text.slice(0, 240); },
        finish(failed = false) { if (run.finishedAt !== null) return; run.state = failed ? 'failed' : 'finished'; run.finishedAt = now(); prune(); }
      });
    },
    get(sessionId, messageId) { const run = runs.get(key(sessionId, messageId)); return run ? copy(run) : null; },
    forSession(sessionId) { return [...runs.values()].filter(run => run.sessionId === sessionId).map(copy); },
    requestStop(sessionId, messageId) {
      const run = runs.get(key(sessionId, messageId));
      if (!run || run.finishedAt !== null) return false;
      if (run.state === 'stopping') return true;
      run.state = 'stopping'; run.onStop?.(); return true;
    }
  };
}
