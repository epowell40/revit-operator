// Synthetic native-contract fixtures. These are not live Revit qualification.
export function existingMepConnectionFixture(mode: "takeoff_fitting" | "air_terminal_on_duct" = "takeoff_fitting") {
  const direct = mode === "air_terminal_on_duct";
  const connector = (id: number, origin: number[], type = "End"): any => ({
    connectorId: id, connectorIdBasis: "revit_native_connector_id", connectorType: type,
    origin, domain: "DomainHvac", shape: "Round", size: { kind: "round", diameterFt: 0.5, radiusFt: 0.25 },
    isConnected: false, isPhysicallyConnected: false, physicalConnectionCount: 0, connectedTo: [], physicalConnectedTo: []
  });
  const element = (id: number, category: string, connectors: any[]): any => ({ id, category, typeId: id + 100,
    typeName: "Sample type", ok: true, connectors, connectorCount: connectors.length,
    returnedConnectorCount: connectors.length, connectorScanTruncated: false });
  const main = element(10, "OST_DuctCurves", [connector(0, [0, 0, 0]), connector(1, [10, 0, 0]), connector(2, [5, 0, 0], "Curve")]);
  const branch = element(20, direct ? "OST_DuctTerminal" : "OST_DuctCurves",
    direct ? [connector(0, [5, 0, 0])] : [connector(0, [5, 1, 0]), connector(1, [5, 5, 0])]);
  const left = element(30, "OST_DuctCurves", [connector(1, [0, 0, 0])]);
  const equipment = element(40, "OST_MechanicalEquipment", [connector(3, [5, 5, 0])]);
  const fitting = element(50, "OST_DuctFitting", [connector(0, [5, 0, 0]), connector(1, [5, 1, 0])]);
  const connect = (a: any, ai: number, b: any, bi: number) => {
    const from = (owner: any, c: any) => ({ ownerId: owner.id, ownerCategory: owner.category,
      connectorId: c.connectorId, connectorIdBasis: c.connectorIdBasis, connectorType: c.connectorType,
      origin: [...c.origin], domain: c.domain, shape: c.shape, size: structuredClone(c.size),
      isMepSystem: false, isPhysicalElement: true, isConnectedTo: true });
    for (const [c, ref] of [[a.connectors[ai], from(b, b.connectors[bi])], [b.connectors[bi], from(a, a.connectors[ai])]]) {
      c.connectedTo.push(ref); c.physicalConnectedTo.push(structuredClone(ref));
      c.physicalConnectionCount++; c.isConnected = c.isPhysicallyConnected = true;
    }
  };
  connect(main, 0, left, 0);
  if (!direct) connect(branch, 1, equipment, 0);
  const retained = (e: any) => e.connectors.flatMap((c: any) => c.physicalConnectedTo.map((r: any) => ({
    connectorId: c.connectorId, connectorIdBasis: c.connectorIdBasis, origin: [...c.origin],
    connectedOwnerId: r.ownerId, connectedConnectorId: r.connectorId,
    connectedConnectorIdBasis: r.connectorIdBasis, connectedOrigin: [...r.origin]
  })));
  const before = { ...structuredClone(branch.connectors[0]), physicalConnectedOwnerIds: [] };
  const apply: any = { status: "Connected", connectionMode: mode, dryRun: false, applied: true,
    mainElementId: 10, preexistingMainPhysicalConnections: retained(main), mainConnectorCountBefore: 2 };
  if (direct) Object.assign(apply, { terminalElementId: 20, terminalConnector: before,
    preexistingTerminalPhysicalConnections: retained(branch) });
  else Object.assign(apply, { branchElementId: 20, branchConnector: before,
    preexistingBranchPhysicalConnections: retained(branch), createdFittingId: 50, createdTypeId: 150 });
  if (direct) connect(branch, 0, main, 2);
  else { connect(branch, 0, fitting, 1); connect(main, 2, fitting, 0); }
  const results = direct ? [main, branch] : [main, branch, fitting];
  const scan = { status: "Ok", filter: "allConnectors", requestedCount: results.length,
    scannedElementCount: results.length, matchedElementCount: results.length, failedElementCount: 0,
    connectorScanTruncatedElementCount: 0, totalScannedConnectorCount: 0,
    physicallyConnectedConnectorCount: 0, openPhysicalConnectorCount: 0, results };
  for (const r of results) {
    r.openPhysicalConnectorCount = r.connectors.filter((c: any) => !c.isPhysicallyConnected).length;
    scan.totalScannedConnectorCount += r.connectors.length;
    scan.openPhysicalConnectorCount += r.openPhysicalConnectorCount;
    scan.physicallyConnectedConnectorCount += r.connectors.length - r.openPhysicalConnectorCount;
  }
  return { input: { method: "POST", path: "/revit/connect-existing-mep-branch", body: {
    kind: "duct", connectionMode: mode, mainElementId: 10, branchElementId: 20,
    branchConnectorId: 0, expectedBranchOriginXyz: [...before.origin], dryRun: false, verify: true
  } }, apply, scan, affected: results.map(r => `element_id:${r.id}`) };
}
