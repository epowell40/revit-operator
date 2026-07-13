import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExternalWriteGrant, writeExternalWriteGrant } from "./externalWriteGrant.js";

test("creates a Revit-compatible short-lived once grant", () => {
  const operatorToken = "operator-test-token";
  const grant = createExternalWriteGrant({
    operatorToken,
    mode: "once",
    ttlMinutes: 10,
    now: new Date("2026-07-13T16:00:00.000Z"),
    grantToken: "granttesttoken"
  });
  const key = crypto.createHash("sha256").update(`write_grant|${operatorToken}`, "utf8").digest();
  const payload = "1|granttesttoken|once|2026-07-13T16:00:00.000Z|2026-07-13T16:10:00.000Z|1";
  const expected = crypto.createHmac("sha256", key).update(payload, "utf8").digest("base64");

  assert.equal(grant.uses_remaining, 1);
  assert.equal(grant.sig, expected);
});

test("caps pane-free grants and writes only the workspace grant file", () => {
  assert.throws(
    () => createExternalWriteGrant({ operatorToken: "token", mode: "session", ttlMinutes: 16 }),
    /between 1 and 15/
  );
  assert.throws(
    () => createExternalWriteGrant({ operatorToken: "token", mode: "yolo" as any }),
    /only 'once' or 'session'/
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-grant-"));
  try {
    const grant = createExternalWriteGrant({ operatorToken: "token", mode: "session", grantToken: "sessiontoken" });
    const grantPath = writeExternalWriteGrant(root, grant);
    assert.equal(grantPath, path.join(root, "write_grant.json"));
    assert.equal(JSON.parse(fs.readFileSync(grantPath, "utf8")).token, "sessiontoken");
    assert.deepEqual(fs.readdirSync(root), ["write_grant.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
