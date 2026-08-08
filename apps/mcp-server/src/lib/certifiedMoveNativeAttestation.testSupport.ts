import { createHash, generateKeyPairSync, sign } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keyPair.publicKey.export({ format: "jwk" });
if (!jwk.n || !jwk.e) throw new Error("Test native RSA key is unavailable.");
const keyMaterial = { algorithm: "RS256", exponent_base64url: jwk.e, modulus_base64url: jwk.n };

export const TEST_NATIVE_EXECUTION_ATTESTATION = Object.freeze({
  schema: "revit-operator.native-execution-attestation-key.v1",
  algorithm: "RS256",
  key_id: `sha256:${createHash("sha256").update(canonical(keyMaterial), "utf8").digest("hex")}`,
  modulus_base64url: jwk.n,
  exponent_base64url: jwk.e
});

export function signTestNativeReceipt(receiptWithoutSignature: Record<string, unknown>): string {
  return sign(
    "sha256",
    Buffer.from(canonical(receiptWithoutSignature as Json), "utf8"),
    keyPair.privateKey
  ).toString("base64url");
}

export function canonicalTestNativeJson(value: unknown): string {
  return canonical(value as Json);
}

function doubleBits(value: number): string {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value, 0);
  return buffer.toString("hex");
}

export function canonicalTestCertifiedMoveResult(value: Record<string, unknown>): string {
  const snapshot = (value.snapshots as Array<Record<string, unknown>>)[0]!;
  const projectPoint = (pointValue: unknown) => {
    const point = pointValue as { kind: string; pointXyz: number[] };
    return { kind: point.kind, point_bits: point.pointXyz.map(doubleBits) };
  };
  return canonical({
    status: value.status as string,
    movedIds: value.movedIds as number[],
    skipped: [],
    warnings: value.warnings as string[],
    snapshots: [{
      id: snapshot.id as number,
      before: projectPoint(snapshot.before),
      after: projectPoint(snapshot.after)
    }],
    movedTogether: value.movedTogether as boolean,
    rolledBack: value.rolledBack as boolean
  });
}
