import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverRegisteredRouteFrontierV1,
  type RegisteredRouteFrontierCandidateV1
} from "../src/existing_conditions/registered_route_frontier_discovery.js";

const HASH = "a".repeat(64);

function candidate(): RegisteredRouteFrontierCandidateV1 {
  return {
    schema_version: 1 as const,
    package_id: "blind-sheet-1",
    primitive_id: "p-bl-2",
    source_interpretation_sha256: HASH,
    registration_receipt_sha256: "b".repeat(64),
    raster_evidence_receipt_sha256: "c".repeat(64),
    kind: "duct" as const,
    points: [
      { x: 26.6969731412, y: 13.5127915031 },
      { x: 22.7889900233, y: 13.5128496646 }
    ],
    view_id: 171920,
    level_name: "L4",
    source_claims: [{
      attribute: "size" as const,
      value: "6 inch",
      association: "contextual" as const,
      confidence: 0.72,
      evidence_reference: "source-crop:nearby-callout-6in"
    }]
  };
}

function connector(index: number, origin: number[], basisZ: number[], physicalConnectionCount: number, physicalConnectedTo: unknown[] = []) {
  return {
    index,
    connectorId: index + 1,
    connectorIdBasis: "revit_native_connector_id",
    origin,
    domain: "DomainHvac",
    shape: "Round",
    systemClassification: "ExhaustAir",
    size: { diameterFt: 1 / 3 },
    coordinateSystem: { basisZ },
    physicalConnectionCount,
    physicalConnectedTo
  };
}

function readback(extra: unknown[] = []) {
  return {
    status: "Ok",
    results: [
      {
        id: 101,
        ok: true,
        category: "OST_DuctFitting",
        name: "1.5 D",
        typeId: 501,
        typeName: "Elbow",
        createdPhaseId: 21885,
        systemName: "Mechanical Exhaust Air 22",
        connectors: [
          connector(0, [26.1740373195, 13.5641153372, 42.5], [-1, 0, 0], 0),
          connector(1, [26.6740373195, 14.0641153372, 42.5], [0, 1, 0], 1, [
            { ownerId: 301, ownerCategory: "OST_DuctCurves", isPhysicalElement: true }
          ])
        ]
      },
      {
        id: 202,
        ok: true,
        category: "OST_DuctFitting",
        name: "1.5 D",
        typeId: 501,
        typeName: "Elbow",
        createdPhaseId: 21885,
        systemName: "Mechanical Exhaust Air 22",
        connectors: [
          connector(0, [23.1740373195, 13.5641153372, 42.5], [1, 0, 0], 0),
          connector(1, [22.6740373195, 14.0641153372, 42.5], [0, 1, 0], 1, [
            { ownerId: 302, ownerCategory: "OST_DuctCurves", isPhysicalElement: true }
          ])
        ]
      },
      {
        id: 301,
        ok: true,
        category: "OST_DuctCurves",
        name: "Tees / Round Duct",
        typeId: 139186,
        typeName: "Tees / Round Duct",
        createdPhaseId: 21885,
        systemName: "Mechanical Exhaust Air 22",
        connectors: []
      },
      {
        id: 302,
        ok: true,
        category: "OST_DuctCurves",
        name: "Tees / Round Duct",
        typeId: 139186,
        typeName: "Tees / Round Duct",
        createdPhaseId: 21885,
        systemName: "Mechanical Exhaust Air 22",
        connectors: []
      },
      ...extra
    ]
  };
}

const policy = { maximum_endpoint_snap_ft: 0.6 };

test("discovers a unique retained frontier and resolves native route parameters without a target id", () => {
  const receipt = discoverRegisteredRouteFrontierV1(candidate(), {
    native_connector_readback: readback(),
    policy
  });
  assert.equal(receipt.status, "ready");
  assert.deepEqual(receipt.blockers, []);
  assert.equal(receipt.endpoint_matches.length, 2);
  assert.equal(receipt.native_consensus?.size, '4"');
  assert.equal(receipt.native_consensus?.system_type, "Exhaust Air");
  assert.equal(receipt.native_consensus?.elevation_z_ft, 42.5);
  assert.equal(receipt.native_consensus?.route_type_id, 139186);
  assert.deepEqual(receipt.native_consensus?.adjacent_route_element_ids, [301, 302]);
  assert.equal(receipt.resolved_candidate?.route_type_id, 139186);
  assert.equal(receipt.resolved_candidate?.size, '4"');
  assert.equal(receipt.source_claim_assessments[0]?.status, "native_override_recorded");
  assert.equal(receipt.source_claim_assessments[0]?.native_value, '4"');
});

test("blocks a high-confidence exact source claim that conflicts with native consensus", () => {
  const input = candidate();
  input.source_claims![0] = {
    ...input.source_claims![0]!,
    association: "exact",
    confidence: 0.95
  };
  const receipt = discoverRegisteredRouteFrontierV1(input, { native_connector_readback: readback(), policy });
  assert.equal(receipt.status, "deferred");
  assert.equal(receipt.resolved_candidate, null);
  assert.ok(receipt.blockers.includes("frontier_exact_source_claim_conflicts_with_native_consensus:size"));
  assert.equal(receipt.source_claim_assessments[0]?.status, "exact_conflict_blocks");
});

test("defers when an endpoint has two materially indistinguishable open connectors", () => {
  const duplicate = {
    id: 999,
    ok: true,
    category: "OST_DuctFitting",
    name: "Duplicate",
    typeId: 502,
    typeName: "Duplicate",
    createdPhaseId: 21885,
    systemName: "Mechanical Exhaust Air 22",
    connectors: [connector(0, [26.1840373195, 13.5641153372, 42.5], [-1, 0, 0], 0)]
  };
  const receipt = discoverRegisteredRouteFrontierV1(candidate(), {
    native_connector_readback: readback([duplicate]),
    policy
  });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("start_frontier_connector_match_is_ambiguous"));
});

test("defers when adjacent native route type metadata is absent", () => {
  const missing = readback();
  delete (missing.results[2] as any).typeId;
  delete (missing.results[3] as any).typeId;
  const receipt = discoverRegisteredRouteFrontierV1(candidate(), { native_connector_readback: missing, policy });
  assert.equal(receipt.status, "deferred");
  assert.ok(receipt.blockers.includes("frontier_route_type_consensus_failed"));
});

test("pipe frontier resolves by native type name without emitting unsupported pipe type id", () => {
  const input = { ...candidate(), kind: "pipe" as const, source_claims: [] };
  const pipeReadback = readback();
  for (const row of pipeReadback.results as any[]) {
    row.category = String(row.category).replace("Duct", "Pipe");
    for (const c of row.connectors ?? []) {
      c.domain = "DomainPiping";
      c.systemClassification = "DomesticColdWater";
    }
    row.systemName = "Domestic Cold Water 1";
    if (String(row.category).includes("PipeCurves")) row.typeName = row.name = "Standard";
  }
  const receipt = discoverRegisteredRouteFrontierV1(input, { native_connector_readback: pipeReadback, policy });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.resolved_candidate?.system_type, "Domestic Cold Water");
  assert.equal(receipt.resolved_candidate?.route_type_name, "Standard");
  assert.equal(receipt.resolved_candidate?.route_type_id, undefined);
});
