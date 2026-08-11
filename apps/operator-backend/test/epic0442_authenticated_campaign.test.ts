import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, type JsonValue } from "../src/capabilities/tool_certification.js";
import { loadEpic0441Campaign, type Epic0441Campaign } from "../src/benchmark/epic0441_campaign.js";
import {
  Epic0442ScorerAuthority,
  DurableEpic0442ReplayAuthority,
  InMemoryEpic0442ReplayAuthority,
  epic0442SourceCampaignSha256,
  verifyEpic0442AuthenticatedChain,
  type Epic0442AssignmentReceipt,
  type Epic0442ExecutionEvidence,
  type Epic0442Representation,
  type Epic0442ScorerVerdict
} from "../src/benchmark/epic0442_authenticated_campaign.js";

const campaign = loadEpic0441Campaign();
const now = 1_786_291_200;
const h = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function authority(replay = new InMemoryEpic0442ReplayAuthority(), mode: "development" | "production" = "development") {
  const keys = generateKeyPairSync("ed25519");
  return { scorer: new Epic0442ScorerAuthority({ runtimeMode: mode, privateKey: keys.privateKey, replayAuthority: replay, now: () => now }), keys };
}

function assignment(scorer: Epic0442ScorerAuthority, campaignReceipt: ReturnType<Epic0442ScorerAuthority["issueCampaign"]>, representation: Epic0442Representation) {
  return scorer.issueAssignment({
    campaign,
    campaignReceipt,
    taskId: "r05_add_tag",
    configId: representation === "dynamic_program" ? "epic0441_dynamic_v1" : "epic0441_typed_v1",
    representation,
    pairOrder: representation === "typed_capability_chain" ? 1 : 2,
    fixtureId: "snowdon-electrical-disposable-copy",
    fixtureSha256: h("fixture"),
    fixtureAdapterSha256: h("hidden-adapter"),
    promptId: "r05-holdout-wording-01",
    promptSha256: h("unseen prompt bytes"),
    substrate: "snowdon_electrical",
    provider: representation === "dynamic_program" ? "openai" : "operator_typed_planner",
    model: representation === "dynamic_program" ? "gpt-5.6" : "deterministic-v1",
    actionPolicy: "apply_cleanup",
    assignmentId: `${representation}-assignment`,
    assignmentNonce: `${representation}-nonce`
  });
}

function evidence(representation: Epic0442Representation, repair = false): Epic0442ExecutionEvidence {
  return {
    schema_version: "epic0442_execution_evidence/v1",
    evidence_tier: "live",
    source_sha256: h(`${representation}-source`),
    runtime_sha256: h(`${representation}-runtime`),
    package_sha256: h(`${representation}-package`),
    revit_process: { process_id: 4242, executable_sha256: h("Revit.exe"), started_at_utc: "2026-08-09T12:00:00.000Z" },
    document: { project_fingerprint: h("document"), document_session_id: "revit-document-session-1" },
    trusted_context: null,
    execution: {
      kind: representation === "dynamic_program" ? "dynamic_program" : "typed_tool_chain",
      status: "completed",
      execution_receipt_sha256: h(`${representation}-execution`),
      program_sha256: representation === "dynamic_program" ? h("generated-program") : null,
      tool_call_receipt_sha256s: representation === "typed_capability_chain" ? [h("typed-call-preview"), h("typed-call-apply")] : []
    },
    preview: { status: "completed", receipt_sha256: h(`${representation}-preview`) },
    apply: { status: "completed", authorization_sha256: h(`${representation}-apply-authorization`), receipt_sha256: h(`${representation}-apply`) },
    element_delta: { changed_ids: repair ? [1201] : [], created_ids: [2201], deleted_ids: [] },
    metrics: { elapsed_ms: repair ? 2900 : 1800, turn_count: repair ? 2 : 1, rpc_count: repair ? 6 : 4 },
    cleanup: { required: true, status: "discarded", restoration_receipt_sha256: h(`${representation}-cleanup`) }
  };
}

