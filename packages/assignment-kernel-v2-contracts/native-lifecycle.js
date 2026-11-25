const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function nativeLifecycleActionMatchesV1(receipt, path, body) {
  const expected = object(body).action ?? (path === '/revit/sync' ? 'sync' : 'link');
  return object(receipt).action === expected;
}
export function nativeLifecycleReceiptEffectV1(value, method, path, effect) {
  const r = object(value);
  const actions = {'/revit/sync':['sync','reload_latest'], '/revit/link-revit':['load','reload','unload']};
  return method === 'POST' && effect === 'apply' && r.schema === 'revit-operator.native-lifecycle.v1'
    && r.path === path && actions[path]?.includes(r.action) && r.transaction_ownership === 'revit_api'
    && /^[a-f0-9]{32}$/.test(r.document_session_id ?? '') && !/^0{32}$/.test(r.document_session_id)
    && r.native_call_attempted === true && r.native_call_returned === true && r.status === 'returned' ? 'applied' : null;
}
export function nativeLifecycleResultEffectV2(value) {
  const r=object(value), identity=object(r.request_identity);
  return r.authority === 'native-host' && r.dispatch_state === 'dispatched' && r.native_transaction_state === 'not_applicable'
    && r.observation_required === true && /^[a-f0-9]{64}$/.test(r.raw_payload_hash ?? '')
    && r.result_schema_id === 'operator-native/POST:'+identity.path+'/v2' && r.persistent_effect === 'applied'
    ? nativeLifecycleReceiptEffectV1(r.native_lifecycle_receipt,identity.method,identity.path,'apply') : null;
}
