import { parentPort } from "node:worker_threads";
import { readNavigationProjection } from "./task_navigation_projection.js";

// Fixed read-only module: no dynamic code, provider, native calls or controls.
parentPort?.on("message", (message: { request_id: number; filePath: string }) => {
  if (!Number.isSafeInteger(message?.request_id) || typeof message.filePath !== "string") return;
  try { parentPort!.postMessage({ request_id: message.request_id, projection: readNavigationProjection(message.filePath) }); }
  catch { parentPort!.postMessage({ request_id: message.request_id, error: "navigation_projection_read_failed" }); }
});
