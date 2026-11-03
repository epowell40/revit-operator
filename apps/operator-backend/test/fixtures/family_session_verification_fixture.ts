export function familySessionVerificationFixtureV2(kind:'save'|'load'){
 const session='a'.repeat(32),root='C:\\OperatorWorkspace',file=root+'\\artifacts\\families\\Underlined.rfa';
 const saved={schema:'revit-operator.family-save.v1',status:'saved',session_id:session,path:file,
  native_save_returned:true,document_path_verified:true,stable_read:true,size_bytes:1234,sha256:'c'.repeat(64),
  path_resolution:{schema:'revit-operator.workspace-path-resolution.v1',requested_path:'artifacts/families/Underlined.rfa',
   workspace_root:root,resolved_path:file,inside_workspace:true}};
 const save={method:'POST',path:'/revit/save-family-doc',body:{familyDocumentId:session,filePath:saved.path_resolution.requested_path,overwrite:false}};
 const savedPayload={ok:true,saved:true,saveMode:'save_as',familyDocumentId:session,docId:session,filePath:file,family_save_receipt:saved};
 const saveRead={method:'POST',path:'/revit/inspect-exported-files',body:{familyDocumentId:session,paths:[file]}};
 const savedReadPayload={schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,requestedPaths:[file],
  files:[{path:file,exists:true,readable:true,stable_read:true,size_bytes:1234,sha256:'c'.repeat(64)}],
  saved_document:{path:file,family_session_id:session,session_id:'native-family-after-save',parent_session_id:'native-parent',
   is_modified:false,is_modifiable:false,is_family_document:true}};
 const load={method:'POST',path:'/revit/load-family-doc',body:{familyDocumentId:session,overwriteParameterValuesOnLoad:false}};
 const loadedPayload={ok:true,status:'Reloaded',familyDocumentId:session,originalFamilyId:99,loadedFamilyId:100,familyId:100,
  familyName:'Underlined',family_reload_receipt:{schema:'revit-operator.family-reload.v1',status:'loaded',session_id:session,
   family_id:100,family_unique_id:'loaded-family-uid',native_load_returned:true,project_readback_verified:true},symbols:[{id:101,name:'Standard'}]};
 const loadRead={method:'POST',path:'/revit/get-element-summary',body:{elementIds:[100]}};
 const loadedReadPayload={result:[{id:100,found:true,uniqueId:'loaded-family-uid',name:'Underlined',className:'Family',fullClassName:'Autodesk.Revit.DB.Family'}]};
 return kind==='save'?{input:save,apply:savedPayload,read:saveRead,payload:savedReadPayload}
  :{input:load,apply:loadedPayload,read:loadRead,payload:loadedReadPayload};
}
