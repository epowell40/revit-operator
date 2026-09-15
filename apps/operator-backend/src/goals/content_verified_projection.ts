import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Existing Goal JSON recovery behavior, shared without caching mutable records. */
export function readJsonWithBackup<T>(filePath: string): T | null {
  for (const candidate of [filePath, `${filePath}.previous`]) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")) as T;
    } catch {
      // A torn/corrupt primary falls back to the last atomically replaced copy.
    }
  }
  return null;
}

/** A cache of validated projections, never a substitute for reading persisted
 * bytes. Same-size rewrites, timestamp restoration and atomic file replacement
 * all change the digest and require the original projector to run again. */
export function createContentVerifiedProjection<T>(
  project: (record: unknown) => T,
  options: Readonly<{ maxEntries?: number; maxProjectionBytes?: number }> = {}
): Readonly<{ read: (filePath: string) => T | null; reset: () => void }> {
  const maxEntries = options.maxEntries ?? 64;
  const maxProjectionBytes = options.maxProjectionBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256
      || !Number.isSafeInteger(maxProjectionBytes) || maxProjectionBytes < 1) {
    throw new Error("content_projection_cache_bounds_invalid");
  }
  const entries = new Map<string, { digest: string; value: T; size: number }>();
  let retainedBytes = 0;
  const remove = (key: string) => {
    const previous = entries.get(key);
    if (previous) { retainedBytes -= previous.size; entries.delete(key); }
  };
  const retain = (key: string, digest: string, value: T) => {
    remove(key);
    const retained = structuredClone(value);
    const size = Buffer.byteLength(JSON.stringify(retained));
    if (size > maxProjectionBytes) return;
    entries.set(key, { digest, value: retained, size });
    retainedBytes += size;
    while (entries.size > maxEntries || retainedBytes > maxProjectionBytes) {
      remove(entries.keys().next().value!);
    }
  };
  return {
    read(filePath: string): T | null {
      const primary = path.resolve(filePath);
      for (const candidate of [primary, `${primary}.previous`]) {
        let raw: Buffer;
        try { raw = fs.readFileSync(candidate); }
        catch { continue; }
        const digest = createHash("sha256").update(raw).digest("hex");
        const cached = entries.get(candidate);
        if (cached?.digest === digest) {
          entries.delete(candidate);
          entries.set(candidate, cached);
          return structuredClone(cached.value);
        }
        let record: unknown;
        try { record = JSON.parse(raw.toString("utf8")); }
        catch { remove(candidate); continue; }
        // Keep the existing file/JSON backup recovery behavior. A semantic
        // validation error must propagate, never reveal an older valid state.
        const projected = project(record);
        retain(candidate, digest, projected);
        return projected;
      }
      return null;
    },
    reset(): void { entries.clear(); retainedBytes = 0; }
  };
}
