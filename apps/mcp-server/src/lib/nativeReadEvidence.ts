type Fact = { fact_id: string; fact_class: "domain"; value: string | number | boolean; dimensions?: Record<string,string> };
const object = (value:unknown):Record<string,any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,any> : {};
const text = (value:unknown) => typeof value === "string" ? value.trim() : "";
const count = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value)>=0;
const fact = (id:string,value:Fact["value"],route:string):Fact => ({fact_id:id,fact_class:"domain",value,dimensions:{route}});

function consistentCount(root:Record<string,any>,names:string[]):number|null {
  const values=names.filter(name=>Object.hasOwn(root,name)).map(name=>root[name]);
  return values.length>0 && values.every(value=>count(value)&&value===values[0]) ? values[0] : null;
}

/** Evidence from known native read contracts, never from metadata labels or
 * model-authored prose. The caller must already establish dispatched, successful,
 * task-eligible read authority and retain/hash the exact native payload. */
export function nativeReadEvidence(path:string,requestBody:unknown,payload:unknown):Fact[] {
  const root=object(payload),body=object(requestBody);
  const content=()=>[fact("model.content_observed",true,path)];
  const complete=(total:number,mode:"count"|"list"):Fact[]=>[
    fact("collection.complete",true,path),fact("collection.total",total,path),fact("collection.mode",mode,path)
  ];
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
    // Quantify scans the entire requested scope for its summary even when its
    // returned element snapshot is bounded. The total is a count, not a full list.
    return [...content(),...complete(total,"count")];
  }
  if(path==="/revit/find-elements") {
    if(root.status!=="Ok" || !Array.isArray(root.elementIds) || !Array.isArray(root.items) || !count(root.count)
      || root.count!==root.elementIds.length || new Set(root.elementIds).size!==root.count
      || root.elementIds.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0))return [];
    if(root.itemsComplete===true && root.truncated===false && root.scanCapReached===false && root.identityExpansionScanCapReached===false)
      return [...content(),...complete(root.count,"list")];
    return root.count>0 ? content() : [];
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
