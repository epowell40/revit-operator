import assert from "node:assert/strict";
import test from "node:test";
import { runNativeProgramViaCourier } from "./dynamicNativeCourier.js";
import { runWithRevitToolAlias } from "./toolExposurePolicy.js";

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
        assert.equal(sent,body); assert.equal(options.canonicalOperationId,"current-operation");
        assert.equal(Object.hasOwn(body,"sourceFile"),false); assert.equal(Object.hasOwn(body,"operatorTokenFile"),false);
        return {schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:{ok:true}};
      }) as any);
      assert.equal(calls,1); assert.equal(result.exitCode,0);
    }
    for (const value of [null,{}, {schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence:[],verified:true},
      {schema:"operator.native-program-workstation-result.v1",exitCode:2,evidence:{}}])
      await assert.rejects(runNativeProgramViaCourier(body,"read",undefined,(async()=>value) as any));
    let calls=0;
    await assert.rejects(runNativeProgramViaCourier(body,"apply",undefined,(async()=>{calls++;throw Error("transport_lost");}) as any),/transport_lost/);
    assert.equal(calls,1,"A transport failure must never retry a write.");
  } finally { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env,prior); }
}));
