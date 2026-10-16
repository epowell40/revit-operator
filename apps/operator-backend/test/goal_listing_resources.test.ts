import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createGoal, getGoalStoragePath, listGoalCandidatesForSessions, listGoals, listGoalsForSession,
  getActiveGoalForSession, __testOnlyResetGoalListCache } from "../src/goals/service.js";

function workspace(fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-goal-list-resources-")), previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root; __testOnlyResetGoalListCache();
  try { fn(root); } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function seed(session = "one-session") {
  return createGoal({title:"Review actual circuit",objective:"Inspect equipment and verify the circuit.",
    acceptance_criteria:["Native result checked"],status:"active",related_session_id:session});
}

test("navigation discovery omits full histories while selected records remain complete and fresh", () => workspace(() => {
  const goal = seed(), file = getGoalStoragePath(goal.id)!;
  const record = JSON.parse(fs.readFileSync(file,"utf8"));
  record.action_log = [{id:"retained-native-change",note:"KEEP THIS HISTORY"}];
  record.progress_summary = "Fresh persisted result";
  fs.writeFileSync(file,JSON.stringify(record)); __testOnlyResetGoalListCache();
  const candidates = listGoalCandidatesForSessions(id => id === "one-session");
  assert.equal(candidates.length,1);
  assert.deepEqual(Object.keys(candidates[0]!).sort(),["id","related_session_id","updated_at"]);
  assert.deepEqual(listGoals(1)[0]!.action_log,record.action_log);
  assert.equal(listGoalsForSession("one-session")[0]!.progress_summary,"Fresh persisted result");
  assert.equal(getActiveGoalForSession("one-session")!.id,goal.id);
  record.progress_summary = "Changed without rebuilding the discovery list";
  fs.writeFileSync(file,JSON.stringify(record));
  assert.equal(listGoals(1)[0]!.progress_summary,record.progress_summary);
  assert.equal(listGoalsForSession("foreign-session").length,0);
}));

for (const updateListed of [false,true]) test(`one-record listing stays within a bounded heap despite large retained histories; updates=${updateListed}`, () => workspace(root => {
  const first = seed(), firstPath = getGoalStoragePath(first.id)!, template = JSON.parse(fs.readFileSync(firstPath,"utf8"));
  // A small result window must not keep all unrelated 2 MiB histories alive.
  // The child limit tests resource behavior without flaky RSS/timing assertions.
  const ids:string[] = [], payload = "retained-history-".padEnd(2*1024*1024,"x");
  for (let i=0;i<80;i++) {
    const id=`large-history-${i.toString().padStart(3,"0")}`, folder=path.join(path.dirname(path.dirname(firstPath)),id);
    fs.mkdirSync(folder);ids.push(id);
    fs.writeFileSync(path.join(folder,"goal.json"),JSON.stringify({...template,id,related_session_id:`session-${i}`,
      updated_at:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),retained_history_payload:payload}));
  }
  const module=pathToFileURL(path.resolve("dist/src/goals/service.js")).href;
  const child=spawnSync(process.execPath,["--max-old-space-size=128","--expose-gc","--input-type=module","-e",
    `const m=await import(${JSON.stringify(module)}); const first=m.listGoals(1); if(first.length!==1)throw Error('window');
     if(${updateListed})for(const id of ${JSON.stringify(ids)})m.updateGoal(id,{progress_summary:'retained update'});
     globalThis.gc();const actual=m.listGoalsForSession('session-79');if(actual.length!==1||actual[0].retained_history_payload.length!==2097152)throw Error('lost history');
     console.log(JSON.stringify({ok:true,window:first.length,selected:actual.length}));`],
    {env:{...process.env,OPERATOR_WORKSPACE_ROOT:root,OPERATOR_BRAIN:"rule",OPERATOR_ASSIGNMENT_KERNEL_V2:"0"},encoding:"utf8",timeout:30000,maxBuffer:128*1024});
  assert.equal(child.status,0,`bounded listing child failed: ${child.error?.message??child.signal??""}\n${child.stderr.slice(-1200)}`);
  assert.equal(JSON.parse(child.stdout.trim()).ok,true);
}));
