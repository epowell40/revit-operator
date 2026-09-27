import assert from "node:assert/strict";
import test from "node:test";
import { existingMepConnectionReadbackMatchesV2 } from "../src/verification/existing_mep_connection_readback_v2.js";
import { verificationCapabilityAdmissionForPathsV2, operationTargetSelectorV2 } from "../src/verification/verification_capability_admission_v2.js";
import { existingMepConnectionFixture } from "./existing_mep_connection.fixtures.js";

const matches = (f: ReturnType<typeof existingMepConnectionFixture>) =>
  existingMepConnectionReadbackMatchesV2(f.input, f.affected, f.apply, f.scan);

for (const mode of ["takeoff_fitting", "air_terminal_on_duct"] as const) {
  test(`${mode} verifies physical native pairs and retained topology, independent of enumeration order`, () => {
    const f = existingMepConnectionFixture(mode);
    assert.equal(matches(f), true);
    f.scan.results.reverse(); f.scan.results.forEach(r => r.connectors.reverse());
    assert.equal(matches(f), true);
    if (mode === "takeoff_fitting") {
      delete (f.input.body as any).connectionMode; delete f.apply.connectionMode;
      assert.equal(matches(f), true, "native omitted mode defaults to takeoff");
      Object.assign(f.input.body, { expectedTakeoffTypeId: 150, expectedTakeoffTypeName: "Sample type" });
      assert.equal(matches(f), true, "requested type is independently read");
    }
  });
  test(`${mode} rejects missing, mismatched, logical, incomplete and collateral edges`, () => {
    const changes: Record<string, (f: any) => void> = {
      preview: f => { f.input.body.dryRun = true; },
      missingNativeCommit: f => { f.apply.applied = false; },
      wrongNativeBranch: f => { f.apply[mode === "takeoff_fitting" ? "branchElementId" : "terminalElementId"] = 99; },
      wrongSelectedConnector: f => { f.input.body.branchConnectorId = 1; },
      wrongGuardedOrigin: f => { f.input.body.expectedBranchOriginXyz[0]++; },
      occupiedBefore: f => { (f.apply.branchConnector ?? f.apply.terminalConnector).physicalConnectedOwnerIds = [90]; },
      wrongMode: f => { f.input.body.connectionMode = "connect_anything"; },
      extraMutation: f => { f.affected.push("element_id:99"); },
      wrongFamilyConstraint: f => { f.input.body.expectedTakeoffFamilyName = "unread family"; },
      wrongWorksetConstraint: f => { f.input.body.worksetId = 99; },
      truncated: f => { f.scan.results[0].connectorScanTruncated = true; },
      filtered: f => { f.scan.filter = "openPhysicalConnectors"; },
      badCounts: f => { f.scan.physicallyConnectedConnectorCount++; },
      missingRow: f => { f.scan.results.pop(); },
      duplicateRow: f => { f.scan.results[1] = f.scan.results[0]; },
      nullConnector: f => { f.scan.results[0].connectors[0] = null; },
      nullReference: f => { f.scan.results[0].connectors[0].physicalConnectedTo[0] = null; },
      missingRetainedMain: f => { delete f.apply.preexistingMainPhysicalConnections; },
      changedRetainedPeerConnector: f => { f.apply.preexistingMainPhysicalConnections[0].connectedConnectorId++; },
      changedRetainedOrigin: f => { f.apply.preexistingMainPhysicalConnections[0].connectedOrigin[0]++; },
      missingPeerId: f => { delete f.apply.preexistingMainPhysicalConnections[0].connectedConnectorId; },
      replacedMainEnd: f => { f.scan.results[0].connectors[2].connectorType = "End"; },
      missingInteriorCount: f => { delete f.apply.mainConnectorCountBefore; },
      forgedSummary: f => { f.scan = { report: f.scan, connected: true }; },
      wrongPeerOwner: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].ownerId = 30; },
      wrongPeerConnector: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].connectorId = 99; },
      mismatchedAllRefs: f => { f.scan.results[1].connectors[0].connectedTo = []; },
      logicalReference: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].connectorType = "Logical"; },
      systemReference: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].isMepSystem = true; },
      nonPhysicalReference: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].isPhysicalElement = false; },
      notNativelyConnected: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].isConnectedTo = false; },
      enumerationOnlyId: f => { f.scan.results[1].connectors[0].connectorIdBasis = "enumeration_index_with_origin_guard_required"; },
      displacedPeer: f => { f.scan.results[1].connectors[0].physicalConnectedTo[0].origin[0]++; }
    };
    for (const [name, change] of Object.entries(changes)) {
      const f = existingMepConnectionFixture(mode); change(f);
      assert.equal(matches(f), false, name);
    }
  });
}

test("physical reciprocal proof rejects a coherent one-sided graph and silent loss of an old edge", () => {
  const f = existingMepConnectionFixture("air_terminal_on_duct");
  const main = f.scan.results[0], c = main.connectors[2];
  Object.assign(c, { connectedTo: [], physicalConnectedTo: [], physicalConnectionCount: 0, isConnected: false, isPhysicallyConnected: false });
  main.openPhysicalConnectorCount++; f.scan.openPhysicalConnectorCount++; f.scan.physicallyConnectedConnectorCount--;
  assert.equal(matches(f), false, "summaries agree but terminal connection is not reciprocal");
  const g = existingMepConnectionFixture(), old = g.scan.results[0].connectors[0];
  Object.assign(old, { connectedTo: [], physicalConnectedTo: [], physicalConnectionCount: 0, isConnected: false, isPhysicallyConnected: false });
  g.scan.results[0].openPhysicalConnectorCount++; g.scan.openPhysicalConnectorCount++; g.scan.physicallyConnectedConnectorCount--;
  assert.equal(matches(g), false, "new connection cannot hide loss of retained main edge");
});

test("connection admission requires connector semantics and excludes connector IDs from element targets", () => {
  for (const read of ["/revit/get-connectors", "revit_get_connectors"]) {
    assert.equal(verificationCapabilityAdmissionForPathsV2("/revit/connect-existing-mep-branch", read).admissible, true);
  }
  for (const read of ["/revit/get-parameters", "/revit/export-image", "/revit/get-element-summary"]) {
    assert.equal(verificationCapabilityAdmissionForPathsV2("/revit/connect-existing-mep-branch", read).admissible, false);
  }
  const selector = operationTargetSelectorV2({ operation: { capability_id: "revit_call_tool", path: "/revit/get-connectors" },
    value: { results: [{ id: 10, connectors: [{ connectorId: 7, physicalConnectedTo: [{ ownerId: 99, connectorId: 4 }] }] }] } });
  assert.deepEqual(selector.principal_target_tokens, ["id:10"]);
});
