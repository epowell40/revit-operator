import test from "node:test";
import assert from "node:assert/strict";
import { withCodexConversationTurn } from "../src/codex/conversation_turn.js";

test("cancelled queued work cannot bypass a still-settling predecessor", async () => {
  const args={workspace:"fixture",sessionId:"one"};
  let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  const first=withCodexConversationTurn(args,async()=>{entered();await new Promise<void>(r=>release=r);});
  await started;
  const abort=new AbortController();let dispatched=false;
  const second=withCodexConversationTurn({...args,signal:abort.signal},async()=>{throw Error("Must not run");});
  abort.abort();await assert.rejects(second,/No successor provider or native work was started/);
  const third=withCodexConversationTurn(args,async()=>{dispatched=true;});
  await new Promise(r=>setImmediate(r));assert.equal(dispatched,false);
  release();await Promise.all([first,third]);assert.equal(dispatched,true);
});

test("different conversations run independently and errors release only their own slot", async () => {
  let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  const first=withCodexConversationTurn({workspace:"fixture",sessionId:"blocked"},async()=>{entered();await new Promise<void>(r=>release=r);});
  await started;
  try {
    assert.equal(await withCodexConversationTurn({workspace:"fixture",sessionId:"other"},async()=>42),42);
    await assert.rejects(withCodexConversationTurn({workspace:"other-workspace",sessionId:"blocked"},async()=>{throw Error("fixture failure");}),/fixture failure/);
    assert.equal(await withCodexConversationTurn({workspace:"other-workspace",sessionId:"blocked"},async()=>7),7);
  } finally {release();await first;}
});
