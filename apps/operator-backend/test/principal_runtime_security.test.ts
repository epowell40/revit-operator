import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveAuthMode } from "../src/auth.js";
import { deriveImprovementOperatorProfile } from "../src/improvement/job_store.js";
import { getScopedWorkspaceRoot, type RequestPrincipal } from "../src/request_context.js";
import { isHostedRuntime, resolveRuntimeMode } from "../src/runtime_mode.js";
import { workbenchEnabled } from "../src/workbench/workbench_runner.js";

const RUNTIME_ENV_KEYS = [
  "REVIT_OPERATOR_MODE",
  "OPERATOR_HOSTED_ENABLED",
  "OPERATOR_AUTH_MODE",
  "OPERATOR_WORKBENCH_ENABLED",
  "AWS_EXECUTION_ENV",
  "EC2_HOME"
] as const;

function withRuntimeEnv(values: Partial<Record<(typeof RUNTIME_ENV_KEYS)[number], string>>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of RUNTIME_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function principal(tenantId: string, userId: string): RequestPrincipal {
  return {
    sub: userId,
    user_id: userId,
    tenant_id: tenantId,
    license_id: tenantId,
    roles: ["user"],
    tier: null,
    claims: {}
  };
}

test("hosted runtime inference selects principal auth and permanently fences the full workbench", { concurrency: false }, () => {
  for (const hostedEnv of [
    { REVIT_OPERATOR_MODE: "hosted" },
    { OPERATOR_HOSTED_ENABLED: "true" }
  ]) {
    withRuntimeEnv({ ...hostedEnv, OPERATOR_WORKBENCH_ENABLED: "1" }, () => {
      assert.equal(isHostedRuntime(), true);
      assert.equal(resolveAuthMode(), "principal_jwt");
      assert.equal(workbenchEnabled(), false);
    });
  }
});

test("unknown runtime and hosted flag values fail closed", { concurrency: false }, () => {
  withRuntimeEnv({ REVIT_OPERATOR_MODE: "mystery" }, () => {
    assert.throws(() => resolveRuntimeMode(), /Unsupported REVIT_OPERATOR_MODE: mystery/);
    assert.throws(() => resolveAuthMode(), /Unsupported REVIT_OPERATOR_MODE: mystery/);
    assert.throws(() => workbenchEnabled(), /Unsupported REVIT_OPERATOR_MODE: mystery/);
  });
  withRuntimeEnv({ OPERATOR_HOSTED_ENABLED: "sometimes" }, () => {
    assert.throws(() => isHostedRuntime(), /Unsupported OPERATOR_HOSTED_ENABLED: sometimes/);
  });
});

test("local and self-hosted shared-token compatibility remains enabled", { concurrency: false }, () => {
  for (const mode of ["local", "self_hosted"] as const) {
    withRuntimeEnv({ REVIT_OPERATOR_MODE: mode }, () => {
      assert.equal(resolveRuntimeMode(), mode);
      assert.equal(resolveAuthMode(), "shared_token");
      assert.equal(workbenchEnabled(), true);
    });
  }
});

test("non-hosted principal auth requires an explicit full-workbench opt-in", { concurrency: false }, () => {
  withRuntimeEnv({ REVIT_OPERATOR_MODE: "self_hosted", OPERATOR_AUTH_MODE: "principal_jwt" }, () => {
    assert.equal(workbenchEnabled(), false);
  });
  withRuntimeEnv({
    REVIT_OPERATOR_MODE: "self_hosted",
    OPERATOR_AUTH_MODE: "principal_jwt",
    OPERATOR_WORKBENCH_ENABLED: "true"
  }, () => {
    assert.equal(workbenchEnabled(), true);
  });
});

test("principal JWT does not imply a vendor or infrastructure environment", { concurrency: false }, () => {
  withRuntimeEnv({ OPERATOR_AUTH_MODE: "principal_jwt" }, () => {
    assert.equal(deriveImprovementOperatorProfile().environment, "dev_workstation");
  });
  withRuntimeEnv({ OPERATOR_AUTH_MODE: "principal_jwt", REVIT_OPERATOR_MODE: "hosted" }, () => {
    assert.equal(deriveImprovementOperatorProfile().environment, "hosted_production");
  });
  withRuntimeEnv({ OPERATOR_AUTH_MODE: "principal_jwt", AWS_EXECUTION_ENV: "AWS_ECS_EC2" }, () => {
    assert.equal(deriveImprovementOperatorProfile().environment, "ec2_production");
  });
});

test("workspace paths hash exact case-sensitive raw claims before slugging or truncation", () => {
  const base = path.resolve("operator-workspace-test-root");
  const punctuationA = getScopedWorkspaceRoot(base, principal("tenant/a", "user:a"));
  const punctuationB = getScopedWorkspaceRoot(base, principal("tenant?a", "user?a"));
  const caseA = getScopedWorkspaceRoot(base, principal("Tenant", "Alice"));
  const caseB = getScopedWorkspaceRoot(base, principal("tenant", "alice"));
  const longPrefix = "x".repeat(160);
  const truncatedA = getScopedWorkspaceRoot(base, principal(`${longPrefix}-a`, `${longPrefix}-a`));
  const truncatedB = getScopedWorkspaceRoot(base, principal(`${longPrefix}-b`, `${longPrefix}-b`));

  assert.notEqual(punctuationA.toLowerCase(), punctuationB.toLowerCase());
  assert.notEqual(caseA.toLowerCase(), caseB.toLowerCase());
  assert.notEqual(truncatedA.toLowerCase(), truncatedB.toLowerCase());
  assert.equal(getScopedWorkspaceRoot(base, principal("tenant/a", "user:a")), punctuationA);

  const relativeSegments = path.relative(base, punctuationA).split(path.sep);
  assert.deepEqual(relativeSegments.slice(0, 1), ["tenants"]);
  assert.match(relativeSegments[1] ?? "", /^tenant_a--[0-9a-f]{64}$/);
  assert.equal(relativeSegments[2], "users");
  assert.match(relativeSegments[3] ?? "", /^user_a--[0-9a-f]{64}$/);
  assert.equal(relativeSegments[4], "Workspace");
});
