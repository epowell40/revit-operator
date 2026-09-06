import { nativeArtifactReceiptEffectV1 } from "@revitoperator/assignment-kernel-v2-contracts";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonicalPath = (value: string): string => value.replaceAll("\\", "/").toLowerCase();

export function artifactTargetTokensV2(value: unknown): readonly string[] {
  let root = object(value);
  if (typeof root.body === "string") { try { root = object(JSON.parse(root.body)); } catch { return []; } }
  else if (root.body && typeof root.body === "object") root = object(root.body);
  const paths = Array.isArray(root.paths) ? root.paths
    : root.schema === "revit-operator.exported-file-inspection.v1" && Array.isArray(root.files) ? root.files.map(file => object(file).path) : [];
  return [...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length < 480 && !/[\u0000-\u001f]/.test(p))
    .map(p => `artifact_path:${canonicalPath(p)}`))].sort();
}

export function nativeArtifactPostconditionV2(receiptValue: unknown, payload: unknown): boolean {
  if (nativeArtifactReceiptEffectV1(receiptValue, "POST", "/revit/export-pdf", "apply") !== "applied") return false;
  const receipt = object(receiptValue), readback = object(payload);
  if (readback.schema !== "revit-operator.exported-file-inspection.v1" || readback.ok !== true || readback.itemsComplete !== true
      || !Array.isArray(readback.requestedPaths) || !Array.isArray(readback.files)) return false;
  const expected = receipt.outputs as Array<{ path: string; size_bytes: number; sha256: string }>;
  const requested = readback.requestedPaths;
  if (requested.length !== expected.length || requested.some(p => typeof p !== "string")
      || new Set(requested.map(p => canonicalPath(p as string))).size !== expected.length
      || expected.some(e => !requested.some(p => canonicalPath(p as string) === canonicalPath(e.path)))
      || readback.files.length !== expected.length) return false;
  const files = readback.files.map(object);
  return expected.every(e => {
    const matches = files.filter(f => typeof f.path === "string" && canonicalPath(f.path) === canonicalPath(e.path));
    return matches.length === 1 && matches[0]!.exists === true && matches[0]!.readable === true
      && matches[0]!.size_bytes === e.size_bytes && matches[0]!.sha256 === e.sha256;
  });
}
