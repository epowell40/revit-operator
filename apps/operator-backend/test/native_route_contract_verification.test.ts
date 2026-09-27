import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { createMepRouteReadbackMatchesV2 } from "../src/verification/polyline_readback_v2.js";
import { openDuctPostconditionSatisfiedV2 } from "../src/verification/open_duct_postcondition_v2.js";

const fixture = () => JSON.parse(fs.readFileSync("test/fixtures/native-route-defaults-repaired-thin.json", "utf8"));
const geometry = (f: any, c = f.cases[0]) => createMepRouteReadbackMatchesV2(
  f.operations[c.subject_id].input, f.payloads[c.subject_id],
  f.payloads[c.read_id].verificationParameters, f.payloads[c.read_id]);
function workspace(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-route-contract-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function retain(f: any) {
  for (const c of f.cases) {
    const subject = f.operations[c.subject_id];
    const saved = storeEvidence({ scope: { ...f.current_binding, attempt_id: subject.operation_id },
      source: "assignment_kernel_v2:revit_call_tool", trust_level: "authoritative_native", raw: f.payloads[c.subject_id] });
    for (const id of subject.observation_ids) f.observations[id].raw_payload_ref = `evidence:${saved.ref.evidence_id}`;
  }
  return f;
}
const verifies = (f: any, c = f.cases[0]) => openDuctPostconditionSatisfiedV2(
  f, f.operations[c.subject_id], f.operations[c.read_id].result, f.payloads[c.read_id]);

test("retained native routes with omitted policies and explicit start override prove unchanged geometry", () => {
  const f = fixture();
  for (const c of f.cases) {
    const subject = f.operations[c.subject_id], read = f.operations[c.read_id];
    assert.equal(payloadDigestV2(f.payloads[c.subject_id]).digest, subject.result.raw_payload_hash);
    assert.equal(payloadDigestV2(f.payloads[c.read_id]).digest, read.result.raw_payload_hash);
    assert.equal(subject.input.body.routingMode, undefined);
    assert.equal(subject.input.body.sizePolicy, undefined);
    assert.equal(subject.input.body.elevationPolicy, undefined);
    assert.equal(subject.input.body.requireExistingEndpointConnections, true);
    assert.equal(subject.input.body.requiredExistingEndpoint, "start");
    assert.equal(geometry(f, c), true, c.name);
  }
});

test("native route defaults and explicit xyz aliases preserve the same strict physical proof", () => {
  const changes: Record<string, (b: any) => void> = {
    explicitPolicies: b => { b.routingMode = "polyline"; b.sizePolicy = b.elevationPolicy = "explicit_required"; },
    nativeFallbackPolicies: b => { b.sizePolicy = "use_default_with_warning"; b.elevationPolicy = "resolve_context_default"; },
    explicitWorldArray: b => { b.points = b.points.map((p: any) => ({ xyz: [p.x, p.y, p.z] })); },
    nativeConnectSegmentsDefault: b => { delete b.connectSegments; },
    optionalLegacyFlag: b => { delete b.requireExistingEndpointConnections; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture(); change(f.operations[f.cases[0].subject_id].input.body);
    assert.equal(geometry(f), true, name);
  }
});

test("native policy normalization never invents dimensions, Z, endpoint owners, or physical connections", () => {
  const changes: Record<string, (f: any, b: any, read: any) => void> = {
    missingSize: (_, b) => { delete b.ductSize; },
    invalidSize: (_, b) => { b.ductSize = "unknown"; },
    missingZ: (_, b) => { delete b.points[0].z; },
    arrayMissingZ: (_, b) => { b.points[0] = { xyz: [1, 2] }; },
    mixedPointAliases: (_, b) => { b.points[0].xyz = [1, 2, 3]; },
    pixels: (_, b) => { b.points[0] = { xPx: 1, yPx: 2, z: 40 }; },
    unknownSizePolicy: (_, b) => { b.sizePolicy = "guess"; },
    unknownElevationPolicy: (_, b) => { b.elevationPolicy = "guess"; },
    unknownRoutingMode: (_, b) => { b.routingMode = "freeform"; },
    invalidConnectDefault: (_, b) => { b.connectSegments = null; },
    wrongStartOwner: (_, b) => { b.expectedExistingStartOwnerId++; },
    missingStartOwner: (_, b) => { delete b.expectedExistingStartOwnerId; },
    contradictingOwner: (_, b) => { b.expectedExistingEndOwnerId = b.expectedExistingStartOwnerId; },
    legacyBothWithoutExplicit: (_, b) => { delete b.requiredExistingEndpoint; delete b.expectedExistingStartOwnerId; },
    requireBoth: (_, b) => { b.requiredExistingEndpoint = "both"; b.expectedExistingEndOwnerId = b.expectedExistingStartOwnerId; },
    disabledConnections: (_, b) => { b.connectToExisting = false; },
    wrongDimensions: (_, __, read) => { read.verificationParameters.items[0].parameters.Diameter = "2"; },
    wrongCoordinates: (_, b) => { b.points[1].x += 0.5; },
    missingEdge: (_, __, read) => { read.results[0].connectors[0].physicalConnectedTo = []; },
    preview: (_, b) => { b.dryRun = true; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture(), c = f.cases[0]; change(f, f.operations[c.subject_id].input.body, f.payloads[c.read_id]);
    assert.equal(geometry(f), false, name);
  }
});

test("exact retained combined reads verify both routes after the shared equipment's later committed edit", () => workspace(() => {
  const f = retain(fixture());
  const [west, east] = f.cases;
  assert(Date.parse(f.operations[east.subject_id].result.completed_at) > Date.parse(f.operations[west.subject_id].result.completed_at));
  assert(Date.parse(f.operations[west.read_id].opened_at) > Date.parse(f.operations[east.subject_id].result.completed_at));
  for (const c of f.cases) assert.equal(verifies(f, c), true, c.name);
}));

test("fresh combined proof rejects stale, partial, foreign, in-flight, or uncertain mutation state", () => workspace(() => {
  const changes: Record<string, (f: any, subject: any, read: any, later: any) => void> = {
    readOpenedBeforeLaterCommit: (_, __, read, later) => { read.opened_at = later.opened_at; },
    mutationDuringRead: (_, __, read, later) => { later.result.completed_at = read.result.completed_at; },
    mutationAfterRead: (_, __, ___, later) => { later.result.completed_at = "2026-09-26T01:13:00Z"; },
    unknownEffect: (_, __, ___, later) => { later.persistent_effect = later.result.persistent_effect = "unknown"; },
    unknownRegistry: f => { f.unresolved_unknown_operation_ids = [f.cases[1].subject_id]; },
    inFlightMutation: (_, __, ___, later) => { later.settlement_state = "open"; later.persistent_effect = "none"; delete later.result; },
    missingCommitTime: (_, __, ___, later) => { delete later.result.completed_at; },
    changedBinding: (_, __, read) => { read.binding = { ...read.binding, generation: 2 }; },
    staleSubject: (_, subject) => { subject.binding = { ...subject.binding, generation: 2 }; },
    uncoveredAppliedTarget: (_, subject) => { subject.result.affected_target_identities.push("element_id:999999"); },
    missingRequestedTarget: (_, __, read) => { read.input.body.elementIds = []; },
    foreignRequestedTarget: (_, __, read) => { read.input.body.elementIds.push(999999); },
    missingPayloadTarget: (f, __, read) => { f.payloads[read.operation_id].verificationParameters.items = []; read.result.raw_payload_hash = payloadDigestV2(f.payloads[read.operation_id]).digest; },
    noPeerEvidence: (_, __, read) => { read.input.body.includeAllRefs = false; },
    corruptPayload: (_, __, read) => { read.result.raw_payload_hash = "0".repeat(64); },
    readTimeBackwards: (_, __, read) => { read.result.completed_at = "2026-09-26T01:12:11Z"; },
    staleLegacySplitRead: (f, __, read) => { delete f.payloads[read.operation_id].verificationParameters; read.result.raw_payload_hash = payloadDigestV2(f.payloads[read.operation_id]).digest; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = retain(fixture()), [west, east] = f.cases;
    change(f, f.operations[west.subject_id], f.operations[west.read_id], f.operations[east.subject_id]);
    assert.equal(verifies(f), false, name);
  }
  const f = retain(fixture()), later = f.operations[f.cases[1].subject_id];
  // A harmless not-dispatched proposed write has no model effect.
  f.operations.unstarted = { ...later, operation_id: "unstarted", dispatch_state: "not_dispatched", settlement_state: "open", persistent_effect: "none", result: undefined };
  assert.equal(verifies(f), true);
}));
