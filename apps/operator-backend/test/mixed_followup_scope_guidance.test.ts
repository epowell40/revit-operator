import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {getOperatorAgentBaseInstructions} from '../src/brains/codex_brain_instructions.js';
import {getThinReferenceCodexProfile} from '../src/brains/codex_turn_profile.js';
import {TASK_DISCRETION_GUIDANCE} from '../src/brains/task_discretion_guidance.js';
import {hostInstructionBinding,assertHostInstructionBinding,CodexInstructionBindingError} from '../src/codex/instruction_binding.js';

// Retained465: "Record a concise follow-up ... do not add equipment or ductwork"
// became "First retain a ... checklist deferral", leaving a prose-only item
// pending after independently verified edits/save. Test delivered instructions,
// not a keyword-based router or a shortcut that marks that task complete.
test('written engineering-basis deliverable stays distinct from unfinished requested design in every helper profile',()=>{
 const guidance=TASK_DISCRETION_GUIDANCE;
 assert.match(guidance,/request is only to list missing inputs, write questions or record a follow-up/);
 assert.match(guidance,/do not turn the underlying unrequested design into an unfinished model-edit checklist item/);
 assert.match(guidance,/user actually requests design.*real unfinished scope.*deferral/);
 assert.match(guidance,/do not themselves verify an edit, supply a design decision or complete requested engineering work/);
 assert.match(guidance,/Do not remove existing items.*required-input\/unknown-effect stops/);
 for(const p of [{baseInstructions:getOperatorAgentBaseInstructions(),developerInstructions:''},getThinReferenceCodexProfile('mixed-followup'),getThinReferenceCodexProfile('mixed-followup',true)]){
  assert.equal(p.baseInstructions.split(guidance).length,2,'normal and advisory consumers must receive the shared strategy once');
  const wrong={...p,baseInstructions:p.baseInstructions.replace(guidance,'')};
  assert.throws(()=>assertHostInstructionBinding(hostInstructionBinding(wrong),hostInstructionBinding(p)),(e:unknown)=>e instanceof CodexInstructionBindingError&&e.providerDispatched===false);
 }
});

test('work-plan tool discovery explains model-edit scope without certifying a written question as native work',()=>{
 const candidates=[path.resolve(process.cwd(),'../mcp-server/src/server.ts'),path.resolve(process.cwd(),'apps/mcp-server/src/server.ts')];
 const file=candidates.find(p=>fs.existsSync(p));assert(file,'Use this composition actual MCP source');
 const source=fs.readFileSync(file,'utf8');
 const begin=source.indexOf('server.tool("operator_manage_work_plan", "');assert(begin>=0);
 const description=source.slice(begin,source.indexOf('\n',begin));
 assert.match(description,/native checklist tracks requested model edits and their dependent inspections/);
 assert.match(description,/written follow-up.*task result.*not.*model-edit item/);
 assert.match(description,/actual unfinished requested design.*defer/);
 assert.match(description,/Edit items require distinct independently verified native edits/);
 assert.match(description,/Existing items cannot be removed or overwritten/);
});
