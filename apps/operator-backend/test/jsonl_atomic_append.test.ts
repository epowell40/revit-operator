import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicAppendJsonlLine } from "../src/persistence/jsonl.js";

test("atomic JSONL append writes valid line-delimited JSON (no corruption)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-jsonl-"));
  const filePath = path.join(dir, "logs", "t.jsonl");

  const n = 60;
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      Promise.resolve().then(() => {
        atomicAppendJsonlLine(filePath, { i, t: `v${i}` });
      })
    )
  );

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert.equal(lines.length, n);

  const parsed = lines.map(l => JSON.parse(l));
  assert.equal(parsed.length, n);
  // Ensure each record has an i.
  const ids = new Set(parsed.map(p => p.i));
  assert.equal(ids.size, n);
});

