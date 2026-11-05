import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {buildImprovementUploadPayload,encodeUploadPayload} from '../src/improvement/upload_payload.js';

test('ordinary support export removes short credentials from manifest logs and feedback', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-export-credentials-'));
  const previous=process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT=root;
  t.after(()=>{
    if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
    assert.equal(path.dirname(root),os.tmpdir());
    fs.rmSync(root,{recursive:true,force:true});
  });
  const session='synthetic-review',bundle=path.join(root,'runs','sessions',session),queue=path.join(root,'feedback','upload_queue',session+'_queued');
  fs.mkdirSync(bundle,{recursive:true});fs.mkdirSync(queue,{recursive:true});
  fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify({api_key:'manifest-credential',status:'failed'}));
  fs.writeFileSync(path.join(bundle,'tool_outputs.jsonl'),JSON.stringify({nested:[{password:'log-credential'}],OPERATOR_TOKEN:'prefixed-credential',token_count:17})+'\n');
  fs.writeFileSync(path.join(bundle,'request_log.jsonl'),'client_secret=raw-credential\n');
  fs.writeFileSync(path.join(root,'feedback','events.jsonl'),JSON.stringify({session_id:session,rating:'failed',dev_handoff:{authorization:'feedback-credential'},note:'CHECK THE RETURN VALUE'})+'\n');
  const result=buildImprovementUploadPayload({queue_dir_full:queue});
  assert.ok(result.ok);
  for(const gzip of [false,true]){
    const encoded=encodeUploadPayload(result.payload,{gzip});
    const text=(gzip?zlib.gunzipSync(encoded.body):encoded.body).toString('utf8');
    for(const marker of ['manifest-credential','log-credential','raw-credential','feedback-credential','prefixed-credential'])assert.ok(!text.includes(marker));
    assert.ok(text.includes('CHECK THE RETURN VALUE'));assert.ok(text.includes('"token_count":17'));
    assert.ok(text.includes('<redacted:credential>'));
  }
  assert.ok(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8').includes('manifest-credential'),
    'export must not rewrite local source history');
});
