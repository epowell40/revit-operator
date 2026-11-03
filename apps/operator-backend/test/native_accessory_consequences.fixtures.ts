import fs from 'node:fs';import {gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const urls=[new URL('./fixtures/native-placement-consequences154.json',import.meta.url),new URL('../../test/fixtures/native-placement-consequences154.json',import.meta.url)];
export function retainedConsequences154(){
 const raw=JSON.parse(fs.readFileSync(urls.find(p=>fs.existsSync(p))!,'utf8'));
 const [apply,after]=raw.records.map((r:any)=>{const b=gunzipSync(Buffer.from(r.gzipBase64,'base64'));assert.equal(b.length,r.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),r.sha256);return JSON.parse(b.toString('utf8'));});
 return {input:raw.input,affected:raw.affected,apply,after};
}
