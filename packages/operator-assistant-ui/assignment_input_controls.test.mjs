import assert from 'node:assert/strict';
import test from 'node:test';
import {assignmentInputMetadata,createAssignmentInputControl,assignmentInputErrorText} from './assignment_input_controls.mjs';
class Element {constructor(tag){this.tag=tag;this.children=[];this.value='';}appendChild(value){this.children.push(value);}setAttribute(name,value){this[name]=value;}}
const document={createElement:tag=>new Element(tag)};
test('canonical approval metadata produces an explicit unselected consent choice, never text coercion',()=>{
  const clause='Ask for my approval before deleting the selected objects.';
  const spec={interpreted_scope:{scope:{prerequisites:[{variable_id:'consent',kind:'approval',source_quote:clause}]}}};
  const metadata=assignmentInputMetadata(spec,'consent');assert.deepEqual(metadata,{input_kind:'approval',source_clause:clause});
  const control=createAssignmentInputControl(document,{...metadata,question:'May I delete the selected objects?'});
  assert.equal(control.input.tag,'select');assert.equal(control.input.value,'');assert.equal(control.sourceClause,clause);
  for(const value of ['', 'yes','true','false']){control.input.value=value;assert.throws(()=>control.value(),/choice_required/);}
  control.input.value='decline';assert.throws(()=>control.value(),/approval_declined/);
  control.input.value='approve';assert.equal(control.value(),true);assert.equal(typeof control.value(),'boolean');
});
test('information remains exact prose regardless of how or when the question is phrased',()=>{
  const exact='  Use a provisional device.\nKeep its service unresolved.\n';
  const metadata=assignmentInputMetadata({interpreted_scope:{scope:{prerequisites:[{variable_id:'shape',kind:'information'}]}}},'shape');
  const control=createAssignmentInputControl(document,{...metadata,question:'Before acting, how should I represent it?'});
  assert.equal(control.input.tag,'textarea');control.input.value=exact;assert.equal(control.value(),exact);
  assert.deepEqual(assignmentInputMetadata({},'legacy'),{input_kind:'information'});
});
test('approval mismatch has actionable UI text while the machine error stays intact',()=>{
  const error=Error('assignment_kernel_v2_approval_requires_explicit_true');
  assert.match(assignmentInputErrorText(error),/explicit approval choice/);assert.equal(error.message,'assignment_kernel_v2_approval_requires_explicit_true');
  assert.match(assignmentInputErrorText(Error('assignment_approval_declined')),/remains paused/);
});
