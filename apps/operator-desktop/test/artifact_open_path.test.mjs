import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {operatorArtifactOpenPath} from '../artifact_open_path.mjs';
test('generated workbook link resolves inside the local workspace without a custom protocol launch',()=>{
 assert.equal(operatorArtifactOpenPath('op://open-folder?path=artifacts/xlsx/Room%20data.xlsx','/workspace'),path.resolve('/workspace/artifacts/xlsx/Room data.xlsx'));
 assert.equal(operatorArtifactOpenPath('file:///C:/output/rooms.xlsx','/workspace'),null);
 for(const value of ['op://task/id','op://open-folder?path=../secret','op://open-folder?path=artifacts/../../secret','op://open-folder?path=C:/secret',
  'op://open-folder?path=artifacts/a&path=artifacts/b','op://open-folder?path=artifacts/%2e%2e/a','op://open-folder?path=artifacts/\\server/a',
  'op://user@open-folder?path=artifacts/a','op://open-folder?path=artifacts/a:stream','op://open-folder?path=artifacts/a%00.xlsx'])assert.throws(()=>operatorArtifactOpenPath(value,'/workspace'),value);
});
