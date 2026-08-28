import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrincipalBoundSessionIdForRequest,
  createUnboundSessionIdForRequest,
  isSessionIdBoundToPrincipal,
  type RequestPrincipal
} from "../src/request_context.js";

function principal(userId: string, tenantId = "tenant-a"): RequestPrincipal {
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

test("session creation request identity is stable for response-loss retries", () => {
  const owner = principal("user-a");
  const first = createPrincipalBoundSessionIdForRequest(owner, "candidate8-session-start");
  const retried = createPrincipalBoundSessionIdForRequest(owner, "candidate8-session-start");

  assert.equal(retried, first);
  assert.equal(isSessionIdBoundToPrincipal(first, owner), true);
  assert.match(first, /^ps1_[A-Za-z0-9_-]{20}_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("session creation request identity cannot merge principals or requests", () => {
  const requestId = "shared-client-request";
  const owner = principal("user-a");
  const first = createPrincipalBoundSessionIdForRequest(owner, requestId);

  assert.notEqual(createPrincipalBoundSessionIdForRequest(principal("user-b"), requestId), first);
  assert.notEqual(createPrincipalBoundSessionIdForRequest(principal("user-a", "tenant-b"), requestId), first);
  assert.notEqual(createPrincipalBoundSessionIdForRequest(owner, "different-client-request"), first);
  assert.notEqual(createUnboundSessionIdForRequest(requestId), first);
  assert.equal(createUnboundSessionIdForRequest(requestId), createUnboundSessionIdForRequest(requestId));
});
