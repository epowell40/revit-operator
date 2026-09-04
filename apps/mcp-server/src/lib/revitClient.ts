import { randomBytes } from "node:crypto";
import { getOrCreateOperatorToken, getWriteGrantToken } from "./workspace.js";
import { callRevitViaCourier, readCertifiedCourierExecutionContext } from "./revitCourier.js";
import { revitRouteEffect } from "./revitRouteEffect.js";
import { isSafeReadReservedPath } from "./safeReadDiscovery.js";
import {
  callNativeTransport,
  isExactDevelopmentLaboratory,
  NativeTransportProtocolError
} from "./nativeTransport.js";
import {
  assertCertifiedMoveOneAdmissionExposure,
  assertLaboratoryMoveEvidenceAdmissionExposure,
  assertProtectedLaboratoryEvidenceExposure,
  assertToolExposure,
  canonicalToolExposureJson,
  createCertifiedCourierAdmission,
  type ToolExposureChannel
} from "./toolExposurePolicy.js";
import {
  issueCertifiedMoveExecutionContext,
  type CertifiedMoveExecutionContext,
  type CertifiedMoveOneAdmission
} from "./certifiedMoveOneRequestFamily.js";
import { createCertificationEnvelope, type FamilyCertificationEnvelope } from "./certifiedExecutionEnvelope.js";
import type { LaboratoryEvidenceDispatch } from "./laboratoryEvidenceDispatch.js";
import type { LaboratoryMoveEvidenceAdmission } from "./laboratoryMoveEvidence.js";
import {
  beginAssignmentKernelNativeRequestV2,
  markAssignmentKernelNativeRequestDispatchingV2,
  recordAssignmentKernelNativeFailureV2,
  recordAssignmentKernelNativeResultV2,
} from "./assignmentKernelV2.js";

// Use localhost or environment variable
export const REVIT_BRIDGE_URL = process.env.REVIT_BRIDGE_URL || "http://localhost:5000";

export type RevitBridgeTransportErrorCode =
  | "revit_bridge_timeout"
  | "revit_bridge_unavailable"
  | "revit_bridge_http_error"
  | "revit_bridge_invalid_response";

export type RevitBridgeErrorCode = RevitBridgeTransportErrorCode;

export type RevitBridgeErrorDetails = Readonly<Record<string, unknown>>;

export type RevitBridgeFailurePayload = Readonly<{
  schema: "revit-operator.revit-bridge-failure.v1";
  ok: false;
  code: RevitBridgeErrorCode;
  transport_code: RevitBridgeTransportErrorCode;
  bridge_code?: string;
  phase: string;
  retryable: boolean;
  request_dispatched: boolean;
  outcome_unknown: boolean;
  method: string;
  path: string;
  status?: number;
  correlation_id?: string;
  error: string;
}>;

export class RevitBridgeCallError extends Error {
  readonly code: RevitBridgeErrorCode;
  readonly transportCode: RevitBridgeTransportErrorCode;
  readonly retryable: boolean;
  readonly request_dispatched: boolean;
  readonly outcome_unknown: boolean;
  readonly outcomeUnknown: boolean;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly bridgeCode?: string;
  readonly phase?: string;
  readonly host_health?: string;
  readonly opens_circuit?: boolean;
  readonly correlation_id?: string;
  readonly deadline_class?: string;
  readonly deadline_ms?: number;
  readonly bridgeDetails?: RevitBridgeErrorDetails;

  constructor(input: {
    code: RevitBridgeErrorCode;
    transportCode?: RevitBridgeTransportErrorCode;
    message: string;
    retryable: boolean;
    requestDispatched?: boolean;
    outcomeUnknown?: boolean;
    method: string;
    path: string;
    status?: number;
    correlationId?: string;
    bridgeDetails?: RevitBridgeErrorDetails;
    cause?: unknown;
  }) {
    const outcomeUnknown = input.outcomeUnknown === true;
    const retryable = outcomeUnknown ? false : input.retryable;
    const outcomeSuffix = outcomeUnknown ? " outcome_unknown=true" : "";
    super(`[${input.code}] ${input.message} retryable=${retryable}${outcomeSuffix}.`, { cause: input.cause });
    this.name = "RevitBridgeCallError";
    this.code = input.code;
    this.transportCode = input.transportCode ?? input.code;
    this.retryable = retryable;
    this.request_dispatched = input.requestDispatched
      ?? booleanField(input.bridgeDetails, "request_dispatched")
      ?? booleanField(input.bridgeDetails, "dispatched")
      ?? outcomeUnknown;
    this.outcome_unknown = outcomeUnknown;
    this.outcomeUnknown = outcomeUnknown;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
    this.bridgeDetails = input.bridgeDetails;

    const details = input.bridgeDetails;
    this.bridgeCode = stringField(details, "code");
    this.phase = stringField(details, "phase");
    this.host_health = stringField(details, "host_health");
    this.opens_circuit = booleanField(details, "opens_circuit");
    this.correlation_id = input.correlationId ?? stringField(details, "correlation_id");
    this.deadline_class = stringField(details, "deadline_class");
    this.deadline_ms = numberField(details, "deadline_ms");
  }
}

