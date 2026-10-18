import { Worker } from "node:worker_threads";
import type { NavigationProjection } from "./task_navigation_projection.js";

let worker: Worker | null = null, sequence = 0;
const pending = new Map<number, { resolve: (value: NavigationProjection | null) => void; reject: (error: Error) => void }>();
const inFlight = new Map<string, Promise<NavigationProjection | null>>();
function reader(): Worker {
  if (worker) return worker;
  const current = new Worker(new URL(import.meta.url.endsWith(".ts")
    ? "./task_navigation_worker_entry.mjs" : "./task_navigation_worker.js", import.meta.url));
  worker = current;
  const fail = () => {
    if (worker !== current) return;
    worker = null;
    for (const request of pending.values()) request.reject(new Error("navigation_projection_worker_unavailable"));
    pending.clear();
  };
  current.on("error", fail);
  current.on("exit", fail);
  current.on("message", (message: { request_id: number; projection: NavigationProjection | null; error?: string }) => {
    const request = pending.get(message.request_id);
    if (!request) return;
    pending.delete(message.request_id);
    if (message.error) request.reject(new Error("navigation_projection_read_failed"));
    else request.resolve(message.projection);
    if (!pending.size) current.unref();
  });
  current.unref();
  return current;
}

/** Validate old journals away from request handling. Controls never use this
 * navigation cache. Concurrent observers share one bounded read-only worker. */
export function readNavigationProjectionAsync(filePath: string): Promise<NavigationProjection | null> {
  const existing = inFlight.get(filePath);
  if (existing) return existing;
  if (pending.size >= 64) return Promise.reject(new Error("navigation_projection_queue_full"));
  const current = reader(), request_id = ++sequence;
  const request: Promise<NavigationProjection | null> = new Promise<NavigationProjection | null>((resolve, reject) => {
    pending.set(request_id, { resolve, reject });
    current.ref();
    try { current.postMessage({ request_id, filePath }); }
    catch { pending.delete(request_id); if (!pending.size) current.unref(); reject(new Error("navigation_projection_worker_unavailable")); }
  }).finally(() => { if (inFlight.get(filePath) === request) inFlight.delete(filePath); });
  inFlight.set(filePath, request);
  return request;
}
