import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";

type Fact = { fact_id: string; fact_class: "domain"; value: string | number | boolean; dimensions?: Record<string,string> };
const object = (value:unknown):Record<string,any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,any> : {};
const text = (value:unknown) => typeof value === "string" ? value.trim() : "";
const count = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value)>=0;
const fact = (id:string,value:Fact["value"],route:string):Fact => ({fact_id:id,fact_class:"domain",value,dimensions:{route}});

// Match the native ViewOwnedDetailingInventoryContract, not a caller-provided
// exclusion flag: infrastructure remains inventoried but has no copy signature.
function detailingInfrastructure(item:Record<string,any>):boolean {
  return item.isAnnotation===false && (item.className==="SketchPlane"
    || item.className==="SunAndShadowSettings"
    || item.className==="Element" && item.name==="ExtentElem"
    || item.builtInCategory==="OST_SunStudy");
}

/** Counts compare only within an effective query. Never use result values or
 * operation IDs: either would hide genuinely conflicting repeated reads.
 * Project FindElementsHandler.Params filters, excluding ignored JSON fields
 * and presentation limits. Update this projection with new native filters. */
function elementQueryScope(body:Record<string,any>):string {
  const scope:Record<string,unknown>={};
  const terms=(values:unknown[],max=Infinity)=>[...new Set(values.map(value=>text(value).toLowerCase()).filter(Boolean))].slice(0,max).sort();
  scope.categories=terms([body.category,...(Array.isArray(body.categories)?body.categories:[])]);
  scope.identityTerms=terms(Array.isArray(body.identityTerms)?body.identityTerms:[],8);
  for(const key of ['nameContains','typeNameContains','familyNameContains','markContains','textContains'])scope[key]=text(body[key]).toLowerCase();
  for(const key of ['physicalElementsOnly','topLevelInstancesOnly','expandIdentityAcronymsInParameters'])scope[key]=body[key]===true;
  scope.viewId=Number.isSafeInteger(body.viewId)&&body.viewId>0?body.viewId:null;
  scope.sheetNumber=scope.viewId===null?text(body.sheetNumber).toLowerCase():'';
  if(scope.sheetNumber){
    scope.includeSheetElements=body.includeSheetElements===true;
    scope.includeViewportElements=body.includeViewportElements!==false;
    scope.sheetRegions=Array.isArray(body.sheetRegions)?body.sheetRegions.map(value=>{
      const region=object(value);
      return {minU:Math.min(region.minU,region.maxU),minV:Math.min(region.minV,region.maxV),
        maxU:Math.max(region.minU,region.maxU),maxV:Math.max(region.minV,region.maxV)};
    }).sort((a,b)=>a.minU-b.minU||a.minV-b.minV||a.maxU-b.maxU||a.maxV-b.maxV):[];
    scope.regionPaddingFt=typeof body.regionPaddingFt==='number'?Math.max(0,Math.min(2,body.regionPaddingFt)):0;
  }
  return payloadDigestV2({schema:'revit-operator.find-elements-query-scope/v1',query:scope}).digest;
}

function consistentCount(root:Record<string,any>,names:string[]):number|null {
  const values=names.filter(name=>Object.hasOwn(root,name)).map(name=>root[name]);
  return values.length>0 && values.every(value=>count(value)&&value===values[0]) ? values[0] : null;
}

function quantifyCoverageComplete(body:Record<string,any>,root:Record<string,any>,total:number):boolean {
  const scope=text(body.scope).toLowerCase() || 'host';
  if(!['host','links','both'].includes(scope))return false;
  if(!Object.hasOwn(root,'sourceCoverage')) {
    // Legacy host-only counts remain usable. Old linked responses cannot prove
    // which sources were skipped, even when no warning happened to be returned.
    return scope==='host' && (root.warnings===undefined || Array.isArray(root.warnings)&&root.warnings.length===0);
  }
  const c=object(root.sourceCoverage);
  if(c.schema!=='operator.quantify_source_coverage.v1' || c.scope!==scope
    || c.instanceScope!=='direct_document_instances' || c.familyDefinitionContentsInspected!==false
    || c.complete!==true || !count(c.directLinkInstances) || c.unavailableLinkInstances!==0
    || c.nestedLinkInstances!==0 || c.matchedCount!==total || !Array.isArray(c.documents))return false;
  const documents=c.documents.map(object),host=documents.filter((x:Record<string,any>)=>x.source==='host'),links=documents.filter((x:Record<string,any>)=>x.source==='link');
  if(host.length+links.length!==documents.length || host.length!==(scope==='links'?0:1)
    || links.length!==c.directLinkInstances || scope==='host'&&links.length!==0
    || documents.some((x:Record<string,any>)=>!text(x.projectUniqueId)||!count(x.matchedCount)||x.nestedLinkInstances!==0)
    || host.some((x:Record<string,any>)=>x.linkInstanceId!=null||x.linkUniqueId!=null)
    || links.some((x:Record<string,any>)=>!Number.isSafeInteger(x.linkInstanceId)||x.linkInstanceId<=0||!text(x.linkUniqueId))
    || new Set(links.map((x:Record<string,any>)=>x.linkInstanceId)).size!==links.length
    || new Set(links.map((x:Record<string,any>)=>x.linkUniqueId)).size!==links.length)return false;
  return documents.reduce((n:number,x:Record<string,any>)=>n+x.matchedCount,0)===total;
}

