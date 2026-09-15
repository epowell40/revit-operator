export function ductPreviewFixture(legacy = false, round = false) {
  const a = { x: -15.998833634163205, y: -17.28571207578689, z: 44.16666666667048 };
  const b = { ...a, x: -1.2865021916655053 };
  const lengthFt = b.x - a.x;
  const dimensions = round ? { diameterFt: 0.5 } : { widthFt: 1, heightFt: 10 / 12 };
  const body: Record<string, any> = {
    ...(legacy ? { startX: a.x, startY: a.y, startZ: a.z, endX: b.x, endY: b.y, endZ: b.z }
      : { kind: "duct", points: [{ xyz: [a.x, a.y, a.z] }, { xyz: [b.x, b.y, b.z] }] }),
    ductTypeId: round ? 20 : 10, ductShape: round ? "round" : "rectangular", ductSize: round ? "6" : "12x10",
    dryRun: true, verify: true, connectToExisting: false, connectSegments: false
  };
  const payload: Record<string, any> = {
    status: "Dry Run", dryRun: true, kind: "duct", rolledBack: true,
    selected: { ductType: { id: body.ductTypeId, name: "Default", familyName: "Duct", shape: body.ductShape },
      level: { id: 2, name: "L4" }, systemType: { id: 3, name: "Supply Air" } },
    plannedPoints: [a, b], segmentCount: 1, totalLengthFt: lengthFt,
    createdElementIds: [], createdFittingIds: [], dryRunElementIds: [1542920], dryRunFittingIds: [], internalConnectionsVerified: true,
    segments: [{ index: 0, id: 1542920, start: a, end: b, lengthFt,
      chosenSize: dimensions, nativeSizeReadback: { shape: body.ductShape, ...dimensions },
      nativeGeometryReadback: { start: a, end: b, lengthFt } }],
    transaction: { status: "rolled_back", committed: false, modified_element_ids: [], affected_element_ids: [] },
    canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "duct-preview",
      requested_effect: "preview", effect_state: "none", effect_authority: "native_rollback",
      effect_reason: "verified_native_rollback", request_dispatched: true, affected_target_identities: [] }
  };
  return { path: legacy ? "/revit/create-duct" : "/revit/create-mep-route", body, payload };
}
