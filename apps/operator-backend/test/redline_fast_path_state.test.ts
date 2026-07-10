import test from "node:test";
import assert from "node:assert/strict";
import {
  appendRedlineFastPathCandidateDiagnostic,
  buildRedlineFastPathDiagnosticsText,
  getRedlineFastPathState,
  noteRedlineFastPathPhase
} from "../src/brains/redline_fast_path_state.js";

test("redline fast-path diagnostics retain phases, blocker, and bounded view candidates", () => {
  const sessionId = `fast-path-state-${Date.now()}-${Math.random()}`;
  noteRedlineFastPathPhase(sessionId, "request_accepted");
  noteRedlineFastPathPhase(sessionId, "blocked", { blocked_reason: "no_pick_hints" });

  for (let index = 1; index <= 8; index += 1) {
    appendRedlineFastPathCandidateDiagnostic(sessionId, {
      view_id: index,
      view_name: `View ${index}`,
      matched: index === 8,
      confidence: index / 10,
      analysis: `candidate ${index}`
    });
  }

  const state = getRedlineFastPathState(sessionId);
  assert.equal(state.candidate_views_checked.length, 6);
  assert.deepEqual(state.candidate_views_checked.map((entry) => entry.view_id), [3, 4, 5, 6, 7, 8]);

  const diagnostics = buildRedlineFastPathDiagnosticsText(sessionId);
  assert.match(diagnostics, /request_accepted=/);
  assert.match(diagnostics, /blocked_reason=no_pick_hints/);
  assert.match(diagnostics, /View 8#8:match:0\.80/);
  assert.doesNotMatch(diagnostics, /View 1#/);
});
