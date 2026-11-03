import test from 'node:test';import assert from 'node:assert/strict';
import {linkedTextParts} from './conversation_ui.mjs';
test('actual516 verified RVT path becomes a usable local link without changing its path',()=>{
 const p='C:\\work space\\artifacts\\models\\Workflow516 annotation-original Result.rvt';
 assert.deepEqual(linkedTextParts('Verified file: '+p),[{text:'Verified file: '},{href:'file:///C:/work space/artifacts/models/Workflow516 annotation-original Result.rvt',label:p}]);
});
for(const ext of ['rfa','RVT','pdf','xlsx','png'])test('local '+ext+' path uses existing file-link handling',()=>{
 const p='C:\\workspace\\drawing.'+ext;assert.equal(linkedTextParts(p)[0].href,'file:///C:/workspace/drawing.'+ext);
});
test('existing markdown/file/web/op links and plain text remain bounded presentation',()=>{
 assert.deepEqual(linkedTextParts('plain text'),[{text:'plain text'}]);
 assert.deepEqual(linkedTextParts('[Open](file:///C:/workspace/model.rvt)'),[{href:'file:///C:/workspace/model.rvt',label:'Open'}]);
 assert.equal(linkedTextParts('https://example.com/test')[0].href,'https://example.com/test');
 assert.equal(linkedTextParts('op://task/example')[0].href,'op://task/example');
 for(const input of ['javascript:alert(1)','C:\\workspace\\run.exe','\\\\remote\\share\\model.rvt','<script>alert(1)</script>'])assert.deepEqual(linkedTextParts(input),[{text:input}]);
});
