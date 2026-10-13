import fs from 'node:fs';
export function retainedTagReadFixtureV2(): any {
  const f=JSON.parse(fs.readFileSync('test/fixtures/existing-tag-property-readback-08.json','utf8'));
  const id=f.apply_input.body.repairExistingTagId;
  const handle=f.read_input.body.operations.find((o:any)=>o.op==='call'&&o.args[0]===id).id;
  f.read_input.body.operations=f.read_input.body.operations.filter((o:any)=>o.id===handle||o.target==='$'+handle);
  const ids=new Set(f.read_input.body.operations.map((o:any)=>o.id));
  f.read_input.body.returns=f.read_input.body.returns.filter((v:string)=>ids.has(v.replace(/^\$/,'')));
  f.native_read.operations=f.native_read.operations.filter((o:any)=>ids.has(o.id));
  f.native_read.operation_count=f.native_read.operations.length;
  return f;
}
