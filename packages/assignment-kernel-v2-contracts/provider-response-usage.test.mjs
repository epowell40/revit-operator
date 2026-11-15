import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderUsageLedgerV1 } from './provider-turn-usage.js';
const receipt = { provider: 'openai', route: 'desktop_computer', call_id: 'resp-a' };
const response = (message='request-a', responseId='resp-a') => ({ provider_response_usage: {
 schema: 'revit-operator.provider-response-usage/v1', session_id: 'session-a', message_id: message,
 disposition: 'completed', raw_response_ids: [responseId]
}});

test('host pre-admission refusal settles only its exact direct request without inventing a provider call', () => {
 const stopped={provider_response_usage:{schema:'revit-operator.provider-response-usage/v1',session_id:'session-a',message_id:'request-a',disposition:'not_started',raw_response_ids:[]}};
 const ledger=createProviderUsageLedgerV1();ledger.begin('session-a','request-a','desktop_computer');
 ledger.observe('session-a','request-a',stopped);
 assert.equal(ledger.snapshot([]).complete,true);assert.equal(ledger.snapshot([]).no_provider_invocation,true);
 assert.equal(ledger.snapshot([receipt]).complete,false,'unexpected actual usage is never erased');
 for(const change of [{message_id:'foreign'},{raw_response_ids:['resp-a']},{disposition:'failed'},{thread_id:'fake'}]){
  const bad=createProviderUsageLedgerV1();bad.begin('session-a','request-a','desktop_computer');
  bad.observe('session-a','request-a',{provider_response_usage:{...stopped.provider_response_usage,...change}});
  assert.equal(bad.snapshot([]).complete,false);
 }
 ledger.observe('session-a','request-a',response());
 assert.equal(ledger.snapshot([receipt]).complete,false,'contradictory later dispatch remains visible');
});
test('direct Responses coverage binds a host attempt without inventing Codex identities', () => {
 const ledger=createProviderUsageLedgerV1();
 ledger.begin('session-a','request-a','desktop_computer');
 assert.equal(ledger.snapshot([receipt]).complete,false);
 ledger.observe('session-a','request-a',response());
 assert.equal(ledger.snapshot([receipt]).complete,true);
 assert.equal(ledger.snapshot([receipt]).attempts[0].provider_response_usage.thread_id,undefined);
 assert.equal(ledger.snapshot([{...receipt, route:'codex_agent'}]).complete,false);
});
test('direct retries, lost responses, extra receipts and contradictory bindings remain incomplete', () => {
 const ledger=createProviderUsageLedgerV1();
 ledger.begin('session-a','request-a','desktop_computer');
 ledger.observe('session-a','request-a',response());
 assert.equal(ledger.snapshot([receipt,{...receipt,call_id:'extra'}]).complete,false);
 ledger.begin('session-a','request-b','desktop_computer');
 assert.equal(ledger.snapshot([receipt]).complete,false);
 ledger.observe('session-a','request-b',response('request-b','resp-b'));
 const receipts=[receipt,{...receipt,call_id:'resp-b'}];
 assert.equal(ledger.snapshot(receipts).complete,true);
 ledger.observe('session-a','request-b',response('request-b','other'));
 ledger.observe('session-a','request-b',response('request-b','resp-b'));
 assert.equal(ledger.snapshot(receipts).complete,false);
});
test('a direct response cannot settle a Codex attempt or reuse an earlier response', () => {
 const ledger=createProviderUsageLedgerV1();
 ledger.begin('session-a','request-a');
 ledger.observe('session-a','request-a',response());
 assert.equal(ledger.snapshot([receipt]).complete,false);
 const direct=createProviderUsageLedgerV1();
 for(const message of ['request-a','request-b']) {
  direct.begin('session-a',message,'desktop_computer');
  direct.observe('session-a',message,response(message));
 }
 assert.equal(direct.snapshot([receipt]).complete,false);
});
