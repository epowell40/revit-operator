const USER_OVERRIDE_MODES = new Set(["off", "once", "session", "yolo"]);

export function activeSessionTokenForRenewal({ grant, signatureValid, nowMs = Date.now() } = {}) {
  if (signatureValid !== true || grant?.version !== 1 || grant?.mode !== "session"
      || grant?.uses_remaining != null || typeof grant?.token !== "string" || !grant.token.trim()) return null;
  const expiresAt = Date.parse(`${grant.expires_at_utc || ""}`);
  return Number.isFinite(expiresAt) && expiresAt > nowMs ? grant.token : null;
}

function normalizedOverrideMode(value) {
  if (value == null) return null;
  const mode = `${value}`.trim().toLowerCase();
  return USER_OVERRIDE_MODES.has(mode) ? mode : "invalid";
}

export function decideWriteGrantRefresh({
  generalAgent,
  userOverrideMode = null,
  status,
  nowMs = Date.now(),
  refreshThresholdMs = 2 * 60 * 1000
} = {}) {
  if (generalAgent !== true) {
    return Object.freeze({ refresh: false, mode: null, reason: "general_agent_unavailable" });
  }

  const overrideMode = normalizedOverrideMode(userOverrideMode);
  if (overrideMode === "invalid") {
    return Object.freeze({ refresh: false, mode: null, reason: "invalid_user_override" });
  }
  if (overrideMode && overrideMode !== "session") {
    return Object.freeze({ refresh: false, mode: null, reason: `explicit_${overrideMode}` });
  }

  const expiresAt = Date.parse(`${status?.expires_at_utc || ""}`);
  const expiresSoon = status?.active !== true
    || !Number.isFinite(expiresAt)
    || expiresAt <= nowMs + refreshThresholdMs;
  const explicitSessionModeMismatch = overrideMode === "session"
    && `${status?.mode || ""}`.trim().toLowerCase() !== "session";
  if (!expiresSoon && !explicitSessionModeMismatch) {
    return Object.freeze({ refresh: false, mode: null, reason: "current_grant_sufficient" });
  }
  return Object.freeze({
    refresh: true,
    mode: "session",
    reason: explicitSessionModeMismatch ? "explicit_session_mode_mismatch" : "session_lease_expiring"
  });
}

// A long backend delegation must not depend on a visible browser polling the
// grant endpoint. This pulse extends only an existing, valid Session lease;
// expired/revoked authority requires the normal user admission path.
export async function renewForegroundSessionLease({
  isWorkActive, readRuntimeProfile, readStatus, readOverrideMode, renew, now = Date.now
}) {
  if (!isWorkActive()) return false;
  const profile = await readRuntimeProfile();
  // Recheck after the network wait: Pause/Off or expiry can occur meanwhile.
  if (!isWorkActive()) return false;
  const status = readStatus();
  if (status?.active !== true || status?.mode !== "session" || status?.uses_remaining != null) return false;
  if (!(Date.parse(`${status.expires_at_utc || ""}`) > now())) return false;
  const decision = decideWriteGrantRefresh({
    generalAgent: profile?.general_agent === true,
    userOverrideMode: readOverrideMode(), status, nowMs: now()
  });
  if (!decision.refresh) return false;
  renew();
  return true;
}
