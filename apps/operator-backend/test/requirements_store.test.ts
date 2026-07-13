import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  createRequirement,
  beginRequirementsPlanningLease,
  deriveRequirementScopesForChat,
  endRequirementsPlanningLease,
  formatRequirementsForPrompt,
  listRequirements,
  requirementScopePrecedence,
  resolveRequirements,
  retireRequirement,
  reviseRequirement
} from "../src/memory/requirements_store.js";
import { runWithRequestContext, type RequestPrincipal } from "../src/request_context.js";
import { requiresMemoryAuthentication } from "../src/memory/requirements_route_policy.js";
import { captureRequirementsResponseGuard, enforceRequirementsResponseGuard, formatRequirementsPromptBlockSafely } from "../src/memory/requirements_response_policy.js";
import { handleRequirementsHttpRoute } from "../src/memory/requirements_http_routes.js";
import { authenticateRequest } from "../src/auth.js";
import { maybeContinueAecLevelPowerPlanPilot, startAecLevelPowerPlanPilot } from "../src/deterministic/aec_level_power_plan_runtime.js";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { getActiveGoalForSession, setAgentGoal } from "../src/goals/service.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-requirements-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

function scope(kind: "office" | "engineer" | "project" | "client", id: string) {
  return { kind, id } as const;
}

function principal(user: string, tenant: string): RequestPrincipal {
  return { sub: user, user_id: user, license_id: tenant, roles: ["user"], tier: "pro", claims: {} };
}

test("create writes a stable requirement id and append-only first revision", () => {
  const root = mkWorkspace();
  const saved = createRequirement({ scope: scope("office", "bimtools"), key: "tags.text_size", text: "Use 3/32 inch text.", source: "test" });
  assert.match(saved.requirement.requirement_id, /^req_/);
  assert.equal(saved.requirement.revision, 1);
  assert.equal(saved.requirement.status, "active");
  assert.ok(fs.existsSync(path.join(root, "memory", "requirements.v1.jsonl")));
  assert.equal(fs.readFileSync(saved.ledger_path, "utf8").trim().split("\n").length, 1);
});

test("revision preserves stable id and enforces optimistic concurrency", () => {
  mkWorkspace();
  const first = createRequirement({ scope: scope("engineer", "eli"), key: "tags.leader_length", text: "Keep leaders short." });
  const second = reviseRequirement({ requirement_id: first.requirement.requirement_id, expected_revision: 1, scope: first.requirement.scope, key: first.requirement.key, text: "Keep leaders under 3 feet when practical." });
  assert.equal(second.requirement.requirement_id, first.requirement.requirement_id);
  assert.equal(second.requirement.revision, 2);
  assert.throws(() => reviseRequirement({ requirement_id: first.requirement.requirement_id, expected_revision: 1, scope: first.requirement.scope, key: first.requirement.key, text: "stale" }), /Revision conflict/);
});

test("retire appends a tombstone and removes the requirement from active resolution", () => {
  mkWorkspace();
  const first = createRequirement({ scope: scope("project", "snowdon"), key: "equipment.clearance", text: "Show service clearances." });
  const retired = retireRequirement({ requirement_id: first.requirement.requirement_id, expected_revision: 1 });
  assert.equal(retired.requirement.status, "retired");
  assert.equal(retired.requirement.revision, 2);
  assert.equal(resolveRequirements({ scope_refs: [scope("project", "snowdon")] }).applied.length, 0);
  assert.equal(listRequirements({ status: "all" })[0]!.status, "retired");
});

test("effective dates exclude future and expired requirements", () => {
  mkWorkspace();
  createRequirement({ scope: scope("client", "hospital-a"), key: "sheets.naming", text: "Future", effective_from: "2030-01-01T00:00:00Z" });
  createRequirement({ scope: scope("client", "hospital-a"), key: "views.naming", text: "Expired", effective_from: "2020-01-01T00:00:00Z", effective_until: "2021-01-01T00:00:00Z" });
  const receipt = resolveRequirements({ scope_refs: [scope("client", "hospital-a")], at: "2026-07-13T12:00:00Z" });
  assert.equal(receipt.applied.length, 0);
});

