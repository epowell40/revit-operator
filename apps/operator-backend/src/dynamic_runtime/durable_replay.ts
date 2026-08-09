import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DynamicAdmissionReplayAuthority } from "./admission.js";

/**
 * Cross-process replay authority backed by a synchronous FULL SQLite transaction.
 * A crash before commit leaves the key reusable; a committed key is durable and
 * can never be made reusable before its admission expiry by a stale lock file.
 */
export class DurableDynamicAdmissionReplayAuthority implements DynamicAdmissionReplayAuthority {
  constructor(private readonly filePath: string) {}

  consume(replayKey: string, expiresUnixSeconds: number, nowUnixSeconds: number): boolean {
    if (!/^sha256:[0-9a-f]{64}$/.test(replayKey) || !Number.isSafeInteger(expiresUnixSeconds) || expiresUnixSeconds <= nowUnixSeconds) return false;
    const directory = path.dirname(path.resolve(this.filePath));
    fs.mkdirSync(directory, { recursive: true });
    requireNoSymlink(directory);
    const database = new Database(path.resolve(this.filePath));
    try {
      database.pragma("journal_mode = DELETE");
      database.pragma("synchronous = FULL");
      database.pragma("busy_timeout = 2000");
      database.exec("CREATE TABLE IF NOT EXISTS consumed_admission (replay_key TEXT PRIMARY KEY NOT NULL, expires_unix_seconds INTEGER NOT NULL) WITHOUT ROWID");
      const consume = database.transaction(() => {
        database.prepare("DELETE FROM consumed_admission WHERE expires_unix_seconds <= ?").run(nowUnixSeconds);
        return database.prepare("INSERT OR IGNORE INTO consumed_admission(replay_key, expires_unix_seconds) VALUES (?, ?)").run(replayKey, expiresUnixSeconds).changes === 1;
      });
      return consume.immediate();
    } finally {
      database.close();
    }
  }
}

function requireNoSymlink(directory: string): void {
  const resolved = path.resolve(directory); const parsed = path.parse(resolved); const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Dynamic admission replay storage crosses a symbolic link.");
  }
}
