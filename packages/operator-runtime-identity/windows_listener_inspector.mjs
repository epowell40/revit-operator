import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WINDOWS_LISTENER_SCRIPT } from './windows_listener_worker.mjs';

/** Reuses only the interpreter, never an ownership result. A failed/timed-out
 * inspection is not retried with a stale snapshot. The caller decides whether
 * a new, independently authorized operation should be attempted. */
export function createWindowsListenerInspector({ powershell = 'powershell', spawnWorker = spawn, timeoutMs = 10000, environment = process.env } = {}) {
  let worker = null;
  const pending = new Map();
  const childEnvironment = { ...environment };
  for (const key of Object.keys(childEnvironment)) if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key];
  function references(current, active) {
    for (const handle of [current.child, current.child.stdin, current.child.stdout, current.child.stderr]) {
      if (active) handle?.ref?.(); else handle?.unref?.();
    }
  }
  function fail(current, reason) {
    if (current.failed) return;
    current.failed = true;
    if (worker === current) worker = null;
    current.rejectReady(reason);
    for (const [id, item] of pending) if (item.worker === current) {
      clearTimeout(item.timer); pending.delete(id); item.reject(reason);
    }
    clearTimeout(current.startTimer);
    current.child.kill();
  }
  function start() {
    if (worker) return worker;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Prewarming is best effort, but callers still receive startup failure.
    ready.catch(() => {});
    const child = spawnWorker(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_LISTENER_SCRIPT, 'utf16le').toString('base64')],
      { env: childEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const current = worker = { child, ready, rejectReady, failed: false, started: false, buffer: '', startTimer: null };
    current.startTimer = setTimeout(() => fail(current, Error('Windows listener inspector startup timed out')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (current.failed) return;
      current.buffer += chunk;
      if (current.buffer.length > 65536) return fail(current, Error('Windows listener inspector response is too large'));
      while (current.buffer.includes('\n')) {
        const end = current.buffer.indexOf('\n'), line = current.buffer.slice(0, end).trim();
        current.buffer = current.buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { return fail(current, Error('Invalid Windows listener inspector response')); }
        if (!current.started) {
          if (value?.ready !== true || Object.keys(value).length !== 1) return fail(current, Error('Windows listener inspector failed to initialize'));
          current.started = true; clearTimeout(current.startTimer); resolveReady();
          if (!pending.size) references(current, false);
          continue;
        }
        const item = pending.get(value?.id);
        if (!item || item.worker !== current) return fail(current, Error('Windows listener inspector returned an unexpected request identity'));
        clearTimeout(item.timer); pending.delete(value.id);
        if (typeof value.error === 'string') item.reject(Error(value.error.slice(0, 1000)));
        else if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) item.reject(Error('Missing Windows listener snapshot'));
        else item.resolve(value.snapshot);
        if (!pending.size) references(current, false);
      }
    });
    // Never forward the host's inherited environment or diagnostic stream.
    child.stderr.on('data', () => {});
    child.on('error', error => fail(current, Error(`Windows listener inspector failed: ${error.code || 'startup'}`)));
    child.on('exit', () => fail(current, Error('Windows listener inspector exited')));
    child.stdin.on('error', () => fail(current, Error('Windows listener inspector input closed')));
    return current;
  }
  return {
    async warm() { await start().ready; },
    async inspect({ port, host = '127.0.0.1', preferredPid = 0 }) {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(preferredPid) || preferredPid < 0 || preferredPid > 0x7fffffff
        || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw Error('Invalid Windows listener inspection target');
      if (pending.size >= 64) throw Error('Windows listener inspector is busy');
      const current = start();
      await current.ready;
      if (current.failed) throw Error('Windows listener inspector exited');
      if (pending.size >= 64) throw Error('Windows listener inspector is busy');
      references(current, true);
      const id = randomBytes(16).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(current, Error('Windows listener inspection timed out')), timeoutMs);
        pending.set(id, { worker: current, resolve, reject, timer });
        current.child.stdin.write(`${JSON.stringify({ id, port, host, preferredPid })}\n`);
      });
    },
    close() { if (worker) fail(worker, Error('Windows listener inspector closed')); }
  };
}