test("precedence is project over client over office over engineer", () => {
  mkWorkspace();
  assert.deepEqual(["engineer", "office", "client", "project"].map(kind => requirementScopePrecedence(kind as any)), [100, 200, 300, 400]);
  const refs = [scope("engineer", "eli"), scope("office", "bimtools"), scope("client", "hospital-a"), scope("project", "snowdon")];
  for (const ref of refs) createRequirement({ scope: ref, key: "tags.text_size", text: `${ref.kind} value` });
  const receipt = resolveRequirements({ scope_refs: refs });
  assert.equal(receipt.applied[0]!.scope.kind, "project");
  assert.equal(receipt.suppressed.length, 3);
});

test("same-precedence contradictory records fail closed as a conflict", () => {
  mkWorkspace();
  const ref = scope("project", "snowdon");
  createRequirement({ scope: ref, key: "tags.text_size", text: "Use 3/32 inch." });
  createRequirement({ scope: ref, key: "tags.text_size", text: "Use 1/8 inch." });
  const receipt = resolveRequirements({ scope_refs: [ref] });
  assert.equal(receipt.status, "conflict");
  assert.equal(receipt.applied.length, 0);
  assert.equal(receipt.conflicts[0]!.requirements.length, 2);
});

test("same-precedence duplicate text resolves deterministically", () => {
  mkWorkspace();
  const ref = scope("office", "bimtools");
  const a = createRequirement({ scope: ref, key: "tags.case", text: "Use ALL CAPS." });
  const b = createRequirement({ scope: ref, key: "tags.case", text: "Use ALL CAPS." });
  const receipt = resolveRequirements({ scope_refs: [ref] });
  assert.equal(receipt.status, "resolved");
  assert.equal(receipt.applied[0]!.requirement_id, [a.requirement.requirement_id, b.requirement.requirement_id].sort()[0]);
  assert.equal(receipt.suppressed[0]!.reason, "duplicate");
});

test("explicit supersession suppresses the named record", () => {
  mkWorkspace();
  const ref = scope("client", "hospital-a");
  const old = createRequirement({ scope: ref, key: "rooms.power", text: "Provide two outlets." });
  const replacement = createRequirement({ scope: ref, key: "rooms.power", text: "Provide four outlets.", supersedes_requirement_ids: [old.requirement.requirement_id] });
  const receipt = resolveRequirements({ scope_refs: [ref] });
  assert.equal(receipt.status, "resolved");
  assert.equal(receipt.applied[0]!.requirement_id, replacement.requirement.requirement_id);
  assert.equal(receipt.suppressed[0]!.reason, "superseded");
});

test("receipt hash is stable across repeated resolution and names exact revisions", () => {
  mkWorkspace();
  const ref = scope("project", "snowdon");
  const saved = createRequirement({ scope: ref, key: "equipment.clearance", text: "Show power-side clearance.", effective_from: "2026-01-01T00:00:00Z" });
  const a = resolveRequirements({ scope_refs: [ref], query: "equipment clearance", at: "2026-07-13T12:00:00Z" });
  const b = resolveRequirements({ scope_refs: [ref], query: "equipment clearance", at: "2026-07-13T12:00:00Z" });
  assert.equal(a.receipt_sha256, b.receipt_sha256);
  assert.deepEqual(a.applied.map(row => [row.requirement_id, row.revision]), [[saved.requirement.requirement_id, 1]]);
});

test("query retrieval is deterministic and bounded to matching keys, text, or tags", () => {
  mkWorkspace();
  const ref = scope("office", "bimtools");
  createRequirement({ scope: ref, key: "tags.leaders", text: "Keep leaders short.", tags: ["annotation"] });
  createRequirement({ scope: ref, key: "duct.routing", text: "Prefer orthogonal routes.", tags: ["mep"] });
  const receipt = resolveRequirements({ scope_refs: [ref], query: "annotation leaders" });
  assert.equal(receipt.applied.length, 1);
  assert.equal(receipt.applied[0]!.key, "tags.leaders");
});