function verdict(outcome: "authenticated_live_success" | "success_after_repair", repairCount: number): Epic0442ScorerVerdict {
  return {
    schema_version: "epic0442_scorer_verdict/v1",
    verifier_id: "sealed-fixture-verifier",
    verifier_version: "v1",
    verification_receipt_sha256: h(`verification-${outcome}`),
    scorer_id: "epic0442-scorer",
    scorer_version: "v1",
    outcome,
    repair_count: repairCount,
    reason_codes: outcome === "success_after_repair" ? ["repaired_then_verified"] : ["all_invariants_verified"]
  };
}

function asLegacySignedResult<T extends { evidence: Epic0442ExecutionEvidence; receipt_hash: string; signature_base64url: string }>(result: T, privateKey: KeyObject): T {
  const legacy = structuredClone(result) as unknown as { evidence: Record<string, unknown>; receipt_hash: string; signature_base64url: string; [key: string]: unknown };
  delete legacy.evidence.trusted_context;
  const { receipt_hash: _receiptHash, signature_base64url: _signature, ...payload } = legacy;
  const receipt_hash = h(canonicalJson(payload as unknown as JsonValue));
  const signature_base64url = sign(null, Buffer.from(canonicalJson({ domain: "epic0442-scorer-receipt/v1", receipt_hash }), "utf8"), privateKey).toString("base64url");
  return { ...payload, receipt_hash, signature_base64url } as T;
}

test("synthetic typed and Dynamic arms produce scorer-owned authenticated paired results", () => {
  const { scorer } = authority();
  const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "epic0442-stream-a-v1", campaignNonce: "campaign-nonce-1" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const dynamicAssignment = assignment(scorer, campaignReceipt, "dynamic_program");
  const typedResult = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"),
    verdict: verdict("authenticated_live_success", 0), resultId: "typed-result", resultNonce: "typed-result-nonce" });
  const dynamicResult = scorer.score({ campaignReceipt, assignmentReceipt: dynamicAssignment, evidence: evidence("dynamic_program", true),
    verdict: verdict("success_after_repair", 1), resultId: "dynamic-result", resultNonce: "dynamic-result-nonce" });

  verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment, dynamicAssignment],
    results: [typedResult, dynamicResult], expectedCampaign: campaign, expectedCampaignVersion: "epic0442-stream-a-v1" });
  assert.equal(typedResult.verdict.outcome, "authenticated_live_success");
  assert.equal(dynamicResult.verdict.outcome, "success_after_repair");
  assert.deepEqual(dynamicResult.evidence.element_delta, { changed_ids: [1201], created_ids: [2201], deleted_ids: [] });
  assert.equal(typedResult.authority_scope, "benchmark_scoring_only");
  assert.equal(typedResult.authorizes_revit_execution, false);
  assert.equal(dynamicResult.authorizes_revit_apply, false);
});

test("verified context record and active-view observation identities are scorer-signed evidence", () => {
  const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "context-campaign" });
  const dynamicAssignment = assignment(scorer, campaignReceipt, "dynamic_program"); const observed = evidence("dynamic_program");
  observed.trusted_context = {
    record_id: "rule-office-annotation-1", record_sha256: h("context-record"), binding_sha256: h("context-binding"),
    observation_scope_sha256: h("active-view-scope"), observation_revision_sha256: h("active-view-revision"), verification_key_sha256: h("fixture-verification-key"),
    worker_package_sha256: observed.package_sha256, observation_receipt_sha256s: [h("observation-page-0")]
  };
  const result = scorer.score({ campaignReceipt, assignmentReceipt: dynamicAssignment, evidence: observed, verdict: verdict("authenticated_live_success", 0) });
  verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [dynamicAssignment], results: [result], expectedCampaign: campaign });
  const forged = structuredClone(result); forged.evidence.trusted_context!.record_sha256 = h("forged-context-record");
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [dynamicAssignment], results: [forged] }), /payload hash is invalid/);
  const wrongPackage = structuredClone(observed); wrongPackage.trusted_context!.worker_package_sha256 = h("other-package");
  assert.throws(() => scorer.score({ campaignReceipt, assignmentReceipt: dynamicAssignment, evidence: wrongPackage, verdict: verdict("authenticated_live_success", 0), resultNonce: "wrong-package" }), /worker package/);
});

test("legacy signed v1 evidence without the additive trusted-context field remains verifiable", () => {
  const { scorer, keys } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "legacy-context-campaign" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const current = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) });
  const legacy = asLegacySignedResult(current, keys.privateKey);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.evidence, "trusted_context"), false);
  verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [legacy], expectedCampaign: campaign });
});

