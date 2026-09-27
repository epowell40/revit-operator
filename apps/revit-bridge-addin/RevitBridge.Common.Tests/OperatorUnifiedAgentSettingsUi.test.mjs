import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Execute the actual embedded UI preference code, without starting Revit/WebView.
const source = readFileSync(new URL('../RevitBridge/Operator/OperatorWebUiHtml.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const select = source.match(/<select id=""agentModel""[^>]*>([\s\S]*?)<\/select>/)[1];
const options = [...select.matchAll(/value=""([^"\n]+)""/g)].map(match => match[1]);
function between(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0 && source.indexOf(end, offset) > offset);
  return source.slice(offset, source.indexOf(end, offset));
}
function boot(storage) {
  const agentModelEl = { current: '', get value() { return this.current; },
    set value(value) { this.current = options.includes(value) ? value : ''; },
    addEventListener(_event, handler) { this.change = handler; } };
  const control = () => ({ value: '', checked: false, addEventListener() {} });
  const context = { agentModelEl, reasoningSel: control(), speedModeEl: control(), speedDietEl: control(), post() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  const settings = runInNewContext(between('      function readBoolPref(', '      function setRunStatus(')
    + between('      if (reasoningSel) {\n        try { reasoningSel.value', "      sendBtn.addEventListener('click'")
    + '; getSpeedSettings', context);
  return { model: agentModelEl, settings };
}

test('native Settings preserves each offered model through change, reload, and the unified request payload', () => {
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const storage = new Map([['op.speedDefaultsVersion', 'unified-agent-56-v3'], ['op.reasoningEffort', 'high'], ['op.speedMode', '0'], ['op.speedDiet', '0']]);
    const page = boot(storage);
    page.model.value = model;
    assert.equal(page.model.value, model, 'model must be an actual selectable option');
    page.model.change();
    assert.equal(storage.get('op.agentModel'), model);
    const reloaded = boot(storage);
    assert.equal(reloaded.model.value, model);
    const payload = reloaded.settings();
    for (const key of ['agent_model', 'planner_model', 'executor_model']) assert.equal(payload[key], model, key);
    assert.equal(payload.agent_reasoning_effort, 'high');
    assert.equal(payload.speed_mode, false);
    assert.equal(payload.context_diet, false);
    assert.equal(payload.split_planner_executor, false);
  }
});

test('native Settings keeps Sol as the default and rejects unknown stored or selected models', () => {
  assert.match(select, /value=""gpt-5\.6-sol"" selected/);
  assert.equal([...select.matchAll(/\bselected\b/g)].length, 1);
  const fresh = boot(new Map());
  assert.equal(fresh.settings().agent_model, 'gpt-5.6-sol');
  assert.equal(fresh.settings().agent_reasoning_effort, 'medium');
  const storage = new Map([['op.speedDefaultsVersion', 'unified-agent-56-v3'], ['op.agentModel', 'unknown-model']]);
  const page = boot(storage);
  assert.equal(page.model.value, 'gpt-5.6-sol');
  assert.equal(page.settings().agent_model, 'gpt-5.6-sol');
  page.model.value = 'unknown-model';
  page.model.change();
  assert.equal(storage.get('op.agentModel'), 'gpt-5.6-sol');
});
