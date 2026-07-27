import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import type { AecSemanticTaskInterpreter } from "../src/aec_semantic_task_interpreter.js";
import { __testOnlyClearAecQueryStates, __testOnlyIdentityScheduleKeyColumn, maybeRunAecSemanticQuery } from "../src/deterministic/aec_query_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

function ahu(): AecSemanticTaskV1 { return { schema: AEC_SEMANTIC_TASK_V1_SCHEMA, operation: "locate", subject: { kind: "exact_identifier", semantic_class: "mechanical_equipment", terms: ["AHU"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }] }, scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null }, reference: { strategy: "none", source_description: null, source_room: null }, mutation: { kind: "none", requested: false }, outputs: ["summary", "element_ids", "parameters", "spatial_context", "best_view"], execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false }, confidence: { value: 0.98, ambiguity: "none", reasons: ["exact mark"] }, evidence: { user_text: "Where is AHU-1?" } }; }
function request(session: string, tool_results?: ChatRequest["tool_results"]): ChatRequest { return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: session, message_id: `m-${tool_results?.length ?? 0}`, user_text: tool_results ? "" : "Where is AHU-1?", tool_results }; }

test("schedule identity headers use exact tokens rather than id substrings", () => {
  assert.equal(__testOnlyIdentityScheduleKeyColumn(["Width", "Fluid", "Mark", "Model"], ["Mark"]), 2);
  assert.equal(__testOnlyIdentityScheduleKeyColumn(["Element ID", "DESIG.", "Model"], ["DESIG."]), 1);
  assert.equal(__testOnlyIdentityScheduleKeyColumn(["Element ID", "DESIG.", "Model"], ["Comments"]), -1);
  assert.equal(__testOnlyIdentityScheduleKeyColumn(["Number", "Model"], ["Number"]), 0);
});

function shockArrestors(where: boolean): AecSemanticTaskV1 {
  const value = ahu();
  value.operation = "locate";
  value.subject = { kind: "class", semantic_class: "other", terms: ["shock arrestors"], categories: ["OST_MechanicalEquipment"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "document", document: "this project" };
  value.outputs = where ? ["summary", "element_ids", "spatial_context"] : ["summary", "element_ids", "parameters", "spatial_context"];
  value.execution = { ...value.execution, max_results: 25, max_primary_actions: 2, allow_document_fallback: true };
  value.evidence.user_text = where
    ? "Where are the shock arrestors? Provide the room number for each device location."
    : "Can you find the shock arrestors in this project and tell me what they are?";
  return value;
}

test("exact identifier runtime completes in two primary actions without broad payload", async () => {
  __testOnlyClearAecQueryStates();
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return ahu(); } };
  const first = await maybeRunAecSemanticQuery(request("ahu"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const second = await maybeRunAecSemanticQuery(request("ahu", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { count: 1, elements: [{ id: 123, value: "AHU-1" }] } }]), interpreter);
  assert.deepEqual(second.response?.actions.map(action => action.path), ["/revit/get-placement-context"]);
  const third = await maybeRunAecSemanticQuery(request("ahu", [{ action_id: "aec-query-exact-context", method: "POST", path: "/revit/get-placement-context", status: "done", result_json: { elementId: 123, familyName: "AHU", typeName: "SIZE 1", levelName: "LEVEL 4", systemName: "SUPPLY AIR", bestView: { id: 44, name: "L4 HVAC" }, room: { number: "401", name: "MECHANICAL" }, center: { x: 1, y: 2, z: 3 } } }]), interpreter);
  assert.equal(third.response?.actions.length, 0);
  assert.match(third.response?.assistant_message ?? "", /AHU-1 is element 123/);
  assert.match(third.response?.assistant_message ?? "", /LEVEL 4/);
  assert.match(third.response?.assistant_message ?? "", /Room 401/);
  assert.match(third.response?.assistant_message ?? "", /System: SUPPLY AIR/);
  assert.match(third.response?.assistant_message ?? "", /Best view: L4 HVAC \(id 44\)/);
  assert.deepEqual(third.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "found", workflow_id: "query.exact_identifier", bounded: true, broadened: false });
});

test("exact identifier not-found is an authoritative bounded terminal receipt", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.subject.identifiers = [
    { parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" },
    { parameter: "Name", value: "AHU-1", match: "case_insensitive_exact" }
  ];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("ahu-missing"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const done = await maybeRunAecSemanticQuery(request("ahu-missing", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { count: 0, elements: [] } }]), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /did not find an exact match/i);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "not_found", workflow_id: "query.exact_identifier", bounded: true, broadened: false });
});