test("campaign, assignment, and result forgery or cross-authority substitution fails", () => {
  const first = authority(); const second = authority();
  const campaignReceipt = first.scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "forgery-campaign" });
  const typedAssignment = assignment(first.scorer, campaignReceipt, "typed_capability_chain");
  const result = first.scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) });

  const campaignTamper = structuredClone(campaignReceipt); campaignTamper.campaign_version = "forged";
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt: campaignTamper,
    assignmentReceipts: [typedAssignment], results: [result] }), /payload hash is invalid/);
  const assignmentTamper = structuredClone(typedAssignment); assignmentTamper.provider = "forged-provider";
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt,
    assignmentReceipts: [assignmentTamper], results: [result] }), /payload hash is invalid/);
  const resultTamper = structuredClone(result); resultTamper.verdict.outcome = "incorrect";
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt,
    assignmentReceipts: [typedAssignment], results: [resultTamper] }), /payload hash is invalid/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: second.scorer.publicKey(), campaignReceipt,
    assignmentReceipts: [typedAssignment], results: [result] }), /authority does not match/);
});

test("every material campaign result dimension is inside the scorer signature", () => {
  const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "dimension-campaign" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const result = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) });
  const mutations: Array<(candidate: typeof result) => void> = [
    candidate => { candidate.campaign_receipt_sha256 = h("other-campaign"); },
    candidate => { candidate.assignment_receipt_sha256 = h("other-assignment"); },
    candidate => { candidate.task_id = "r06_move_tag_cleanup"; },
    candidate => { candidate.config_id = "other-config"; },
    candidate => { candidate.fixture_sha256 = h("other-fixture"); },
    candidate => { candidate.prompt_sha256 = h("other-prompt"); },
    candidate => { candidate.substrate = "other-substrate"; },
    candidate => { candidate.provider = "other-provider"; },
    candidate => { candidate.model = "other-model"; },
    candidate => { candidate.evidence.source_sha256 = h("other-source"); },
    candidate => { candidate.evidence.runtime_sha256 = h("other-runtime"); },
    candidate => { candidate.evidence.package_sha256 = h("other-package"); },
    candidate => { candidate.evidence.revit_process!.process_id += 1; },
    candidate => { candidate.evidence.document!.document_session_id = "other-session"; },
    candidate => { candidate.evidence.trusted_context = { record_id: "rule-1", record_sha256: h("rule"), binding_sha256: h("binding"), observation_scope_sha256: h("scope"), observation_revision_sha256: h("revision"), verification_key_sha256: h("key"), worker_package_sha256: candidate.evidence.package_sha256, observation_receipt_sha256s: [h("observation")] }; },
    candidate => { candidate.evidence.execution.execution_receipt_sha256 = h("other-execution"); },
    candidate => { candidate.evidence.preview.receipt_sha256 = h("other-preview"); },
    candidate => { candidate.evidence.apply.receipt_sha256 = h("other-apply"); },
    candidate => { candidate.evidence.element_delta.created_ids = [2202]; },
    candidate => { candidate.evidence.metrics.rpc_count += 1; },
    candidate => { candidate.evidence.cleanup.restoration_receipt_sha256 = h("other-cleanup"); },
    candidate => { candidate.verdict.verifier_id = "other-verifier"; },
    candidate => { candidate.verdict.scorer_id = "other-scorer"; },
    candidate => { candidate.verdict.outcome = "incorrect"; }
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(result); mutate(forged);
    assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [forged] }));
  }
});

test("campaign hash/version and every result assignment binding fail closed on mismatch", () => {
  const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "binding-campaign" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const result = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) });
  const otherCampaign = structuredClone(campaign) as Epic0441Campaign; otherCampaign.purpose = `${otherCampaign.purpose} changed`;
  assert.notEqual(epic0442SourceCampaignSha256(otherCampaign), epic0442SourceCampaignSha256(campaign));
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [result], expectedCampaign: otherCampaign }), /campaign hash does not match/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [result], expectedCampaignVersion: "v2" }), /version does not match/);

  const wrongAssignment = structuredClone(typedAssignment); wrongAssignment.campaign_receipt_sha256 = h("other-campaign");
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [wrongAssignment], results: [result] }), /payload hash is invalid/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: scorer.publicKey(), campaignReceipt, assignmentReceipts: [], results: [result] }), /no authenticated assignment/);
});

