import assert from "node:assert/strict";
import test from "node:test";
import { codexResearchConfig } from "../src/codex/research_config.js";

test("ordinary agent research explicitly uses live search", () => {
  assert.deepEqual(codexResearchConfig(false, {}), { web_search: "live" });
});
test("certified, offline, domain-limited and denylisted research never bypass local policy with built-in search", () => {
  assert.equal(codexResearchConfig(true, {}).web_search, "disabled");
  for (const env of [{ OPERATOR_WEB_RESEARCH_MODE: "off" }, { OPERATOR_WEB_RESEARCH_MODE: "whitelist", OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS: "example.com" }, { OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS: "example.com" }]) {
    assert.equal(codexResearchConfig(false, env).web_search, "disabled");
  }
});