test("room count runtime reports once from scoped room contents", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "count"; value.subject = { kind: "category", semantic_class: "receptacle", terms: ["receptacle"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] }; value.scope = { ...value.scope, kind: "room", rooms: ["403"] }; value.outputs = ["count", "element_ids", "summary"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("count"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/room-contents"]);
  const done = await maybeRunAecSemanticQuery(request("count", [{ action_id: "aec-query-room-contents", method: "POST", path: "/revit/room-contents", status: "done", result_json: { count: 14, elements: new Array(14).fill({}) } }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /14 receptacles matched in Room 403/);
  assert.match(done.response?.assistant_message ?? "", /no model changes/i);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "complete", workflow_id: "query.room_contents", bounded: true, broadened: false });
});

test("whole-document sheet count reports the exact native total", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "count";
  value.subject = { kind: "category", semantic_class: "sheet", terms: ["sheets"], categories: ["OST_Sheets"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "document", document: "the current model" };
  value.outputs = ["count", "summary"];
  value.execution.allow_document_fallback = true;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("sheet-count"), interpreter);
  assert.deepEqual(first.response?.actions, [{ action_id: "aec-query-document-sheets", method: "POST", path: "/revit/sheets", body: { action: "list", offset: 0, limit: 1 } }]);
  const done = await maybeRunAecSemanticQuery(request("sheet-count", [{ action_id: "aec-query-document-sheets", method: "POST", path: "/revit/sheets", status: "done", result_json: { action: "list", totalSheets: 42, totalMatches: 42, total: 42, returned: 1, items: [{ id: 1, sheetNumber: "A1", name: "Cover" }] } }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /42 sheets matched in the current model/);
  assert.match(done.response?.assistant_message ?? "", /no model changes/i);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "complete", workflow_id: "query.document_sheets", bounded: true, broadened: false });
});

test("whole-document sheet count completes from its exact result after volatile state is lost", async () => {
  __testOnlyClearAecQueryStates();
  const done = await maybeRunAecSemanticQuery(request("sheet-count-orphaned", [{ action_id: "aec-query-document-sheets", method: "POST", path: "/revit/sheets", status: "done", result_json: { totalSheets: 42, items: [] } }]));
  assert.match(done.response?.assistant_message ?? "", /42 sheets matched in the whole Revit document/);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "complete", workflow_id: "query.document_sheets", bounded: true, broadened: false });
});

test("whole-document sheet count honors an explicit count-only response", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "count";
  value.subject = { kind: "category", semantic_class: "sheet", terms: ["sheets"], categories: ["OST_Sheets"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "document", document: "the current model" };
  value.outputs = ["count"];
  value.execution.allow_document_fallback = true;
  value.evidence.user_text = "How many sheets are in this model? Return only the count.";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("sheet-count-only");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("sheet-count-only", [{ action_id: "aec-query-document-sheets", method: "POST", path: "/revit/sheets", status: "done", result_json: { totalSheets: 345, items: [] } }]), interpreter);
  assert.equal(done.response?.assistant_message, "345");
});

