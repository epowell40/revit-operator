import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeReadEvidence} from './nativeReadEvidence.js';
const route='/revit/quantify';
const host=(matchedCount=0)=>({source:'host',projectUniqueId:'host-project',linkInstanceId:null,linkUniqueId:null,matchedCount,nestedLinkInstances:0});
const link=(matchedCount=0)=>({source:'link',projectUniqueId:'electrical-project',linkInstanceId:10,linkUniqueId:'link-10',matchedCount,nestedLinkInstances:0});
const body={scope:'both',intent:'count_and_list',categories:['OST_ElectricalEquipment']};
const payload=(total=0)=>({summary:{total},rows:[],warnings:[],sourceCoverage:{schema:'operator.quantify_source_coverage.v1',scope:'both',
  instanceScope:'direct_document_instances',familyDefinitionContentsInspected:false,complete:true,directLinkInstances:1,
  unavailableLinkInstances:0,nestedLinkInstances:0,matchedCount:total,documents:[host(),link(total)]}});
const facts=(b:any,p:any)=>nativeReadEvidence(route,b,p);
const completed=(b:any,p:any)=>facts(b,p).find(f=>f.fact_id==='collection.complete')?.value===true;

test('source-derived unavailable-link warning cannot prove zero/absence',()=>{
  assert.deepEqual(facts({...body,scope:'links'},{summary:{total:0},rows:[],warnings:["Link 'Electrical' is unloaded or not accessible."]}),[]);
  assert(!completed({...body,scope:'links'},{summary:{total:0},rows:[],warnings:[]}),'legacy linked count lacks coverage');
  assert(completed({}, {summary:{total:0},rows:[],warnings:[]}),'legacy host-only neighbor remains');
});
test('current native full-source zero and positive counts carry source-scoped count evidence',()=>{
  for(const n of [0,5]) {
    const f=facts(body,payload(n));assert(completed(body,payload(n)));
    assert.equal(f.find(x=>x.fact_id==='collection.total')?.value,n);
    assert.equal(f.find(x=>x.fact_id==='collection.total')?.dimensions?.instance_scope,'direct_document_instances');
    assert(!f.some(x=>/room|absence|design/.test(x.fact_id)));
  }
});
test('inaccessible and nested sources retain positive observation without completeness',()=>{
  for(const n of [0,5])for(const kind of ['unavailable','nested']) {
    const p=payload(n);p.sourceCoverage.complete=false;
    if(kind==='unavailable'){p.sourceCoverage.directLinkInstances=2;p.sourceCoverage.unavailableLinkInstances=1;}
    else {p.sourceCoverage.nestedLinkInstances=1;p.sourceCoverage.documents[1].nestedLinkInstances=1;}
    assert(!completed(body,p));assert.deepEqual(facts(body,p).map(x=>x.fact_id),n?['model.content_observed']:[]);
  }
});
test('malformed, conflicting and wrong-source coverage never establishes completeness',()=>{
  const variants:(()=>any)[]=[
    ()=>({...payload(),sourceCoverage:null}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,scope:'host'}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,matchedCount:1}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,directLinkInstances:2}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,documents:[host(),link(),link()]}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,documents:[host(),{...link(),projectUniqueId:''}]}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,documents:[host(),{...link(),matchedCount:1}]}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,documents:[host(),{...link(),nestedLinkInstances:1}]}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,familyDefinitionContentsInspected:true}}),
    ()=>({...payload(),sourceCoverage:{...payload().sourceCoverage,unavailableLinkInstances:1}}),
  ];
  for(const variant of variants)assert(!completed(body,variant()));
  assert(!completed({...body,scope:'host'},payload()));
});
test('query scopes separate filtered counts and source identities but ignore presentation grouping',()=>{
  const scope=(b:any,p:any=payload())=>facts(b,p).find(x=>x.fact_id==='collection.total')?.dimensions?.query_scope;
  assert(scope(body));assert.equal(scope(body),scope({...body,intent:'count',group_by:['Level'],room_resolution:true}));
  assert.notEqual(scope(body),scope({...body,filters:{keywords_include:['Transformer']}}));
  const p=payload();p.sourceCoverage.documents[1].projectUniqueId='different-source';
  assert.notEqual(scope(body),scope(body,p));
});