test("duplicate task arms, assignment replay, score replay, duplicate result, and nonce replay are rejected", () => {
  const replay = new InMemoryEpic0442ReplayAuthority(); const first = authority(replay);
  const campaignReceipt = first.scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "replay-campaign" });
  assert.throws(() => first.scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "replay-campaign" }), /already authenticated/);
  const typedAssignment = assignment(first.scorer, campaignReceipt, "typed_capability_chain");
  assert.throws(() => assignment(first.scorer, campaignReceipt, "typed_capability_chain"), /Duplicate campaign task\/arm/);
  const result = first.scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) });
  assert.throws(() => first.scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: evidence("typed_capability_chain"), verdict: verdict("authenticated_live_success", 0) }), /scoring was replayed/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment, typedAssignment], results: [result] }), /Duplicate assignment receipt/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [result, result] }), /Duplicate result for authenticated assignment/);

  const secondKeys = generateKeyPairSync("ed25519");
  const freshProcessSameReplay = new Epic0442ScorerAuthority({ runtimeMode: "development", privateKey: secondKeys.privateKey, replayAuthority: replay, now: () => now });
  assert.throws(() => freshProcessSameReplay.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "replay-campaign" }), /already authenticated/);
  assert.throws(() => verifyEpic0442AuthenticatedChain({ publicKey: first.scorer.publicKey(), campaignReceipt, assignmentReceipts: [typedAssignment], results: [] }), /exactly one authenticated result/);
});

test("invalid receipt lifetimes fail before consuming durable campaign or assignment replay slots", () => {
  const { scorer } = authority();
  assert.throws(() => scorer.issueCampaign({ campaign, campaignVersion: "lifetime-retry-v1", campaignNonce: "bad-lifetime-campaign", lifetimeSeconds: 31_536_001 }), /lifetime/);
  const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "lifetime-retry-v1", campaignNonce: "valid-lifetime-campaign", lifetimeSeconds: 86_400 });
  const invalid = {
    campaign,
    campaignReceipt,
    taskId: "r05_add_tag",
    configId: "epic0441_typed_v1",
    representation: "typed_capability_chain" as const,
    pairOrder: 1 as const,
    fixtureId: "snowdon-electrical-disposable-copy",
    fixtureSha256: h("fixture"),
    fixtureAdapterSha256: h("hidden-adapter"),
    promptId: "r05-holdout-wording-01",
    promptSha256: h("unseen prompt bytes"),
    substrate: "snowdon_electrical",
    provider: "operator_typed_planner",
    model: "deterministic-v1",
    actionPolicy: "apply_cleanup" as const,
    assignmentId: "lifetime-retry-assignment",
    assignmentNonce: "lifetime-retry-nonce"
  };
  assert.throws(() => scorer.issueAssignment({ ...invalid, lifetimeSeconds: 86_401 }), /lifetime/);
  const receipt = scorer.issueAssignment({ ...invalid, lifetimeSeconds: 3_600 });
  assert.equal(receipt.assignment_id, "lifetime-retry-assignment");
});