/** Stable MCP-visible settlement metadata for bridge failures. */
export function revitBridgeFailurePayload(error: RevitBridgeCallError): RevitBridgeFailurePayload {
  const phase = error.phase
    ?? (error.request_dispatched ? "dispatch" : "pre_dispatch");
  return {
    schema: "revit-operator.revit-bridge-failure.v1",
    ok: false,
    code: error.code,
    transport_code: error.transportCode,
    ...(error.bridgeCode ? { bridge_code: error.bridgeCode } : {}),
    phase,
    retryable: error.retryable,
    request_dispatched: error.request_dispatched,
    outcome_unknown: error.outcome_unknown,
    method: error.method,
    path: error.path,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.correlation_id ? { correlation_id: error.correlation_id } : {}),
    error: error.message
  };
}

function stringField(details: RevitBridgeErrorDetails | undefined, name: string): string | undefined {
  const value = details?.[name];
  return typeof value === "string" ? value : undefined;
}

function booleanField(details: RevitBridgeErrorDetails | undefined, name: string): boolean | undefined {
  const value = details?.[name];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(details: RevitBridgeErrorDetails | undefined, name: string): number | undefined {
  const value = details?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBridgeErrorDetails(details: string): RevitBridgeErrorDetails | undefined {
  if (!details.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(details);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Legacy bridge errors can be plain text.
  }
  return undefined;
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return 120_000;
  return Math.max(250, Math.min(15 * 60_000, parsed));
}

function bridgeUrl(): string {
  return (process.env.REVIT_BRIDGE_URL || REVIT_BRIDGE_URL).replace(/\/+$/, "");
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error || "unknown error");
}

const PROVEN_PRE_DISPATCH_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isProvenPreDispatchFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  const errorCodes: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || (typeof current !== "object" && typeof current !== "function") || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string") errorCodes.push(record.code);
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  return errorCodes.length > 0 && errorCodes.every(code => PROVEN_PRE_DISPATCH_ERROR_CODES.has(code));
}

const PRE_DISPATCH_PHASES = new Set([
  "pre_dispatch",
  "request_validation",
  "authentication",
  "authorization",
  "write_grant",
  "admission",
  "routing",
]);

function isStructuredPreDispatchRejection(details: RevitBridgeErrorDetails | undefined): boolean {
  if (!details) return false;
  if (booleanField(details, "pre_dispatch") === true) return true;
  if (booleanField(details, "dispatched") === false) return true;
  if (booleanField(details, "request_dispatched") === false) return true;
  const phase = stringField(details, "phase")?.trim().toLowerCase();
  return booleanField(details, "outcome_unknown") === false && !!phase && PRE_DISPATCH_PHASES.has(phase);
}

export type RevitCallOptions = {
  channel?: ToolExposureChannel;
  workflow?: string;
  /** Opaque, validator-issued capability for the one-element move family. */
  certifiedMoveOneAdmission?: CertifiedMoveOneAdmission;
  /** Opaque one-use provenance for an exact protected certification-evidence step. */
  laboratoryEvidenceDispatch?: LaboratoryEvidenceDispatch;
  /** Distinct evidence-only wrapper capability; never production authority. */
  laboratoryMoveEvidenceAdmission?: LaboratoryMoveEvidenceAdmission;
  /** Explicit nested kernel role for a native prerequisite or child action. */
  assignmentOperationRole?: "prerequisite" | "child";
  /** Trusted admission for a nested action that actually fulfills the parent task. */
  assignmentFulfillmentRole?: "supporting_control" | "delegated_task_execution" | "verification" | "reconciliation" | "telemetry";
};

