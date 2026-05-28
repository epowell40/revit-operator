import test from "node:test";
import assert from "node:assert/strict";

import { redactString, redactUnknown } from "../src/improvement/redact.js";

test("redactString removes paths, emails, and tokens", () => {
  const raw = "Email a@b.com and open C:\\Users\\Alice\\ClientX\\model.rvt with Bearer abcdefghijklmnopqrstuvwxyz0123456789";
  const red = redactString(raw, { workspaceRoot: "C:\\Users\\Alice\\AppData\\Local\\RevitOperator\\Workspace" });
  assert.ok(!red.includes("a@b.com"));
  assert.ok(!red.includes("C:\\Users\\Alice\\ClientX\\model.rvt"));
  assert.ok(red.includes("<email>"));
  assert.ok(red.includes("<user-home>") || red.includes("<path>"));
  assert.ok(red.includes("Bearer <token>"));
});

test("redactUnknown walks objects and preserves structure", () => {
  const v = {
    p: "C:\\Users\\Bob\\secret.txt",
    nested: { email: "bob@example.com" },
    arr: ["C:\\x\\y\\z", 1, true]
  };
  const r = redactUnknown(v);
  assert.equal(typeof r, "object");
  assert.equal(typeof (r as any).p, "string");
  assert.ok((r as any).p.includes("<"));
  assert.ok((r as any).nested.email.includes("<email>"));
});

