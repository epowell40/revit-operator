import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchWebEvidence } from "../src/web_research/fetch.js";
import type { WebResearchPolicy } from "../src/web_research/policy.js";

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("web evidence writing: successful HTML fetch writes snapshot/text/meta", async () => {
  const root = tmpWorkspace();
  const policy: WebResearchPolicy = { mode: "unrestricted", allowlistDomains: [], denylistDomains: [] };

  const html = "<html><head><title>Example</title></head><body><h1>Hello</h1><p>World</p></body></html>";
  const fetchImpl = async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

  const r = await fetchWebEvidence({ requestId: "r1", url: "https://example.com", policy, fetchImpl: fetchImpl as any });
  assert.equal(r.ok, true);
  assert.ok(typeof r.evidence_dir === "string" && r.evidence_dir.length > 0);
  assert.ok(typeof r.meta_path === "string" && r.meta_path.length > 0);

  const metaFull = path.join(root, r.meta_path!.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(metaFull));
  const meta = JSON.parse(fs.readFileSync(metaFull, "utf8"));
  assert.equal(meta.ok, true);
  assert.equal(meta.url, "https://example.com");

  if (r.snapshot_path) {
    const snapFull = path.join(root, r.snapshot_path.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(snapFull));
  } else {
    assert.fail("expected snapshot_path");
  }

  if (r.text_path) {
    const txtFull = path.join(root, r.text_path.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(txtFull));
    const txt = fs.readFileSync(txtFull, "utf8");
    assert.match(txt, /Hello/);
    assert.match(txt, /World/);
  } else {
    assert.fail("expected text_path");
  }
});

test("web evidence writing: blocked domain still writes metadata", async () => {
  const root = tmpWorkspace();
  const policy: WebResearchPolicy = { mode: "whitelist", allowlistDomains: ["example.com"], denylistDomains: [] };

  const fetchImpl = async () => {
    throw new Error("should not be called");
  };

  const r = await fetchWebEvidence({ requestId: "r2", url: "https://evil.com", policy, fetchImpl: fetchImpl as any });
  assert.equal(r.ok, false);
  assert.ok(typeof r.meta_path === "string" && r.meta_path.length > 0);

  const metaFull = path.join(root, r.meta_path!.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(metaFull));
  const meta = JSON.parse(fs.readFileSync(metaFull, "utf8"));
  assert.equal(meta.ok, false);
  assert.match(String(meta.error ?? ""), /whitelist/i);
});

test("web evidence writing: paywall-like 403 gets flagged", async () => {
  const root = tmpWorkspace();
  const policy: WebResearchPolicy = { mode: "unrestricted", allowlistDomains: [], denylistDomains: [] };

  const html = "<html><head><title>Paywall</title></head><body>Subscribe to continue reading</body></html>";
  const fetchImpl = async () => new Response(html, { status: 403, headers: { "content-type": "text/html" } });

  const r = await fetchWebEvidence({ requestId: "r3", url: "https://example.com/paywall", policy, fetchImpl: fetchImpl as any });
  assert.equal(r.ok, false);
  assert.equal(r.paywall, true);
  assert.ok(typeof r.meta_path === "string" && r.meta_path.length > 0);

  const metaFull = path.join(root, r.meta_path!.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(metaFull));
  const meta = JSON.parse(fs.readFileSync(metaFull, "utf8"));
  assert.equal(meta.paywall, true);
});

test("web evidence writing: fetch error still writes metadata", async () => {
  const root = tmpWorkspace();
  const policy: WebResearchPolicy = { mode: "unrestricted", allowlistDomains: [], denylistDomains: [] };

  const fetchImpl = async () => {
    throw new Error("network down");
  };

  const r = await fetchWebEvidence({ requestId: "r4", url: "https://example.com", policy, fetchImpl: fetchImpl as any });
  assert.equal(r.ok, false);
  assert.match(String(r.error ?? ""), /network down/i);

  const metaFull = path.join(root, r.meta_path!.replace(/\//g, path.sep));
  assert.ok(fs.existsSync(metaFull));
  const meta = JSON.parse(fs.readFileSync(metaFull, "utf8"));
  assert.equal(meta.ok, false);
  assert.match(String(meta.error ?? ""), /network down/i);
});

