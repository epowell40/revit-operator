import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type GoalAuthorityContext = {
  goal_id: string;
  session_id: string | null;
  criterion: string;
  goal_owner_principal_id: string | null;
};

export type GoalAuthorityEnvelope = {
  provider_id: string;
  assertion: unknown;
};

export type VerifiedGoalValidatorExecution = {
  provider_id: string;
  receipt_id: string;
  validator_id: string;
  method: string;
  status: "pass" | "fail" | "unknown";
  issued_at: string;
  expires_at: string;
};

export type VerifiedGoalHumanApproval = {
  provider_id: string;
  receipt_id: string;
  approver_principal_id: string;
  approver_role: string;
  method: string;
  status: "approved" | "rejected" | "unknown";
  issued_at: string;
  expires_at: string;
};

/**
 * Provider-neutral seam for trusted goal evidence. Hosted/private wiring can
 * install an offline signature verifier or another authenticated verifier
 * without teaching the public goal service about a particular identity vendor.
 */
export interface GoalEvidenceAuthorityProvider {
  readonly provider_id: string;
  verifyValidatorExecutionReceipt(
    envelope: GoalAuthorityEnvelope,
    context: GoalAuthorityContext
  ): VerifiedGoalValidatorExecution;
  verifyHumanApproval(
    envelope: GoalAuthorityEnvelope,
    context: GoalAuthorityContext
  ): VerifiedGoalHumanApproval;
}

export type AuthenticatedApprovalPrincipal = {
  principal_id: string;
  roles: string[];
};

export type LocalGoalEvidenceAuthority = GoalEvidenceAuthorityProvider & {
  issueValidatorExecutionReceipt(input: GoalAuthorityContext & {
    validator_id: string;
    method: string;
    status: "pass" | "fail" | "unknown";
    ttl_seconds?: number;
  }): GoalAuthorityEnvelope;
  issueHumanApproval(input: GoalAuthorityContext & {
    authenticated_principal: AuthenticatedApprovalPrincipal;
    method: string;
    status: "approved" | "rejected" | "unknown";
    ttl_seconds?: number;
  }): GoalAuthorityEnvelope;
};

type LocalReceiptPayload = {
  v: 1;
  receipt_id: string;
  kind: "validator_execution" | "human_approval";
  provider_id: string;
  goal_id: string;
  session_id: string | null;
  criterion: string;
  goal_owner_principal_id: string | null;
  subject_id: string;
  subject_role: string | null;
  method: string;
  status: "pass" | "fail" | "unknown" | "approved" | "rejected";
  issued_at_ms: number;
  expires_at_ms: number;
};

export type LocalGoalEvidenceAuthorityOptions = {
  secret: string | Buffer;
  provider_id?: string;
  allowed_approval_roles?: string[];
  now?: () => Date;
  default_ttl_seconds?: number;
  max_ttl_seconds?: number;
};

function nonEmpty(value: unknown, field: string, max = 1000): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > max) throw new Error(`${field} is too long.`);
  return text;
}

function normalizeContext(context: GoalAuthorityContext): GoalAuthorityContext {
  return {
    goal_id: nonEmpty(context.goal_id, "goal_id", 160),
    session_id: context.session_id === null ? null : nonEmpty(context.session_id, "session_id", 180),
    criterion: nonEmpty(context.criterion, "criterion", 1200),
    goal_owner_principal_id: context.goal_owner_principal_id === null
      ? null
      : nonEmpty(context.goal_owner_principal_id, "goal_owner_principal_id", 240)
  };
}

