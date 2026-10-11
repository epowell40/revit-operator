import assert from "node:assert/strict";
import test from "node:test";
import { familySessionOpenedV1 } from "../src/verification/family_session_open_v1.js";

test("family session completion requires the exact requested source and registered native session", () => {
  const payload = { ok: true, familyDocumentId: "a".repeat(32), family_session_receipt: {
    schema: "revit-operator.family-session-open.v1", status: "opened", session_id: "a".repeat(32),
    source_kind: "instance", source_id: "42", document_valid: true, session_registered: true,
    model_write_performed: false, file_write_performed: false
  } };
  assert(familySessionOpenedV1("/revit/open-family-doc", { titleblockInstanceId: 42 }, payload));
  assert(familySessionOpenedV1("/revit/edit-family-from-instance", { elementId: 42 }, payload));
  for (const change of [{ source_id: "43" }, { source_kind: "family" }, { session_id: "b".repeat(32) },
    { document_valid: false }, { session_registered: false }, { model_write_performed: true }, { file_write_performed: true }])
    assert.equal(familySessionOpenedV1("/revit/open-family-doc", { titleblockInstanceId: 42 }, {
      ...payload, family_session_receipt: { ...payload.family_session_receipt, ...change }
    }), false);
  assert.equal(familySessionOpenedV1("/revit/save-family-doc", { elementId: 42 }, payload), false);
  assert.equal(familySessionOpenedV1("/revit/open-family-doc", { elementId: 42 }, { request: payload }), false);
});

import { familySessionReloadedV1, familySessionSavedV1 } from "../src/verification/family_session_open_v1.js";
test("family load confirms exact session and native project identity only", () => {
  const session = "a".repeat(32);
  const p = {ok:true,familyDocumentId:session,loadedFamilyId:42,family_reload_receipt:{schema:"revit-operator.family-reload.v1",status:"loaded",session_id:session,family_id:42,family_unique_id:"native-unique",native_load_returned:true,project_readback_verified:true}};
  for(const path of ["/revit/load-family-doc","/revit/reload-family-edit-session"]){
    assert(familySessionReloadedV1(path,{familyDocumentId:session},p));
    assert(!familySessionReloadedV1(path,{familyDocumentId:"b".repeat(32)},p));
    for(const delta of [{native_load_returned:false},{project_readback_verified:false},{family_id:43},{family_unique_id:""}])
      assert(!familySessionReloadedV1(path,{docId:session},{...p,family_reload_receipt:{...p.family_reload_receipt,...delta}}));
  }
  assert(!familySessionReloadedV1("/revit/save-family-doc",{docId:session},p));
});
test("family save requires exact session, native save and stable file evidence", () => {
  const session="a".repeat(32), filePath="C:\\lab\\titleblock.rfa";
  const p={ok:true,saved:true,familyDocumentId:session,filePath,family_save_receipt:{schema:"revit-operator.family-save.v1",status:"saved",session_id:session,path:filePath,native_save_returned:true,document_path_verified:true,stable_read:true,size_bytes:12,sha256:"a".repeat(64)}};
  assert(familySessionSavedV1("/revit/save-family-doc",{docId:session,filePath},p));
  for(const delta of [{native_save_returned:false},{document_path_verified:false},{stable_read:false},{size_bytes:0},{sha256:"bad"}])
    assert(!familySessionSavedV1("/revit/save-family-doc",{docId:session,filePath},{...p,family_save_receipt:{...p.family_save_receipt,...delta}}));
  assert(!familySessionSavedV1("/revit/save-family-doc",{docId:session,filePath:"C:\\other.rfa"},p));
  assert(!familySessionSavedV1("/revit/save-family-doc",{docId:"b".repeat(32)},p));
  assert(!familySessionSavedV1("/revit/save-family-doc",{docId:session},{...p,saved:false}));
});

import { familySessionClosedV1 } from "../src/verification/family_session_open_v1.js";
test("close completion binds native closure, session removal and explicit save intent", () => {
  const id="a".repeat(32);
  const p={ok:true,closed:true,saved:false,familyDocumentId:id,family_close_receipt:{schema:"revit-operator.family-session-close.v1",status:"closed",session_id:id,native_close_returned:true,document_closed:true,session_unregistered:true,save_requested:false}};
  assert(familySessionClosedV1("/revit/close-doc",{docId:id,saveChanges:false},p));
  for(const delta of [{native_close_returned:false},{document_closed:false},{session_unregistered:false},{save_requested:true},{session_id:"b".repeat(32)}])
    assert(!familySessionClosedV1("/revit/close-doc",{docId:id},{...p,family_close_receipt:{...p.family_close_receipt,...delta}}));
  assert(!familySessionClosedV1("/revit/close-doc",{docId:"b".repeat(32)},p));
  assert(!familySessionClosedV1("/revit/close-doc",{docId:id,saveChanges:true},p));
  assert(!familySessionClosedV1("/revit/close-doc",{docId:id},{...p,saved:true}));
  assert(!familySessionClosedV1("/revit/save-family-doc",{docId:id},p));
  const saved={...p,saved:true,filePath:"C:\\lab\\a.rfa",family_close_receipt:{...p.family_close_receipt,save_requested:true},family_save_receipt:{schema:"revit-operator.family-save.v1",status:"saved",session_id:id,path:"C:\\lab\\a.rfa",native_save_returned:true,document_path_verified:true,stable_read:true,size_bytes:12,sha256:"a".repeat(64)}};
  assert(familySessionClosedV1("/revit/close-doc",{docId:id,saveChanges:true},saved));
  assert(!familySessionClosedV1("/revit/close-doc",{docId:id,saveChanges:true},{...saved,family_save_receipt:{...saved.family_save_receipt,stable_read:false}}));
});
