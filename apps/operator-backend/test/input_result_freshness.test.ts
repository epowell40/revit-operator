import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { invalidateDependentInputResultsV2, operationUsesCurrentInputsV2 } from "../src/domain/assignment-kernel/input_result_freshness.js";
import { deriveAssignmentOutcomeV2 } from "../src/domain/assignment-kernel/outcome.js";
import { resultObservationEligibilityV2 } from "../src/domain/assignment-kernel/result_delivery.js";
import { evaluateCriterionV2 } from "../src/domain/assignment-kernel/criterion_evaluator.js";
import type { AssignmentSnapshotV2 } from "../src/domain/assignment-kernel/snapshot.js";
const fixture = (): AssignmentSnapshotV2 => JSON.parse(fs.readFileSync("test/fixtures/c35-workbook-before-answer.json", "utf8"));

test("retained twelve-space workbook cannot finish after missing airflow is supplied without refreshing dependent results", () => {
  const before=fixture(), variable="space_307_supply_return_cfm";
  const answered={...before,input_values:{...before.input_values,[variable]:"450 supply, 450 return, 0 exhaust"},pending_input_variable_ids:[]};
  assert.equal(deriveAssignmentOutcomeV2(answered),"complete", "retained pre-fix failure shape");
  const after=invalidateDependentInputResultsV2(answered,variable);
  assert.equal(deriveAssignmentOutcomeV2(after),"active");
  assert.equal(after.result_delivery,undefined);
  assert.deepEqual(after.operations,before.operations,"completed receipts remain available");
  assert.deepEqual(after.observations,before.observations,"source evidence remains available");
  assert.equal(after.spec,before.spec,"original request and limits remain unchanged");
  const criterion=after.spec.criteria[0]!;
  const result=evaluateCriterionV2({snapshot:after,criterion_id:criterion.criterion_id,observation_ids:Object.keys(after.observations),evaluator_authority:criterion.accepted_evaluator_authority_ids[0]!,evaluated_at:"2026-09-15T20:19:23.000Z"});
  assert.notEqual(result.status,"pass");
  for(const item of before.result_delivery!.items) assert.equal(resultObservationEligibilityV2(after,item.observation_id),"ineligible");
  assert.deepEqual(invalidateDependentInputResultsV2(after,variable),after,"invalidating twice does not duplicate history");
});

test("unrelated work stays eligible; a new verification of an obsolete artifact cannot revive it", () => {
  const before=fixture(), after=invalidateDependentInputResultsV2(before,"space_307_supply_return_cfm");
  const invalid=after.input_invalidated_operation_ids![0]!;
  const old=after.operations[invalid]!;
  assert.equal(operationUsesCurrentInputsV2(after,{...old,operation_id:"new-read",verification_of_operation_id:invalid}),false);
  assert.equal(operationUsesCurrentInputsV2(after,{...old,operation_id:"new-output",verification_of_operation_id:undefined}),true);
  assert.equal(invalidateDependentInputResultsV2(before,"unrelated-variable"),before);
});