test("scope ids isolate requirements even within the same scope kind", () => {
  mkWorkspace();
  createRequirement({ scope: scope("client", "client-a"), key: "sheets.logo", text: "Use logo A." });
  createRequirement({ scope: scope("client", "client-b"), key: "sheets.logo", text: "Use logo B." });
  const a = resolveRequirements({ scope_refs: [scope("client", "client-a")] });
  assert.equal(a.applied.length, 1);
  assert.equal(a.applied[0]!.text, "Use logo A.");
});

test("hosted request context isolates ledgers by tenant and user", () => {
  const base = mkWorkspace();
  runWithRequestContext({ principal: principal("alice", "tenant-a") }, () => createRequirement({ scope: scope("engineer", "alice"), key: "tags.case", text: "Alice" }));
  runWithRequestContext({ principal: principal("bob", "tenant-b") }, () => createRequirement({ scope: scope("engineer", "bob"), key: "tags.case", text: "Bob" }));
  const alice = runWithRequestContext({ principal: principal("alice", "tenant-a") }, () => listRequirements());
  const bob = runWithRequestContext({ principal: principal("bob", "tenant-b") }, () => listRequirements());
  assert.deepEqual(alice.map(row => row.text), ["Alice"]);
  assert.deepEqual(bob.map(row => row.text), ["Bob"]);
  assert.ok(fs.existsSync(path.join(base, "tenants", "tenant-a", "users", "alice", "Workspace", "memory", "requirements.v1.jsonl")));
});

test("chat scope derivation uses engineer identity and stable active-project identity", () => {
  mkWorkspace();
  const req = { context: { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } } };
  const a = runWithRequestContext({ principal: principal("eli", "tenant-a") }, () => deriveRequirementScopesForChat(req));
  const b = runWithRequestContext({ principal: principal("eli", "tenant-a") }, () => deriveRequirementScopesForChat(req));
  assert.deepEqual(a, b);
  assert.ok(a.some(row => row.kind === "engineer" && row.id === "eli"));
  assert.ok(a.some(row => row.kind === "project" && /^revit_[a-f0-9]{16}$/.test(row.id)));
});

test("prompt block includes exact ids, revisions, hash, and conflict guard", () => {
  mkWorkspace();
  const ref = scope("project", "snowdon");
  createRequirement({ scope: ref, key: "tags.position", text: "Keep tags in clear floor space." });
  const block = formatRequirementsForPrompt(resolveRequirements({ scope_refs: [ref] }));
  assert.match(block, /receipt_sha256=[a-f0-9]{64}/);
  assert.match(block, /id=req_/);
  assert.match(block, /rev=1/);
  assert.match(block, /never silently override a conflict/);
});

test("bounded writes reject oversized requirement text", () => {
  mkWorkspace();
  assert.throws(() => createRequirement({ scope: scope("office", "bimtools"), key: "notes.general", text: "x".repeat(2001) }), /exceeds 2000 characters/);
});

test("every memory route, including legacy project profile, requires authentication", () => {
  assert.equal(requiresMemoryAuthentication("/memory/project-profile"), true);
  assert.equal(requiresMemoryAuthentication("/memory/project-profile/standards"), true);
  assert.equal(requiresMemoryAuthentication("/memory/requirements/resolve"), true);
  assert.equal(requiresMemoryAuthentication("/health"), false);
  const denied = authenticateRequest({ headers: {} } as any, { mode: "shared_token", requireAuth: requiresMemoryAuthentication("/memory/requirements"), sharedToken: "test-token" });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 401);
});