function useLegacyPlaintextLaboratoryTransport(): boolean {
  return isExactDevelopmentLaboratory()
    && process.env.OPERATOR_UNSAFE_LEGACY_PLAINTEXT_REVIT_TRANSPORT === "1";
}

const certifiedExecutionContexts = new WeakMap<object, CertifiedMoveExecutionContext>();
export type RevitDirectLaboratoryEvidenceContext = Readonly<{
  schema: "revit-operator.direct-laboratory-evidence-context.v1";
  transportKind: "direct_protected_native";
  dispatchId: string;
  correlationId: string;
  receiptPath: string;
  receiptSha256: string;
}>;
const laboratoryEvidenceContexts = new WeakMap<object, RevitDirectLaboratoryEvidenceContext>();

export function readRevitDirectLaboratoryEvidenceContext(result: unknown): RevitDirectLaboratoryEvidenceContext {
  if (!result || typeof result !== "object") throw new Error("Direct laboratory result has no protected evidence context.");
  const context = laboratoryEvidenceContexts.get(result as object);
  if (!context) throw new Error("Direct laboratory result has no protected evidence context.");
  return context;
}

/** Returns only transport-issued context attached to this exact parsed result object. */
export function readCertifiedMoveExecutionContext(result: unknown): CertifiedMoveExecutionContext {
  if (!result || typeof result !== "object") throw new Error("Certified move result has no authenticated execution context.");
  const context = certifiedExecutionContexts.get(result as object);
  if (!context) throw new Error("Certified move result has no authenticated execution context.");
  return context;
}

