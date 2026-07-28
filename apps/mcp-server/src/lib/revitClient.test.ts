import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callRevit, RevitBridgeCallError } from "./revitClient.js";

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function setTestEnvironment(url: string, timeoutMs: number): () => void {
  const previous = {
    url: process.env.REVIT_BRIDGE_URL,
    timeout: process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS,
    workspace: process.env.OPERATOR_WORKSPACE_ROOT,
    token: process.env.OPERATOR_TOKEN,
    transport: process.env.OPERATOR_REVIT_TRANSPORT,
  };
  process.env.REVIT_BRIDGE_URL = url;
  process.env.OPERATOR_REVIT_REQUEST_TIMEOUT_MS = String(timeoutMs);
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "revit-client-test-"));
  process.env.OPERATOR_TOKEN = "revit-client-test-token";
  process.env.OPERATOR_REVIT_TRANSPORT = "direct";
  return () => {
    for (const [name, value] of Object.entries({
      REVIT_BRIDGE_URL: previous.url,
      OPERATOR_REVIT_REQUEST_TIMEOUT_MS: previous.timeout,
      OPERATOR_WORKSPACE_ROOT: previous.workspace,
      OPERATOR_TOKEN: previous.token,
      OPERATOR_REVIT_TRANSPORT: previous.transport,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("callRevit returns JSON from a responsive bridge", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    assert.deepEqual(await callRevit("/revit/ping"), { ok: true });
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks a timed-out mutating request as non-retryable with an unknown outcome", async () => {
  const server = http.createServer(() => {
    // Deliberately leave the response open until the client deadline aborts it.
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 250);
  const started = Date.now();
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_timeout");
        assert.equal(error.transportCode, "revit_bridge_timeout");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.equal(error.outcomeUnknown, true);
        assert.match(error.message, /POST \/revit\/walls exceeded 250 ms/);
        assert.match(error.message, /may already have started/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit preserves structured outcome-unknown bridge errors", async () => {
  const bridgeError = {
    ok: false,
    error: "The Revit action deadline elapsed after execution may have started.",
    code: "revit_action_deadline_elapsed_outcome_unknown",
    retryable: false,
    phase: "revit_external_event",
    host_health: "degraded",
    opens_circuit: true,
    outcome_unknown: true,
    correlation_id: "correlation-408",
    deadline_class: "write",
    deadline_ms: 30_000,
  };
  const server = http.createServer((_request, response) => {
    response.statusCode = 408;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(bridgeError));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.transportCode, "revit_bridge_http_error");
        assert.equal(error.status, 408);
        assert.equal(error.bridgeCode, bridgeError.code);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.equal(error.phase, bridgeError.phase);
        assert.equal(error.host_health, bridgeError.host_health);
        assert.equal(error.opens_circuit, bridgeError.opens_circuit);
        assert.equal(error.correlation_id, bridgeError.correlation_id);
        assert.equal(error.deadline_class, bridgeError.deadline_class);
        assert.equal(error.deadline_ms, bridgeError.deadline_ms);
        assert.deepEqual(error.bridgeDetails, bridgeError);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps legacy unstructured HTTP errors compatible", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.transportCode, "revit_bridge_http_error");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.bridgeDetails, undefined);
        assert.match(error.message, /bridge unavailable/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

for (const status of [500, 502, 503]) {
  test(`callRevit settles an unstructured mutation HTTP ${status} as outcome unknown`, async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = status;
      response.end("legacy bridge failure");
    });
    const port = await listen(server);
    const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
    try {
      await assert.rejects(
        callRevit("/revit/walls", "POST", { action: "create" }),
        (error: unknown) => {
          assert.ok(error instanceof RevitBridgeCallError);
          assert.equal(error.status, status);
          assert.equal(error.retryable, false);
          assert.equal(error.outcome_unknown, true);
          assert.match(error.message, /legacy bridge failure/);
          return true;
        },
      );
    } finally {
      restore();
      await close(server);
    }
  });
}

test("callRevit does not replay an unstructured mutation rejection", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.statusCode = 403;
    response.end("write requires approval; X-Operator-Write-Grant missing");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.status, 403);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit honors a structured pre-dispatch rejection for a mutation", async () => {
  const bridgeError = {
    ok: false,
    code: "request_validation_failed",
    phase: "pre_dispatch",
    outcome_unknown: false,
    retryable: true,
  };
  const server = http.createServer((_request, response) => {
    response.statusCode = 422;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(bridgeError));
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.status, 422);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.phase, "pre_dispatch");
        assert.deepEqual(error.bridgeDetails, bridgeError);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit settles a truncated mutation error body as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(503, {
      "content-type": "application/json",
      "content-length": "200",
    });
    response.write('{"ok":false,"code":');
    setImmediate(() => response.socket?.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_http_error");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /response body was unavailable or incomplete/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps a known read-only POST safely retryable", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/sheets", "POST", { action: "list" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit classifies conditional POST bodies as read or apply", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end("bridge unavailable");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/fire-damper-audit", "POST", { command: "audit" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/fire-damper-audit", "POST", { command: "fix", dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", JSON.stringify({ action: "list" })),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", { action: "rename_types", dryRun: true }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
    await assert.rejects(
      callRevit("/revit/list-element-types", "POST", { action: "rename_types", dryRun: false }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit treats a pre-connect refusal for a mutation as proven safe to retry", async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        assert.match(error.message, /Revit may be closed or the bridge may not be listening/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("callRevit marks a mutation socket reset after the server reads its body as outcome unknown", async () => {
  let receivedBody = "";
  const server = http.createServer((request) => {
    request.setEncoding("utf8");
    request.on("data", chunk => { receivedBody += chunk; });
    request.on("end", () => request.socket.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /after dispatch could not be ruled out/);
        assert.match(error.message, /reconcile its outcome in Revit/);
        return true;
      },
    );
    assert.equal(receivedBody, JSON.stringify({ action: "create" }));
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps a read-only socket reset retryable", async () => {
  const server = http.createServer(request => {
    request.on("end", () => request.socket.destroy());
    request.resume();
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_unavailable");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks invalid 2xx JSON for a mutation as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("not-json");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        assert.match(error.message, /invalid or incomplete JSON response/);
        assert.match(error.message, /may already have completed/);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit marks truncated 2xx JSON for a mutation as outcome unknown", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "100",
    });
    response.write('{"ok":');
    setImmediate(() => response.socket?.destroy());
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/walls", "POST", { action: "create" }),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, false);
        assert.equal(error.outcome_unknown, true);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});

test("callRevit keeps invalid 2xx JSON for a read-only call retryable", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("not-json");
  });
  const port = await listen(server);
  const restore = setTestEnvironment(`http://127.0.0.1:${port}`, 2_000);
  try {
    await assert.rejects(
      callRevit("/revit/ping"),
      (error: unknown) => {
        assert.ok(error instanceof RevitBridgeCallError);
        assert.equal(error.code, "revit_bridge_invalid_response");
        assert.equal(error.retryable, true);
        assert.equal(error.outcome_unknown, false);
        return true;
      },
    );
  } finally {
    restore();
    await close(server);
  }
});
