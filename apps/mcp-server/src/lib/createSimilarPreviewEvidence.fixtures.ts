// Retained binder failure coordinates/identities with the candidate's explicit
// native readback/rollback contract. Original signed failure stays private.
export function createSimilarPreviewFixture() {
  const point = { x: -49.03125, y: -16.5, z: 0 };
  const orientation = { basisX: { x: 0, y: 1, z: 0 }, basisY: { x: 0, y: 0, z: 1 }, basisZ: { x: 1, y: 0, z: 0 },
    facing: { x: 0, y: 0, z: 1 }, hand: { x: 0, y: 1, z: 0 }, handFlipped: false, facingFlipped: false };
  const circuit = { exactPowerSystemCount: 1, powerSystemIds: [1585772] };
  const body = { exemplarElementId: 1585163, placements: [{ pointXyz: Object.values(point) }], dryRun: true,
    matchOrientationFromSource: true, copyRotation: true, copyFacingHandState: true,
    matchElectricalCircuitFromSource: true, requireElectricalCircuitMatch: true, parameterNamesToCopy: ["Comments"] };
  const payload = { status: "Planned", dryRun: true, previewExecuted: true, rollbackVerified: true,
    transactionGroupRolledBack: true, transactionStatus: "Committed", residualCreatedElementIds: [],
    transaction: { status: "rolled_back", committed: false, affected_element_ids: [], modified_element_ids: [], added_element_ids: [], deleted_element_ids: [] },
    exemplar: { id: 1585163, electricalCircuit: circuit }, host: { id: 1362762 }, familySymbol: { id: 1372793 }, level: { id: 1474365 },
    placements: [{ index: 0, elementId: null, temporaryElementId: 1736522, placementPoint: point, workset: null,
      levelContext: { requestedLevelId: 1474365, verifiedCreatedLevelId: 1474365, resolvedLevelMatched: true },
      phasing: { sourceCreatedPhaseId: 21885, verifiedCreatedPhaseId: 21885, sourceCreatedPhaseMatched: true },
      sourceOrientation: orientation, electricalCircuit: circuit,
      copiedParameterReadback: [{ name: "Comments", sourcePresent: true, createdPresent: true, sourceStorageType: "String", createdStorageType: "String", sourceValue: "", createdValue: "" }] }],
    placementValidation: { valid: true, invalidIds: [], missingIds: [], offRoomIds: [], offWallIds: [], unsupportedIds: [],
      audit: { items: [{ elementId: 1736522, valid: true, placementContext: { elementId: 1736522, insertionPoint: point,
        typeId: 1372793, host: { id: 1362762 }, orientation, electricalCircuit: circuit } }] } },
    canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview", request_dispatched: true,
      effect_state: "none", effect_authority: "native_rollback", effect_reason: "verified_native_rollback", affected_target_identities: [] }
  };
  // A wire response has independent records; mutation vectors must not alter
  // both expected and observed fields through in-memory object aliases.
  return { path: "/revit/create-similar-from-instance", body,
    payload: JSON.parse(JSON.stringify(payload)) as typeof payload };
}
