import test from "node:test";
import assert from "node:assert/strict";
import { ordinaryInputTokens, standardProviderTextTokenCostUsd as cost } from "../src/provider_token_cost.js";

const tokens = { input_tokens:100, cached_input_tokens:60, cache_write_input_tokens:10, output_tokens:40 };

test("Terra and Luna price actual cache categories and the per-call long threshold", () => {
  for (const [model, input, cached, write, output] of [
    ['gpt-6.1-terra', 1, .05, 1.25, 5], ['gpt-6-luna', .1, .01, .125, .5]
  ] as const) {
    assert.equal(cost(model, tokens), (30*input + 60*cached + 10*write + 40*output)/1_000_000);
    assert.equal(cost(model, {...tokens, input_tokens:272001}),
      ((271931*input + 60*cached + 10*write)*2 + 40*output*1.5)/1_000_000);
    assert.equal(cost(model, {...tokens, cached_input_tokens:undefined}), null);
  }
  assert.equal(cost('gpt-6.6-astra', tokens), null);
  assert.equal(cost('gpt-6.1-luna', tokens), null);
});

test("input partitions price cache writes instead of adding them to ordinary input", () => {
  assert.equal(ordinaryInputTokens(tokens),30);
  assert.equal(cost("gpt-6.1-sol",tokens),(30*2+60*.1+10*2.5+40*10)/1_000_000);
  assert.equal(cost("gpt-6-astra",tokens),(30*10+60+10*12.5+40*50)/1_000_000);
  assert.equal(cost("gpt-6.1-sol",{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0}),0);
});

test("long-context threshold is per request and prices the full request", () => {
  const exact={input_tokens:272_000,cached_input_tokens:200_000,cache_write_input_tokens:70_000,output_tokens:100};
  assert.equal(cost("gpt-6.1-sol",exact),(2000*2+200_000*.1+70_000*2.5+100*10)/1_000_000);
  assert.equal(cost("gpt-6.1-sol",{...exact,input_tokens:272_001}),((2001*2+200_000*.1+70_000*2.5)*2+100*15)/1_000_000);
  const short={input_tokens:150_000,cached_input_tokens:140_000,cache_write_input_tokens:1000,output_tokens:10};
  assert.equal(cost("gpt-6.1-sol",short)!*2,(9000*2+140_000*.1+1000*2.5+10*10)*2/1_000_000);
});

test("missing, impossible, fractional or unsafe counts never mean free usage", () => {
  for(const field of Object.keys(tokens)) {
    for(const bad of [undefined,null,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"10"]) {
      assert.equal(cost("gpt-6.1-sol",{...tokens,[field]:bad}),null,`${field}: ${String(bad)}`);
    }
  }
  assert.equal(cost("gpt-6.1-sol",{...tokens,cached_input_tokens:91}),null);
  assert.equal(cost("gpt-6.1-sol",{...tokens,cache_write_input_tokens:41}),null);
  assert.equal(cost("unknown-model",tokens),null);
  for (const name of ["constructor", "toString", "__proto__"]) assert.equal(cost(name,tokens),null);
  assert.equal(cost("",tokens),null);
});