export async function callRevit<T = unknown>(path: string, method: string = "GET", body?: unknown, options: RevitCallOptions = {}): Promise<T> {
  const upperMethod = String(method || "GET").trim().toUpperCase();
  if (options.certifiedMoveOneAdmission && options.laboratoryMoveEvidenceAdmission) {
    throw new Error("Production and laboratory move-family admissions are mutually exclusive.");
  }
  if (isSafeReadReservedPath(path)) {
    throw new Error("Certified SafeRead routes are reserved for the direct attested SafeRead microhost client.");
  }
  // Certification is the final in-process admission boundary shared by direct
  // HTTP and durable courier dispatch. A write grant only matters after this
  // exact request/effect/channel decision has passed.
  const familyAdmission = options.certifiedMoveOneAdmission ?? options.laboratoryMoveEvidenceAdmission?.request;
  const exposure = options.laboratoryMoveEvidenceAdmission
    ? assertLaboratoryMoveEvidenceAdmissionExposure({
      admission: options.laboratoryMoveEvidenceAdmission.request,
      channel: options.channel ?? "typed_mcp"
    })
    : options.laboratoryEvidenceDispatch
    ? assertProtectedLaboratoryEvidenceExposure({
      method: upperMethod,
      path,
      body,
      channel: options.channel ?? "typed_mcp",
      workflow: options.workflow
    })
    : familyAdmission
    ? assertCertifiedMoveOneAdmissionExposure({
      admission: familyAdmission,
      channel: options.channel ?? "typed_mcp"
    })
    : assertToolExposure({
      method: upperMethod,
      path,
      body,
      channel: options.channel ?? "typed_mcp",
      workflow: options.workflow
    });

  // Family execution bytes are canonical at the first transport boundary so
  // direct, courier, backend, and native recomputation all see one exact body.
  const serializedBody = familyAdmission
    ? canonicalToolExposureJson(familyAdmission.outboundBody)
    : body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const transportBody = familyAdmission ? serializedBody : body;
  const kernelNativeRequest = await beginAssignmentKernelNativeRequestV2(upperMethod, path, transportBody, {
    ...(options.assignmentOperationRole ? { operation_role: options.assignmentOperationRole } : {}),
    ...(options.assignmentFulfillmentRole ? { fulfillment_role: options.assignmentFulfillmentRole } : {}),
    classified_effect: revitRouteEffect(path, upperMethod, body)
  });

  const transport = (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase();
  if (transport === "courier") {
    const certifiedAdmission = createCertifiedCourierAdmission({
      method: upperMethod,
      path,
      body: transportBody,
      channel: options.channel ?? "typed_mcp",
      workflow: options.workflow,
      certifiedMoveOneAdmission: options.certifiedMoveOneAdmission,
      laboratoryMoveEvidenceAdmission: options.laboratoryMoveEvidenceAdmission?.request,
      laboratoryEvidence: options.laboratoryEvidenceDispatch !== undefined
    });
    await markAssignmentKernelNativeRequestDispatchingV2(kernelNativeRequest);
    let result: T;
    try {
      result = await callRevitViaCourier<T>(path, upperMethod, transportBody, {
        certifiedAdmission,
        laboratoryEvidenceDispatch: options.laboratoryEvidenceDispatch,
        laboratoryMoveEvidenceAdmission: options.laboratoryMoveEvidenceAdmission,
        canonicalOperationId: kernelNativeRequest?.operation_id
      });
    } catch (error) {
      await recordAssignmentKernelNativeFailureV2(kernelNativeRequest, error);
      throw error;
    }
    if (options.certifiedMoveOneAdmission) {
      try {
        if (!result || typeof result !== "object") throw new Error("Certified courier returned a non-object result.");
        certifiedExecutionContexts.set(result as object, readCertifiedCourierExecutionContext(result));
      } catch (error) {
        throw new RevitBridgeCallError({
          code: "revit_bridge_invalid_response",
          message: `${upperMethod} ${path} completed without an authenticated courier execution context. Reconcile the Revit outcome before any retry.`,
          retryable: false,
          requestDispatched: true,
          outcomeUnknown: true,
          method: upperMethod,
          path,
          cause: error
        });
      }
    }
    await recordAssignmentKernelNativeResultV2(upperMethod, path, result, kernelNativeRequest);
    return result;
  }
  if (transport !== "direct") throw new Error(`Unsupported OPERATOR_REVIT_TRANSPORT: ${transport}`);

  const token = getOrCreateOperatorToken();
  const requestEffect = revitRouteEffect(path, upperMethod, body);
  // A rollback preview still enters a native mutation transaction. If dispatch
  // status is unknown, it must be reconciled instead of retried automatically.
  const mutating = requestEffect !== "read";
  const laboratoryRuntime = isExactDevelopmentLaboratory();
  // Development/laboratory is an exposure policy, not proof that the independently
  // hosted Revit process accepts the legacy plaintext loopback protocol. Normal
  // local product checkpoints keep Revit in its protected local-host identity, so
  // plaintext direct transport must remain an explicit unsafe compatibility opt-in.
  const legacyPlaintextLaboratoryTransport = useLegacyPlaintextLaboratoryTransport();
  const protectedLaboratoryEvidence = laboratoryRuntime
    && process.env.OPERATOR_CERTIFICATION_PROTECTED_LABORATORY === "1";
  if (protectedLaboratoryEvidence && options.certifiedMoveOneAdmission) {
    throw new Error("Protected laboratory evidence transport cannot manufacture certified request-family admission; use the exact generic candidate body until L4 policy is generated.");
  }
  if (options.laboratoryMoveEvidenceAdmission && !protectedLaboratoryEvidence) {
    throw new Error("Laboratory move-family evidence admission is forbidden outside exact protected development/laboratory mode.");
  }
  if (options.laboratoryEvidenceDispatch && !protectedLaboratoryEvidence) {
    throw new Error("Laboratory evidence dispatch is forbidden outside exact protected development/laboratory mode.");
  }

  const doFetch = async (): Promise<{ ok: boolean; status: number; text(): Promise<string>; certifiedExecutionContext?: CertifiedMoveExecutionContext; laboratoryEvidenceContext?: RevitDirectLaboratoryEvidenceContext }> => {
    const controller = new AbortController();
    const timeoutMs = requestTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const writeGrant = getWriteGrantToken();
    // OperationV2 identities intentionally use the `opv2_...` domain format,
    // while the protected native wire contract accepts only 32/64 lowercase
    // hexadecimal request IDs. The kernel already derives a stable 64-hex
    // request identity bound to the exact operation and request payload; keep
    // those two identities distinct at the transport boundary.
    const certifiedDirectDispatchId = kernelNativeRequest?.request_id ?? (!legacyPlaintextLaboratoryTransport && options.certifiedMoveOneAdmission
      ? randomBytes(16).toString("hex")
      : undefined);

    try {
      if (!legacyPlaintextLaboratoryTransport || protectedLaboratoryEvidence) {
        const nativeChannel = exposure.channel;
        if (nativeChannel === "deterministic_workflow") {
          throw new Error("Deterministic workflow certification requires the durable courier transport.");
        }
        const certificationEnvelope = options.certifiedMoveOneAdmission
          ? createCertificationEnvelope({
            decision: exposure,
            bodyPresent: serializedBody !== undefined,
            bodyJson: serializedBody ?? "",
            certifiedMoveOneAdmission: options.certifiedMoveOneAdmission
          }) as FamilyCertificationEnvelope
          : undefined;
        await markAssignmentKernelNativeRequestDispatchingV2(kernelNativeRequest);
        const result = await callNativeTransport({
          operatorToken: token,
          method: upperMethod,
          path,
          bodyJson: serializedBody,
          writeGrant,
          channel: nativeChannel,
          alias: exposure.alias,
          certificationEnvelope,
          laboratoryEvidenceDispatch: options.laboratoryEvidenceDispatch,
          laboratoryPolicyBinding: options.laboratoryEvidenceDispatch ? {
            policyHash: exposure.policyHash ?? "",
            policyRecordHash: exposure.policyRecordHash ?? "",
            evidenceRecordHash: exposure.evidenceRecordHash ?? "",
            effectHash: exposure.effectHash
          } : undefined,
          laboratoryMoveEvidenceAdmission: options.laboratoryMoveEvidenceAdmission,
          requestId: certifiedDirectDispatchId,
          signal: controller.signal
        });
        return {
          ok: result.statusCode >= 200 && result.statusCode <= 299,
          status: result.statusCode,
          async text() { return result.bodyJson; },
          ...(options.certifiedMoveOneAdmission && certificationEnvelope ? {
            certifiedExecutionContext: issueCertifiedMoveExecutionContext({
              transportKind: "direct",
              dispatchId: result.requestId,
              correlationId: result.requestId,
              executionSessionId: options.certifiedMoveOneAdmission.admissionSessionId,
              executorId: options.certifiedMoveOneAdmission.request.nativeAttestationKeyId,
              certificationEnvelopeHash: certificationEnvelope.envelope_hash,
              completionChallengeHash: null
            })
          } : {}),
          ...(protectedLaboratoryEvidence ? {
            laboratoryEvidenceContext: Object.freeze({
              schema: "revit-operator.direct-laboratory-evidence-context.v1" as const,
              transportKind: "direct_protected_native" as const,
              dispatchId: result.requestId,
              correlationId: result.requestId,
              receiptPath: result.receiptPath,
              receiptSha256: result.receiptSha256
            })
          } : {})
        };
      }

      await markAssignmentKernelNativeRequestDispatchingV2(kernelNativeRequest);
      const response = await fetch(`${bridgeUrl()}${path}`, {
        method: upperMethod,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Operator-Token": token } : {}),
          ...(writeGrant ? { "X-Operator-Write-Grant": writeGrant } : {}),
          ...(kernelNativeRequest ? { "X-Operator-Correlation-Id": kernelNativeRequest.operation_id } : {}),
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
      return response;
    } catch (error) {
      const protectedRequestId = error instanceof NativeTransportProtocolError
        ? (error.requestId ?? certifiedDirectDispatchId)
        : certifiedDirectDispatchId;
      if (controller.signal.aborted) {
        const outcomeUnknown = mutating;
        throw new RevitBridgeCallError({
          code: "revit_bridge_timeout",
          message: `${upperMethod} ${path} exceeded ${timeoutMs} ms while waiting for the Revit bridge. ${outcomeUnknown ? "The request may already have started; reconcile its outcome in Revit before any retry." : "Revit may be busy; inspect its UI before retrying."}`,
          retryable: !outcomeUnknown,
          requestDispatched: true,
          outcomeUnknown,
          method: upperMethod,
          path,
          correlationId: protectedRequestId,
          cause: error,
        });
      }
      if (error instanceof NativeTransportProtocolError && error.phase === "response") {
        const outcomeUnknown = mutating;
        throw new RevitBridgeCallError({
          code: "revit_bridge_invalid_response",
          message: `${upperMethod} ${path} returned an unauthenticated, invalid, or incomplete protected response.${outcomeUnknown ? " The request may already have completed; reconcile its outcome in Revit before any retry." : ""}`,
          retryable: !outcomeUnknown,
          requestDispatched: true,
          outcomeUnknown,
          method: upperMethod,
          path,
          correlationId: protectedRequestId,
          cause: error,
        });
      }
      if (error instanceof NativeTransportProtocolError && error.phase === "pre_dispatch") {
        throw new RevitBridgeCallError({
          code: "revit_bridge_unavailable",
          message: `${upperMethod} ${path} was not dispatched because certified native Revit transport discovery or request protection failed. Cause: ${errorDetail(error)}`,
          retryable: true,
          requestDispatched: false,
          outcomeUnknown: false,
          method: upperMethod,
          path,
          correlationId: protectedRequestId,
          bridgeDetails: {
            code: "native_transport_request_protection_failed",
            phase: "pre_dispatch",
            retryable: true,
            request_dispatched: false,
            outcome_unknown: false
          },
          cause: error,
        });
      }
      const preDispatchFailure = isProvenPreDispatchFailure(error);
      const outcomeUnknown = mutating && !preDispatchFailure;
      throw new RevitBridgeCallError({
        code: "revit_bridge_unavailable",
        message: outcomeUnknown
          ? `${upperMethod} ${path} lost its connection to ${bridgeUrl()} after dispatch could not be ruled out. The request may already have started; reconcile its outcome in Revit before any retry. Cause: ${errorDetail(error)}`
          : `${upperMethod} ${path} could not reach ${bridgeUrl()}. Revit may be closed or the bridge may not be listening. Cause: ${errorDetail(error)}`,
        retryable: !mutating || preDispatchFailure,
        requestDispatched: !preDispatchFailure,
        outcomeUnknown,
        method: upperMethod,
        path,
        correlationId: protectedRequestId,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Awaited<ReturnType<typeof doFetch>>;
  try {
    response = await doFetch();
  } catch (error) {
    await recordAssignmentKernelNativeFailureV2(kernelNativeRequest, error);
    throw error;
  }
  if (!response.ok) {
    let details = "";
    let detailsReadFailed = false;
    try { details = await response.text(); } catch { detailsReadFailed = true; }

    const bridgeDetails = parseBridgeErrorDetails(details);
    const bridgeOutcomeUnknown = booleanField(bridgeDetails, "outcome_unknown");
    const preDispatchRejection = isStructuredPreDispatchRejection(bridgeDetails);
    const outcomeUnknown = mutating && (bridgeOutcomeUnknown === true || !preDispatchRejection);
    const bridgeRetryable = booleanField(bridgeDetails, "retryable");
    const statusRetryable = response.status === 408 || response.status === 409 || response.status === 423 || response.status === 429 || response.status >= 500;
    const detailSuffix = details
      ? `: ${details}`
      : detailsReadFailed
        ? ": response body was unavailable or incomplete"
        : "";

    const bridgeError = new RevitBridgeCallError({
      code: "revit_bridge_http_error",
      transportCode: "revit_bridge_http_error",
      message: `${upperMethod} ${path} received HTTP ${response.status}${detailSuffix}`,
      retryable: outcomeUnknown ? false : (bridgeRetryable ?? statusRetryable),
      requestDispatched: !preDispatchRejection,
      outcomeUnknown,
      method: upperMethod,
      path,
      status: response.status,
      correlationId: response.certifiedExecutionContext?.dispatchId,
      bridgeDetails,
    });
    await recordAssignmentKernelNativeFailureV2(kernelNativeRequest, bridgeError);
    throw bridgeError;
  }
  try {
    const parsed = JSON.parse(await response.text()) as T;
    if (options.certifiedMoveOneAdmission) {
      if (!parsed || typeof parsed !== "object" || !response.certifiedExecutionContext) {
        throw new Error("Certified native response omitted its authenticated execution context.");
      }
      certifiedExecutionContexts.set(parsed as object, response.certifiedExecutionContext);
    }
    if (response.laboratoryEvidenceContext && parsed && typeof parsed === "object") {
      laboratoryEvidenceContexts.set(parsed as object, response.laboratoryEvidenceContext);
    }
    await recordAssignmentKernelNativeResultV2(upperMethod, path, parsed, kernelNativeRequest);
    return parsed;
  } catch (error) {
    const outcomeUnknown = mutating;
    const bridgeError = new RevitBridgeCallError({
      code: "revit_bridge_invalid_response",
      message: `${upperMethod} ${path} returned an invalid or incomplete JSON response.${outcomeUnknown ? " The request may already have completed; reconcile its outcome in Revit before any retry." : ""}`,
      retryable: !outcomeUnknown,
      requestDispatched: true,
      outcomeUnknown,
      method: upperMethod,
      path,
      correlationId: response.certifiedExecutionContext?.dispatchId,
      cause: error,
    });
    await recordAssignmentKernelNativeFailureV2(kernelNativeRequest, bridgeError);
    throw bridgeError;
  }
}
