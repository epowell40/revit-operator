import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createContentVerifiedProjection } from "../src/goals/content_verified_projection.js";

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-content-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function numericRecord(value: unknown): { n: number } { return value as { n: number }; }

test("unchanged actual bytes reuse a validated projection with no mutable aliases", t => {
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, '{"n":1}');
  let calls = 0;
  const cache = createContentVerifiedProjection(value => { calls++; return numericRecord(value); });
  cache.read(file)!.n = 7;
  cache.read(file)!.n = 8;
  assert.deepEqual(cache.read(file), { n: 1 });
  assert.equal(calls, 1);
});

test("same-size rewrites with restored timestamps require fresh projection", t => {
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, '{"n":1}');
  let calls = 0;
  const cache = createContentVerifiedProjection(value => { calls++; return numericRecord(value); });
  assert.equal(cache.read(file)!.n, 1);
  const stamp = fs.statSync(file);
  fs.writeFileSync(file, '{"n":2}');
  fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.equal(cache.read(file)!.n, 2);
  assert.equal(calls, 2);
});

test("semantic rejection cannot recover an earlier valid cache or backup", t => {
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, '{"n":1}');
  fs.writeFileSync(file + ".previous", '{"n":2}');
  const cache = createContentVerifiedProjection(value => {
    const record = numericRecord(value);
    assert.ok(record.n > 0);
    return record;
  });
  assert.equal(cache.read(file)!.n, 1);
  fs.writeFileSync(file, '{"n":0}');
  assert.throws(() => cache.read(file));
});

test("torn primary uses current backup and repaired primary takes precedence", t => {
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, "broken");
  fs.writeFileSync(file + ".previous", '{"n":2}');
  const cache = createContentVerifiedProjection(numericRecord);
  assert.equal(cache.read(file)!.n, 2);
  fs.writeFileSync(file, '{"n":3}');
  assert.equal(cache.read(file)!.n, 3);
  fs.unlinkSync(file);
  fs.writeFileSync(file + ".previous", '{"n":4}');
  assert.equal(cache.read(file)!.n, 4);
  fs.unlinkSync(file + ".previous");
  assert.equal(cache.read(file), null);
});

test("different storage paths and bounded least-recently-used entries remain separate", t => {
  const root = fixture(t), one = path.join(root, "one.json"), two = path.join(root, "two.json");
  fs.writeFileSync(one, '{"n":1}');
  fs.writeFileSync(two, '{"n":2}');
  let calls = 0;
  const cache = createContentVerifiedProjection(value => { calls++; return numericRecord(value); }, { maxEntries: 1, maxProjectionBytes: 32 });
  assert.equal(cache.read(one)!.n, 1);
  assert.equal(cache.read(two)!.n, 2);
  assert.equal(cache.read(one)!.n, 1);
  assert.equal(calls, 3);
});

test("invalid bounds are rejected and oversized projections are not retained", t => {
  assert.throws(() => createContentVerifiedProjection(value => value, { maxEntries: -1 }), /bounds/);
  assert.throws(() => createContentVerifiedProjection(value => value, { maxProjectionBytes: NaN }), /bounds/);
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, '{"n":"a deliberately oversized projection"}');
  let calls = 0;
  const cache = createContentVerifiedProjection(value => { calls++; return value; }, { maxProjectionBytes: 8 });
  cache.read(file);
  cache.read(file);
  assert.equal(calls, 2);
});

test("only values decoded from persisted JSON are retained", t => {
  const file = path.join(fixture(t), "goal.json");
  fs.writeFileSync(file, JSON.stringify({ n: NaN }));
  const cache = createContentVerifiedProjection(value => value);
  assert.deepEqual(cache.read(file), { n: null });
  assert.deepEqual(cache.read(file), { n: null });
});

test("atomic replacement invalidates a warm result at the same path", t => {
  const root = fixture(t), file = path.join(root, "goal.json"), replacement = path.join(root, "next.json");
  fs.writeFileSync(file, '{"n":1}');
  const cache = createContentVerifiedProjection(numericRecord);
  assert.equal(cache.read(file)!.n, 1);
  fs.writeFileSync(replacement, '{"n":2}');
  fs.renameSync(replacement, file);
  assert.equal(cache.read(file)!.n, 2);
});
