import { createHash } from "node:crypto";

/**
 * Contract material for the first reversible-write certification tranche.
 * This module is deliberately unexposed: it prepares a request-family binding
 * but does not change tool exposure, write grants, or native authorization.
 */
export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1 = "revit-operator.certified-move-one.request-family.v1";
export const CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET = 2;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Phase = "preview" | "apply";

export type CertifiedMoveOneRequest = {
  phase: Phase;
  documentFingerprint: string;
  sourceScopedId: string;
  elementId: number;
  observationId: string;
  vectorFeet: { x: number; y: number; z: number };
  previewInstanceHash?: string;
};

export type CertifiedMoveOneAdmission = {
  familyId: typeof CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1;
  familyHash: string;
  requestInstanceHash: string;
  request: CertifiedMoveOneRequest;
  outboundBody: {
    ids: number[];
    mode: "vector";
    vectorX: number;
    vectorY: number;
    vectorZ: number;
    dryRun: boolean;
    behavior: "allOrNothing";
    moveTogether: false;
    options: { failOnPinned: true; unpinIfAllowed: false };
  };
};

export class CertifiedMoveOneRequestError extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); }
}

// Admission objects are process-local capabilities. A structurally identical
// JSON object cannot skip the reviewed validator on the execution path.
const admittedRequests = new WeakSet<object>();

const FAMILY_MATERIAL: Json = {
  family: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1,
  route: { method: "POST", path: "/revit/move-elements", alias: "revit_move_one_certified" },
  target: { exactlyOne: true, hostDocumentOnly: true, pointLocatedOnly: true, linked: false, grouped: false, pinned: false },
  vector: { unit: "feet", finite: true, maxEuclideanMagnitude: CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET },
  options: { behavior: "allOrNothing", moveTogether: false, failOnPinned: true, unpinIfAllowed: false },
  lineage: { documentFingerprint: true, sourceScopedId: true, observationId: true, previewRequiredForApply: true }
};

function canonical(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_INVALID", "All vector values must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key.normalize("NFC"))}:${canonical(value[key]!)}`).join(",")}}`;
}

function digest(value: Json): string { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const found = Object.keys(value).sort(); const expected = [...keys].sort();
  if (found.length !== expected.length || found.some((key, index) => key !== expected[index])) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} has missing or unknown fields.`);
  }
}
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.normalize("NFC")) throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a nonempty NFC string.`);
  return value;
}
function sha256(value: unknown, name: string): string {
  const text = nonempty(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", `${name} must be a lowercase sha256 digest.`);
  return text;
}

export const CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH = digest(FAMILY_MATERIAL);

/** Validates the model-facing profile and produces the legacy handler's exact body. */
export function admitCertifiedMoveOneRequest(input: unknown): CertifiedMoveOneAdmission {
  const raw = object(input, "request");
  exactKeys(raw, ["phase", "documentFingerprint", "sourceScopedId", "elementId", "observationId", "vectorFeet", "previewInstanceHash"], "request");
  if (raw.phase !== "preview" && raw.phase !== "apply") throw new CertifiedMoveOneRequestError("MOVE_ONE_REQUEST_INVALID", "phase must be preview or apply.");
  const phase = raw.phase;
  const vector = object(raw.vectorFeet, "vectorFeet"); exactKeys(vector, ["x", "y", "z"], "vectorFeet");
  for (const key of ["x", "y", "z"] as const) if (typeof vector[key] !== "number" || !Number.isFinite(vector[key])) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_INVALID", `vectorFeet.${key} must be finite.`);
  const magnitude = Math.hypot(vector.x as number, vector.y as number, vector.z as number);
  if (magnitude <= 0 || magnitude > CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET) throw new CertifiedMoveOneRequestError("MOVE_ONE_VECTOR_OUT_OF_BOUNDS", `Vector magnitude must be greater than zero and at most ${CERTIFIED_MOVE_ONE_MAX_DISPLACEMENT_FEET} feet.`);
  if (!Number.isSafeInteger(raw.elementId) || (raw.elementId as number) <= 0) throw new CertifiedMoveOneRequestError("MOVE_ONE_TARGET_INVALID", "elementId must be one positive safe integer.");
  const previewInstanceHash = raw.previewInstanceHash === undefined ? undefined : sha256(raw.previewInstanceHash, "previewInstanceHash");
  if ((phase === "preview" && previewInstanceHash !== undefined) || (phase === "apply" && !previewInstanceHash)) {
    throw new CertifiedMoveOneRequestError("MOVE_ONE_PREVIEW_LINEAGE_INVALID", "Preview may not carry preview lineage; apply requires the exact preview instance hash.");
  }
  const request: CertifiedMoveOneRequest = {
    phase,
    documentFingerprint: sha256(raw.documentFingerprint, "documentFingerprint"),
    sourceScopedId: nonempty(raw.sourceScopedId, "sourceScopedId"),
    elementId: raw.elementId as number,
    observationId: nonempty(raw.observationId, "observationId"),
    vectorFeet: { x: vector.x as number, y: vector.y as number, z: vector.z as number },
    ...(previewInstanceHash ? { previewInstanceHash } : {})
  };
  const outboundBody = {
    ids: [request.elementId], mode: "vector" as const,
    vectorX: request.vectorFeet.x, vectorY: request.vectorFeet.y, vectorZ: request.vectorFeet.z,
    dryRun: request.phase === "preview", behavior: "allOrNothing" as const, moveTogether: false as const,
    options: { failOnPinned: true as const, unpinIfAllowed: false as const }
  };
  const requestInstanceHash = digest({ familyHash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, request: request as unknown as Json, outboundBody: outboundBody as unknown as Json });
  const admission = Object.freeze({ familyId: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_V1, familyHash: CERTIFIED_MOVE_ONE_REQUEST_FAMILY_HASH, requestInstanceHash, request, outboundBody });
  admittedRequests.add(admission);
  return admission;
}

export function isCertifiedMoveOneAdmission(value: unknown): value is CertifiedMoveOneAdmission {
  return !!value && typeof value === "object" && admittedRequests.has(value as object);
}
