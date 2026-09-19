import { retrieveMemoryContext } from "./jsonl_memory_store.js";

/** Historical context only. Native observations remain the authority for model state. */
export function formatTaskMemoryContext(sessionId: string, queryText: string, maxEntries: number): string {
  const memories = retrieveMemoryContext({ queryText, maxEntries, currentSessionId: sessionId });
  if (memories.length === 0) return "";
  return [
    "MEMORY CONTEXT (historical, read-only; not evidence of the current model state; cite by [M#]):",
    ...memories.map((m, i) => `[M${i + 1}] (${m.scope}/${m.kind}; recorded ${m.ts}; source ${m.source ?? "unspecified"}) ${m.text}`)
  ].join("\n");
}
