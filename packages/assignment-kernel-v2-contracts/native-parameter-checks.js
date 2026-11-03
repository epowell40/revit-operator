const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
/** Desired field checks, not mutation authority or a prediction of collateral
 * effects. Preserve them in the canonical call; never send them as C# output. */
export function normalizeNativeParameterChecks(value, mode) {
  if (value === undefined) return undefined;
  if (mode !== "apply" || !Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new Error("Native parameter_checks require 1..64 explicit apply postconditions.");
  const keys = new Set(), names = new Set();
  const checks = value.map(raw => {
    const row = object(raw);
    if (Object.keys(row).length !== 3 || Object.keys(row).some(k => !["element_id", "parameter_name", "expected_value"].includes(k))
        || !Number.isSafeInteger(row.element_id) || Number(row.element_id) <= 0
        || typeof row.parameter_name !== "string" || !row.parameter_name.trim() || row.parameter_name !== row.parameter_name.trim()
        || row.parameter_name.length > 128 || /[\x00-\x1f\x7f]/.test(row.parameter_name)
        || typeof row.expected_value !== "string" || row.expected_value.length > 32768 || row.expected_value.includes("\0"))
      throw new Error("Native parameter_checks contain invalid target, field or expected text.");
    const key = JSON.stringify([row.element_id, row.parameter_name.toLowerCase()]);
    if (keys.has(key)) throw new Error("Native parameter_checks must not repeat a target/field.");
    keys.add(key); names.add(row.parameter_name);
    return { element_id: Number(row.element_id), parameter_name: row.parameter_name, expected_value: row.expected_value };
  });
  if (names.size > 50) throw new Error("Native parameter_checks exceed the bounded parameter-read field count.");
  if (new TextEncoder().encode(JSON.stringify(checks)).byteLength > 65536)
    throw new Error("Native parameter_checks exceed the 64KiB aggregate text budget.");
  return checks;
}

