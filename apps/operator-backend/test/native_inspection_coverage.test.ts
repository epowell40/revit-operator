import assert from "node:assert/strict";
import test from "node:test";
import { nativeInspectionTargetIdsV2 } from "../src/assignments/native_inspection_coverage.js";
import { summaryInspectionFixture, familyInspectionFixture } from "./fixtures/native_inspection_coverage_fixture.js";

test("external family file facts cannot certify a loaded project family even with incidental IDs", () => {
  const f: any = familyInspectionFixture();
  f.input.body.filePath = "artifacts/reference/manufacturer.rfa";
  assert.equal(nativeInspectionTargetIdsV2(f.input, f.payload), null);
  delete f.input.body.filePath;
  f.payload.source.scope = "external_file";
  assert.equal(nativeInspectionTargetIdsV2(f.input, f.payload), null);
});

test("inspection records requested host coverage, not child labels, types or incidental tagged subjects", () => {
  for (const f of [summaryInspectionFixture(), familyInspectionFixture()]) {
    assert.deepEqual(nativeInspectionTargetIdsV2(f.input, f.payload), [42]);
    assert.deepEqual(nativeInspectionTargetIdsV2({ ...f.input, body: JSON.stringify(f.input.body) }, f.payload), [42]);
  }
  const f = familyInspectionFixture();
  f.payload.labels[0]!.labelType.underline = false;
  assert.deepEqual(nativeInspectionTargetIdsV2(f.input, f.payload), [42], "coverage is not a styling pass");
  assert.deepEqual(nativeInspectionTargetIdsV2({ method: "POST", path: "/revit/get-element-summary", body: { ids: [7] } },
    { result: [{ id: 7, found: true, uniqueId: "family-uid", className: "Family", typeId: null }] }), [7]);
});

test("linked tag references use native link identity without promoting linked IDs to host coverage", () => {
  const f: any = summaryInspectionFixture();
  Object.assign(f.payload.result[0].tagReferences.items[0], { documentScope: "linked", linkInstanceId: 120, identityKey: "link:120:90" });
  assert.deepEqual(nativeInspectionTargetIdsV2(f.input, f.payload), [42]);
});

const summaryChanges: Record<string, (f: any) => void> = {
  "missing requested row": f => f.payload.result = [],
  "extra row": f => f.payload.result.push({ ...f.payload.result[0], id: 43, uniqueId: "other" }),
  "wrong returned ID": f => f.payload.result[0].id = 43,
  "duplicate request": f => f.input.body.elementIds.push(42),
  "nonpositive request": f => f.input.body.elementIds = [0],
  "ambiguous aliases": f => f.input.body.ids = [43],
  "unread element": f => f.payload.result[0].found = false,
  "missing UID": f => delete f.payload.result[0].uniqueId,
  "row error": f => f.payload.result[0].error = "read failed",
  "bad type ID": f => f.payload.result[0].typeId = -1,
  "unrequested tag references": f => delete f.input.body.includeTagReferences,
  "missing tag references": f => delete f.payload.result[0].tagReferences,
  "false tag applicability": f => f.payload.result[0].tagReferences.applicable = false,
  "incomplete references": f => f.payload.result[0].tagReferences.complete = false,
  "truncated references": f => f.payload.result[0].tagReferences.truncated = true,
  "reference enumeration failure": f => f.payload.result[0].tagReferences.enumerationFailed = true,
  "reference count mismatch": f => f.payload.result[0].tagReferences.totalReferences = 2,
  "unresolved reference": f => f.payload.result[0].tagReferences.unresolvedReferences = 1,
  "orphaned tag": f => f.payload.result[0].tagReferences.orphaned = true,
  "reference error": f => f.payload.result[0].tagReferences.errors.push("unreadable"),
  "invalid reference identity": f => f.payload.result[0].tagReferences.items[0].identityKey = "host:999",
  "unloaded linked reference": f => Object.assign(f.payload.result[0].tagReferences.items[0], { resolved: false, documentScope: "linked", linkInstanceId: 120 }),
  "wrong owner identity": f => f.payload.result[0].location.ownerViewUniqueId = "foreign",
  "nonfinite tag head": f => f.payload.result[0].location.z = Infinity,
  "unsupported circuit facet": f => f.input.body.includeElectricalCircuitMembership = true
};
for (const [name, change] of Object.entries(summaryChanges)) test("summary inspection rejects " + name, () => {
  const f: any = summaryInspectionFixture(); change(f);
  assert.equal(nativeInspectionTargetIdsV2(f.input, f.payload), null);
});