test("ordinary whole-document class query discovers physical instances and explains what they are", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-identity");
  initial.user_text = value.evidence.user_text;
  const first = await maybeRunAecSemanticQuery(initial, interpreter);
  assert.deepEqual(first.response?.actions, [
    {
      action_id: "aec-query-document-elements",
      method: "POST",
      path: "/revit/find-elements",
      body: {
        identityTerms: ["shock arrestors"],
        expandIdentityAcronymsInParameters: true,
        physicalElementsOnly: true,
        topLevelInstancesOnly: true,
        limit: 500
      }
    },
    {
      action_id: "aec-query-document-element-schedule",
      method: "POST",
      path: "/revit/schedules",
      body: { action: "detail", query: "shock arrestor", exact: false, requireUniqueQuery: true, includeFields: true, includeData: true, rowOffset: 0, columnOffset: 0, maxRows: 500, maxColumns: 40 }
    }
  ]);
  assert.equal((first.response?.actions[0]?.body as Record<string, unknown>).categories, undefined, "an inferred category must not over-filter a class-name discovery");
  const modelKeys = Array.from({ length: 49 }, (_, index) => `B2-SA-${index + 1}`);
  const items = Array.from({ length: 66 }, (_, index) => ({
    elementId: 1000 + index,
    name: "Standard",
    familyName: "LW_Shock Absorber",
    typeName: "Standard",
    category: "Pipe Fittings",
    matchedParameterName: "Comments",
    matchedText: "shock arrestor coordination note",
    identityParameterEvidence: { parameterName: "DESIG.", text: modelKeys[index % modelKeys.length], textNormalized: modelKeys[index % modelKeys.length].toLocaleLowerCase(), source: "identityParameterAcronym" },
    isNested: false
  }));
  const scheduleKeys = modelKeys.slice(0, 41);
  const done = await maybeRunAecSemanticQuery(request("shock-identity", [
    {
      action_id: "aec-query-document-elements",
      method: "POST",
      path: "/revit/find-elements",
      status: "done",
      result_json: { count: 66, elementIds: items.map(item => item.elementId), items, identityExpansionCount: 41, truncated: false, itemsComplete: true }
    },
    {
      action_id: "aec-query-document-element-schedule",
      method: "POST",
      path: "/revit/schedules",
      status: "done",
      result_json: {
        status: "Ok",
        action: "detail",
        schedule: { id: 9975292, name: "SHOCK ARRESTOR SCHEDULE - BUILDING 200" },
        fields: [
          { index: 0, name: "DESIG.", heading: "DESIG.", isHidden: false },
          { index: 1, name: "Level", heading: "FLOOR", isHidden: false },
          { index: 2, name: "TEXT01", heading: "PDI SIZE", isHidden: false },
          { index: 3, name: "Manufacturer", heading: "MANUFACTURER", isHidden: false },
          { index: 4, name: "Model", heading: "MODEL", isHidden: false },
          { index: 5, name: "DESCRIPTION", heading: "REMARKS", isHidden: false },
          { index: 6, name: "Comments", heading: "Comments", isHidden: true }
        ],
        table: {
          header: { rows: [
            { cells: ["SHOCK ARRESTOR SCHEDULE - BUILDING 200", "", "", "", "", "", "", "", ""] }
          ] },
          body: { hasMoreRows: false, rowsComplete: true, rows: [
            { cells: ["DESIG.", "FLOOR", "PDI SIZE", "MANUFACTURER", "MODEL", "REMARKS"] },
            ...scheduleKeys.map(key => ({ cells: [key, "LEVEL 02", "A", "JOSAM", "75001A", ""] }))
          ] }
        }
      }
    }
  ]), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /found 66 physical model instances/i);
  assert.match(done.response?.assistant_message ?? "", /66 Pipe Fittings, family LW_Shock Absorber, type Standard/);
  assert.match(done.response?.assistant_message ?? "", /SHOCK ARRESTOR SCHEDULE - BUILDING 200 \(id 9975292\), with 41 visible data rows and 41 unique DESIG\. values/);
  assert.match(done.response?.assistant_message ?? "", /PDI SIZE A, MANUFACTURER JOSAM, MODEL 75001A/);
  assert.match(done.response?.assistant_message ?? "", /physical instances carry 49 unique DESIG\. values/);
  assert.match(done.response?.assistant_message ?? "", /Schedule\/model discrepancy: 8 model-only values/);
  assert.match(done.response?.assistant_message ?? "", /No model changes were made/);
  assert.equal(done.response?.aec_query_receipt?.workflow_id, "query.document_elements");
  assert.equal(done.response?.aec_query_receipt?.status, "complete");
});

test("schedule correlation fails closed when the separate bridge header section is unusable", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-schedule-no-header");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-schedule-no-header", [
    {
      action_id: "aec-query-document-elements",
      method: "POST",
      path: "/revit/find-elements",
      status: "done",
      result_json: {
        count: 1,
        elementIds: [101],
        items: [{ elementId: 101, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", matchedParameterName: "DESIG.", matchedText: "B2-1-SA-1" }],
        itemsComplete: true
      }
    },
    {
      action_id: "aec-query-document-element-schedule",
      method: "POST",
      path: "/revit/schedules",
      status: "done",
      result_json: {
        status: "Ok",
        action: "detail",
        schedule: { id: 9975292, name: "SHOCK ARRESTOR SCHEDULE - BUILDING 200" },
        table: {
          header: { rows: [{ cells: ["", "", ""] }] },
          body: { hasMoreRows: false, rows: [{ cells: ["B2-1-SA-1", "A", "75001A"] }] }
        }
      }
    }
  ]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /did not include usable column headers, so I am not inferring schedule facts or discrepancies/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /MODEL 75001A/);
});

