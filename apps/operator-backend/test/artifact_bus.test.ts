import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactShare, listArtifacts, resolveArtifactShare } from "../src/artifacts/artifact_bus.js";

test("artifact bus: listArtifacts returns files under artifacts/ by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  fs.mkdirSync(path.join(root, "artifacts", "exports"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts", "exports", "report.csv"), "a,b\n1,2\n", "utf8");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "note.txt"), "private", "utf8");

  const listed = listArtifacts({ recursive: true, limit: 100 });
  assert.equal(listed.prefix, "artifacts");
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.relative_path, "artifacts/exports/report.csv");
});

test("artifact bus: listArtifacts rejects prefixes outside artifacts/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  assert.throws(() => listArtifacts({ prefix: "../notes" }), /under artifacts/i);
});

test("artifact bus: createArtifactShare + resolveArtifactShare work for artifact files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const rel = "artifacts/exports/out.json";
  const full = path.join(root, "artifacts", "exports", "out.json");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "{\"ok\":true}", "utf8");

  const shared = createArtifactShare({ relativePath: rel, fileName: "result.json", ttlSeconds: 600 });
  assert.ok(shared.token.length > 8);
  assert.equal(shared.relative_path, rel);
  assert.equal(shared.file_name, "result.json");

  const resolved = resolveArtifactShare(shared.token);
  assert.ok(resolved);
  assert.equal(resolved?.relative_path, rel);
  assert.equal(resolved?.file_name, "result.json");
  assert.equal(path.resolve(resolved!.full_path), path.resolve(full));
});

test("artifact bus: createArtifactShare rejects non-artifact files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator_ws_"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const rel = "notes/private.txt";
  const full = path.join(root, "notes", "private.txt");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "top-secret", "utf8");

  assert.throws(() => createArtifactShare({ relativePath: rel }), /Only files under artifacts\//i);
});
