import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../RevitBridge.Logic/Handlers/DynamicRuntime/DynamicNativeProgramRevitHost.cs',import.meta.url),'utf8');
test('real native write host requests repaint after transaction cleanup and retains native outcome',()=>{
 const write=source.slice(source.indexOf('private static Dictionary<string,object?> Write('),source.indexOf('private static MethodInfo LoadTrustedEntry'));
 const cleanup=write.indexOf('try{transaction.Dispose();}finally{group.Dispose();}');
 const refresh=write.indexOf('OperatorNativeProgramExecution.RefreshCommittedView(result,()=>');
 assert(cleanup>0&&refresh>cleanup,'committed canvas refresh must follow disposal');
 assert.match(write.slice(refresh),/ui\.RefreshActiveView\(\)/);
 assert.match(write.slice(refresh),/Fingerprint\(ui.Document\)!=fingerprint/);
 assert.match(write.slice(refresh),/Session\(ui.Document\)!=session/);
 assert.match(write.slice(refresh),/result\["native_failures"\]=failures;return result/);
 assert(!source.slice(0,source.indexOf('private static Dictionary<string,object?> Write(')).includes('RefreshCommittedView'));
});
