import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkTrackedSecrets,GITLEAKS_VERSION} from './check-secrets.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-scan-test-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  for(const args of [['init','--quiet'],['config','core.autocrlf','false']])assert.equal(spawnSync('git',args,{cwd:root}).status,0);
  fs.writeFileSync(path.join(root,'source.txt'),'ordinary source\n');
  assert.equal(spawnSync('git',['add','--','source.txt'],{cwd:root}).status,0);
  return root;
}
function fakeScanner(onScan,version=GITLEAKS_VERSION){
  return(binary,args,options)=>{
    if(binary==='git')return spawnSync(binary,args,{...options,encoding:'utf8',windowsHide:true});
    if(args[0]==='version')return{status:0,stdout:version};
    return onScan(args,options);
  };
}
function clean(args){fs.writeFileSync(args[args.indexOf('--report-path')+1],'[]');return{status:0,stdout:''};}

test('missing wrong-version failing and timed-out scanners never pass or echo their output',t=>{
  const root=fixture(t),marker='synthetic-do-not-print';
  for(const version of ['', '0.0.1'])assert.equal(checkTrackedSecrets(root,{execute:fakeScanner(clean,version)}).code,2);
  for(const status of [1,2,null]){
    const result=checkTrackedSecrets(root,{execute:fakeScanner(()=>({status,stdout:marker,stderr:marker}))});
    assert.equal(result.code,2);assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test('findings block the gate without leaking raw values and snapshots are removed',t=>{
  const root=fixture(t);let scratch;
  const result=checkTrackedSecrets(root,{execute:fakeScanner((args,options)=>{
    scratch=options.cwd;
    assert.ok(args.includes('--redact=100'));assert.ok(args.includes('--ignore-gitleaks-allow'));
    assert.equal(options.env.GITLEAKS_CONFIG,undefined);assert.equal(options.env.OPENAI_API_KEY,undefined);
    fs.writeFileSync(args[args.indexOf('--report-path')+1],JSON.stringify([{File:path.join(args[1],'source.txt'),RuleID:'synthetic',StartLine:1,EndLine:1,Secret:'synthetic-secret-value'}]));
    return{status:7,stdout:'synthetic-secret-value',stderr:'synthetic-secret-value'};
  })});
  assert.equal(result.code,1);assert.ok(!JSON.stringify(result).includes('synthetic-secret-value'));assert.ok(!fs.existsSync(scratch));
});

test('reviewed non-secret spans never exempt changed values other rules or other files',t=>{
  const root=fixture(t),reviewedMatches=[{file:'source.txt',rule:'synthetic',span_sha256:createHash('sha256').update('ordinary source').digest('hex'),reason:'Synthetic non-credential test text'}];
  const execute=fakeScanner(args=>{
    fs.writeFileSync(args[args.indexOf('--report-path')+1],JSON.stringify([{File:path.join(args[1],'source.txt'),RuleID:'synthetic',StartLine:1,EndLine:1}]));return{status:7,stdout:''};
  });
  assert.equal(checkTrackedSecrets(root,{execute,reviewedMatches}).code,0);
  fs.writeFileSync(path.join(root,'source.txt'),'changed value');
  assert.equal(checkTrackedSecrets(root,{execute,reviewedMatches}).code,1);
  fs.writeFileSync(path.join(root,'source.txt'),'ordinary source');
  for(const entry of [{...reviewedMatches[0],file:'other.txt'},{...reviewedMatches[0],rule:'other-rule'}])
    assert.equal(checkTrackedSecrets(root,{execute,reviewedMatches:[entry]}).code,1);
});

test('tracked current bytes include dirty edits and staged additions, exclude ignored files',t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'source.txt'),'current dirty bytes');
  fs.writeFileSync(path.join(root,'added.txt'),'staged bytes');
  assert.equal(spawnSync('git',['add','--','added.txt'],{cwd:root}).status,0);
  fs.writeFileSync(path.join(root,'ignored-local.env'),'local credential must not be copied');
  let scratch;
  const result=checkTrackedSecrets(root,{execute:fakeScanner((args,options)=>{
    scratch=options.cwd;const content=args[1];
    assert.equal(fs.readFileSync(path.join(content,'source.txt'),'utf8'),'current dirty bytes');
    assert.equal(fs.readFileSync(path.join(content,'added.txt'),'utf8'),'staged bytes');
    assert.ok(!fs.existsSync(path.join(content,'ignored-local.env')));return clean(args);
  })});
  assert.equal(result.code,0);assert.ok(!fs.existsSync(scratch));
});

test('scanner success without a valid clean report fails closed',t=>{
  const root=fixture(t);
  for(const content of [null,'not-json','{}','[{"Secret":"synthetic"}]']){
    const result=checkTrackedSecrets(root,{execute:fakeScanner(args=>{
      if(content!==null)fs.writeFileSync(args[args.indexOf('--report-path')+1],content);
      return{status:0,stdout:''};
    })});assert.equal(result.code,2);
  }
});

test('actual pinned binary detects synthetic token in staged source without publishing it',{
  skip:!process.env.GITLEAKS_PATH?'Explicit pinned local scanner required for integration probe':false
},t=>{
  const root=fixture(t);assert.equal(checkTrackedSecrets(root).code,0);
  const token='gh'+'p_'+[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].reverse().join('');
  fs.writeFileSync(path.join(root,'added.txt'),'access_token="'+token+'"');
  assert.equal(spawnSync('git',['add','--','added.txt'],{cwd:root}).status,0);
  const result=checkTrackedSecrets(root);assert.equal(result.code,1);assert.ok(!JSON.stringify(result).includes(token));
});
