import test from "node:test";
import assert from "node:assert/strict";
import { getWebResearchPolicyFromEnv, isUrlAllowedByPolicy } from "../src/web_research/policy.js";

test("web research policy: default env fallback is unrestricted", () => {
  const p = getWebResearchPolicyFromEnv({} as any);
  assert.equal(p.mode, "unrestricted");
  assert.equal(isUrlAllowedByPolicy("https://example.com", p).ok, true);
});

test("web research policy: off blocks", () => {
  const p = getWebResearchPolicyFromEnv({ OPERATOR_WEB_RESEARCH_MODE: "off" } as any);
  const r = isUrlAllowedByPolicy("https://example.com", p);
  assert.equal(r.ok, false);
});

test("web research policy: whitelist enforces domains (incl subdomains)", () => {
  const p = getWebResearchPolicyFromEnv({
    OPERATOR_WEB_RESEARCH_MODE: "whitelist",
    OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS: "example.com,*.allowed.test"
  } as any);

  assert.equal(isUrlAllowedByPolicy("https://example.com/a", p).ok, true);
  assert.equal(isUrlAllowedByPolicy("https://sub.example.com/a", p).ok, true);
  assert.equal(isUrlAllowedByPolicy("https://deep.sub.example.com/a", p).ok, true);
  assert.equal(isUrlAllowedByPolicy("https://allowed.test/a", p).ok, true);
  assert.equal(isUrlAllowedByPolicy("https://x.allowed.test/a", p).ok, true);

  const blocked = isUrlAllowedByPolicy("https://evil.com/a", p);
  assert.equal(blocked.ok, false);
});

test("web research policy: unrestricted denies denylist", () => {
  const p = getWebResearchPolicyFromEnv({
    OPERATOR_WEB_RESEARCH_MODE: "unrestricted",
    OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS: "evil.com,*.blocked.test"
  } as any);

  assert.equal(isUrlAllowedByPolicy("https://example.com", p).ok, true);
  assert.equal(isUrlAllowedByPolicy("https://evil.com", p).ok, false);
  assert.equal(isUrlAllowedByPolicy("https://sub.evil.com", p).ok, false);
  assert.equal(isUrlAllowedByPolicy("https://blocked.test", p).ok, false);
  assert.equal(isUrlAllowedByPolicy("https://x.blocked.test", p).ok, false);
});

