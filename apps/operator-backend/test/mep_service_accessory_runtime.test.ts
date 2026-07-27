import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ToolResult } from "../src/contracts.js";
import {
  __testOnlyClearMepServiceAccessoryStates,
  maybeRunMepServiceAccessoryPreflight,
  parseMepServiceAccessoryTask
} from "../src/deterministic/mep_service_accessory_runtime.js";

const prompt = "Add a shock arrestor to the domestic water piping serving the toilet in room 2968T.";

function request(session: string, userText = prompt, toolResults?: ToolResult[]): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `${session}-m`, user_text: userText, ...(toolResults ? { tool_results: toolResults } : {}) };
}

function done(action_id: string, path: string, result_json: Record<string, unknown>): ToolResult {
  return { action_id, method: "POST", path, status: "done", result_json };
}

test("service-accessory parser preserves the user's accessory, target, room, and service semantics", () => {
  const task = parseMepServiceAccessoryTask(prompt);
  assert.equal(task?.accessory.text, "shock arrestor");
  assert.equal(task?.target.text, "toilet");
  assert.deepEqual(task?.target.identity_terms, ["toilet", "water closet", "wc"]);
  assert.equal(task?.room_number, "2968T");
  assert.equal(task?.service.kind, "pipe");
  assert.deepEqual(task?.service.system_classifications, ["DomesticColdWater", "DomesticHotWater"]);
  assert.equal(parseMepServiceAccessoryTask("Where are the shock arrestors?"), null);
  assert.equal(parseMepServiceAccessoryTask("Do not add a shock arrestor to the piping serving the toilet in room 2968T."), null);
  assert.equal(parseMepServiceAccessoryTask("Install a balancing damper on the supply air ductwork serving diffuser D-12 in Room 405.")?.service.kind, "duct");
});

test("service-accessory preflight resolves a linked-room target, proves the connector is open, and asks one grounded clarification", () => {
  __testOnlyClearMepServiceAccessoryStates();
  const session = "service-accessory-open-connector";
  const first = maybeRunMepServiceAccessoryPreflight(request(session));
  assert.equal(first?.actions.length, 1);
  assert.equal(first?.actions[0]?.path, "/revit/find-elements");
  assert.deepEqual(first?.actions[0]?.body, { identityTerms: ["toilet", "water closet", "wc"], physicalElementsOnly: true, topLevelInstancesOnly: true, limit: 500 });

  const second = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-find", "/revit/find-elements", {
    status: "Ok",
    elementIds: [14242290, 14242291],
    itemsComplete: true,
    truncated: false
  })]));
  assert.equal(second?.actions[0]?.path, "/revit/locate-elements");
  assert.equal((second?.actions[0]?.body as Record<string, unknown>).roomNumber, "2968T");
  assert.equal((second?.actions[0]?.body as Record<string, unknown>).includeLinkedRooms, true);
  assert.equal((second?.actions[0]?.body as Record<string, unknown>).spatialVerticalScope, "same_level");

  const third = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-locate", "/revit/locate-elements", {
    status: "Ok",
    count: 1,
    items: [{ elementId: 14242290, familyName: "P-6", typeName: "P-6", roomNumber: "2968T", levelName: "LEVEL 2", spatialContext: { status: "resolved", selected: { number: "2968T", sourceScope: "linked" } } }]
  })]));
  assert.equal(third?.actions[0]?.path, "/revit/get-connectors");
  assert.deepEqual((third?.actions[0]?.body as Record<string, unknown>).elementIds, [14242290]);

  const terminal = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-connectors", "/revit/get-connectors", {
    status: "Ok",
    results: [{
      id: 14242290,
      ok: true,
      connectors: [
        { domain: "Piping", systemClassification: "DomesticColdWater", physicalConnectionCount: 0, isPhysicallyConnected: false, physicalConnectedTo: [] },
        { domain: "Piping", systemClassification: "Sanitary", physicalConnectionCount: 0, isPhysicallyConnected: false, physicalConnectedTo: [] }
      ]
    }]
  })]));
  assert.equal(terminal?.actions.length, 0);
  assert.equal(terminal?.aec_query_receipt?.status, "ambiguous");
  assert.match(terminal?.assistant_message ?? "", /P-6\), element 14242290/);
  assert.match(terminal?.assistant_message ?? "", /DomesticColdWater connector is open/);
  assert.match(terminal?.assistant_message ?? "", /no physical pipe connection/);
  assert.match(terminal?.assistant_message ?? "", /Should I first route and connect/);
  assert.match(terminal?.assistant_message ?? "", /No model changes were made/);
});

