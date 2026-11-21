import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeAgentModel, isOptionalProviderModel } from '../public/agent_model_catalog.mjs';
const browser=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function source(text,name){const start=text.indexOf(`function ${name}(`);assert(start>=0,name);return text.slice(start,text.indexOf('\n}\n',start)+2);}
function page(saved={}) {
 const values=new Map(Object.entries(saved));
 const elements={agentModel:{value:'gpt-5.6-sol',options:[]},agentReasoning:{value:'medium'},inputBadge:{},computerBadge:{},shellBadge:{}};
 const context={elements,state:{},Set,isOptionalProviderModel,normalizeSpeedModel:normalizeAgentModel,
   normalizeReasoningEffort:(v,f)=>['none','low','medium','high','xhigh','max'].includes(v)?v:f,
   readStringSetting:(k,f)=>values.get(k)||f,synchronizeModelReasoning(){},
   renderRuntimeProfile(){},renderNextCertifiedReadUi(){},nextCertifiedReadUiFixture(){},updateAuthBadge(){},renderEnvironmentProfile(){}};
 const helper=browser.includes('function applyRuntimeSpeedDefaults(')?source(browser,'applyRuntimeSpeedDefaults'):'';
 const apply=vm.runInNewContext(helper+'\n'+source(browser,'applySidecarConfig')+'\napplySidecarConfig',context);
 return {elements,apply,values};
}
test('new browser uses configured runtime model instead of overriding it with legacy HTML default',()=>{
 const p=page();p.apply({backendConfigStatus:'ready',speedDefaults:{agent_model:'gpt-6.1-terra',agent_reasoning_effort:'high'}});
 assert.equal(p.elements.agentModel.value,'gpt-6.1-terra');assert.equal(p.elements.agentReasoning.value,'high');
 assert.equal(p.values.size,0,'defaults are not an explicit user preference');
});
test('runtime defaults preserve explicit browser choices and ignore unavailable or invalid config',()=>{
 const p=page({'operator.agentModel':'gpt-6.1-sol','operator.agentReasoning':'low'});
 p.elements.agentModel.value='gpt-6.1-sol';p.elements.agentReasoning.value='low';
 p.apply({backendConfigStatus:'ready',speedDefaults:{agent_model:'gpt-6.1-terra',agent_reasoning_effort:'high'}});
 assert.equal(p.elements.agentModel.value,'gpt-6.1-sol');assert.equal(p.elements.agentReasoning.value,'low');
 for(const config of [{backendConfigStatus:'unavailable',speedDefaults:{agent_model:'gpt-6.1-terra'}},{backendConfigStatus:'ready',speedDefaults:{agent_model:'unknown'}}]){
  const fresh=page();fresh.apply(config);assert.equal(fresh.elements.agentModel.value,'gpt-5.6-sol');
 }
});
test('config producer exposes runtime defaults through existing config contract',()=>{
 const fn=source(server,'defaultComputerSpeedSettings');
 const settings=vm.runInNewContext(fn+'\ndefaultComputerSpeedSettings()',{
  COMPUTER_MODEL:'gpt-6.1-terra',COMPUTER_REASONING_EFFORT:'medium',sanitizeSpeedModel:normalizeAgentModel
 });
 assert.equal(settings.agent_model,'gpt-6.1-terra');assert.equal(settings.agent_reasoning_effort,'medium');
 assert.match(server,/speedDefaults:\s*defaultComputerSpeedSettings\(\)/);
 const p=page();p.apply({backendConfigStatus:'ready',speedDefaults:settings});
 assert.equal(p.elements.agentModel.value,settings.agent_model);
});
