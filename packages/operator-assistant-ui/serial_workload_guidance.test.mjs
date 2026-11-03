import assert from'node:assert/strict';import test from'node:test';import{singleExecutionInstructions}from'./desktop_native_tools.mjs';
test('one executor owns whole typical scope and uses compact inventory then bounded serial groups',()=>{
 const s=singleExecutionInstructions('Original requested work, Pause and native verification remain.','Native contracts.');
 assert.match(s,/compact inventory/i);assert.match(s,/one sheet|bounded group/i);assert.match(s,/same context/i);assert.match(s,/verify each/i);assert.match(s,/whole requested scope/i);assert.match(s,/do not request.*all.*sheet.*detail/i);assert.match(s,/Pause and native verification remain/);assert(!s.includes('delegate_revit_task'));
});
test('source reconstruction keeps device and branch coverage in the same owner without new mandatory previews or handoffs',()=>{
 const s=singleExecutionInstructions('Preserve Pause, unknown effects and the user scope.','Current native contracts.');
 assert.match(s,/compact source-to-model outline/i);
 assert.match(s,/devices.*branches.*connections/i);
 assert.match(s,/one connected system.*before starting/i);
 assert.match(s,/unfinished work alone is not a blocking decision/i);
 assert.match(s,/reuse.*tool schemas/i);
 assert.match(s,/actual source ambiguity.*technical limit.*user stop.*budget/i);
 assert(!s.includes('delegate_revit_task'));
 assert.match(s,/Preserve Pause, unknown effects and the user scope/);
});