test("durable scorer replay survives fresh authority instances and separates namespaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epic0442-scorer-replay-"));
  try {
    const ledger = path.join(root, "scorer-replay.sqlite");
    assert.equal(new DurableEpic0442ReplayAuthority(ledger).reserve("campaign", "same-key"), true);
    assert.equal(new DurableEpic0442ReplayAuthority(ledger).reserve("campaign", "same-key"), false);
    assert.equal(new DurableEpic0442ReplayAuthority(ledger).reserve("assignment", "same-key"), true);
    assert.equal(new DurableEpic0442ReplayAuthority(ledger).reserve("result", "same-key"), true);
    assert.equal(new DurableEpic0442ReplayAuthority(ledger).reserve("result", "same-key"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task/provider self-scoring fields, arm mismatches, unsafe blocker claims, and malformed deltas are rejected", () => {
  const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "truth-boundary-campaign" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const selfScored = { ...evidence("typed_capability_chain"), claimed_outcome: "authenticated_live_success" } as Epic0442ExecutionEvidence;
  assert.throws(() => scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: selfScored, verdict: verdict("authenticated_live_success", 0) }), /unexpected or missing fields/);
  const wrongArm = evidence("dynamic_program");
  assert.throws(() => scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: wrongArm, verdict: verdict("authenticated_live_success", 0) }), /does not match its authenticated arm/);
  const malformedDelta = evidence("typed_capability_chain"); malformedDelta.element_delta.changed_ids = [4, 4];
  assert.throws(() => scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: malformedDelta, verdict: verdict("authenticated_live_success", 0) }), /unique and ascending/);

  const blockerEvidence = evidence("typed_capability_chain"); blockerEvidence.execution.status = "blocked"; blockerEvidence.preview.status = "blocked";
  const blockerVerdict: Epic0442ScorerVerdict = { ...verdict("authenticated_live_success", 0), outcome: "safe_blocker", reason_codes: ["capability_not_granted"] };
  assert.throws(() => scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: blockerEvidence, verdict: blockerVerdict }), /safe blocker cannot carry/);
});

test("safe_blocker, incorrect, and outcome_unknown remain distinct authenticated scorer outcomes", () => {
  const cases = ["safe_blocker", "incorrect", "outcome_unknown"] as const;
  for (const outcome of cases) {
    const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: `outcome-${outcome}` });
    const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain"); const observed = evidence("typed_capability_chain");
    if (outcome === "safe_blocker") {
      observed.execution.status = "blocked"; observed.preview.status = "blocked"; observed.apply = { status: "not_requested", authorization_sha256: null, receipt_sha256: null };
      observed.element_delta = { changed_ids: [], created_ids: [], deleted_ids: [] };
      observed.cleanup = { required: false, status: "not_required", restoration_receipt_sha256: null };
    } else if (outcome === "outcome_unknown") {
      observed.apply = { status: "outcome_unknown", authorization_sha256: h("uncertain-auth"), receipt_sha256: null };
      observed.cleanup = { required: true, status: "outcome_unknown", restoration_receipt_sha256: null };
    }
    const scorerVerdict: Epic0442ScorerVerdict = {
      ...verdict("authenticated_live_success", 0), outcome, reason_codes: [`scorer_${outcome}`]
    };
    const result = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: observed, verdict: scorerVerdict });
    assert.equal(result.verdict.outcome, outcome);
  }
});

test("source-only is explicit and production mode cannot issue scorer truth", () => {
  const production = authority(new InMemoryEpic0442ReplayAuthority(), "production");
  assert.throws(() => production.scorer.issueCampaign({ campaign, campaignVersion: "v1" }), /disabled in production/);

  const { scorer } = authority(); const campaignReceipt = scorer.issueCampaign({ campaign, campaignVersion: "v1", campaignNonce: "source-only-campaign" });
  const typedAssignment = assignment(scorer, campaignReceipt, "typed_capability_chain");
  const sourceOnly: Epic0442ExecutionEvidence = {
    ...evidence("typed_capability_chain"), evidence_tier: "source_only", revit_process: null, document: null,
    execution: { kind: "typed_tool_chain", status: "source_only", execution_receipt_sha256: null, program_sha256: null, tool_call_receipt_sha256s: [] },
    preview: { status: "source_only", receipt_sha256: null }, apply: { status: "source_only", authorization_sha256: null, receipt_sha256: null },
    element_delta: { changed_ids: [], created_ids: [], deleted_ids: [] }, metrics: { elapsed_ms: 0, turn_count: 0, rpc_count: 0 },
    cleanup: { required: false, status: "source_only", restoration_receipt_sha256: null }
  };
  const sourceVerdict: Epic0442ScorerVerdict = { ...verdict("authenticated_live_success", 0), outcome: "source_only", reason_codes: ["no_live_receipt"] };
  const result = scorer.score({ campaignReceipt, assignmentReceipt: typedAssignment, evidence: sourceOnly, verdict: sourceVerdict });
  assert.equal(result.verdict.outcome, "source_only"); assert.equal(result.authorizes_revit_execution, false); assert.equal(result.authorizes_revit_apply, false);
});
