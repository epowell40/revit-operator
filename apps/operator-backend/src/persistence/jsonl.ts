import fs from "node:fs";
import path from "node:path";

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const wrote = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (!Number.isFinite(wrote) || wrote <= 0) throw new Error("Failed to write JSONL line.");
    offset += wrote;
  }
}

export function atomicAppendJsonlLine(filePath: string, record: unknown): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }

  const line = JSON.stringify(record) + "\n";
  const buf = Buffer.from(line, "utf8");

  // Open/append/fsync/close for crash safety. This is slower than keeping FDs open,
  // but matches the Phase 1 "flush every append" requirement.
  const fd = fs.openSync(filePath, "a");
  try {
    writeAllSync(fd, buf);
    try {
      fs.fsyncSync(fd);
    } catch {
      // best-effort; some filesystems may not support fsync semantics fully
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

