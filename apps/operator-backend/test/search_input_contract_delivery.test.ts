import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { storeEvidence, retrieveEvidence, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, assertBoundedModelEvidencePayload } from "../src/evidence/model_context_budget.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { projectToolDocumentation } from "../src/evidence/tool_documentation_projection.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

const scope = { session_id: "search-contract", assignment_id: "search-assignment", run_id: "search-run", generation: 1 };
const source = "assignment_kernel_v2:revit_search_tools";
const fixture = (name = "search-types177") => JSON.parse(fs.readFileSync(`test/fixtures/${name}.json`, "utf8"));
const payload = (raw: any) => JSON.parse(raw.content[0].text);
const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
function isolated(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-search-contract-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const retain = (raw: unknown, budget = 8192) => storeEvidence({ scope, source, trust_level: "host_observed", verification_relevance: "supporting", raw }, budget);

test("exact retained type search delivers the whole input contract without dropping ranked identities", () => isolated(() => {
  const raw = fixture();
  assert.equal(createHash("sha256").update(JSON.stringify(raw)).digest("hex"), "de012635c8da5083d93bbf6143e1c3510240ebd3e1b6dd1b7fa4f77a8bca2cdc");
  const saved = retain(raw);
  const doc = saved.projection.tool_documentation!;
  assert.deepEqual(doc.tools.map(t => t.path), payload(raw).matches.map((t: any) => t.path));
  assert.deepEqual(doc.tools[0]!.request_schema, payload(raw).matches[0].request_schema);
  assert(!doc.omitted_paths.includes("payload.matches[0].request_schema"));
  assert.equal(doc.completion_eligible, false);
  assert.equal(doc.complete, false);
  assert.equal(saved.projection.effect_state, null);
  assert.deepEqual(saved.projection.key_facts, {});
  assert.deepEqual(saved.projection.target_scope, []);
  assert.deepEqual(JSON.parse(readAuthoritativeEvidence(saved.ref, scope).toString()), raw);
}));

test("exact search contract survives bounded assembly and the owner model-visible adapter", () => isolated(() => {
  const raw = fixture();
  const saved = retain(raw);
  const bounded = assembleBoundedEvidenceContext({ projections: [saved.projection], ...scope });
  const response = adaptMcpToolCallResultToDynamicResponse(raw, { tool: "revit_search_tools", projections: bounded.projections, omitted: bounded.omitted });
  const visible = JSON.parse((response.contentItems[0] as any).text);
  assert.equal(visible.schema, "revit-operator.model-evidence-envelope.v1");
  assert.deepEqual(visible.evidence_projections[0].tool_documentation.tools[0].request_schema, payload(raw).matches[0].request_schema);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(visible) }]);
  assert.throws(() => retrieveEvidence({ scope: { ...scope, session_id: "foreign" }, evidence_id: saved.ref.evidence_id, purpose: "contract", fields: ["payload.matches[0].request_schema"] }), /scope|session/i);
}));

test("large placement schemas stay atomic and independently retrievable within unchanged caps", () => isolated(() => {
  const raw = fixture("search-placement177");
  for (const budget of [4096, 8192]) {
    const saved = retain(raw, budget), doc = saved.projection.tool_documentation!;
    assert(saved.projection.projected_bytes <= budget);
    for (const [index, tool] of doc.tools.entries()) {
      if (tool.request_schema !== undefined) assert.deepEqual(tool.request_schema, payload(raw).matches[index].request_schema);
      else assert(doc.omitted_paths.includes(`payload.matches[${index}].request_schema`));
    }
    assert.equal(doc.completion_eligible, false);
    assert.equal(doc.complete, false);
    const recovered = retrieveEvidence({ scope, evidence_id: saved.ref.evidence_id, purpose: "Exact omitted placement contract", fields: ["payload.matches[0].request_schema"], max_bytes: 32768 });
    assert.deepEqual((recovered.selection as any)["payload.matches[0].request_schema"], payload(raw).matches[0].request_schema);
  }
}));

test("schema-free and oversized schemas retain catalog identities without invention or partial contracts", () => isolated(() => {
  const original = payload(fixture());
  for (const schema of [undefined, null, { type: "object", properties: { value: { enum: Array.from({ length: 900 }, (_, i) => `choice-${i}`) } } }]) {
    const changed = structuredClone(original);
    for (const row of changed.matches) {
      if (schema === undefined) delete row.request_schema;
      else row.request_schema = schema;
    }
    const saved = retain(wrap(changed), 4096), doc = saved.projection.tool_documentation!;
    assert.deepEqual(doc.tools.map(t => t.path), original.matches.map((t: any) => t.path));
    assert(doc.tools.every(t => t.request_schema === undefined));
    assert(saved.projection.projected_bytes <= 4096);
    assert.equal(doc.complete, false);
  }
}));

test("search metadata cannot acquire native authority or bypass source and ambiguity guards", () => isolated(() => {
  const raw = fixture(), saved = retain(raw);
  for (const change of [
    { source: "caller:revit_search_tools" }, { trust_level: "untrusted_caller" },
  ]) assert.equal(projectToolDocumentation({ ...saved.ref, ...change } as any, raw, 8192), null);
  for (const changed of [
    { ...raw, isError: true },
    { ...raw, structuredContent: { source: "foreign" } },
    { content: [...raw.content, { type: "text", text: "{}" }] },
    wrap({ ...payload(raw), source: "/foreign/registry" }),
    wrap({ ...payload(raw), matches: [{ ...payload(raw).matches[0], path: "/admin/execute" }] }),
  ]) assert.equal(retain(changed).projection.tool_documentation, undefined);
}));
