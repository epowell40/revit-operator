import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {projectSidecarFunctionOutput, validateEvidenceStoreResponse} from '../evidence_projection.js';

const {handleEvidenceHttpRoute} = await import('../../operator-backend/dist/src/evidence/evidence_http_routes.js');
const {storeEvidence, readAuthoritativeEvidence} = await import('../../operator-backend/dist/src/evidence/evidence_store.js');
const {__closeForTests} = await import('../../operator-backend/dist/src/memory/sqlite_store.js');

test('HTTP store fits the released desktop contract after a large unavailable review without replaying work', async () => {
  const names = ['OPERATOR_WORKSPACE_ROOT', 'OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-evidence-wire-'));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES = '24576';
  const scope = {session_id:'test-session', assignment_id:'test-task', run_id:'test-run', generation:1};
  const raw = {ok:false, state:'unavailable', reason:'visual_review_focus_unconfirmed', checks:[],
    whole_task_verified:false, native_postcondition_verified:false,
    observations:Object.fromEntries(Array.from({length:48}, (_,i) => [`inspection_${i}_status`, 'Diagnostic context '.repeat(12)]))};
  const server = http.createServer(async (req, res) => {
    if (!await handleEvidenceHttpRoute(req,res,new URL(req.url || '/', 'http://localhost'))) {res.statusCode=404;res.end();}
  });
  try {
    // The larger native-read ceiling reproduces the original producer/consumer
    // mismatch. This is synthetic data; retained work-PC evidence stays private.
    const old = storeEvidence({scope,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw},24576);
    assert.throws(() => validateEvidenceStoreResponse({ok:true,...old}), /8192-byte item budget/);
    await new Promise((resolve,reject) => server.listen(0,'127.0.0.1',resolve).once('error',reject));
    let calls = 0;
    const projected = await projectSidecarFunctionOutput({
      toolCall:{name:'review_current_work',arguments:'{}'},
      functionOutput:{type:'function_call_output',call_id:'review-call',output:JSON.stringify(raw)},scope,
      storeEvidence:async body => {
        calls++;
        const response = await fetch(`http://127.0.0.1:${server.address().port}/evidence/store`, {
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        assert.equal(response.status,201);
        return response.json();
      }
    });
    assert.equal(calls,1);
    assert.equal(projected.model_output.call_id,'review-call');
    assert(Buffer.byteLength(JSON.stringify(projected.evidence_projection)) <= 8192);
    assert.equal(projected.evidence_projection.key_facts.state,'unavailable');
    assert.equal(projected.evidence_projection.trust_level,'untrusted_caller');
    assert.equal(projected.evidence_projection.content_hash,old.ref.content_hash);
    assert.deepEqual(JSON.parse(readAuthoritativeEvidence(projected.evidence_ref,scope).toString()),raw);
    assert.throws(() => readAuthoritativeEvidence(projected.evidence_ref,{...scope,session_id:'foreign'}));
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    __closeForTests();
    for (const name of names) {if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name];}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
