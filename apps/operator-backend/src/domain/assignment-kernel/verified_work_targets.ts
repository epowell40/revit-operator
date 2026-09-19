import type { AssignmentSnapshotV2 } from "./snapshot.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import { verificationOperationHasVerifiedPostconditionV2 } from "./outcome.js";
import { operationTargetIdentityAliasesV2 } from "./operation_target_identity.js";

/** A Revit transaction also modifies levels, spaces and other dependents.
 * Use the independently verified deliverable targets, not those incidental
 * modified owners, when measuring distinct work or planning a final review. */
export function verifiedNativeWorkTargetIdentitiesV2(snapshot: AssignmentSnapshotV2, appliedId: string): string[] {
  const applied = snapshot.operations[appliedId];
  if (!applied || applied.requested_effect !== "apply" || !sameAssignmentBindingV2(applied.binding, snapshot.current_binding)) return [];
  const targets = new Set<string>();
  for (const id of applied.verification_operation_ids) {
    const read = snapshot.operations[id];
    if (!verificationOperationHasVerifiedPostconditionV2(snapshot,id) || read?.verification_of_operation_id !== appliedId
        || read.result?.authority !== "native-host" || !sameAssignmentBindingV2(read.binding,snapshot.current_binding)
        || !sameAssignmentBindingV2(read.result.binding,snapshot.current_binding)
        || !read.observation_ids.some(oid => {
          const observation = snapshot.observations[oid];
          return observation?.operation_id === id && observation.authority === "native-host" && sameAssignmentBindingV2(observation.binding,snapshot.current_binding)
            && observation.facts.some(f=>f.fact_id === "verification.postcondition_satisfied" && f.fact_class === "verification" && f.value === true);
        })) continue;
    const identities = [read.target.target_id,...Object.values(read.target.semantic_scope ?? {})];
    for (const value of identities) for (const alias of operationTargetIdentityAliasesV2(value)) {
      if (/^id:[1-9][0-9]*$/.test(alias)) targets.add(`element_id:${alias.slice(3)}`);
      else if (alias.startsWith("artifact_path:")) targets.add(alias);
    }
  }
  return [...targets].sort();
}
