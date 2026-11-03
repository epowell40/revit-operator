import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { compareToolSearchCandidatesV3, scoreToolSearchCandidateV3, isToolSearchRankingVersionV3, TOOL_SEARCH_RANKING_VERSION_V3, toolSearchResultCoverageV3 } from "./toolSearchRanking.js";
import { shouldExposeBroaderRiskCandidates, partitionRiskFilteredCandidates, buildToolSearchRiskFilterAdvisory } from "./toolSearchRiskSemantics.js";

function sourceFile(relative: string): string {
  const urls = [new URL(relative, import.meta.url), new URL(relative.replace("../", "../../src/"), import.meta.url)];
  const found = urls.find(url => fs.existsSync(url));
  assert.ok(found, `Missing source fixture ${relative}`);
  return fs.readFileSync(found, "utf8");
}
const fixture = JSON.parse(sourceFile("../lib/fixtures/tool-search-bounded468.json"));

// Execute the actual registered producer body, with only transport/catalog
// boundaries replaced. No Revit, provider, write grant or lifecycle is exercised.
function searchHandler(options: { cold?: boolean; exposed?: (tool: any) => boolean; direct?: any; tools?: any[] } = {}) {
  const source = sourceFile("../server.ts");
  const start = source.indexOf('server.tool("revit_search_tools"');
  const body = source.slice(start, source.indexOf("\n);", start)+3);
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const filter = (tools: any[]) => tools.filter(options.exposed ?? (() => true));
  const dependencies: Record<string, unknown> = {
    normalizeRegistryMethod: (value: unknown) => String(value ?? "").toUpperCase(),
    shouldExposeBroaderRiskCandidates, freshCachedToolRegistry: () => !options.cold,
    callRevit: async () => options.direct, isToolSearchRankingVersionV3,
    filterRegistryEntriesForSearch: filter, normalizeRegistryTool: (tool: any) => tool,
    compactToolForList: (tool: any, score: number) => ({ method:tool.method,path:tool.path,risk:tool.risk,group:tool.group,title:tool.title,score,compact_test_marker:true }),
    partitionRiskFilteredCandidates, buildToolSearchRiskFilterAdvisory,
    getToolRegistry: async () => ({ tools: filter(options.tools??fixture.tools) }),
    scoreToolMatch: scoreToolSearchCandidateV3, compareToolSearchCandidatesV3, TOOL_SEARCH_RANKING_VERSION_V3, toolSearchResultCoverageV3
  };
  let handler: any;
  const server={tool:(_name:string,_description:string,schema:any,callback:any)=>{handler=(args:any)=>callback(z.object(schema).parse(args));}};
  new Function('server','z',...Object.keys(dependencies),compiled)(server,z,...Object.values(dependencies));
  assert.equal(typeof handler,'function');
  return handler;
}
const payload = async (handler: any, args: any) => JSON.parse((await handler(args)).content[0].text);

test('small default discovery includes contracts while explicit compact and broad searches stay compact',async()=>{
 const result=await payload(searchHandler(),{query:'save model SaveAs workspace path',max:3});
 assert.equal(result.matches[0].compact_test_marker,undefined,'small search must deliver the registry contract, avoiding a second documentation turn');
 assert.equal(result.matches[0].path,'/revit/save-as');
 const implicit=await payload(searchHandler(),{query:fixture.query});assert.equal(implicit.returned_matches,3);assert(implicit.matches.every((x:any)=>!x.compact_test_marker));
 for(const args of [{max:3,includeSchemas:false},{max:20}]){const compact=await payload(searchHandler(),{query:fixture.query,...args});assert(compact.matches.every((x:any)=>x.compact_test_marker));}
 const cold=await payload(searchHandler({cold:true}),{query:'save-as',max:1});assert.equal(cold.source,'/revit/tool-registry');assert.equal(cold.matches[0].compact_test_marker,undefined);
 const contract={...fixture.tools.find((t:any)=>t.path==='/revit/save-as'),request_schema:{type:'object',properties:{path:{type:'string'}},required:['path']},response_schema:{type:'object'},notes:['Keep save admission unchanged.']};
 const model=await payload(searchHandler({tools:[contract]}),{query:'save-as'});
 assert.deepEqual(model.matches[0].request_schema,contract.request_schema);assert.deepEqual(model.matches[0].response_schema,contract.response_schema);assert.deepEqual(model.matches[0].notes,contract.notes);
});

