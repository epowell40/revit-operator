import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExpectedGfciModelSha256,
  collectGfciNativeEvidence,
  type GfciNativeAdapterConfig
} from "../src/existing_conditions/engineering_native_adapters.js";

const PROFILE = "e28ae52a495eaeec357987854c75d5f1cfec1b455a71c6612f74b5a235ef373e";

function config(bounds = { min: { x: 0, y: 0 }, max: { x: 12, y: 8 } }): GfciNativeAdapterConfig {
  return {
    schema_version: 1,
    case_id: "live-gfci-room-403-v1",
    standards_profile_sha256: PROFILE,
    starting_model_sha256: "c".repeat(64),
    expected_model_sha256: "a".repeat(64),
    check_id: "sink-protection",
    room_number: "403",
    scope_bounds_ft: bounds,
    sink_match_tokens: ["sink", "vanity", "lavatory"],
    receptacle_match_tokens: ["receptacle"],
    integral_protection_tokens: ["gfci", "g.f.c.i."],
    location_classes: ["dwelling_sink"],
    receptacle_amps: 20,
    sink_search_radius_ft: 6,
    distance_measurement: "horizontal_clear_distance_to_sink_bbox"
  };
}

function nativePayload(typeName = "Standard", receptaclePoint = { x: 4, y: 3, z: 4 }) {
  return {
    roomNumber: "403",
    diagnostics: { matchedScopedCount: 3 },
    elements: [
      {
        id: 101,
        sourceScopedId: "host:101",
        builtInCategory: "OST_ElectricalFixtures",
        category: "Electrical Fixtures",
        familyName: "Duplex Receptacle",
        typeName,
        name: typeName,
        point: receptaclePoint,
        bbox: { min: { x: receptaclePoint.x - 0.1, y: receptaclePoint.y - 0.1 }, max: { x: receptaclePoint.x + 0.1, y: receptaclePoint.y + 0.1 } },
        electricalCircuit: { powerSystemIds: [9001], exactPowerSystemCount: 1 },
        source: { scope: "host", hostDocumentPath: "C:/fixtures/electrical.rvt" }
      },
      {
        id: 202,
        sourceScopedId: "link:12:202",
        builtInCategory: "OST_PlumbingFixtures",
        category: "Plumbing Fixtures",
        familyName: "SinkConnection",
        typeName: "Kitchen Sink",
        name: "Kitchen Sink",
        point: { x: 8, y: 3, z: 3 },
        bbox: { min: { x: 7.5, y: 2.5 }, max: { x: 8.5, y: 3.5 } },
        source: { scope: "linked", sourceDocumentPath: "C:/fixtures/plumbing.rvt" }
      },
      {
        id: 303,
        sourceScopedId: "link:12:303",
        builtInCategory: "OST_PlumbingFixtures",
        category: "Plumbing Fixtures",
        familyName: "Water Closet",
        typeName: "Tank",
        name: "Toilet-Domestic-3D",
        point: { x: 4.1, y: 3, z: 3 },
        bbox: { min: { x: 3.5, y: 2.5 }, max: { x: 4.5, y: 3.5 } }
      }
    ]
  };
}

const parameters = [{
  id: 101,
  name: "Standard",
  category: "Electrical Fixtures",
  parameters: { "Electrical Data": "120 V/1-180 VA" }
}];

test("collects geometric GFCI evidence from native room and parameter readbacks without target element IDs in config", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload(), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles.length, 1);
  assert.equal(check.receptacles[0]?.element_key, "host:101");
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
  assert.equal(check.receptacles[0]?.voltage_to_ground, 120);
  assert.equal(check.receptacles[0]?.protection, undefined);
  assert.equal((evidence.collection_receipt as Record<string, unknown>).subject_element_ids_withheld_from_config, true);
});

test("accepts a geometrically different integral GFCI solution and records native circuit association", () => {
  const evidence = collectGfciNativeEvidence(
    config({ min: { x: 10, y: -5 }, max: { x: 25, y: 10 } }),
    nativePayload("GFCI", { x: 12, y: 3, z: 4 }),
    [{ ...parameters[0]!, name: "GFCI" }]
  );
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
  assert.equal(check.receptacles[0]?.protection?.method, "integral_device");
  assert.deepEqual(check.receptacles[0]?.protection?.path_element_keys, ["host:101"]);
  assert.deepEqual((check.receptacles[0] as unknown as { native_collection: { power_system_ids: number[] } }).native_collection.power_system_ids, [9001]);
});

test("requires the per-element parameter readback to prove the integral GFCI type", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload("GFCI"), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.protection, undefined);
});

test("uses sink bbox clear distance instead of memorized source coordinates or fixture origin distance", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload("Standard", { x: 7, y: 3, z: 4 }), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 0.5);
});

test("rejects missing native voltage readback instead of filling a convenient benchmark answer", () => {
  assert.throws(
    () => collectGfciNativeEvidence(config(), nativePayload(), [{ id: 101, category: "Electrical Fixtures", parameters: {} }]),
    /gfci_adapter_voltage_missing:101/
  );
});

test("does not let a nearby toilet satisfy the sink geometry requirement", () => {
  const payload = nativePayload();
  payload.elements = payload.elements.filter((element) => element.id !== 202);
  assert.throws(() => collectGfciNativeEvidence(config(), payload, parameters), /gfci_adapter_sink_geometry_missing/);
});

test("requires geometric scope to contain a native receptacle", () => {
  assert.throws(
    () => collectGfciNativeEvidence(config({ min: { x: 20, y: 20 }, max: { x: 30, y: 30 } }), nativePayload(), parameters),
    /gfci_adapter_scoped_receptacles_missing/
  );
});

test("rejects a live capture whose active model hash differs from evaluator configuration", () => {
  assert.throws(() => assertExpectedGfciModelSha256(config(), "b".repeat(64)), /gfci_adapter_expected_model_hash_mismatch/);
  assert.doesNotThrow(() => assertExpectedGfciModelSha256(config(), "a".repeat(64)));
});

test("ignores a token-matching sink outside the bounded search region", () => {
  const payload = nativePayload("Standard", { x: 4, y: 3, z: 4 });
  payload.elements.push({
    id: 404,
    sourceScopedId: "link:12:404",
    builtInCategory: "OST_PlumbingFixtures",
    category: "Plumbing Fixtures",
    familyName: "Sink",
    typeName: "Out of scope",
    name: "Sink",
    point: { x: 20, y: 3, z: 3 },
    bbox: { min: { x: 19.9, y: 2.9 }, max: { x: 20.1, y: 3.1 } }
  });
  const evidence = collectGfciNativeEvidence(config(), payload, parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
});