test("schedule correlation never splices partial identity evidence with conflicting legacy text evidence", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-schedule-no-comparable-key");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-schedule-no-comparable-key", [
    {
      action_id: "aec-query-document-elements",
      method: "POST",
      path: "/revit/find-elements",
      status: "done",
      result_json: {
        count: 2,
        elementIds: [101, 102],
        items: [
          { elementId: 101, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", matchedParameterName: "Comments", matchedText: "coordination note", identityParameterEvidence: { parameterName: "DESIG." } },
          { elementId: 102, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", matchedParameterName: "Comments", matchedText: "coordination note", identityParameterEvidence: { text: "B2-2-SA-1" } }
        ],
        itemsComplete: true
      }
    },
    {
      action_id: "aec-query-document-element-schedule",
      method: "POST",
      path: "/revit/schedules",
      status: "done",
      result_json: {
        status: "Ok",
        action: "detail",
        schedule: { id: 9975292, name: "SHOCK ARRESTOR SCHEDULE - BUILDING 200" },
        table: {
          header: { rows: [{ cells: ["DESIG.", "MODEL"] }] },
          body: { hasMoreRows: false, rows: [{ cells: ["B2-1-SA-1", "75001A"] }, { cells: ["B2-2-SA-1", "75001A"] }] }
        }
      }
    }
  ]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /could not identify one unique schedule key column matching the returned model identity-parameter evidence/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /Schedule\/model discrepancy:/);
});

test("incomplete model discovery never produces an exhaustive schedule discrepancy", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-schedule-partial-model");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-schedule-partial-model", [
    {
      action_id: "aec-query-document-elements", method: "POST", path: "/revit/find-elements", status: "done",
      result_json: {
        count: 1, elementIds: [101], scanCapReached: true, itemsComplete: false,
        items: [{ elementId: 101, category: "Pipe Fittings", identityParameterEvidence: { parameterName: "DESIG.", text: "B2-1-SA-1" } }]
      }
    },
    {
      action_id: "aec-query-document-element-schedule", method: "POST", path: "/revit/schedules", status: "done",
      result_json: {
        status: "Ok", action: "detail", schedule: { id: 9975292, name: "SHOCK ARRESTOR SCHEDULE - BUILDING 200" },
        table: { header: { rows: [{ cells: ["DESIG.", "MODEL"] }] }, body: { hasMoreRows: false, rows: [{ cells: ["B2-1-SA-1", "75001A"] }] } }
      }
    }
  ]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /model discovery result is incomplete, so I am not claiming an exhaustive model\/schedule discrepancy/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /Schedule\/model discrepancy:/);
  assert.equal(done.response?.aec_query_receipt?.status, "ambiguous");
});

