import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceExistingConditionsController,
  createExistingConditionsControllerState,
  type ExistingConditionsControllerEvent,
  type ExistingConditionsPlanElement,
  type ExistingConditionsSourceObservation
} from "../src/existing_conditions/controller.js";

const HASH = "a".repeat(64);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = [
  path.join(testDirectory, "fixtures", "existing_conditions", "challenge_cases", "source_grounding_challenges.v1.json"),
  path.join(testDirectory, "..", "..", "test", "fixtures", "existing_conditions", "challenge_cases", "source_grounding_challenges.v1.json")
].find((candidate) => fs.existsSync(candidate));
if (!fixturePath) throw new Error("source_grounding_challenge_fixture_missing");

type ChallengeCase = {
  case_id: string;
  allowed_categories: string[];
  source_observations: ExistingConditionsSourceObservation[];
  plan: ExistingConditionsPlanElement[];
  expected: { phase?: "clarify"; ambiguity_count?: number; question_contains?: string[]; error_contains?: string };
};

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { schema_version: number; cases: ChallengeCase[] };

function replay(value: ChallengeCase, identitySuffix = "") {
  const idMap = new Map(value.source_observations.map((entry) => [entry.observation_id, `${entry.observation_id}${identitySuffix}`]));
  let state = createExistingConditionsControllerState({
    fixture_id: value.case_id,
    scope_id: "independent-bounded-region",
    discipline: "mixed",
    allowed_categories: value.allowed_categories,
    maximum_created_elements: 12,
    visible_evidence: [{ role: "source_pdf", sha256: HASH }],
    require_source_observation_grounding: true
  });
  state = advanceExistingConditionsController(state, {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH }],
    native_readback: true,
    inventory_complete: true,
    discovered_element_keys: [],
    surrounding_anchor_keys: [],
    source_observations_complete: true,
    source_observations: value.source_observations.map((entry) => ({
      ...entry,
      observation_id: idMap.get(entry.observation_id)!
    }))
  });
  const event: ExistingConditionsControllerEvent = {
    type: "plan_submitted",
    elements: value.plan.map((entry) => ({
      ...entry,
      plan_key: `${entry.plan_key}${identitySuffix}`,
      source_observation_ids: (entry.source_observation_ids ?? []).map((id) => idMap.get(id) ?? id)
    }))
  };
  return advanceExistingConditionsController(state, event);
}

test("data-driven source-grounding challenges remain valid under identity perturbation", () => {
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.cases.length, 3);
  for (const challenge of fixture.cases) {
    for (const suffix of ["", "-different-identities"]) {
      if (challenge.expected.error_contains) {
        assert.throws(() => replay(challenge, suffix), new RegExp(challenge.expected.error_contains));
        continue;
      }
      const state = replay(challenge, suffix);
      assert.equal(state.phase, challenge.expected.phase, challenge.case_id);
      assert.equal(state.ambiguities.length, challenge.expected.ambiguity_count, challenge.case_id);
      for (const phrase of challenge.expected.question_contains ?? []) {
        assert.match(state.clarification_question ?? "", new RegExp(phrase, "i"), `${challenge.case_id}:${phrase}`);
      }
    }
  }
});
