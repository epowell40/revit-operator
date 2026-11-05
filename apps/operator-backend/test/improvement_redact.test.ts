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

test("short structured credentials are removed independently of length and nesting", () => {
  const value = { api_key: "short", nested: { password: 1234, OPENAI_API_KEY: "tiny", clientSecret: "x",
    refresh_token: "r", authorization: "Basic c2hvcnQ=", cookie: "sid=small" },
    credentials: { username: "synthetic", password: "hidden" },
    list: [{ AWS_SECRET_ACCESS_KEY: "s" }, { name: "X-Api-Key", value: "abc" }, { key: "Authorization", value: "Bearer a" }] };
  const result = redactUnknown(value);
  for (const item of [result.api_key, ...Object.values(result.nested), result.credentials,
    result.list[0].AWS_SECRET_ACCESS_KEY, result.list[1].value, result.list[2].value])
    assert.equal(item, "<redacted:credential>");
  assert.equal(value.api_key, "short", "export redaction must not alter retained source evidence");
});

test("credential-shaped text is scrubbed without consuming adjacent diagnostics", () => {
  const value = 'api_key=tiny&status=failed\n{"password":"x","token_count":12}\nAuthorization: Basic short\nnext=ready';
  const result = redactString(value);
  for (const secret of ["tiny", '"x"', "Basic short"]) assert.ok(!result.includes(secret));
  assert.ok(result.includes("status=failed"));
  assert.ok(result.includes('"token_count":12'));
  assert.ok(result.includes("next=ready"));
  assert.ok(!redactString("Bearer a").includes("Bearer a"));
  assert.ok(!redactString("HTTP failed; Authorization: Bearer tiny").includes("tiny"));
});

test("header records and prototype-shaped input cannot bypass structured redaction", () => {
  const value = JSON.parse('{"__proto__":{"api_key":"small"},"headers":[{"Name":"Authorization","Value":"Basic small"}]}');
  const result = redactUnknown(value);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(Object.hasOwn(result, "__proto__"));
  assert.equal(result.__proto__.api_key, "<redacted:credential>");
  assert.equal(result.headers[0].Value, "<redacted:credential>");
});

test("ordinary task IDs counts flags and model keys remain diagnostic data", () => {
  const value = { token_count: 12, max_tokens: 50, secret_count: 0, has_api_key: true,
    password_present: false, source_hash: "sha256:short", key: "Comments", value: "KEEP",
    name: "Comments", status: "ready", api_key: null, nested: [{ name: "Mark", value: "P-1" }] };
  const result = redactUnknown(value);
  assert.deepEqual(result, value);
});

