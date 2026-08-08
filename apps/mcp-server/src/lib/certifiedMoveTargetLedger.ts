import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type CertifiedMoveTargetBinding = Readonly<{
  observationId: string;
  documentFingerprint: string;
  documentSessionId: string;
  sourceScopedId: string;
  elementId: number;
  observationBindingHash: string;
}>;

const observations = new Map<string, Readonly<{
  documentFingerprint: string;
  documentSessionId: string;
  targets: ReadonlyMap<number, CertifiedMoveTargetBinding>;
}>>();

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as JsonObject;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.normalize("NFC")) throw new Error(`${name} must be a nonempty NFC string.`);
  return value;
}

function documentFingerprint(value: unknown): string {
  const normalized = text(value, "context document fingerprint").toLowerCase();
  const prefixed = normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(prefixed)) throw new Error("Context document fingerprint is invalid.");
  return prefixed;
}

function documentSessionId(value: unknown): string {
  const normalized = text(value, "context document session id").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("Context document session id is invalid.");
  }
  return normalized;
}

function digest(parts: readonly string[]): string {
  return `sha256:${createHash("sha256").update(parts.join("\n"), "utf8").digest("hex")}`;
}

function pointLocated(item: JsonObject): boolean {
  const orientation = item.orientation && typeof item.orientation === "object" && !Array.isArray(item.orientation)
    ? item.orientation as JsonObject
    : undefined;
  return orientation?.locationKind === "point" || orientation?.location_kind === "point";
}

/**
 * Records only target identity returned by an authenticated native observation
 * and its immediately-following authenticated context read. Model-provided
 * identifiers never create ledger entries.
 */
export function registerCertifiedSpatialObservation(contextValue: unknown, observationValue: unknown): Record<string, unknown> {
  const context = object(contextValue, "native context");
  const document = object(context.document, "native context document");
  const projectIdentity = object(document.projectIdentity ?? document.project_identity, "native context project identity");
  const activeView = object(document.activeView ?? document.active_view, "native context active view");
  const observation = object(observationValue, "native spatial observation");
  const observationId = text(observation.observationId ?? observation.observation_id ?? observation.frameId ?? observation.frame_id, "observation id");
  const fingerprint = documentFingerprint(projectIdentity.fingerprint);
  const sessionId = documentSessionId(document.sessionId ?? document.session_id);
  const viewId = observation.viewId ?? observation.view_id;
  if (!Number.isSafeInteger(viewId) || viewId !== activeView.id) {
    throw new Error("Spatial observation is not bound to the context's current active view.");
  }
  if (!Array.isArray(observation.items)) throw new Error("Spatial observation items are unavailable.");

  const targets = new Map<number, CertifiedMoveTargetBinding>();
  for (const rawItem of observation.items) {
    const item = object(rawItem, "spatial observation item");
    const elementId = item.elementId ?? item.element_id ?? item.id;
    if (!Number.isSafeInteger(elementId) || (elementId as number) <= 0) continue;
    const sourceScopedId = typeof (item.sourceScopedId ?? item.source_scoped_id) === "string"
      ? String(item.sourceScopedId ?? item.source_scoped_id)
      : "";
    if (sourceScopedId !== `host:${elementId}` || !pointLocated(item) || item.groundingStatus === "ungrounded") continue;
    const binding: CertifiedMoveTargetBinding = Object.freeze({
      observationId,
      documentFingerprint: fingerprint,
      documentSessionId: sessionId,
      sourceScopedId,
      elementId: elementId as number,
      observationBindingHash: digest([observationId, fingerprint, sessionId, sourceScopedId, String(elementId)])
    });
    targets.set(elementId as number, binding);
  }
  observations.set(observationId, Object.freeze({ documentFingerprint: fingerprint, documentSessionId: sessionId, targets }));
  return {
    ...observation,
    document: { projectFingerprint: fingerprint, documentSessionId: sessionId },
    certifiedTargetCount: targets.size
  };
}

export function resolveCertifiedMoveTarget(observationIdValue: unknown, elementIdValue: unknown): CertifiedMoveTargetBinding {
  const observationId = text(observationIdValue, "observationId");
  if (!Number.isSafeInteger(elementIdValue) || (elementIdValue as number) <= 0) throw new Error("elementId must be one positive safe integer.");
  const target = observations.get(observationId)?.targets.get(elementIdValue as number);
  if (!target) throw new Error("Move target was not issued by the current process from the exact host-document spatial observation as a point-located target.");
  return target;
}

export function clearCertifiedMoveTargetLedgerForTests(): void {
  observations.clear();
}
