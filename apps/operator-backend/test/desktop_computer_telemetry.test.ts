import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { relayDesktopComputerResponse } from "../src/desktop_computer.js";

test("desktop relay preserves outer-model usage for Luna at literal max", { concurrency: false }, async () => {
  let requestBody: any = null;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_desktop_luna",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: {
          input_tokens: 210,
          input_tokens_details: { cached_tokens: 150 },
          output_tokens: 55,
          output_tokens_details: { reasoning_tokens: 34 },
          total_tokens: 265
        }
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    key: process.env.OPERATOR_OPENAI_API_KEY,
    baseUrl: process.env.OPERATOR_OPENAI_BASE_URL
  };
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
    const result = await relayDesktopComputerResponse({
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      input: "test input"
    });

    assert.equal(requestBody.model, "gpt-5.6-luna");
    assert.equal(requestBody.reasoning.effort, "max");
    assert.equal(result.model_call_receipt.route, "desktop_computer");
    assert.equal(result.model_call_receipt.call_id, "resp_desktop_luna");
    assert.deepEqual(result.model_call_receipt.tokens, {
      input_tokens: 210,
      cached_input_tokens: 150,
      output_tokens: 55,
      reasoning_output_tokens: 34,
      total_tokens: 265
    });
  } finally {
    if (previous.key === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.OPERATOR_OPENAI_BASE_URL;
    else process.env.OPERATOR_OPENAI_BASE_URL = previous.baseUrl;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("desktop relay rejects unsafe explicit model and effort values before dispatch", { concurrency: false }, async () => {
  const previous = process.env.OPERATOR_OPENAI_API_KEY;
  process.env.OPERATOR_OPENAI_API_KEY = "test-key";
  try {
    await assert.rejects(
      relayDesktopComputerResponse({ model: "../../bad model", input: "test" }),
      /bounded provider model identifier/
    );
    await assert.rejects(
      relayDesktopComputerResponse({ reasoning_effort: "maximum", input: "test" }),
      /none, low, medium, high, xhigh, or max/
    );
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_OPENAI_API_KEY;
    else process.env.OPERATOR_OPENAI_API_KEY = previous;
  }
});
