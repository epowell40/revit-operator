import assert from "node:assert/strict";
import test from "node:test";
import { recordChatExecutionFailureDiagnostic, recordProviderStartFailureDiagnostic } from "../src/assignments/chat_execution_failure_diagnostic.js";

for (const stream of [true, false]) {
  test(`original ${stream ? "streaming" : "JSON"} failure survives terminal recovery`, () => {
    const events: unknown[] = [];
    const bundles: unknown[] = [];
    const logs: unknown[] = [];
    const original = new Error("provider rejected tool schema");
    const message = recordChatExecutionFailureDiagnostic({
      session_id: "session-1", message_id: "message-1", error: original, stream
    }, {
      append_event: (sessionId, payload) => events.push({ sessionId, payload }),
      capture_bundle: (sessionId, messageId, error, isStream) => bundles.push({ sessionId, messageId, error, isStream }),
      log_error: payload => logs.push(payload)
    });
    assert.equal(message, original.message);
    assert.deepEqual(events, [{ sessionId: "session-1", payload: {
      message_id: "message-1", message: original.message, stack: original.stack
    } }]);
    assert.deepEqual(bundles, [{ sessionId: "session-1", messageId: "message-1", error: original, isStream: stream }]);
    assert.deepEqual(logs, [{ session_id: "session-1", message_id: "message-1", error: original.message, stream }]);
  });
}

test("diagnostic storage failures cannot replace the original execution error", () => {
  const message = recordChatExecutionFailureDiagnostic({
    session_id: "session-2", message_id: "message-2", error: new Error("original provider error"), stream: true
  }, {
    append_event: () => { throw new Error("event store unavailable"); },
    capture_bundle: () => { throw new Error("bundle store unavailable"); },
    log_error: () => { throw new Error("audit store unavailable"); }
  });
  assert.equal(message, "original provider error");
});

test("provider startup stores its original exception before the brain settles V2", () => {
  const events: unknown[] = [];
  const error = new Error("thread/start rejected invalid tools");
  recordProviderStartFailureDiagnostic({ session_id: "session-3", message_id: "message-3", error },
    (sessionId, payload) => events.push({ sessionId, payload }));
  assert.deepEqual(events, [{ sessionId: "session-3", payload: {
    message_id: "message-3", message: error.message, stack: error.stack
  } }]);
});

test("provider startup diagnostic failure cannot replace V2 settlement", () => {
  assert.doesNotThrow(() => recordProviderStartFailureDiagnostic({
    session_id: "session-4", message_id: "message-4", error: "transport rejected"
  }, () => { throw new Error("event store unavailable"); }));
});
