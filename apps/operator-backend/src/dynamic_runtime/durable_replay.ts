import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DynamicAdmissionReplayAuthority } from "./admission.js";

const SCHEMA = "dynamic_program_replay_state/v1";
type State = { schema: typeof SCHEMA; consumed: Record<string, number> };

export class DurableDynamicAdmissionReplayAuthority implements DynamicAdmissionReplayAuthority {
  constructor(private readonly filePath: string, private readonly lockWaitMilliseconds = 2000) {}

  consume(replayKey: string, expiresUnixSeconds: number, nowUnixSeconds: number): boolean {
    if (!/^sha256:[0-9a-f]{64}$/.test(replayKey) || !Number.isSafeInteger(expiresUnixSeconds) || expiresUnixSeconds <= nowUnixSeconds) return false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockWaitMilliseconds;
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      try { descriptor = fs.openSync(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) return false;
      }
    }
    try {
      const state = this.read();
      for (const [key, expiry] of Object.entries(state.consumed)) if (expiry <= nowUnixSeconds) delete state.consumed[key];
      if (state.consumed[replayKey] !== undefined) return false;
      state.consumed[replayKey] = expiresUnixSeconds;
      this.write(state);
      return true;
    } finally {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { }
      try { fs.unlinkSync(lockPath); } catch { }
    }
  }

  private read(): State {
    if (!fs.existsSync(this.filePath)) return { schema: SCHEMA, consumed: {} };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Dynamic admission replay state is malformed.");
    const record = parsed as Record<string, unknown>;
    if (record.schema !== SCHEMA || !record.consumed || typeof record.consumed !== "object" || Array.isArray(record.consumed)) {
      throw new Error("Dynamic admission replay state schema is invalid.");
    }
    const consumed: Record<string, number> = {};
    for (const [key, value] of Object.entries(record.consumed as Record<string, unknown>)) {
      if (!/^sha256:[0-9a-f]{64}$/.test(key) || typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Dynamic admission replay entry is invalid.");
      consumed[key] = value;
    }
    return { schema: SCHEMA, consumed };
  }

  private write(state: State): void {
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID().replaceAll("-", "")}`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(state, null, 2) + "\n", "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
    } finally {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { }
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { }
    }
  }
}
