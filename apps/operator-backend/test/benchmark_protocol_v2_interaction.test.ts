import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_INTERACTION_MANIFEST_V1,
  benchmarkInteractionCaseV1,
  benchmarkInteractionResultPatternsV1,
  parseBenchmarkInteractionManifestV1
} from "../src/benchmark/protocol_v2_interaction.js";

const oracleHash = "ab".repeat(32);

function manifest(): Record<string, any> {
  return {
    schema: BENCHMARK_INTERACTION_MANIFEST_V1,
    manifest_id: "release-interactions-v1",
    cases: [{
      source_case_id: "mutation_requires_value",
      transformation_id: "clarification-user-response",
      transformation_version: "v1",
      clarification_response: {
        candidate_visible_user_text: "Use the approved issue wording.",
        supplied_values: { replacement_text: "Approved issue wording" }
      },
      direct_variant: {
        candidate_visible_user_text: "Replace the selected note with Approved issue wording.",
        transformation_id: "fully-specified-direct",
        transformation_version: "v1"
      },
      evaluator_oracle: {
        protected_identity: "oracle-note-v1",
        sha256: oracleHash,
        required_result_variable_ids: ["replacement_text"]
      }
    }]
  };
}

test("interactive manifest keeps candidate-visible input separate from protected oracle identity", () => {
  const parsed = parseBenchmarkInteractionManifestV1(manifest());
  const entry = benchmarkInteractionCaseV1(parsed, "mutation_requires_value");
  assert.equal(entry?.clarification_response.supplied_values.replacement_text, "Approved issue wording");
  assert.equal(entry?.evaluator_oracle.sha256, oracleHash);
  assert.equal(JSON.stringify(entry?.clarification_response).includes(oracleHash), false);
  const [pattern] = benchmarkInteractionResultPatternsV1(entry!);
  assert.match("Previewed replacement. Proposed: Approved issue wording", new RegExp(pattern!, "i"));
  assert.doesNotMatch("Previewed replacement. Proposed: old wording", new RegExp(pattern!, "i"));
});

test("interactive manifest rejects duplicate cases, credential-like values, and invalid oracle hashes", () => {
  const duplicate = manifest();
  duplicate.cases.push(structuredClone(duplicate.cases[0]!));
  assert.throws(() => parseBenchmarkInteractionManifestV1(duplicate), /unique/i);
  const credential = manifest();
  credential.cases[0]!.clarification_response.supplied_values = { api_key: "do-not-store" };
  assert.throws(() => parseBenchmarkInteractionManifestV1(credential), /credentials/i);
  const invalidHash = manifest();
  invalidHash.cases[0]!.evaluator_oracle.sha256 = "not-a-hash";
  assert.throws(() => parseBenchmarkInteractionManifestV1(invalidHash), /SHA-256/i);
  const missingResultValue = manifest();
  missingResultValue.cases[0]!.evaluator_oracle.required_result_variable_ids = ["missing_value"];
  assert.throws(() => parseBenchmarkInteractionManifestV1(missingResultValue), /missing supplied value/i);
});

test("interactive manifest does not invent a direct variant", () => {
  const value = manifest();
  delete value.cases[0]!.direct_variant;
  const parsed = parseBenchmarkInteractionManifestV1(value);
  assert.equal(parsed.cases[0]!.direct_variant, undefined);
});
