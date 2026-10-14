import assert from "node:assert/strict";
import test from "node:test";
import { assignmentBudgetForPrompt } from "../src/brains/assignment_budget_prompt.js";
import { assignmentWorkBudgetStatusV2 } from "../src/assignments/assignment_work_allowance_v2.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";

function status(missing = false) {
  const snapshot:any={spec:{requested_effect:"apply",work_plan_required:true,created_at:"2026-10-12T10:00:00Z",
    execution_policy:{mode:"local_advisory_v1",max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:1_200_000}},
    operations:{},observations:{},provider_calls:{call:{model:"gpt-6.1-sol",admitted_at:"2026-10-12T10:00:00Z",completed_at:"2026-10-12T10:01:00Z",
      ...(missing?{}:{usage:{input_tokens:100_000,cached_input_tokens:90_000,cache_write_input_tokens:0,output_tokens:100,total_tokens:100_100}})}}};
  return assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,"2026-10-12T10:02:00Z");
}

test("provider budget keeps exact meters and accounting coverage while removing repeated tables",()=>{
  const full=status(),before=JSON.stringify(full),compact=assignmentBudgetForPrompt(full);
  assert.deepEqual(compact.resources,full.resources);assert.deepEqual(compact.token_breakdown,full.token_breakdown);
  assert.equal(compact.cost_estimate.total_usd,full.cost_estimate.total_usd);
  assert.equal(compact.cost_estimate.status,full.cost_estimate.status);
  assert.deepEqual(compact.approaching_limits,full.approaching_limits);
  assert.equal(compact.checkpoint_recommended,full.checkpoint_recommended);
  assert.equal(compact.allocation.verified_distinct_changes,full.allocation.verified_distinct_changes);
  assert.equal(compact.allocation.progress_extension_enabled,full.allocation.progress_extension_enabled);
  assert.ok(full.cost_estimate.pricing_snapshot);assert.equal("pricing_snapshot" in compact.cost_estimate,false);
  assert.equal(JSON.stringify(full),before,"host accounting record must stay intact");
  assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(before)*.7);
});

test("provider budget keeps unavailable categories and checkpoint warnings",()=>{
  const full=status(true);full.checkpoint_recommended=true;full.approaching_limits=["total_tokens"];
  const compact=assignmentBudgetForPrompt(full);
  assert.equal(compact.token_breakdown.output_tokens,null);
  assert.equal(compact.cost_estimate.status,"unavailable");assert.equal(compact.cost_estimate.total_usd,null);
  assert.equal(compact.missing_usage_calls,1);assert.equal(compact.checkpoint_recommended,true);
  assert.deepEqual(compact.approaching_limits,["total_tokens"]);
});

test("work-plan tool keeps dependencies and unfinished claims with compact provider accounting",()=>{
  const payload={ok:true,work_plan:{items:[{item_id:"remove",depends_on:[]},{item_id:"rename",depends_on:["remove"]}]},
    checklist_claims:{remaining:["rename"]},budget_status:status()};const before=JSON.stringify(payload);
  const result=adaptMcpToolCallResultToDynamicResponse({content:[{type:"text",text:before}]},{tool:"operator_manage_work_plan"});
  assert.equal(result.success,true);assert.equal(result.contentItems[0].type,"inputText");
  const projected=JSON.parse((result.contentItems[0] as any).text);
  assert.deepEqual(projected.work_plan,payload.work_plan);assert.deepEqual(projected.checklist_claims,payload.checklist_claims);
  assert.deepEqual(projected.budget_status.resources,payload.budget_status.resources);
  assert.equal(projected.budget_status.cost_estimate.pricing_snapshot,undefined);
  assert.equal(JSON.stringify(payload),before);
  for(const text of ['{"ok":false,"error":"validation failed"}','unfamiliar result']){
    const failed=adaptMcpToolCallResultToDynamicResponse({isError:true,content:[{type:"text",text}]},{tool:"operator_manage_work_plan"});
    assert.equal((failed.contentItems[0] as any).text,text);assert.equal(failed.success,false);
  }
});