function quantifyQueryScope(body:Record<string,any>,root:Record<string,any>):string {
  // Include source and filter identity; never compare a host count with a link
  // count or a filtered subset merely because they share the same fact name.
  const filters=object(body.filters),terms=(x:unknown)=>Array.isArray(x)?x.map(text).filter(Boolean).sort():[];
  return payloadDigestV2({schema:'operator.quantify_query_scope.v1',scope:text(body.scope).toLowerCase()||'host',
    categories:terms(body.categories),filters:{level:text(filters.level),keywords_include:terms(filters.keywords_include),
      keywords_exclude:terms(filters.keywords_exclude),parameters:Array.isArray(filters.parameters)?filters.parameters.map((v:unknown)=>{
        const p=object(v);return {param:text(p.param),value:text(p.value),op:text(p.op).toLowerCase()||'contains'};
      }).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):[]},
    sources:Array.isArray(object(root.sourceCoverage).documents)?object(root.sourceCoverage).documents.map((v:unknown)=>{
      const s=object(v);return {source:s.source,projectUniqueId:s.projectUniqueId,linkInstanceId:s.linkInstanceId??null,linkUniqueId:s.linkUniqueId??null};
    }).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):null}).digest;
}

// The native read graph already attests Element receivers. Reuse that contract
// rather than treating arbitrary API return values or document labels as proof.
// This establishes observation only, never inventory completeness or correctness.
function graphObservedElement(body:Record<string,any>,root:Record<string,any>):boolean {
  const steps=body.operations,receipts=root.operations;
  if(root.version!=="operator.native_api_ops.v2" || root.ok!==true || root.read_only!==true
    || root.ephemeral_handles!==true || !Array.isArray(steps) || !steps.length
    || !Array.isArray(receipts) || root.operation_count!==steps.length || receipts.length!==steps.length
    || !Array.isArray(root.geometry_cleanup_errors) || root.geometry_cleanup_errors.length
    || root.source?.scope==="external_file" || !root.results || typeof root.results!=="object" || Array.isArray(root.results))return false;
  const names=steps.map(value=>text(object(value).id));
  if(names.some(name=>!name) || new Set(names.map(name=>name.toLowerCase())).size!==names.length)return false;
  const returned=Array.isArray(body.returns)&&body.returns.length
    ? [...new Set(body.returns.map((value:unknown)=>text(value).replace(/^\$+/,"").toLowerCase()).filter(Boolean))]
    : [names[names.length-1]!.toLowerCase()];
  const resultNames=Object.keys(root.results).map(name=>name.toLowerCase());
  if(!returned.length || returned.some(name=>!names.some(id=>id.toLowerCase()===name))
    || resultNames.length!==returned.length || new Set(resultNames).size!==resultNames.length
    || resultNames.some(name=>!returned.includes(name)))return false;
  const preceding=(reference:string,before:number):number=>{
    const index=names.findIndex(name=>name.toLowerCase()===reference.toLowerCase());
    return index>=0&&index<before?index:-1;
  };
  const collectorType="Autodesk.Revit.DB.FilteredElementCollector";
  const currentCollector=(index:number):boolean=>{
    if(index<0)return false;
    const step=object(steps[index]),receipt=object(receipts[index]);
    if(object(receipt.result_preview).type!==collectorType)return false;
    if(text(step.op).toLowerCase()==="construct"
      && text(step.memberId)===`ctor:${collectorType}(Autodesk.Revit.DB.Document)`
      && Array.isArray(step.args)&&step.args.length===1){
      const documentIndex=preceding(text(object(step.args[0]).$ref),index);
      if(documentIndex<0)return false;
      const document=object(steps[documentIndex]),native=object(receipts[documentIndex]);
      return text(document.op).toLowerCase()==="get_property"&&text(document.target)==="uidoc"
        && text(document.property)==="Document"&&native.target_type==="Autodesk.Revit.UI.UIDocument";
    }
    const target=text(step.target);
    // Native collector-returning filters retain their source document. An
    // arbitrary constructed object or foreign document is not a model read.
    return text(step.op).toLowerCase()==="call"&&target.startsWith("$")
      && text(step.memberId).startsWith(`method:${collectorType}.`)
      && receipt.target_type===collectorType&&currentCollector(preceding(target.slice(1),index));
  };
  let observed=false;
  for(let index=0;index<steps.length;index++){
    const step=object(steps[index]),receipt=object(receipts[index]),op=text(step.op).toLowerCase();
    if(receipt.id!==names[index] || receipt.op!==op || !["call","construct","get_property"].includes(op)
      || (op==="get_property" ? receipt.property!==text(step.property) || receipt.member_id!==null
        : receipt.member_id!==text(step.memberId) || receipt.property!==null))return false;
    if(receipt.target_identity==null)continue;
    const receiver=object(receipt.target_identity);
    if(receiver.schema!=="operator.native_element_receiver.v1" || receiver.active_document!==true
      || !Number.isSafeInteger(receiver.element_id) || receiver.element_id<=0 || !text(receiver.unique_id)
      || !text(receiver.type_name).startsWith("Autodesk.Revit.DB.") || receiver.type_name!==receipt.target_type)return false;
    const target=text(step.target),parentIndex=target.startsWith("$")
      ? names.findIndex(name=>name.toLowerCase()===target.slice(1).toLowerCase()) : -1;
    if(parentIndex<0 || parentIndex>=index)continue;
    const parent=object(steps[parentIndex]),preview=object(object(receipts[parentIndex]).result_preview);
    const literalElement=text(parent.op).toLowerCase()==="call" && text(parent.target)==="doc"
      && text(parent.memberId)==="method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)"
      && Array.isArray(parent.args) && parent.args.length===1 && parent.args[0]===receiver.element_id;
    const collectorTarget=text(parent.target);
    const collectedElement=text(parent.op).toLowerCase()==="call"
      && text(parent.memberId)===`method:${collectorType}.FirstElement()`
      && Array.isArray(parent.args)&&parent.args.length===0&&collectorTarget.startsWith("$")
      && object(receipts[parentIndex]).target_type===collectorType
      && currentCollector(preceding(collectorTarget.slice(1),parentIndex));
    if((literalElement||collectedElement)&&preview.id===receiver.element_id&&preview.unique_id===receiver.unique_id)observed=true;
  }
  return observed;
}