test("where query follows exact discovered ids with geometry-aware room resolution and preserves uncertainty", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(true);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-rooms");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const found = await maybeRunAecSemanticQuery(request("shock-rooms", [{
    action_id: "aec-query-document-elements",
    method: "POST",
    path: "/revit/find-elements",
    status: "done",
    result_json: {
      count: 5,
      elementIds: [101, 102, 103, 104, 105],
      items: [
        { elementId: 101, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", identityMatch: { matchedFields: ["familyName"] } },
        { elementId: 102, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", identityMatch: { matchedFields: ["familyName"] } },
        { elementId: 103, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", identityMatch: { matchedFields: ["familyName"] } },
        { elementId: 104, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings", identityMatch: { matchedFields: ["familyName"] } },
        { elementId: 105, familyName: "Elbow-Standard_LW", typeName: "Small Radius .75 R", category: "Pipe Fittings", identityMatch: { matchedFields: ["parameter:DESIG."] }, identityParameterEvidence: { parameterName: "DESIG.", text: "B2-2-SA-99" } }
      ],
      identityExpansionCount: 1,
      truncated: false,
      itemsComplete: true
    }
  }]), interpreter);
  assert.deepEqual(found.response?.actions, [{
    action_id: "aec-query-document-element-locations",
    method: "POST",
    path: "/revit/locate-elements",
    body: {
      elementIds: [101, 102, 103, 104],
      limit: 5,
      spatialResolution: "geometry_with_nearest",
      spatialVerticalScope: "same_level",
      spatialKindPreference: "room",
      includeHostRooms: true,
      includeHostSpaces: false,
      includeLinkedRooms: true,
      nearestCandidateLimit: 5
    }
  }]);
  const done = await maybeRunAecSemanticQuery(request("shock-rooms", [{
    action_id: "aec-query-document-element-locations",
    method: "POST",
    path: "/revit/locate-elements",
    status: "done",
    result_json: {
      count: 3,
      spatialResolution: "geometry_with_nearest",
      spatialVerticalScope: "same_level",
      truncated: false,
      requestedElementCount: 4,
      requestedElementIdsMissing: [104],
      requestedElementIdsMissingCount: 1,
      itemsComplete: false,
      items: [
        { elementId: 101, levelName: "LEVEL 02", roomNumber: "214", roomName: "PATIENT", spatialKind: "Room", isNested: false, spatialContext: { status: "resolved", spatialVerticalScope: "same_level", selected: { sourceScope: "linked", linkInstanceName: "A_DUKE B200.rvt" } } },
        { elementId: 102, levelName: "LEVEL 02", roomNumber: null, roomName: null, isNested: false, spatialContext: { status: "ambiguous", spatialVerticalScope: "same_level", matches: [{ spatialKind: "Room", number: "215", name: "CORRIDOR" }, { spatialKind: "Room", number: "216", name: "STORAGE" }] } },
        { elementId: 103, levelName: "LEVEL 01", roomNumber: null, roomName: null, isNested: false, spatialContext: { status: "unresolved", spatialVerticalScope: "same_level", nearestCandidates: [{ spatialKind: "Room", number: "117", name: "MECHANICAL" }] } }
      ]
    }
  }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /Room results: 1 resolved, 1 ambiguous, 2 unresolved/);
  assert.match(done.response?.assistant_message ?? "", /4 Pipe Fittings, family LW_Shock Absorber, type Standard/);
  assert.match(done.response?.assistant_message ?? "", /excluded 1 candidate that matched only an abbreviated parameter value/);
  assert.match(done.response?.assistant_message ?? "", /element 101: Room 214 — PATIENT, LEVEL 02 via linked model A_DUKE B200\.rvt/);
  assert.match(done.response?.assistant_message ?? "", /element 102: room assignment is ambiguous among Room 215 — CORRIDOR, Room 216 — STORAGE/);
  assert.match(done.response?.assistant_message ?? "", /element 103: room unresolved, LEVEL 01; nearest candidates \(not assignments\): Room 117 — MECHANICAL/);
  assert.match(done.response?.assistant_message ?? "", /element 104: room unresolved; Revit did not return a spatial row for this requested element/);
  assert.equal(done.response?.aec_query_receipt?.status, "ambiguous");
});

test("where completion rejects stale, missing, and mixed same-level provenance", async () => {
  const scenarios = [
    {
      name: "stale-volume",
      root: { spatialResolution: "geometry_with_nearest", spatialVerticalScope: "volume" },
      rowScopes: ["volume", "volume"]
    },
    {
      name: "missing-receipt",
      root: {},
      rowScopes: [undefined, undefined]
    },
    {
      name: "mixed-row",
      root: { spatialResolution: "geometry_with_nearest", spatialVerticalScope: "same_level" },
      rowScopes: ["same_level", "volume"]
    }
  ] as const;

  for (const scenario of scenarios) {
    __testOnlyClearAecQueryStates();
    const value = shockArrestors(true);
    const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
    const session = `shock-provenance-${scenario.name}`;
    const initial = request(session);
    initial.user_text = value.evidence.user_text;
    await maybeRunAecSemanticQuery(initial, interpreter);
    await maybeRunAecSemanticQuery(request(session, [{
      action_id: "aec-query-document-elements",
      method: "POST",
      path: "/revit/find-elements",
      status: "done",
      result_json: {
        count: 2,
        elementIds: [301, 302],
        itemsComplete: true,
        items: [
          { elementId: 301, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings" },
          { elementId: 302, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings" }
        ]
      }
    }]), interpreter);

    const done = await maybeRunAecSemanticQuery(request(session, [{
      action_id: "aec-query-document-element-locations",
      method: "POST",
      path: "/revit/locate-elements",
      status: "done",
      result_json: {
        count: 2,
        ...scenario.root,
        items: scenario.rowScopes.map((spatialVerticalScope, index) => ({
          elementId: 301 + index,
          levelName: "LEVEL 02",
          roomNumber: String(214 + index),
          roomName: "PATIENT",
          spatialContext: {
            status: "resolved",
            ...(spatialVerticalScope ? { spatialVerticalScope } : {}),
            selected: { sourceScope: "linked" }
          }
        }))
      }
    }]), interpreter);

    assert.match(done.response?.assistant_message ?? "", /did not return consistent geometry_with_nearest\/same_level provenance/);
    assert.doesNotMatch(done.response?.assistant_message ?? "", /Room 214/);
    assert.equal(done.response?.aec_query_receipt?.status, "failed");
  }
});

test("whole-document discovery reports explicit incompleteness rather than claiming exhaustive inventory", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  value.execution.max_primary_actions = 1;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-partial");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-partial", [{
    action_id: "aec-query-document-elements",
    method: "POST",
    path: "/revit/find-elements",
    status: "done",
    result_json: { count: 1, elementIds: [101], items: [{ elementId: 101, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings" }], truncated: false, scanCapReached: true, itemsComplete: false }
  }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /partial inventory rather than a claim that no additional matches exist/);
  assert.equal(done.response?.aec_query_receipt?.status, "ambiguous");
});

test("spatial completion remains non-complete when Revit omits any requested element id", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(true);
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-rooms-missing");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  await maybeRunAecSemanticQuery(request("shock-rooms-missing", [{
    action_id: "aec-query-document-elements",
    method: "POST",
    path: "/revit/find-elements",
    status: "done",
    result_json: {
      count: 2,
      elementIds: [201, 202],
      items: [
        { elementId: 201, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings" },
        { elementId: 202, familyName: "LW_Shock Absorber", typeName: "Standard", category: "Pipe Fittings" }
      ],
      itemsComplete: true
    }
  }]), interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-rooms-missing", [{
    action_id: "aec-query-document-element-locations",
    method: "POST",
    path: "/revit/locate-elements",
    status: "done",
    result_json: {
      count: 1,
      spatialResolution: "geometry_with_nearest",
      spatialVerticalScope: "same_level",
      requestedElementCount: 2,
      requestedElementIdsMissing: [202],
      requestedElementIdsMissingCount: 1,
      itemsComplete: false,
      items: [
        { elementId: 201, levelName: "LEVEL 02", roomNumber: "214", roomName: "PATIENT", isNested: false, spatialContext: { status: "resolved", spatialVerticalScope: "same_level", selected: { sourceScope: "host" } } }
      ]
    }
  }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /Room results: 1 resolved, 0 ambiguous, 1 unresolved/);
  assert.match(done.response?.assistant_message ?? "", /element 202: room unresolved; Revit did not return a spatial row for this requested element/);
  assert.equal(done.response?.aec_query_receipt?.status, "ambiguous");
});

