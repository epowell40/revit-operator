/**
 * Deterministic semantic comparison shared by the live teammate controller and
 * Assignment Kernel V2 settlement/recovery. The comparison intentionally uses
 * only the admitted apply input and authoritative verification payload so the
 * same result can be derived after process loss.
 */

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function structuredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_000_000 || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function semanticApplyInput(value: unknown): unknown {
  const input = objectValue(value);
  return Object.prototype.hasOwnProperty.call(input, "body")
    ? structuredValue(input.body)
    : structuredValue(value);
}

export function expectedPostconditionValuesV2(value: unknown, includeIdentityRenames = true): readonly string[] {
  const values = new Set<string>();
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 6 || values.size >= 32) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, childKey, key, depth + 1);
      }
      return;
    }
    if (node === null || node === undefined) return;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const normalizedParent = parent.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const valueIsPredicate = /(?:filter|condition|rule|criterion|criteria)/.test(normalizedParent);
    const identityRename = includeIdentityRenames && ["newname", "newnumber"].includes(normalizedKey);
    const assignedValue = ["value", "newvalue", "replaceto", "targetvalue", "newtext", "replacementtext", "replacewith"].includes(normalizedKey);
    if (normalizedParent === "parameters" || (!valueIsPredicate && (identityRename || assignedValue))) {
      values.add(JSON.stringify(node));
    }
  };
  visit(semanticApplyInput(value));
  return [...values].sort();
}

export function observedPostconditionValuesV2(value: unknown): ReadonlySet<string> {
  const values = new Set<string>();
  const excludedContainers = new Set([
    "arguments", "body", "canonicalattemptsettlement", "control", "input", "meta", "metadata",
    "operationresultv2", "payloadprovenance", "provenance", "request", "requestbody", "requestinput"
  ]);
  const controlLeaves = new Set([
    "action", "complete", "dryrun", "error", "failure", "message", "ok", "status", "success", "verified"
  ]);
  const visit = (node: unknown, key = "", parent = "", depth = 0): void => {
    if (depth > 8 || values.size >= 512 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, parent, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, item] of Object.entries(node as Record<string, unknown>)) {
        const normalizedChild = childKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
        if (excludedContainers.has(normalizedChild)) continue;
        visit(item, childKey, key, depth + 1);
      }
      return;
    }
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try {
        visit(JSON.parse(node), key, parent, depth + 1);
        return;
      } catch {
        // The string itself remains valid observable evidence.
      }
    }
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    // Native adapters do not share one field vocabulary: a parameter can be
    // returned as `value`, `values`, or its actual parameter name, while sheet
    // and TextNote reads use names such as `afterName` and `text`. Treat those
    // result fields as observable but exclude lifecycle/control leaves and all
    // request/input/provenance containers above.
    if (normalizedKey && !controlLeaves.has(normalizedKey)) {
      values.add(JSON.stringify(node));
    }
  };
  visit(value);
  return values;
}

export function postconditionSatisfiedByPayloadV2(applyInput: unknown, verificationPayload: unknown): boolean {
  const expected = expectedPostconditionValuesV2(applyInput);
  if (expected.length > 0) {
    const observed = observedPostconditionValuesV2(verificationPayload);
    return expected.every(value => observed.has(value));
  }
  // An untyped success/complete/exists flag cannot prove an arbitrary mutation.
  // Operations without assigned values require a capability-specific trusted
  // assertion from the controller until their postcondition has a typed adapter.
  return false;
}