test("service-accessory preflight never substitutes a nearby main for a serving connection", () => {
  __testOnlyClearMepServiceAccessoryStates();
  const session = "service-accessory-nearby-is-not-serving";
  maybeRunMepServiceAccessoryPreflight(request(session));
  maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-find", "/revit/find-elements", { elementIds: [14242290], itemsComplete: true, truncated: false })]));
  maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-locate", "/revit/locate-elements", { items: [{ elementId: 14242290, familyName: "P-6", roomNumber: "2968T", spatialContext: { status: "resolved", selected: { number: "2968T", sourceScope: "linked" } } }] })]));
  const terminal = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-connectors", "/revit/get-connectors", {
    results: [{ id: 14242290, ok: true, connectors: [{ domain: "Piping", systemClassification: "DomesticColdWater", physicalConnectedTo: [], nearestElement: { id: 16555477, category: "OST_PipeCurves", distanceFt: 0.5 } }] }]
  })]));
  assert.equal(terminal?.actions.length, 0);
  assert.match(terminal?.assistant_message ?? "", /no physical pipe connection/);
  assert.doesNotMatch(terminal?.assistant_message ?? "", /16555477/);
});

test("service-accessory preflight rejects a possible room match when the spatial resolver is ambiguous", () => {
  __testOnlyClearMepServiceAccessoryStates();
  const session = "service-accessory-ambiguous-room";
  maybeRunMepServiceAccessoryPreflight(request(session));
  maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-find", "/revit/find-elements", { elementIds: [14242290], itemsComplete: true, truncated: false })]));
  const terminal = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-locate", "/revit/locate-elements", { items: [{ elementId: 14242290, roomNumber: null, spatialContext: { status: "ambiguous", matches: [{ number: "2968T" }, { number: "2969T" }] } }] })]));
  assert.equal(terminal?.actions.length, 0);
  assert.equal(terminal?.aec_query_receipt?.status, "ambiguous");
  assert.match(terminal?.assistant_message ?? "", /will not turn a possible room match into a unique target/);
});

test("a connected service is traced to exact serving curve ids before producing a bounded handoff", () => {
  __testOnlyClearMepServiceAccessoryStates();
  const session = "service-accessory-connected-trace";
  maybeRunMepServiceAccessoryPreflight(request(session));
  maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-find", "/revit/find-elements", { elementIds: [14242290], itemsComplete: true, truncated: false })]));
  maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-locate", "/revit/locate-elements", { items: [{ elementId: 14242290, familyName: "P-6", roomNumber: "2968T", spatialContext: { status: "resolved", selected: { number: "2968T", sourceScope: "linked" } } }] })]));
  const tracePlan = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-connectors", "/revit/get-connectors", {
    results: [{ id: 14242290, ok: true, connectors: [{ connectorId: 7, domain: "Piping", systemClassification: "DomesticColdWater", isPhysicallyConnected: true, physicalConnectionCount: 1, physicalConnectedTo: [{ ownerId: 16555477, ownerCategory: "OST_PipeCurves", isPhysicalElement: true }] }] }]
  })]));
  assert.equal(tracePlan?.actions[0]?.path, "/revit/trace-connected-network");
  assert.equal((tracePlan?.actions[0]?.body as Record<string, unknown>).startElementId, 14242290);
  assert.equal((tracePlan?.actions[0]?.body as Record<string, unknown>).maxHops, 4);
  const terminal = maybeRunMepServiceAccessoryPreflight(request(session, "", [done("mep-service-target-trace", "/revit/trace-connected-network", {
    status: "Ok", visitedCount: 3, maxElements: 200, elementIdsByCategory: { OST_PipeCurves: [16555477], OST_PipeFitting: [16555478] }, edges: [{ fromId: 14242290, toId: 16555477 }], warnings: []
  })]));
  assert.equal(terminal?.actions.length, 0);
  assert.equal(terminal?.aec_query_receipt?.status, "found");
  assert.match(terminal?.assistant_message ?? "", /connector 7/);
  assert.match(terminal?.assistant_message ?? "", /serving pipe curve 16555477/);
  assert.match(terminal?.assistant_message ?? "", /no verified existing-segment insertion action/);
});