test("zero matches from an incomplete document scan never becomes an authoritative not-found claim", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  value.execution.max_primary_actions = 1;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("shock-zero-incomplete");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("shock-zero-incomplete", [{
    action_id: "aec-query-document-elements",
    method: "POST",
    path: "/revit/find-elements",
    status: "done",
    result_json: { count: 0, elementIds: [], items: [], truncated: false, scanCapReached: true, itemsComplete: false }
  }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /cannot honestly say that no shock arrestors exist/);
  assert.equal(done.response?.aec_query_receipt?.status, "failed");
});

test("whole-document element discovery refuses an unfiltered scan", async () => {
  __testOnlyClearAecQueryStates();
  const value = shockArrestors(false);
  value.subject.terms = [];
  value.subject.categories = [];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const done = await maybeRunAecSemanticQuery(request("document-unfiltered"), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /unfiltered document scan is not allowed/);
  assert.equal(done.response?.aec_query_receipt?.status, "failed");
});

test("singular air-handler schedule request offers the strongest grounded match conversationally", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "focus";
  value.subject = { kind: "generic", semantic_class: "view", terms: ["schedules", "air handlers"], categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "document", document: "the current model" };
  value.outputs = ["summary"];
  value.execution.max_primary_actions = 1;
  value.execution.allow_document_fallback = true;
  value.evidence.user_text = "Can you show me the air handling unit schedule?";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("schedule-discovery");
  initial.user_text = value.evidence.user_text;
  const first = await maybeRunAecSemanticQuery(initial, interpreter);
  assert.deepEqual(first.response?.actions, [{ action_id: "aec-query-document-schedules", method: "POST", path: "/revit/schedules", body: { action: "list", query: "", max: 500 } }]);
  const earlierSchedules = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, name: `EARLIER SCHEDULE ${index + 1}` }));
  const done = await maybeRunAecSemanticQuery(request("schedule-discovery", [{ action_id: "aec-query-document-schedules", method: "POST", path: "/revit/schedules", status: "done", result_json: { returned: 28, items: [...earlierSchedules, { id: 741436, name: "AHU AIR BALANCE SCHEDULE" }, { id: 741504, name: "AIR HANDLING UNIT SCHEDULE" }, { id: 1495907, name: "MAKE-UP AIR HANDLING UNIT SCHEDULE" }] } }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /I found AIR HANDLING UNIT SCHEDULE \(id 741504\)/);
  assert.match(done.response?.assistant_message ?? "", /I think that's the schedule you mean/);
  assert.match(done.response?.assistant_message ?? "", /Would you like me to open it\?/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /AHU AIR BALANCE SCHEDULE/);
  assert.equal(done.response?.aec_query_receipt?.workflow_id, "query.document_schedules");
  assert.equal(done.response?.aec_query_receipt?.status, "found");
});

test("explicit AHU schedule inventory still returns the grounded alternatives", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "list";
  value.subject = { kind: "generic", semantic_class: "view", terms: ["schedules", "air handlers"], categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "document", document: "the current model" };
  value.outputs = ["summary"];
  value.execution.max_primary_actions = 1;
  value.execution.allow_document_fallback = true;
  value.evidence.user_text = "List all AHU schedules in this model.";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const initial = request("schedule-inventory");
  initial.user_text = value.evidence.user_text;
  await maybeRunAecSemanticQuery(initial, interpreter);
  const done = await maybeRunAecSemanticQuery(request("schedule-inventory", [{ action_id: "aec-query-document-schedules", method: "POST", path: "/revit/schedules", status: "done", result_json: { returned: 3, items: [{ id: 741436, name: "AHU AIR BALANCE SCHEDULE" }, { id: 741504, name: "AIR HANDLING UNIT SCHEDULE" }, { id: 1495907, name: "MAKE-UP AIR HANDLING UNIT SCHEDULE" }] } }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /strongest direct match is AIR HANDLING UNIT SCHEDULE \(id 741504\)/);
  assert.match(done.response?.assistant_message ?? "", /AHU AIR BALANCE SCHEDULE/);
  assert.equal(done.response?.aec_query_receipt?.status, "ambiguous");
});

test("orphaned results with the sheet action id but a different endpoint still fail closed", async () => {
  __testOnlyClearAecQueryStates();
  const done = await maybeRunAecSemanticQuery(request("sheet-count-spoofed", [{ action_id: "aec-query-document-sheets", method: "POST", path: "/revit/find-elements", status: "done", result_json: { count: 42 } }]));
  assert.equal(done.response, null);
});

test("scoped list returns bounded element identity and location details instead of count-only prose", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "list";
  value.subject = { kind: "category", semantic_class: "air_terminal", terms: ["air terminals"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "view", views: [{ id: 44, name: "L4 HVAC" }] };
  value.outputs = ["summary", "element_ids", "spatial_context"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("list-view"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements"]);
  const second = await maybeRunAecSemanticQuery(request("list-view", [{ action_id: "aec-query-view-elements", method: "POST", path: "/revit/find-elements", status: "done", result_json: { elementIds: [101, 102], items: [], truncated: false } }]), interpreter);
  assert.deepEqual(second.response?.actions, [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", body: { elementIds: [101, 102] } }]);
  const done = await maybeRunAecSemanticQuery(request("list-view", [{ action_id: "aec-query-scoped-summaries", method: "POST", path: "/revit/get-element-summary", status: "done", result_json: [{ id: 101, name: "Supply Diffuser", category: "Air Terminals", found: true }, { id: 102, name: "Return Grille", category: "Air Terminals", found: true }] }]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /id 101 — Supply Diffuser — Air Terminals/);
  assert.match(done.response?.assistant_message ?? "", /id 102 — Return Grille — Air Terminals/);
  assert.doesNotMatch(done.response?.assistant_message ?? "", /\[object Object\]/);
});

test("exact focus resolves identity and context before one native view activation", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "focus"; value.execution.max_primary_actions = 3;
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("focus"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/find-elements-by-parameter"]);
  const second = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-identifier", method: "POST", path: "/revit/find-elements-by-parameter", status: "done", result_json: { elements: [{ id: 123, value: "AHU-1" }] } }]), interpreter);
  assert.deepEqual(second.response?.actions.map(action => action.path), ["/revit/get-placement-context"]);
  const third = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-context", method: "POST", path: "/revit/get-placement-context", status: "done", result_json: { elementId: 123, bestView: { id: 44, name: "L4 HVAC" } } }]), interpreter);
  assert.deepEqual(third.response?.actions, [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", body: { viewId: 44, showElementIds: [123] } }]);
  const done = await maybeRunAecSemanticQuery(request("focus", [{ action_id: "aec-query-exact-focus", method: "POST", path: "/revit/activate-view", status: "done", result_json: { ok: true, activeViewId: 44, activeViewName: "L4 HVAC", shownElementIds: [123] } }]), interpreter);
  assert.equal(done.response?.assistant_message, "Focused AHU-1 in L4 HVAC. No model elements were changed.");
  assert.equal(done.response?.aec_query_receipt?.status, "found");
});

test("unsupported semantic query terminates authoritatively instead of falling through and broadening", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu(); value.operation = "compare";
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const done = await maybeRunAecSemanticQuery(request("blocked-compare"), interpreter);
  assert.equal(done.response?.actions.length, 0);
  assert.match(done.response?.assistant_message ?? "", /without broadening or guessing/);
  assert.deepEqual(done.response?.aec_query_receipt, { schema: "revit-operator.aec-query-receipt.v1", terminal: true, status: "failed", workflow_id: "query.blocked", bounded: true, broadened: false });
});

test("two-room inventory comparison reports both exact scoped counts and their delta", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "compare";
  value.subject = { kind: "category", semantic_class: "receptacle", terms: ["receptacle"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "room", rooms: ["403", "405"] };
  value.outputs = ["summary", "count", "element_ids", "comparison"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  const first = await maybeRunAecSemanticQuery(request("compare-rooms"), interpreter);
  assert.deepEqual(first.response?.actions.map(action => action.path), ["/revit/room-contents", "/revit/room-contents"]);
  const done = await maybeRunAecSemanticQuery(request("compare-rooms", [
    { action_id: "aec-query-compare-a", method: "POST", path: "/revit/room-contents", status: "done", result_json: { count: 6, elements: new Array(6).fill({}), truncated: false } },
    { action_id: "aec-query-compare-b", method: "POST", path: "/revit/room-contents", status: "done", result_json: { count: 8, elements: new Array(8).fill({}), truncated: false } }
  ]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /Room 403: 6\. Room 405: 8\./);
  assert.match(done.response?.assistant_message ?? "", /Room 405 has 2 receptacles more than Room 403/);
  assert.equal(done.response?.aec_query_receipt?.workflow_id, "query.compare_scopes");
});

test("truncated comparison does not claim an exact delta", async () => {
  __testOnlyClearAecQueryStates();
  const value = ahu();
  value.operation = "compare";
  value.subject = { kind: "category", semantic_class: "air_terminal", terms: ["air terminal"], categories: ["OST_DuctTerminal"], family_name: null, type_name: null, system_name: null, identifiers: [] };
  value.scope = { ...value.scope, kind: "level", levels: ["L3", "L4"] };
  value.outputs = ["summary", "count", "comparison"];
  const interpreter: AecSemanticTaskInterpreter = { async interpret() { return value; } };
  await maybeRunAecSemanticQuery(request("compare-truncated"), interpreter);
  const done = await maybeRunAecSemanticQuery(request("compare-truncated", [
    { action_id: "aec-query-compare-a", method: "POST", path: "/revit/locate-elements", status: "done", result_json: { count: 10, truncated: true, items: new Array(10).fill({}) } },
    { action_id: "aec-query-compare-b", method: "POST", path: "/revit/locate-elements", status: "done", result_json: { count: 9, truncated: false, items: new Array(9).fill({}) } }
  ]), interpreter);
  assert.match(done.response?.assistant_message ?? "", /no exact difference is claimed/);
  assert.equal(done.response?.aec_query_receipt?.status, "failed");
});