test("deterministic Level power planning carries exact applied requirement ids and receipt hash", () => {
  mkWorkspace();
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "requirements-power-plan",
    message_id: "m1",
    user_text: "Lay out the power plans on Level 4 using the project precedent.",
    context: { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } }
  };
  const projectScope = deriveRequirementScopesForChat(request).find(row => row.kind === "project")!;
  const saved = createRequirement({ scope: projectScope, key: "power.precedent_policy", text: "Use an exact current-project adjacent-level precedent." });
  setAgentGoal(request.session_id, { title: "Power plan", objective: request.user_text!, success_criteria: ["Bounded receipt"], created_by: "test" });
  const task: AecSemanticTaskV1 = {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "layout",
    subject: { kind: "class", semantic_class: "electrical_equipment", terms: ["power plan"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "current_project_precedent", source_description: null, source_room: null },
    mutation: { kind: "create", requested: true },
    outputs: ["summary", "verification"],
    execution: { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true },
    confidence: { value: 0.95, ambiguity: "low", reasons: ["bounded level"] },
    evidence: { user_text: request.user_text! }
  };
  const result = startAecLevelPowerPlanPilot(request, task, [{ id: 101, name: "L4 - Power", levelName: "L4" }]);
  assert.equal(result?.requirements_receipt?.status, "resolved");
  assert.deepEqual(result?.requirements_receipt?.applied.map(row => [row.requirement_id, row.revision]), [[saved.requirement.requirement_id, 1]]);
  assert.match(result?.requirements_receipt?.receipt_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(result?.actions.map(action => action.path), ["/revit/find-elements"]);
  assert.match(getActiveGoalForSession(request.session_id)?.assumptions.find(row => row.id === "requirements.receipt")?.statement ?? "", new RegExp(saved.requirement.requirement_id));
});

test("deterministic Level power planning blocks before Revit actions on a requirement conflict", () => {
  mkWorkspace();
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "requirements-power-conflict",
    message_id: "m1",
    user_text: "Lay out the power plans on Level 4.",
    context: { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } }
  };
  const projectScope = deriveRequirementScopesForChat(request).find(row => row.kind === "project")!;
  createRequirement({ scope: projectScope, key: "power.precedent_policy", text: "Use Level 3." });
  createRequirement({ scope: projectScope, key: "power.precedent_policy", text: "Use Level 5." });
  setAgentGoal(request.session_id, { title: "Power plan", objective: request.user_text!, success_criteria: ["Bounded receipt"], created_by: "test" });
  const task: AecSemanticTaskV1 = {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "layout",
    subject: { kind: "class", semantic_class: "electrical_equipment", terms: ["power plan"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "current_project_precedent", source_description: null, source_room: null },
    mutation: { kind: "create", requested: true },
    outputs: ["summary"],
    execution: { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true },
    confidence: { value: 0.95, ambiguity: "low", reasons: ["bounded level"] },
    evidence: { user_text: request.user_text! }
  };
  const result = startAecLevelPowerPlanPilot(request, task, [{ id: 101, name: "L4 - Power", levelName: "L4" }]);
  assert.equal(result?.requirements_receipt?.status, "conflict");
  assert.deepEqual(result?.actions, []);
  assert.equal(result?.aec_query_receipt?.status, "failed");
});

test("supersession cannot suppress a different scope or directive key", () => {
  mkWorkspace();
  const old = createRequirement({ scope: scope("office", "bimtools"), key: "tags.case", text: "Use ALL CAPS." });
  assert.throws(() => createRequirement({ scope: scope("client", "hospital-a"), key: "sheets.case", text: "Use title case.", supersedes_requirement_ids: [old.requirement.requirement_id] }), /same scope and key/);
});

test("hosted actor provenance is derived from the authenticated principal", () => {
  mkWorkspace();
  const saved = runWithRequestContext({ principal: principal("alice", "tenant-a") }, () => createRequirement({ scope: scope("engineer", "alice"), key: "tags.leaders", text: "Keep leaders short.", actor_id: "forged-user" }));
  assert.equal(saved.requirement.provenance.actor_id, "alice");
});

