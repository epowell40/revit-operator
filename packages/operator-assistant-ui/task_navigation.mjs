export const TASK_NAVIGATION_SCHEMA = 'revit-operator.task-navigation/v1';
const states = new Set(['working','pausing','paused','needs_input','ready','complete','failed','unknown','loading']);
const text = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum;

/** Discovery is for navigation. Opening a row never executes or resumes work;
 * controls must subsequently load and authorize the canonical task binding. */
export function parseTaskNavigation(value) {
  if (!value || value.schema !== TASK_NAVIGATION_SCHEMA || !Array.isArray(value.tasks) || value.tasks.length > 200) throw Error('Task list is unavailable');
  const ids = new Set();
  return value.tasks.map(row => {
    if (!row || !text(row.task_id,240) || !text(row.session_id,240) || !text(row.title,180)
      || !states.has(row.state) || !Number.isFinite(Date.parse(row.updated_at)) || typeof row.summary !== 'string' || row.summary.length > 300
      || !(row.assignment_id === null || text(row.assignment_id,240)) || ids.has(row.task_id)) throw Error('Task list is unavailable');
    ids.add(row.task_id);
    return { task_id:row.task_id,session_id:row.session_id,title:row.title,state:row.state,
      updated_at:row.updated_at,summary:row.summary,assignment_id:row.assignment_id };
  });
}

export function groupTasks(tasks, selectedSessionId = '') {
  const groups = [{title:'Current task',items:[]},{title:'Working',items:[]},{title:'Needs you',items:[]},{title:'Recent',items:[]}];
  for (const task of tasks) {
    const group = selectedSessionId && task.session_id === selectedSessionId ? 0
      : ['working','pausing'].includes(task.state) ? 1 : ['paused','needs_input','ready','unknown','failed'].includes(task.state) ? 2 : 3;
    groups[group].items.push(task);
  }
  for (const group of groups) group.items.sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return groups.filter(group => group.items.length);
}

export function taskStateLabel(state) {
  return {working:'Working',pausing:'Pausing…',paused:'Paused',needs_input:'Needs your input',ready:'Ready to continue',
    complete:'Complete',failed:'Needs attention',unknown:'Result needs checking',loading:'Loading saved status…'}[state] || 'Status unavailable';
}

/** The opened task's validated publication is fresher than the discovery list.
 * This affects display only; controls still authorize the exact binding. */
export function currentTaskState(task, goal, sessionId) {
  if (!sessionId || goal?._sourceKind !== 'assignment_kernel_v2'
    || goal?._bindingV2?.session_id !== sessionId) return task?.state;
  if (goal._projection?.truth?.outcome_uncertain || goal._projection?.truth?.reconciliation_required) return 'unknown';
  const phase = goal._assignmentPhase;
  if (['complete','complete_with_issues','verified_noop'].includes(phase)) return 'complete';
  if (['paused','pausing'].includes(phase)) return phase;
  if (['awaiting_user_input','awaiting_user_review'].includes(phase)) return 'needs_input';
  if (['failed','blocked'].includes(phase)) return 'failed';
  if (phase === 'active' && task?.assignment_id === goal._bindingV2.assignment_id && task?.state === 'paused')
    return goal._canResume ? 'ready' : 'working';
  return task?.state;
}

/** Resolve the exact task selected in history, independent of recent-page
 * limits. The host projector must validate the complete canonical publication;
 * discovery IDs alone never confer control authority. */
export async function readNavigationAssignment(readJson, projectPublication, sessionId, assignmentId) {
  if (!text(sessionId,240) || !text(assignmentId,240)) throw Error('A saved task and conversation are required.');
  const raw = await readJson('/api/assignments/v2/' + encodeURIComponent(assignmentId), { method: 'GET' });
  const view = projectPublication(raw?.assignment_kernel_v2);
  if (view?._sourceKind !== 'assignment_kernel_v2' || !Number.isSafeInteger(view._assignmentVersion) || view._assignmentVersion < 1
    || view._bindingV2?.session_id !== sessionId || view._bindingV2?.assignment_id !== assignmentId
    || view.related_session_id !== sessionId) throw Error('The saved task does not match this conversation.');
  return view;
}

/** IDs can contain underscores/colons. Hash the exact tuple rather than
 * concatenating or truncating IDs into colliding local recovery keys. */
export async function taskDraftKey(tabId, sessionId, crypto = globalThis.crypto) {
  if (!text(tabId,240) || typeof sessionId !== 'string' || sessionId.length > 240) throw Error('Draft recovery key is unavailable');
  const bytes = new TextEncoder().encode(JSON.stringify([tabId,sessionId]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return 'task-' + [...digest].map(value => value.toString(16).padStart(2,'0')).join('');
}

export function renderTaskList(container, tasks, selectedSessionId, onOpen) {
  const document = container.ownerDocument;
  container.replaceChildren();
  if (!tasks.length) {const empty=document.createElement('p');empty.className='taskListEmpty';empty.textContent='Your tasks will appear here.';container.append(empty);return;}
  for (const group of groupTasks(tasks, selectedSessionId)) {
    const section=document.createElement('section'), heading=document.createElement('h3');
    heading.textContent=group.title;section.append(heading);
    for(const task of group.items) {
      const button=document.createElement('button');button.type='button';button.className='taskListRow';
      if(task.session_id===selectedSessionId)button.setAttribute('aria-current','page');
      const title=document.createElement('span');title.className='taskListTitle';title.textContent=task.title;title.title=task.title;
      const status=document.createElement('span');status.className='taskListStatus';status.textContent=taskStateLabel(task.state);
      button.append(title,status);button.addEventListener('click',()=>onOpen(task));section.append(button);
    }
    container.append(section);
  }
}