/** Evidence from known native read contracts, never from metadata labels or
 * model-authored prose. The caller must already establish dispatched, successful,
 * task-eligible read authority and retain/hash the exact native payload. */
export function nativeReadEvidence(path:string,requestBody:unknown,payload:unknown):Fact[] {
  const root=object(payload),body=object(requestBody);
  const content=()=>[fact("model.content_observed",true,path)];
  if(path==="/revit/native-api-ops")return graphObservedElement(body,root)?content():[];
  const complete=(total:number,mode:"count"|"list"):Fact[]=>[
    fact("collection.complete",true,path),fact("collection.total",total,path),fact("collection.mode",mode,path)
  ].map(value=>path==='/revit/find-elements'
    ? {...value,dimensions:{...value.dimensions,query_scope:elementQueryScope(body)}} : value);
  if(path==="/revit/sheets") {
    const requestedAction=text(body.action).toLowerCase() || "list";
    const action=requestedAction==="detail"?"detail":body.countOnly===true?"count":requestedAction;
    if(!["list","count"].includes(action) || root.action!==action || root.countOnly!==(action==="count"))return [];
    const query=text(body.query);
    const prefix=text(body.sheetNumberPrefix) || (query.endsWith("*")?query.replace(/\*+$/g,"").trim():"");
    if(text(root.query)!==query || text(root.sheetNumberPrefix)!==prefix || root.exact!==(body.exact===true))return [];
    const total=consistentCount(root,["totalMatches","total"]);
    if(total===null || !count(root.totalSheets) || total>root.totalSheets || !Array.isArray(root.items)
      || !count(root.returned) || root.returned!==root.items.length || !count(root.offset)
      || typeof root.hasMore!=="boolean")return [];
    const paging=object(root.paging);
    if(Object.keys(paging).length && ["offset","returned","hasMore","nextOffset"].some(key=>paging[key]!==root[key]))return [];
    if(action==="count")return root.offset===0 && root.returned===0 && root.hasMore===false && root.nextOffset===null
      ? complete(total,"count") : [];
    const ids=root.items.map((item:unknown)=>object(item).id);
    if(ids.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0) || new Set(ids).size!==ids.length
      || root.returned>total || root.offset+root.returned>total
      || root.hasMore!==(root.offset+root.returned<total))return [];
    return root.offset===0 && !root.hasMore && root.nextOffset===null && root.returned===total
      ? complete(total,"list") : [];
  }
  if(path==="/revit/quantify") {
    const keys=["total","total_count","totalCount","count"];
    const direct=consistentCount(root,keys);
    const summaryRoot=object(root.summary),summary=consistentCount(summaryRoot,keys);
    if((keys.some(key=>Object.hasOwn(root,key))&&direct===null) || (keys.some(key=>Object.hasOwn(summaryRoot,key))&&summary===null))return [];
    const total=direct??summary;
    if(total===null || (direct!==null&&summary!==null&&direct!==summary))return [];
    // Native instance counts are not family-definition or room-absence proof.
    // Missing or uninspected linked sources cannot become collection.complete.
    if(!quantifyCoverageComplete(body,root,total))return total>0?content():[];
    return [...content(),...complete(total,"count").map(value=>({...value,dimensions:{...value.dimensions,
      query_scope:quantifyQueryScope(body,root),instance_scope:'direct_document_instances'}}))];
  }
  if(path==="/revit/find-elements") {
    if(root.status!=="Ok" || !Array.isArray(root.elementIds) || !Array.isArray(root.items) || !count(root.count)
      || root.count!==root.elementIds.length || new Set(root.elementIds).size!==root.count
      || root.elementIds.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0))return [];
    if(root.itemsComplete===true && root.truncated===false && root.scanCapReached===false && root.identityExpansionScanCapReached===false)
      return [...content(),...complete(root.count,"list")];
    return root.count>0 ? content() : [];
  }
  if(path==="/revit/view-owned-detailing") {
    const requested=Array.isArray(body.viewIds)?body.viewIds:(body.viewId===undefined?[]:[body.viewId]);
    if(root.schema!=="revit-operator.view-owned-detailing/v1" || root.scope!=="exact_owner_view"
      || body.viewId!==undefined && body.viewIds!==undefined
      || requested.length<1 || requested.length>2 || requested.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0)
      || new Set(requested).size!==requested.length || !Array.isArray(root.requestedViewIds)
      || JSON.stringify(root.requestedViewIds)!==JSON.stringify(requested)
      || !Array.isArray(root.views) || root.views.length!==requested.length
      || typeof root.viewsComplete!=="boolean")return [];
    let total=0,hasContent=false,allComplete=true;
    for(let index=0;index<requested.length;index++){
      const inventory=object(root.views[index]),view=object(inventory.view),items=inventory.items;
      if(view.id!==requested[index] || !text(view.uniqueId) || !text(view.name) || !text(view.viewType)
        || !Array.isArray(items) || !Number.isSafeInteger(inventory.limit) || inventory.limit<1
        || inventory.limit>5000 || !count(inventory.totalOwnedCount) || !count(inventory.annotationCount)
        || !count(inventory.returnedCount) || inventory.returnedCount!==items.length
        || inventory.returnedCount>inventory.limit
        || inventory.annotationCount>inventory.totalOwnedCount || inventory.returnedCount>inventory.totalOwnedCount
        || !count(inventory.unreadableCount) || !count(inventory.unclassifiedCount)
        || !count(inventory.incompleteTextCount) || !count(inventory.incompleteSignatureCount)
        || typeof inventory.truncated!=="boolean"
        || typeof inventory.itemsComplete!=="boolean"
        || inventory.unreadableCount+inventory.returnedCount>inventory.totalOwnedCount
        || items.some((item:unknown)=>{const row=object(item);return !Number.isSafeInteger(row.elementId)
          || row.elementId<=0 || row.ownerViewId!==view.id || !text(row.uniqueId)
          || !text(row.className) || typeof row.isAnnotation!=="boolean"
          || typeof row.semanticSignatureComplete!=="boolean"
          || (row.comparisonExcluded===true)!==detailingInfrastructure(row)
          || detailingInfrastructure(row) && (row.semanticSignatureComplete!==false || row.semanticSignature!==null)
          || row.semanticSignatureComplete && !/^sha256:[a-f0-9]{64}$/.test(text(row.semanticSignature));})
        || new Set(items.map((item:unknown)=>object(item).elementId)).size!==items.length)return [];
      total+=inventory.totalOwnedCount;
      hasContent ||=inventory.returnedCount>0;
      allComplete &&=inventory.itemsComplete===true && inventory.truncated===false
        && inventory.unreadableCount===0 && inventory.unclassifiedCount===0
        && inventory.incompleteTextCount===0 && inventory.incompleteSignatureCount===0
        && inventory.returnedCount===inventory.totalOwnedCount
        && items.every((item:unknown)=>detailingInfrastructure(object(item)) || object(item).semanticSignatureComplete===true)
        && inventory.annotationCount===items.filter((item:unknown)=>object(item).isAnnotation===true).length;
    }
    if(root.viewsComplete!==allComplete)return [];
    return allComplete?[...content(),...complete(total,"list")]:hasContent?content():[];
  }
  // A targeted native object read can answer its attributes without a second
  // inventory request. These receipts establish observation, never enumeration
  // completeness, connectivity correctness or the truth of a prose conclusion.
  if(path==="/revit/get-parameters") {
    return Number.isSafeInteger(body.elementId) && body.elementId>0 && root.id===body.elementId
      && text(root.category) && root.parameters!==null && typeof root.parameters==="object"
      && !Array.isArray(root.parameters) && Object.values(root.parameters).every(value=>typeof value==="string")
      ? content() : [];
  }
  if(path==="/revit/get-element-summary" && Array.isArray(payload)) {
    const requested=body.elementIds??body.ids;
    if(!Array.isArray(requested) || !requested.length || requested.some(id=>!Number.isSafeInteger(id)||id<=0)
      || payload.some(row=>!requested.includes(object(row).id)))return [];
    return payload.some(row=>object(row).found===true && text(object(row).category)
      && (object(row).location || object(row).boundingBox)) ? content() : [];
  }
  if(path==="/revit/get-connectors" && root.status==="Ok" && Array.isArray(root.results)) {
    if(!Array.isArray(body.elementIds) || !body.elementIds.length
      || body.elementIds.some(id=>!Number.isSafeInteger(id)||id<=0)
      || root.results.some((row:unknown)=>!body.elementIds.includes(object(row).id)))return [];
    return root.results.some((value:unknown)=>{
      const row=object(value);
      return row.ok===true && Number.isSafeInteger(row.id) && row.id>0
        && Array.isArray(row.connectors) && count(row.returnedConnectorCount)
        && row.returnedConnectorCount===row.connectors.length && row.returnedConnectorCount>0;
    }) ? content() : [];
  }
  // This native handler returns all non-template views as an uncapped array.
  if(path==="/revit/views" && Array.isArray(payload)) {
    const ids=payload.map(row=>object(row).id);
    if(ids.every(id=>Number.isSafeInteger(id)&&id>0) && new Set(ids).size===ids.length)
      return complete(ids.length,"list");
  }
  if(path==="/revit/rooms" && Array.isArray(payload)) {
    const ids=payload.map(row=>object(row).id);
    if(ids.some(id=>!Number.isSafeInteger(id)||id<=0) || new Set(ids).size!==ids.length)return [];
    const cap=Number.isSafeInteger(body.max)&&body.max>0?Math.min(body.max,5000):Infinity;
    return text(body.action).toLowerCase()==="list" && ids.length<cap ? [...content(),...complete(ids.length,"list")]
      : ids.length>0 ? content() : [];
  }
  if(path==="/revit/schedules" && root.status==="Ok" && root.action==="list" && Array.isArray(root.items)) {
    const cap=Number.isSafeInteger(body.max)&&body.max>0?Math.min(body.max,2000):200;
    const ids=root.items.map((row:unknown)=>object(row).id??object(row).scheduleId);
    if(ids.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0) || new Set(ids).size!==ids.length || root.returned!==ids.length)return [];
    return ids.length<cap ? complete(ids.length,"list") : [];
  }
  return [];
}