const familyChanges: Record<string, (f: any) => void> = {
  "wrong source": f => f.payload.source.elementId = 43,
  "missing source UID": f => delete f.payload.source.uniqueId,
  "missing loaded family": f => f.payload.source.familyId = null,
  "failed inspection": f => f.payload.ok = false,
  "nonobservational": f => f.payload.observational = false,
  "mutation": f => f.payload.mutated = true,
  "retained temporary editor": f => f.payload.closedWithoutSaving = false,
  "filtered request": f => f.input.body.contains = "one label",
  "filtered result": f => f.payload.query = "one label",
  "truncated inventory": f => f.payload.inventory.truncated = true,
  "invalid scan count": f => f.payload.inventory.scannedElementCount = 0,
  "count mismatch": f => f.payload.inventory.returnedElementCount = 2,
  "inventory cap reached": f => f.payload.inventory.maxElements = 1,
  "missing rows": f => delete f.payload.otherElements,
  "duplicate child ID": f => f.payload.labels.push({ ...f.payload.labels[0], uniqueId: "other" }),
  "unread child": f => f.payload.labels[0].error = "read failed",
  "missing child UID": f => delete f.payload.labels[0].uniqueId,
  "missing label type": f => delete f.payload.labels[0].labelType,
  "missing font": f => delete f.payload.labels[0].labelType.font,
  "invalid size": f => f.payload.labels[0].labelType.textSizeFeet = NaN,
  "invalid width": f => f.payload.labels[0].labelType.widthFactor = 0,
  "unknown underline": f => f.payload.labels[0].labelType.underline = null
};

test("pre-placement loaded type inspection covers only the requested project symbol, not future instances", () => {
  //323's retained failure occurs before family opening, not an observation proof.
  const request = { method: "POST", path: "/revit/inspect-family-content", body: {
    elementId: 1545043, includeOtherElements: true, includeParameters: true, maxElements: 1000
  } };
  const failure = { error: "Element must be a loaded FamilyInstance or IndependentTag with a FamilySymbol type.",
    type: "System.InvalidOperationException", outcome_unknown: false };
  assert.equal(nativeInspectionTargetIdsV2(request, failure), null);
  // Contract projection, not live qualification: native source identity is the
  // loaded symbol itself. Existing exact-ID and complete temporary-read gates apply.
  const f: any = familyInspectionFixture(1545043);
  Object.assign(f.payload.source, { uniqueId: "11d14dd3-f725-44d2-9eee-6c9178640276-00179353",
    runtimeType: "FamilySymbol", familyId: 1543801, familyName: "Balancing Damper - Round", typeId: 1545043 });
  assert.deepEqual(nativeInspectionTargetIdsV2(request, f.payload), [1545043]);
  assert.equal(nativeInspectionTargetIdsV2({ ...request, body: { ...request.body, elementId: 1485080 } }, f.payload), null);
  f.payload.closedWithoutSaving = false;
  assert.equal(nativeInspectionTargetIdsV2(request, f.payload), null);
});

test("connector geometry does not expand family inspection source, completeness or instance authority",()=>{
  const f:any=familyInspectionFixture(42);
  f.payload.otherElements=[{elementId:123,uniqueId:'connector-123',runtimeType:'ConnectorElement',name:'Global',category:'Connector Element',
    connector:{coordinateSpace:'family_document_current_type',lengthUnit:'feet',shape:{available:true,value:'Round',reason:null,error:null},
      radius:{available:false,value:null,reason:'getter_failed',error:'unavailable'}}}];
  f.payload.inventory.scannedElementCount=2;f.payload.inventory.returnedElementCount=2;
  assert.deepEqual(nativeInspectionTargetIdsV2(f.input,f.payload),[42]);
  assert.equal(nativeInspectionTargetIdsV2({...f.input,body:{...f.input.body,elementId:123}},f.payload),null,'Family connector ID is not a loaded instance');
  for(const change of [
    (x:any)=>x.payload.source.scope='external_file',
    (x:any)=>x.payload.closedWithoutSaving=false,
    (x:any)=>x.payload.inventory.truncated=true,
    (x:any)=>x.payload.source.uniqueId=''
  ]){const x=structuredClone(f);change(x);assert.equal(nativeInspectionTargetIdsV2(x.input,x.payload),null);}
});
for (const [name, change] of Object.entries(familyChanges)) test("loaded family inspection rejects " + name, () => {
  const f: any = familyInspectionFixture(); change(f);
  assert.equal(nativeInspectionTargetIdsV2(f.input, f.payload), null);
});

test("unsupported routes and malformed request bodies cannot become inspection proof", () => {
  const f = summaryInspectionFixture();
  for (const input of [null, { ...f.input, body: "{" }, { ...f.input, body: [] }, { ...f.input, method: "GET" },
    { ...f.input, path: "/revit/view-owned-detailing" }, { ...f.input, path: "/revit/set-parameters" }]) {
    assert.equal(nativeInspectionTargetIdsV2(input, f.payload), null);
  }
});
