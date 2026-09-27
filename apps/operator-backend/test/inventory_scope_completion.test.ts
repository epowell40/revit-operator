import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AssignmentJournalV2, evaluateCriterionV2, type AssignmentEventV2,
  type AssignmentSpecV2, type ObservationV2, type OperationV2, type OperationResultV2 } from "../src/domain/assignment-kernel/index.js";

// The MCP adapter test checks these exact scope fingerprints against the two
// retained native requests/payloads. Here the unchanged kernel must accept the
// resulting facts together, while still rejecting contradictory same-scope reads.
const fixture=JSON.parse(fs.readFileSync('test/fixtures/ui-inventory-scope-collision.json','utf8')) as {
  spec:AssignmentSpecV2;
  cases:Array<{request:OperationV2;result:OperationResultV2;observation:ObservationV2}>;
  expected_query_scopes:string[];
  evaluation:{reason:string};
};
function evaluate(scopes:readonly (string|undefined)[],changedCount?:number) {
  const binding=fixture.spec.binding;
  const journal=new AssignmentJournalV2();
  journal.append({schema:'revit-operator.assignment-event/v2',event_id:'scope-replay-created',assignment_id:binding.assignment_id,
    assignment_version:1,binding,occurred_at:fixture.spec.created_at,actor:'scope-regression',event_type:'assignment_created',spec:fixture.spec} as AssignmentEventV2);
  const snapshot={...journal.snapshot(),operations:{} as Record<string,OperationV2>,observations:{} as Record<string,ObservationV2>};
  const observationIds:string[]=[];
  for(let index=0;index<fixture.cases.length;index++) {
    const entry=structuredClone(fixture.cases[index]!);
    const observation=entry.observation;
    observation.facts=observation.facts.map(fact=>fact.fact_id.startsWith('collection.')
      ? {...fact,...(fact.fact_id==='collection.total' && index===1 && changedCount!==undefined?{value:changedCount}:{}),
        dimensions:{...fact.dimensions,...(scopes[index]?{query_scope:scopes[index]!}:{})}}
      : fact);
    snapshot.operations[entry.request.operation_id]={...entry.request,dispatch_state:'dispatched',settlement_state:'settled',
      result:entry.result,observation_ids:[observation.observation_id]};
    snapshot.observations[observation.observation_id]=observation;
    observationIds.push(observation.observation_id);
  }
  return evaluateCriterionV2({snapshot,criterion_id:fixture.spec.criteria[0]!.criterion_id,observation_ids:observationIds,
    evaluator_authority:'operator-runtime',evaluated_at:'2026-09-26T01:22:00.272Z'});
}

test('exact retained route-only totals reproduce the UI inventory criterion conflict',()=>{
  const result=evaluate([undefined,undefined]);
  assert.equal(result.status,'uncertain');
  assert.equal(result.reason,fixture.evaluation.reason);
});

test('native inventories with different query scopes can jointly establish collection evidence',()=>{
  assert.equal(evaluate(fixture.expected_query_scopes).status,'pass');
});

test('same-scope native count disagreements remain uncertain and matching repeated counts agree',()=>{
  const sameScope=[fixture.expected_query_scopes[0]!,fixture.expected_query_scopes[0]!];
  assert.equal(evaluate(sameScope).status,'uncertain');
  assert.equal(evaluate(sameScope,7).status,'pass');
});
