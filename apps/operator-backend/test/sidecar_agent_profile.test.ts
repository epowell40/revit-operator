import test from "node:test";
import assert from "node:assert/strict";
import { getSidecarAgentProfileState, SIDECAR_AGENT_PROFILE_SCHEMA } from "../src/capabilities/sidecar_agent_profile.js";

test("Sidecar general-agent profile requires exact development laboratory backend state", () => {
  const state = getSidecarAgentProfileState({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_BRAIN: "codex",
    OPERATOR_HOSTED_ENABLED: "0"
  });

  assert.deepEqual(state, {
    schema: SIDECAR_AGENT_PROFILE_SCHEMA,
    source: "backend_environment",
    runtime_mode: "development",
    tool_exposure_profile: "laboratory",
    capability_profile: "general_agent_laboratory",
    general_agent_ready: true,
    reason_code: "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY"
  });
  assert.equal(Object.isFrozen(state), true);
});

test("Sidecar refuses a rule-brain laboratory as not being the General Agent", () => {
  const state = getSidecarAgentProfileState({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_BRAIN: "rule",
    OPERATOR_HOSTED_ENABLED: "0"
  });
  assert.equal(state.capability_profile, "general_agent_unavailable");
  assert.equal(state.general_agent_ready, false);
  assert.equal(state.reason_code, "GENERAL_AGENT_UNAVAILABLE_GENERAL_BRAIN_REQUIRED");
});

test("Sidecar exposes the full General Agent by default for an authenticated hosted production provider", () => {
  for (const runtime of ["hosted", "production"]) {
    const state = getSidecarAgentProfileState({
      REVIT_OPERATOR_MODE: runtime,
      OPERATOR_AUTH_MODE: "principal_jwt",
      OPERATOR_BRAIN: "codex",
      OPERATOR_OPENAI_API_KEY: "test-provider-key"
    });
    assert.equal(state.capability_profile, "general_agent");
    assert.equal(state.tool_exposure_profile, "general");
    assert.equal(state.general_agent_ready, true);
    assert.equal(state.reason_code, "GENERAL_AGENT_HOSTED_PRODUCTION_READY");
  }
});

test("Sidecar hosted production readiness requires principal auth and a live general provider", () => {
  const missingPrincipal = getSidecarAgentProfileState({
    REVIT_OPERATOR_MODE: "hosted", OPERATOR_AUTH_MODE: "shared_token", OPERATOR_BRAIN: "codex", OPERATOR_OPENAI_API_KEY: "test-key"
  });
  assert.equal(missingPrincipal.reason_code, "GENERAL_AGENT_UNAVAILABLE_PRINCIPAL_AUTH_REQUIRED");
  assert.equal(missingPrincipal.tool_exposure_profile, "unavailable");

  const missingProvider = getSidecarAgentProfileState({
    REVIT_OPERATOR_MODE: "hosted", OPERATOR_AUTH_MODE: "principal_jwt", OPERATOR_BRAIN: "codex"
  });
  assert.equal(missingProvider.reason_code, "GENERAL_AGENT_UNAVAILABLE_PROVIDER_REQUIRED");
  assert.equal(missingProvider.general_agent_ready, false);
});

test("Sidecar laboratory escape rejects normalized lookalikes and incomplete configuration", () => {
  for (const env of [
    { REVIT_OPERATOR_MODE: "Development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development ", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "Laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: " laboratory" },
    { REVIT_OPERATOR_MODE: "development" },
    { OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    {}
  ]) {
    const state = getSidecarAgentProfileState(env);
    assert.equal(state.capability_profile, "general_agent_unavailable", JSON.stringify(env));
    assert.equal(state.tool_exposure_profile, "unavailable", JSON.stringify(env));
    assert.equal(state.general_agent_ready, false, JSON.stringify(env));
  }
});

test("Sidecar profile fails closed when the hosted flag is malformed", () => {
  assert.throws(() => getSidecarAgentProfileState({
    REVIT_OPERATOR_MODE: "development",
    OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_HOSTED_ENABLED: "sometimes"
  }), /Unsupported OPERATOR_HOSTED_ENABLED/);
});