test("retained468 bounded discovery distinguishes four returned tools from86 matching tools", async () => {
  const result = await payload(searchHandler(), { query: fixture.query, max: 4, includeSchemas: true });
  assert.deepEqual(result.matches.map((x: any) => [x.path, x.score]), [
    ["/revit/inspect-exported-files", 1138], ["/revit/inspect-drawing-spec", 766],
    ["/revit/find-elements", 706], ["/revit/export-visible-elements", 492]
  ]);
  assert.equal(result.total_matches, 86);
  assert.equal(result.returned_matches, 4);
  assert.equal(result.truncated, true);
  assert.match(result.search_guidance, /focused/i);
  assert.match(result.search_guidance, /omitted.*unavailable/i);
  const focused = await payload(searchHandler(), { query: "save model SaveAs workspace path", max: 2, includeSchemas: true });
  assert.equal(focused.matches[0].path, "/revit/save-as");
});

test("registry completeness counts only exposed candidates matching exact filters", async () => {
  const result = await payload(searchHandler({ exposed: t => t.path !== "/revit/save-as" }), {
    query: "save model SaveAs workspace path", max: 100, includeSchemas: true, method: "POST", risk: "high", pathPrefix: "/revit/save"
  });
  assert.ok(result.matches.length > 0);
  assert.equal(result.total_matches, result.matches.length);
  assert.equal(result.returned_matches, result.matches.length);
  assert.equal(result.truncated, false);
  assert.ok(result.matches.every((x: any) => x.risk === "high" && x.path !== "/revit/save-as"));
  const empty = await payload(searchHandler(), { query: "qzxvkwp", max: 4, includeSchemas: true });
  assert.equal(empty.total_matches, 0);
  assert.equal(empty.truncated, false);
});

test("cold bounded native search never presents its upstream returned count as a complete total", async () => {
  const direct = { version: "operator.tool_search.v1", ranking_version: TOOL_SEARCH_RANKING_VERSION_V3, total_matches: 4,
    matches: fixture.tools.filter((t: any) => t.path === "/revit/save-as") };
  const result = await payload(searchHandler({ cold: true, direct }), { query: "save-as", max: 4 });
  assert.equal(result.source, "/revit/tool-search");
  assert.equal(result.total_matches, null);
  assert.equal(result.returned_matches, 1);
  assert.equal(result.truncated, null);
  assert.match(result.search_guidance, /focused/i);
});

test("risk preview neighbors and locally omitted native candidates retain truthful count scope", async () => {
  const low = await payload(searchHandler(), { query: "create text preview", max: 2, risk: "low", includeSchemas: true });
  assert.ok(low.matches.every((t: any) => t.risk === "low"));
  const expected = fixture.tools.filter((t: any) => t.risk === "low" && scoreToolSearchCandidateV3(t, "create text preview") > 0).length;
  assert.equal(low.total_matches, expected);
  assert.equal(low.truncated, expected > low.matches.length);
  const direct = { version: "operator.tool_search.v1", ranking_version: TOOL_SEARCH_RANKING_VERSION_V3,
    matches: fixture.tools.filter((t: any) => t.path.startsWith("/revit/save")) };
  const bounded = await payload(searchHandler({ cold: true, direct }), { query: "save-as", max: 1, includeSchemas: false });
  assert.equal(bounded.total_matches, null);
  assert.equal(bounded.returned_matches, 1);
  assert.equal(bounded.truncated, true);
});

