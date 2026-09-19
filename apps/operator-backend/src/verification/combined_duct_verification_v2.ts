import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from "../domain/assignment-kernel/index.js";

export const DUCT_VERIFICATION_PARAMETERS_SCHEMA = "revit-operator.duct-verification-parameters/v1";
const fields = ["System Classification", "Reference Level", "Width", "Height", "Diameter"];
const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= 500
  && v.every(id => Number.isSafeInteger(id) && id > 0) && new Set(v).size === v.length;
const sameIds = (a: unknown, b: number[]) => ids(a) && a.length === b.length && a.every(id => b.includes(id));

/** This is a suggested inspection, not permission to dispatch or completion. */
export function pendingDuctVerificationRequestV2(operation: OperationV2) {
  if (!["/revit/mep-route-workflow", "/revit/create-duct"].includes(operation.request_identity?.path ?? "")
      || operation.requested_effect !== "apply" || operation.persistent_effect !== "applied" || operation.settlement_state !== "settled"
      || operation.result?.authority !== "native-host" || operation.result.status !== "succeeded"
      || operation.result.native_transaction_state !== "committed") return null;
  const affected = operation.result.affected_target_identities;
  if (!Array.isArray(affected) || affected.some(value => !/^element_id:[1-9][0-9]*$/.test(value))) return null;
  const elementIds = affected.map(value => Number(value.slice("element_id:".length)));
  if (!ids(elementIds)) return null;
  return { method: "POST", path: "/revit/get-connectors", body: { elementIds,
    includeVerificationParameters: true, includeAllRefs: true, includeCoordinateSystem: true,
    onlyOpenPhysicalConnectors: false, maxConnectorsPerElement: 512 } };
}

/** The caller has already checked native authority, payload hash, binding,
 * post-commit result time and absence of later edits. Validate this combined
 * read's admission and exact coverage before considering its geometric proof. */
export function combinedDuctVerificationParametersV2(snapshot: AssignmentSnapshotV2, subject: OperationV2,
  result: OperationResultV2, payload: unknown): unknown | null {
  const proposed = pendingDuctVerificationRequestV2(subject), read = snapshot.operations[result.operation_id];
  const input = row(read?.input), body = row(input.body), parameters = row(row(payload).verificationParameters);
  if (!proposed || !read || read.operation_id !== result.operation_id || read.verification_of_operation_id !== subject.operation_id
      || read.purpose !== "verification" || read.fulfillment_role !== "verification" || read.requested_effect !== "read"
      || !sameAssignmentBindingV2(read.binding, snapshot.current_binding) || input.method !== "POST" || input.path !== proposed.path
      || !Number.isFinite(Date.parse(read.opened_at)) || Date.parse(read.opened_at) < Date.parse(subject.result!.completed_at)
      || body.includeVerificationParameters !== true || body.includeAllRefs === false || body.includeCoordinateSystem === false
      || body.onlyOpenPhysicalConnectors === true || !sameIds(body.elementIds, proposed.body.elementIds)
      || parameters.schema !== DUCT_VERIFICATION_PARAMETERS_SCHEMA
      || !Array.isArray(parameters.fields) || parameters.fields.length !== fields.length
      || !fields.every(field => parameters.fields.includes(field)) || new Set(parameters.fields).size !== fields.length
      || !Array.isArray(parameters.items) || !sameIds(parameters.items.map((item: unknown) => row(item).id), proposed.body.elementIds)
      || parameters.items.some((item: unknown) => row(item).error)) return null;
  return parameters;
}
