import assert from "node:assert/strict";
import test from "node:test";
import { runNativeProgramViaCourier, decodeNativeCourierEvidence } from "./dynamicNativeCourier.js";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { runWithRevitToolAlias } from "./toolExposurePolicy.js";
import { isSupportedNativeTransport, isSupportedStandaloneExecutorTool } from "./supportedToolInventory.js";

const packed = (bytes: Buffer) => ({ schema:"operator.native-program-workstation-result.v1",exitCode:0,
  evidenceTransport:{encoding:"gzip+base64",uncompressedBytes:bytes.length,
    sha256:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,data:gzipSync(bytes).toString('base64')} });

test('compressed courier preserves exact nested receipt strings and does not assert native success',()=>{
  const evidence={ok:false,nativeExecutionReceipt:JSON.stringify({text:'Ω界'.repeat(180000),verified:false}),snapshotReceipt:' { "x": 1 } '};
  const wire=packed(Buffer.from(JSON.stringify(evidence)));
  assert.ok(Buffer.byteLength(JSON.stringify(wire))<600000);
  assert.deepEqual(decodeNativeCourierEvidence(wire),evidence);
  assert.equal(decodeNativeCourierEvidence(wire).nativeExecutionReceipt,evidence.nativeExecutionReceipt);
});

test('compressed courier rejects corruption, ambiguity, oversized expansion and malformed encoding',()=>{
  const wire=packed(Buffer.from(JSON.stringify({ok:true,padding:'x'.repeat(900000)})));
  const bad=(overrides:Record<string,unknown>)=>({...wire,evidenceTransport:{...wire.evidenceTransport,...overrides}});
  for(const value of [
    {...wire,evidence:{}}, bad({encoding:'br'}),bad({sha256:'sha256:'+'0'.repeat(64)}),
    bad({uncompressedBytes:8*1024*1024+1}),bad({uncompressedBytes:100}),bad({uncompressedBytes:wire.evidenceTransport.uncompressedBytes+1}),
    bad({data:wire.evidenceTransport.data+'\n'}),bad({data:Buffer.from('not gzip').toString('base64')}),
    bad({extra:true}),packed(Buffer.from('[]')),packed(Buffer.from('{bad json')),
    packed(Buffer.from([0xff,0xfe]))
  ]) assert.throws(()=>decodeNativeCourierEvidence(value));
});

test("hosted native C# ships source and native scope to the existing target courier, not cloud filesystem commands", () => runWithRevitToolAlias("operator_run_dynamic_revit_program", async () => {
  const prior = { ...process.env };
  Object.assign(process.env, { REVIT_OPERATOR_MODE: "hosted", OPERATOR_REVIT_TRANSPORT: "courier" });
  try {
    const body = { source: "public class Query {}", targetRevitYear: "2024", expectedDocumentFingerprint: "sha256:"+"a".repeat(64),
      nativeProgram: { entryType: "Query", mode: "read" }, workerDeadlineMs: 15000 };
    for (const mode of ["read", "apply"] as const) {
      let calls=0;
      const result = await runNativeProgramViaCourier(body, mode, "current-operation", (async (path: string, method: string, sent: unknown, options: any) => {
        calls++; assert.equal(path, `/revit/dynamic-runtime/run-native-${mode}-v1`); assert.equal(method,"POST");
        assert.equal(isSupportedStandaloneExecutorTool(method,path,'revit-operator.native-program-workstation.v1'),true,"The producer must target its registered workstation executor.");
        assert.equal(isSupportedNativeTransport(method,path),false,"Workstation compilation must not become raw native forwarding.");
        assert.equal(sent,body); assert.equal(options.canonicalOperationId,"current-operation");
        assert.equal(Object.hasOwn(body,"sourceFile"),false); assert.equal(Object.hasOwn(body,"operatorTokenFile"),false);
        return {schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:{ok:true}};
      }) as any);
      assert.equal(calls,1); assert.equal(result.exitCode,0);
    }
    for (const value of [null,{}, {schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:[],verified:true},
      {schema:"operator.native-program-workstation-result.v1",exitCode:2,evidence:{}}])
      await assert.rejects(runNativeProgramViaCourier(body,"read",undefined,(async()=>value) as any));
    const large = { nativeExecutionReceipt: "x".repeat(2200000) };
    const transported = await runNativeProgramViaCourier(body,"apply",undefined,(async()=>({
      schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:large
    })) as any);
    assert.equal(transported.evidence,large,"Transport accepts bounded large evidence; runner authentication is still required.");
    const compressed = await runNativeProgramViaCourier(body,"apply","compressed-operation",(async(_path: string,_method: string,_body: unknown,options: any)=>{
      assert.equal(options.canonicalOperationId,"compressed-operation");
      return packed(Buffer.from(JSON.stringify(large)));
    }) as any);
    assert.deepEqual(compressed.evidence,large,"The active courier consumer decodes losslessly before existing native validation.");
    await assert.rejects(runNativeProgramViaCourier(body,"apply",undefined,(async()=>({
      schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:{padding:"界".repeat(3*1024*1024)}
    })) as any),/invalid/);
    let calls=0;
    await assert.rejects(runNativeProgramViaCourier(body,"apply",undefined,(async()=>{calls++;throw Error("transport_lost");}) as any),/transport_lost/);
    assert.equal(calls,1,"A transport failure must never retry a write.");
  } finally { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env,prior); }
}));