test("malformed ledger rows fail closed instead of silently changing resolution", () => {
  const root = mkWorkspace();
  createRequirement({ scope: scope("office", "bimtools"), key: "tags.case", text: "Use ALL CAPS." });
  fs.appendFileSync(path.join(root, "memory", "requirements.v1.jsonl"), "{malformed\n", "utf8");
  assert.throws(() => listRequirements(), /ledger is malformed at line 2/i);
});

test("receipt overflow blocks instead of silently truncating applicable requirements", () => {
  mkWorkspace();
  const ref = scope("office", "bimtools");
  createRequirement({ scope: ref, key: "tags.a", text: "A" });
  createRequirement({ scope: ref, key: "tags.b", text: "B" });
  createRequirement({ scope: ref, key: "tags.c", text: "C" });
  const receipt = resolveRequirements({ scope_refs: [ref], max_results: 2 });
  assert.equal(receipt.status, "overflow");
  assert.deepEqual(receipt.overflow, { applied_count: 3, suppressed_count: 0, conflict_count: 0, max_results: 2 });
});

test("supersession is applied before query filtering", () => {
  mkWorkspace();
  const ref = scope("client", "hospital-a");
  const old = createRequirement({ scope: ref, key: "rooms.naming", text: "Use legacyword room labels." });
  createRequirement({ scope: ref, key: "rooms.naming", text: "Use current room labels.", supersedes_requirement_ids: [old.requirement.requirement_id] });
  const receipt = resolveRequirements({ scope_refs: [ref], query: "legacyword" });
  assert.equal(receipt.applied.length, 0);
  assert.equal(receipt.suppressed[0]!.requirement_id, old.requirement.requirement_id);
  assert.equal(receipt.suppressed[0]!.reason, "superseded");
});

test("Level power continuation revalidates and rejects a stale requirement receipt", () => {
  mkWorkspace();
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "requirements-power-stale",
    message_id: "m1",
    user_text: "Lay out the power plans on Level 4.",
    context: { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } }
  };
  const projectScope = deriveRequirementScopesForChat(request).find(row => row.kind === "project")!;
  createRequirement({ scope: projectScope, key: "power.precedent_policy", text: "Use Level 3." });
  setAgentGoal(request.session_id, { title: "Power plan", objective: request.user_text!, success_criteria: ["Bounded receipt"], created_by: "test" });
  const task: AecSemanticTaskV1 = {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "layout",
    subject: { kind: "class", semantic_class: "electrical_equipment", terms: ["power plan"], categories: ["OST_ElectricalFixtures"], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "level", document: null, levels: ["L4"], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "current_project_precedent", source_description: null, source_room: null },
    mutation: { kind: "create", requested: true }, outputs: ["summary"],
    execution: { max_results: 100, max_primary_actions: 8, allow_document_fallback: false, requires_visual_verification: true },
    confidence: { value: 0.95, ambiguity: "low", reasons: ["bounded level"] }, evidence: { user_text: request.user_text! }
  };
  startAecLevelPowerPlanPilot(request, task, [{ id: 101, name: "L4 - Power", levelName: "L4" }]);
  createRequirement({ scope: projectScope, key: "power.precedent_policy", text: "Use Level 5." });
  const result = maybeContinueAecLevelPowerPlanPilot({ ...request, message_id: "m2", user_text: "", tool_results: [{ action_id: "aec-power-view-101-inventory", method: "POST", path: "/revit/find-elements", status: "done", result_json: {} }] });
  assert.deepEqual(result?.actions, []);
  assert.equal(result?.aec_query_receipt?.status, "failed");
  assert.match(result?.assistant_message ?? "", /changed or became blocked/);
});