function samePrincipal(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function asEpochIso(value: number): string {
  return new Date(value).toISOString();
}

function safeSignatureEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function createLocalGoalEvidenceAuthority(options: LocalGoalEvidenceAuthorityOptions): LocalGoalEvidenceAuthority {
  const secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(options.secret, "utf8");
  if (secret.byteLength < 32) throw new Error("Goal authority HMAC secret must contain at least 32 bytes.");
  const providerId = nonEmpty(options.provider_id ?? "local-hmac-v1", "provider_id", 120);
  const allowedApprovalRoles = new Set(
    (options.allowed_approval_roles ?? ["goal_approver", "operator_admin", "administrator"])
      .map(role => String(role).trim().toLowerCase())
      .filter(Boolean)
  );
  if (allowedApprovalRoles.size === 0) throw new Error("At least one approval role is required.");
  const now = options.now ?? (() => new Date());
  const defaultTtlSeconds = Math.max(1, Math.min(3600, Math.trunc(options.default_ttl_seconds ?? 300)));
  const maxTtlSeconds = Math.max(defaultTtlSeconds, Math.min(86_400, Math.trunc(options.max_ttl_seconds ?? 3600)));

  const sign = (payload: LocalReceiptPayload): GoalAuthorityEnvelope => {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    return { provider_id: providerId, assertion: `${body}.${signature}` };
  };

  const parse = (envelope: GoalAuthorityEnvelope, context: GoalAuthorityContext, expectedKind: LocalReceiptPayload["kind"]): LocalReceiptPayload => {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("Trusted authority envelope is required.");
    }
    if (envelope.provider_id !== providerId) throw new Error("Goal evidence authority provider does not match the configured verifier.");
    const token = nonEmpty(envelope.assertion, "authority assertion", 32_768);
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Goal authority receipt is malformed.");
    const expectedSignature = createHmac("sha256", secret).update(parts[0]).digest();
    let actualSignature: Buffer;
    try {
      actualSignature = Buffer.from(parts[1], "base64url");
    } catch {
      throw new Error("Goal authority receipt signature is invalid.");
    }
    if (!safeSignatureEqual(actualSignature, expectedSignature)) throw new Error("Goal authority receipt signature is invalid.");

    let payload: LocalReceiptPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as LocalReceiptPayload;
    } catch {
      throw new Error("Goal authority receipt payload is invalid.");
    }
    const normalized = normalizeContext(context);
    if (!payload || payload.v !== 1 || payload.kind !== expectedKind || payload.provider_id !== providerId) {
      throw new Error("Goal authority receipt type is invalid.");
    }
    if (
      payload.goal_id !== normalized.goal_id ||
      payload.session_id !== normalized.session_id ||
      payload.criterion !== normalized.criterion ||
      payload.goal_owner_principal_id !== normalized.goal_owner_principal_id
    ) {
      throw new Error("Goal authority receipt is not valid for this goal, session, criterion, or owner.");
    }
    nonEmpty(payload.receipt_id, "authority receipt_id", 160);
    nonEmpty(payload.subject_id, "authority subject_id", 240);
    nonEmpty(payload.method, "authority method", 1000);
    if (!Number.isFinite(payload.issued_at_ms) || !Number.isFinite(payload.expires_at_ms) || payload.expires_at_ms <= payload.issued_at_ms) {
      throw new Error("Goal authority receipt timestamps are invalid.");
    }
    const currentMs = now().getTime();
    if (payload.issued_at_ms > currentMs + 60_000) throw new Error("Goal authority receipt was issued in the future.");
    if (payload.expires_at_ms <= currentMs) throw new Error("Goal authority receipt has expired.");
    if (payload.expires_at_ms - payload.issued_at_ms > maxTtlSeconds * 1000) throw new Error("Goal authority receipt lifetime exceeds policy.");
    return payload;
  };

  const issue = (
    kind: LocalReceiptPayload["kind"],
    context: GoalAuthorityContext,
    subjectId: string,
    subjectRole: string | null,
    method: string,
    status: LocalReceiptPayload["status"],
    ttlSeconds?: number
  ): GoalAuthorityEnvelope => {
    const normalized = normalizeContext(context);
    const issuedAtMs = now().getTime();
    const ttl = Math.max(1, Math.min(maxTtlSeconds, Math.trunc(ttlSeconds ?? defaultTtlSeconds)));
    return sign({
      v: 1,
      receipt_id: randomUUID(),
      kind,
      provider_id: providerId,
      ...normalized,
      subject_id: nonEmpty(subjectId, "authority subject_id", 240),
      subject_role: subjectRole,
      method: nonEmpty(method, "authority method", 1000),
      status,
      issued_at_ms: issuedAtMs,
      expires_at_ms: issuedAtMs + ttl * 1000
    });
  };

  return {
    provider_id: providerId,
    issueValidatorExecutionReceipt(input) {
      if (input.status !== "pass" && input.status !== "fail" && input.status !== "unknown") {
        throw new Error("Validator execution status must be pass, fail, or unknown.");
      }
      return issue("validator_execution", input, input.validator_id, null, input.method, input.status, input.ttl_seconds);
    },
    issueHumanApproval(input) {
      if (input.status !== "approved" && input.status !== "rejected" && input.status !== "unknown") {
        throw new Error("Human approval status must be approved, rejected, or unknown.");
      }
      const principalId = nonEmpty(input.authenticated_principal?.principal_id, "authenticated approval principal_id", 240);
      const role = (input.authenticated_principal?.roles ?? [])
        .map(candidate => String(candidate).trim().toLowerCase())
        .find(candidate => allowedApprovalRoles.has(candidate));
      if (!role) throw new Error("Authenticated approval principal does not hold an authorized approval role.");
      if (samePrincipal(principalId, input.goal_owner_principal_id)) {
        throw new Error("Goal owners cannot approve their own goal completion.");
      }
      return issue("human_approval", input, principalId, role, input.method, input.status, input.ttl_seconds);
    },
    verifyValidatorExecutionReceipt(envelope, context) {
      const payload = parse(envelope, context, "validator_execution");
      if (payload.status !== "pass" && payload.status !== "fail" && payload.status !== "unknown") {
        throw new Error("Trusted validator execution receipt has an invalid status.");
      }
      return {
        provider_id: providerId,
        receipt_id: payload.receipt_id,
        validator_id: payload.subject_id,
        method: payload.method,
        status: payload.status,
        issued_at: asEpochIso(payload.issued_at_ms),
        expires_at: asEpochIso(payload.expires_at_ms)
      };
    },
    verifyHumanApproval(envelope, context) {
      const payload = parse(envelope, context, "human_approval");
      const role = String(payload.subject_role ?? "").toLowerCase();
      if (!allowedApprovalRoles.has(role)) throw new Error("Trusted approval receipt does not contain an authorized approval role.");
      if (samePrincipal(payload.subject_id, context.goal_owner_principal_id)) {
        throw new Error("Goal owners cannot approve their own goal completion.");
      }
      if (payload.status !== "approved" && payload.status !== "rejected" && payload.status !== "unknown") {
        throw new Error("Trusted human approval receipt has an invalid status.");
      }
      return {
        provider_id: providerId,
        receipt_id: payload.receipt_id,
        approver_principal_id: payload.subject_id,
        approver_role: role,
        method: payload.method,
        status: payload.status,
        issued_at: asEpochIso(payload.issued_at_ms),
        expires_at: asEpochIso(payload.expires_at_ms)
      };
    }
  };
}

const processLocalSecret = randomBytes(32);

export function createDefaultLocalGoalEvidenceAuthority(): LocalGoalEvidenceAuthority {
  const configuredSecret = String(process.env.OPERATOR_GOAL_AUTHORITY_SECRET ?? "").trim();
  return createLocalGoalEvidenceAuthority({
    secret: configuredSecret || processLocalSecret,
    provider_id: String(process.env.OPERATOR_GOAL_AUTHORITY_PROVIDER_ID ?? "local-hmac-v1").trim() || "local-hmac-v1"
  });
}
