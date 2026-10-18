import assert from 'node:assert/strict';
import test from 'node:test';
import {currentTaskState, taskStateLabel, parseTaskNavigation, groupTasks} from './task_navigation.mjs';

const binding={session_id:'conversation',assignment_id:'retained-work',run_id:'original-run',generation:1};
const goal=phase=>({_sourceKind:'assignment_kernel_v2',_bindingV2:binding,_assignmentPhase:phase,_canResume:false,_projection:{truth:{}}});
const task={task_id:'session:conversation',session_id:binding.session_id,assignment_id:binding.assignment_id,
  title:'Update and inspect the schedule',state:'needs_input',summary:'Retained work',updated_at:'2026-10-17T20:00:00Z'};

test('a canonical review replaces a stale input label without declaring completion or enabling controls',()=>{
  const review=goal('awaiting_user_review'),before=structuredClone(review);
  const state=currentTaskState(task,review,binding.session_id);
  assert.equal(state,'needs_review');assert.equal(taskStateLabel(state),'Ready for review');
  assert.equal(currentTaskState(task,goal('awaiting_user_input'),binding.session_id),'needs_input');
  assert.equal(taskStateLabel('needs_input'),'Needs your input');assert.deepEqual(review,before);
});

test('unknown results, explicit Pause and usage holds retain their existing presentation',()=>{
  const review=goal('awaiting_user_review');review._projection.truth.outcome_uncertain=true;
  assert.equal(currentTaskState(task,review,binding.session_id),'unknown');
  for(const phase of ['paused','pausing','waiting_for_usage','stopping_after_usage_limit'])
    assert.equal(currentTaskState(task,goal(phase),binding.session_id),phase);
  assert.equal(currentTaskState(task,goal('awaiting_user_review'),'foreign-conversation'),'needs_input');
});

test('validated task discovery accepts a review row and keeps it visible with other saved work',()=>{
  const row={...task,state:'needs_review'};
  const tasks=parseTaskNavigation({schema:'revit-operator.task-navigation/v1',tasks:[row]});
  assert.equal(tasks[0].state,'needs_review');
  assert.equal(groupTasks(tasks)[0].title,'Needs you');
  assert.equal(groupTasks(tasks,binding.session_id)[0].title,'Current task');
  assert.throws(()=>parseTaskNavigation({schema:'revit-operator.task-navigation/v1',tasks:[{...row,state:'invented'}]}));
});