test("active planning lease blocks requirement writes until the turn releases it", () => {
  mkWorkspace();
  const ref = scope("engineer", "local");
  const receipt = resolveRequirements({ scope_refs: [ref] });
  const lease = beginRequirementsPlanningLease(receipt.receipt_sha256);
  try {
    assert.throws(() => createRequirement({ scope: ref, key: "tags.leaders", text: "Keep leaders short." }), /active planning lease/);
  } finally {
    endRequirementsPlanningLease(lease);
  }
  assert.equal(createRequirement({ scope: ref, key: "tags.leaders", text: "Keep leaders short." }).requirement.revision, 1);
});

test("filesystem planning lease blocks a second backend process sharing the ledger", () => {
  const root = mkWorkspace();
  const ref = scope("engineer", "local");
  const receipt = resolveRequirements({ scope_refs: [ref] });
  const lease = beginRequirementsPlanningLease(receipt.receipt_sha256);
  assert.ok(fs.existsSync(lease.lease_path));
  try {
    const moduleUrl = pathToFileURL(path.resolve("dist/src/memory/requirements_store.js")).href;
    const script = `
      const { createRequirement } = await import(${JSON.stringify(moduleUrl)});
      try {
        createRequirement({ scope: { kind: "engineer", id: "local" }, key: "tags.leaders", text: "Cross-process write must block." });
        process.exit(2);
      } catch (error) {
        if (!/active planning lease/.test(error instanceof Error ? error.message : String(error))) process.exit(3);
        process.stdout.write("blocked");
      }
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, OPERATOR_WORKSPACE_ROOT: root },
      encoding: "utf8"
    });
    assert.equal(output, "blocked");
  } finally {
    endRequirementsPlanningLease(lease);
  }
  assert.equal(fs.existsSync(lease.lease_path), false);
  assert.equal(createRequirement({ scope: ref, key: "tags.leaders", text: "Write after release." }).requirement.revision, 1);
});

test("OpenAI requirements policy formats prompts and blocks a stale action response", () => {
  mkWorkspace();
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "requirements-openai-policy",
    message_id: "m1",
    user_text: "Keep tag leaders short.",
    context: { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } }
  };
  const guard = captureRequirementsResponseGuard(request);
  assert.equal(guard.blocker, null);
  const projectScope = deriveRequirementScopesForChat(request).find(row => row.kind === "project")!;
  createRequirement({ scope: projectScope, key: "tags.leaders", text: "Keep leaders short." });
  assert.match(formatRequirementsPromptBlockSafely(request), /Keep leaders short/);
  const guarded = enforceRequirementsResponseGuard(request, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Applying tags.",
    actions: [{ action_id: "a1", method: "POST", path: "/revit/tag-elements", body: {} }]
  }, guard);
  assert.deepEqual(guarded.actions, []);
  assert.match(guarded.assistant_message, /changed while this plan was being prepared/);
  assert.equal(guarded.requirements_receipt?.applied[0]?.key, "tags.leaders");
});

test("requirements HTTP adapter creates, lists, and reports revision conflicts", async () => {
  mkWorkspace();
  const created = await handleRequirementsHttpRoute({
    method: "POST",
    url: new URL("http://localhost/memory/requirements"),
    actor_id: "eli",
    read_body: async () => ({ scope: scope("office", "bimtools"), key: "tags.text", text: "Use readable text." })
  });
  assert.equal(created?.status, 201);
  assert.equal(created?.audit?.type, "requirements.created");
  const requirement = (created?.body as any).requirement;
  const listed = await handleRequirementsHttpRoute({
    method: "GET",
    url: new URL("http://localhost/memory/requirements?scope_kind=office&scope_id=bimtools"),
    actor_id: "eli",
    read_body: async () => null
  });
  assert.equal((listed?.body as any).requirements[0].requirement_id, requirement.requirement_id);
  const conflict = await handleRequirementsHttpRoute({
    method: "POST",
    url: new URL("http://localhost/memory/requirements/revise"),
    actor_id: "eli",
    read_body: async () => ({ ...requirement, expected_revision: 0, text: "stale" })
  });
  assert.equal(conflict?.status, 409);
});
