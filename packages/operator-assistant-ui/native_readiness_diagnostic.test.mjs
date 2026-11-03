import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeReadinessFailureMessage,nativeReadinessHealthDetail} from './native_readiness_diagnostic.mjs';
import {assertDesktopHandoffNativeReady} from './work_report.mjs';

test('shared UI handoff preserves a known local discovery cause without exposing its raw path',()=>{
  const error=Object.assign(new Error('Listener identity unavailable.',{
    cause:Object.assign(Error('secret=token C:\\Users\\private\\receipt.json'),{code:'ENOENT'})
  }),{code:'NATIVE_TRANSPORT_DISCOVERY_UNAVAILABLE'});
  const message=nativeReadinessFailureMessage(error);
  assert.match(message,/ENOENT/);assert(!message.includes('private'));assert(!message.includes('token'));
  const health={ok:false,context:null,revit_bridge:{error:JSON.stringify({code:'REVIT_CONTEXT_HOST_UNAVAILABLE',error:message})}};
  assert.match(nativeReadinessHealthDetail(health),/ENOENT/);
  assert.throws(()=>assertDesktopHandoffNativeReady(health),/desktop_handoff_native_readiness_unproven:.*ENOENT/);
});
test('shared handoff retains failure without disclosing arbitrary nested messages',()=>{
  const health={ok:false,context:null,revit_bridge:{error:JSON.stringify({code:'REVIT_CONTEXT_HOST_UNAVAILABLE',error:'token=SECRET'})}};
  assert(!nativeReadinessHealthDetail(health).includes('SECRET'));
  assert.throws(()=>assertDesktopHandoffNativeReady(health),/native_readiness_unproven/);
});
