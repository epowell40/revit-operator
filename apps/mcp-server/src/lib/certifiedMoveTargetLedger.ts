import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type CertifiedMoveTargetBinding = Readonly<{
  observationId: string;
  documentFingerprint: string;
  documentSessionId: string;
  sourceScopedId: string;
  elementId: number;
  observationBindingHash: string;
  nativeAttestationKeyId: string;
  nativeAttestationModulusBase64Url: string;
  nativeAttestationExponentBase64Url: string;
  pointXyz: Readonly<{ x: number; y: number; z: number }>;
  category: string | null;
  familyName: string | null;
  typeName: string | null;
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

function nativeAttestation(value: unknown): Readonly<{ keyId: string; modulus: string; exponent: string }> {
  const raw = object(value, "native execution attestation");
  if (raw.schema !== "revit-operator.native-execution-attestation-key.v1" || raw.algorithm !== "RS256") {
    throw new Error("Native execution attestation schema or algorithm is invalid.");
  }
  const keyId = documentFingerprint(raw.key_id);
  const modulus = text(raw.modulus_base64url, "native attestation modulus");
  const exponent = text(raw.exponent_base64url, "native attestation exponent");
  if (!/^[A-Za-z0-9_-]{256,512}$/.test(modulus) || !/^[A-Za-z0-9_-]{1,16}$/.test(exponent)) {
    throw new Error("Native execution attestation public key is invalid.");
  }
  const material = `{"algorithm":"RS256","exponent_base64url":${JSON.stringify(exponent)},"modulus_base64url":${JSON.stringify(modulus)}}`;
  const expected = `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
  if (keyId !== expected) throw new Error("Native execution attestation key id is invalid.");
  return Object.freeze({ keyId, modulus, exponent });
}

function pointLocated(item: JsonObject): boolean {
  const orientation = item.orientation && typeof item.orientation === "object" && !Array.isArray(item.orientation)
    ? item.orientation as JsonObject
    : undefined;
  return orientation?.locationKind === "point" || orientation?.location_kind === "point";
}

function finitePoint(value: unknown): Readonly<{ x: number; y: number; z: number }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as JsonObject;
  return typeof point.x === "number" && Number.isFinite(point.x)
    && typeof point.y === "number" && Number.isFinite(point.y)
    && typeof point.z === "number" && Number.isFinite(point.z)
    ? Object.freeze({ x: point.x, y: point.y, z: point.z })
    : null;
}

function observedPoint(item: JsonObject): Readonly<{ x: number; y: number; z: number }> | null {
  if (!item.orientation || typeof item.orientation !== "object" || Array.isArray(item.orientation)) return null;
  const orientation = item.orientation as JsonObject;
  return finitePoint(orientation.locationPoint ?? orientation.location_point);
}

function independentlySafeToMove(item: JsonObject): boolean {
  return item.pinned === false && (item.groupId === null || item.group_id === null);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value === value.normalize("NFC") ? value : null;
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
  const attestation = nativeAttestation(document.nativeExecutionAttestation ?? document.native_execution_attestation);
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
    const pointXyz = observedPoint(item);
    if (sourceScopedId !== `host:${elementId}` || !pointLocated(item) || !pointXyz
      || item.groundingStatus === "ungrounded" || !independentlySafeToMove(item)) continue;
    const binding: CertifiedMoveTargetBinding = Object.freeze({
      observationId,
      documentFingerprint: fingerprint,
      documentSessionId: sessionId,
      sourceScopedId,
      elementId: elementId as number,
      observationBindingHash: digest([observationId, fingerprint, sessionId, sourceScopedId, String(elementId), attestation.keyId]),
      nativeAttestationKeyId: attestation.keyId,
      nativeAttestationModulusBase64Url: attestation.modulus,
      nativeAttestationExponentBase64Url: attestation.exponent,
      pointXyz,
      category: optionalText(item.category ?? item.categoryName ?? item.category_name),
      familyName: optionalText(item.familyName ?? item.family_name ?? item.family),
      typeName: optionalText(item.typeName ?? item.type_name ?? item.type)
    });
    targets.set(elementId as number, binding);
  }
  observations.set(observationId, Object.freeze({ documentFingerprint: fingerprint, documentSessionId: sessionId, targets }));
  return {
    ...observation,
    document: {
      projectFingerprint: fingerprint,
      documentSessionId: sessionId,
      nativeExecutionAttestation: {
        schema: "revit-operator.native-execution-attestation-key.v1",
        algorithm: "RS256",
        keyId: attestation.keyId
      }
    },
    certifiedTargetCount: targets.size
  };
}

/** Returns a bounded projection issued only from native-attested observation data. */
export function listCertifiedMoveTargets(observationIdValue: unknown): ReadonlyArray<Readonly<{
  observationId: string;
  sourceScopedId: string;
  elementId: number;
  pointXyz: Readonly<{ x: number; y: number; z: number }>;
  category: string | null;
  familyName: string | null;
  typeName: string | null;
}>> {
  const observationId = text(observationIdValue, "observationId");
  const observation = observations.get(observationId);
  if (!observation) throw new Error("Move targets were not issued by the current process from this observation.");
  return [...observation.targets.values()]
    .sort((left, right) => left.elementId - right.elementId)
    .slice(0, 100)
    .map(target => Object.freeze({
      observationId: target.observationId,
      sourceScopedId: target.sourceScopedId,
      elementId: target.elementId,
      pointXyz: target.pointXyz,
      category: target.category,
      familyName: target.familyName,
      typeName: target.typeName
    }));
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
