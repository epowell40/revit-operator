import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertGeneralRevitCandidateIdentity,
  assertGeneralRevitCandidatePolicyIdentity,
  generalRevitCandidatePolicyHashes,
  generalRevitCandidateSourceIdentity
} from "../src/benchmark/general_revit_candidate_identity_preflight.js";
import { sha256Value } from "../src/benchmark/protocol_v2_hash.js";
import { GENERAL_REVIT_EVALUATOR_V2 } from "../src/benchmark/protocol_v2_types.js";

const POLICY_FILES = {
  tool_registry_sha256: "tool_certification_candidates.v1.json",
  tool_exposure_sha256: "tool_exposure_policy.v1.json",
  certification_policy_sha256: "tool_certification_evidence.v1.json"
} as const;

const SOURCE_IDENTITY = {
  public_revision: "a".repeat(40),
  private_revision: "b".repeat(40),
  private_public_pin: "a".repeat(40),
  worktree_clean: true
};

function sha256(bytes: string): string {
  return crypto.createHash("sha256").update(bytes, "utf8").digest("hex");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

test("candidate source identity binds the owning Git commit and rejects untracked source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-identity-"));
  const backend = path.join(root, "backend");
  try {
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, "tracked.ts"), "export const value = 1;\n", "utf8");
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Identity Test");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fixture");
    const revision = git(root, "rev-parse", "HEAD").toLowerCase();
    assert.deepEqual(generalRevitCandidateSourceIdentity(backend), {
      public_revision: revision,
      private_revision: null,
      private_public_pin: null,
      worktree_clean: true
    });
    fs.writeFileSync(path.join(backend, "untracked.ts"), "export const value = 2;\n", "utf8");
    assert.equal(generalRevitCandidateSourceIdentity(backend).worktree_clean, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private candidate source identity binds its exact public gitlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-pin-"));
  const publicRoot = path.join(root, "public-origin");
  const privateRoot = path.join(root, "private");
  try {
    fs.mkdirSync(publicRoot);
    fs.writeFileSync(path.join(publicRoot, "public.ts"), "export const value = 1;\n", "utf8");
    git(publicRoot, "init", "--quiet");
    git(publicRoot, "config", "user.email", "test@example.invalid");
    git(publicRoot, "config", "user.name", "Identity Test");
    git(publicRoot, "add", ".");
    git(publicRoot, "commit", "--quiet", "-m", "public fixture");
    fs.mkdirSync(path.join(privateRoot, "operator-backend"), { recursive: true });
    fs.writeFileSync(path.join(privateRoot, "operator-backend", "private.ts"), "export const value = 1;\n", "utf8");
    git(privateRoot, "init", "--quiet");
    git(privateRoot, "config", "user.email", "test@example.invalid");
    git(privateRoot, "config", "user.name", "Identity Test");
    git(privateRoot, "add", ".");
    git(privateRoot, "commit", "--quiet", "-m", "private fixture");
    execFileSync("git", ["-C", privateRoot, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", publicRoot, "public"], { windowsHide: true });
    git(privateRoot, "commit", "--quiet", "-am", "pin public fixture");
    git(path.join(privateRoot, "public"), "config", "user.email", "test@example.invalid");
    git(path.join(privateRoot, "public"), "config", "user.name", "Identity Test");
    const current = generalRevitCandidateSourceIdentity(path.join(privateRoot, "operator-backend"));
    assert.equal(current.private_revision, git(privateRoot, "rev-parse", "HEAD").toLowerCase());
    assert.equal(current.public_revision, git(path.join(privateRoot, "public"), "rev-parse", "HEAD").toLowerCase());
    assert.equal(current.private_public_pin, current.public_revision);
    assert.equal(current.worktree_clean, true);
    fs.writeFileSync(path.join(privateRoot, "public", "public.ts"), "export const value = 2;\n", "utf8");
    git(path.join(privateRoot, "public"), "commit", "--quiet", "-am", "advance public fixture");
    const advanced = generalRevitCandidateSourceIdentity(path.join(privateRoot, "operator-backend"));
    assert.notEqual(advanced.private_public_pin, advanced.public_revision);
    assert.equal(advanced.worktree_clean, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; values: Record<keyof typeof POLICY_FILES, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-policy-identity-"));
  const config = path.join(root, "config");
  fs.mkdirSync(config, { recursive: true });
  const values = {
    tool_registry_sha256: "{\n  \"registry\": [\"read\"]\n}\n",
    tool_exposure_sha256: "{\"exposure\":true}\n",
    certification_policy_sha256: "{\"evidence\":{\"required\":true}}\n"
  };
  for (const [key, filename] of Object.entries(POLICY_FILES) as Array<[keyof typeof POLICY_FILES, string]>) {
    fs.writeFileSync(path.join(config, filename), values[key], "utf8");
  }
  return { root, values };
}

test("candidate policy identity uses the exact bytes of all three authoritative policy files", () => {
  const { root, values } = fixture();
  try {
    const actual = generalRevitCandidatePolicyHashes(root);
    assert.deepEqual(actual, {
      tool_registry_sha256: sha256(values.tool_registry_sha256),
      tool_exposure_sha256: sha256(values.tool_exposure_sha256),
      certification_policy_sha256: sha256(values.certification_policy_sha256)
    });
    assert.doesNotThrow(() => assertGeneralRevitCandidatePolicyIdentity({
      backend_root: root,
      declared: actual,
      rescore_only: false
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("byte-distinct policy representations cannot share a candidate identity", () => {
  const { root } = fixture();
  try {
    const original = generalRevitCandidatePolicyHashes(root);
    fs.writeFileSync(path.join(root, "config", POLICY_FILES.tool_exposure_sha256), "{ \"exposure\": true }\n", "utf8");
    const changed = generalRevitCandidatePolicyHashes(root);
    assert.notEqual(changed.tool_exposure_sha256, original.tool_exposure_sha256);
    assert.throws(() => assertGeneralRevitCandidatePolicyIdentity({
      backend_root: root,
      declared: original,
      rescore_only: false
    }), /policy identity preflight failed.*before fixture, Assignment, provider, or Revit work.*tool_exposure_sha256/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or malformed live candidate policy identities fail closed", () => {
  const { root } = fixture();
  try {
    const current = generalRevitCandidatePolicyHashes(root);
    for (const declared of [
      {},
      { ...current, certification_policy_sha256: "not-a-digest" },
      { ...current, tool_registry_sha256: "0".repeat(64) }
    ]) {
      assert.throws(() => assertGeneralRevitCandidatePolicyIdentity({
        backend_root: root,
        declared,
        rescore_only: false
      }), /policy identity preflight failed/i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("historical rescore bypasses current-checkout policy comparison", () => {
  const missingRoot = path.join(os.tmpdir(), `operator-policy-missing-${crypto.randomUUID()}`);
  assert.doesNotThrow(() => assertGeneralRevitCandidatePolicyIdentity({
    backend_root: missingRoot,
    declared: {},
    rescore_only: true
  }));
});

test("historical rescore bypasses every current-checkout candidate identity comparison", () => {
  const missingRoot = path.join(os.tmpdir(), `operator-candidate-missing-${crypto.randomUUID()}`);
  assert.equal(assertGeneralRevitCandidateIdentity({
    backend_root: missingRoot,
    draft: {
      corpus: { sha256: "", original_case_manifest_sha256: "", case_hashes: {} },
      evaluator_version: "",
      fixture_adapter: { version: "", fixtures: [] },
      requested_agent: { model: "", reasoning_effort: "" },
      policy_hashes: { tool_registry_sha256: "", tool_exposure_sha256: "", certification_policy_sha256: "" },
      source_revisions: { public: "", private: "" }
    },
    corpus_value: null,
    original_manifest_path: path.join(missingRoot, "missing.json"),
    selected_cases: [],
    fixture_adapter_version: "",
    selected_fixtures: [],
    requested_agent: { model: null, reasoning_effort: null },
    source_identity: null,
    rescore_only: true
  }), null);
});

test("candidate identity binds corpus, selected cases, fixture bytes, evaluator, model, and policy before live work", () => {
  const { root } = fixture();
  const manifestPath = path.join(root, "corpus.json");
  const fixturePath = path.join(root, "fixture.rvt");
  const corpus = { schema: "corpus/v1", cases: [{ case_id: "q01", prompt: "Count model elements." }] };
  fs.writeFileSync(manifestPath, JSON.stringify(corpus) + "\n", "utf8");
  fs.writeFileSync(fixturePath, "fixture-bytes", "utf8");
  const policyHashes = generalRevitCandidatePolicyHashes(root);
  const draft = {
    corpus: {
      sha256: sha256Value(corpus),
      original_case_manifest_sha256: crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
      case_hashes: { q01: sha256Value(corpus.cases[0]) }
    },
    evaluator_version: GENERAL_REVIT_EVALUATOR_V2,
    fixture_adapter: {
      version: "fixture-adapter/v1",
      fixtures: [{ identity: "fixture", rvt_sha256: crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex") }]
    },
    requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    policy_hashes: policyHashes,
    source_revisions: { public: SOURCE_IDENTITY.public_revision, private: SOURCE_IDENTITY.private_revision }
  };
  try {
    assert.deepEqual(assertGeneralRevitCandidateIdentity({
      backend_root: root,
      draft,
      corpus_value: corpus,
      original_manifest_path: manifestPath,
      selected_cases: corpus.cases,
      fixture_adapter_version: "fixture-adapter/v1",
      selected_fixtures: [{ identity: "fixture", file_path: fixturePath }],
      requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
      source_identity: SOURCE_IDENTITY,
      rescore_only: false
    }), {
      policy_hashes: policyHashes,
      corpus_sha256: sha256Value(corpus),
      selected_case_ids: ["q01"],
      selected_fixture_ids: ["fixture"],
      source_revisions: { public: SOURCE_IDENTITY.public_revision, private: SOURCE_IDENTITY.private_revision }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate identity rejects each stale reproducible envelope surface before live work", () => {
  const { root } = fixture();
  const manifestPath = path.join(root, "corpus.json");
  const fixturePath = path.join(root, "fixture.rvt");
  const corpus = { schema: "corpus/v1", cases: [{ case_id: "q01", prompt: "Count model elements." }] };
  fs.writeFileSync(manifestPath, JSON.stringify(corpus) + "\n", "utf8");
  fs.writeFileSync(fixturePath, "fixture-bytes", "utf8");
  const policyHashes = generalRevitCandidatePolicyHashes(root);
  const base = {
    backend_root: root,
    draft: {
      corpus: {
        sha256: sha256Value(corpus),
        original_case_manifest_sha256: crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
        case_hashes: { q01: sha256Value(corpus.cases[0]) }
      },
      evaluator_version: GENERAL_REVIT_EVALUATOR_V2,
      fixture_adapter: {
        version: "fixture-adapter/v1",
        fixtures: [{ identity: "fixture", rvt_sha256: crypto.createHash("sha256").update(fs.readFileSync(fixturePath)).digest("hex") }]
      },
      requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
      policy_hashes: policyHashes,
      source_revisions: { public: SOURCE_IDENTITY.public_revision, private: SOURCE_IDENTITY.private_revision }
    },
    corpus_value: corpus,
    original_manifest_path: manifestPath,
    selected_cases: corpus.cases,
    fixture_adapter_version: "fixture-adapter/v1",
    selected_fixtures: [{ identity: "fixture", file_path: fixturePath }],
    requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    source_identity: SOURCE_IDENTITY,
    rescore_only: false
  };
  try {
    const badInputs = [
      { ...base, draft: { ...base.draft, corpus: { ...base.draft.corpus, sha256: "0".repeat(64) } } },
      { ...base, draft: { ...base.draft, corpus: { ...base.draft.corpus, original_case_manifest_sha256: "0".repeat(64) } } },
      { ...base, draft: { ...base.draft, corpus: { ...base.draft.corpus, case_hashes: { q01: "0".repeat(64) } } } },
      { ...base, draft: { ...base.draft, evaluator_version: "stale-evaluator" } },
      { ...base, draft: { ...base.draft, fixture_adapter: { ...base.draft.fixture_adapter, version: "stale-adapter" } } },
      { ...base, draft: { ...base.draft, fixture_adapter: { ...base.draft.fixture_adapter, fixtures: [{ identity: "fixture", rvt_sha256: "0".repeat(64) }] } } },
      { ...base, requested_agent: { model: "gpt-5.6-luna", reasoning_effort: "medium" } },
      { ...base, draft: { ...base.draft, source_revisions: { ...base.draft.source_revisions, public: "c".repeat(40) } } },
      { ...base, draft: { ...base.draft, source_revisions: { ...base.draft.source_revisions, private: "c".repeat(40) } } },
      { ...base, source_identity: { ...SOURCE_IDENTITY, private_public_pin: "c".repeat(40) } },
      { ...base, source_identity: { ...SOURCE_IDENTITY, worktree_clean: false } }
    ];
    for (const input of badInputs) {
      assert.throws(() => assertGeneralRevitCandidateIdentity(input), /candidate identity preflight failed.*before fixture, Assignment, provider, or Revit work/i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the live runner verifies candidate identity before Sidecar, fixture, Assignment, provider, or Revit work", () => {
  const source = fs.readFileSync("src/tools/general_revit_capability_acceptance.ts", "utf8");
  const identityPreflight = source.indexOf("assertGeneralRevitCandidateIdentity({");
  const configRequest = source.indexOf("const [config, grant] = rescoreOnly");
  const fixtureReadiness = source.indexOf("let fixturePreflight: JsonRecord = {};");
  assert.ok(identityPreflight >= 0, "runner must invoke the shared candidate-policy identity preflight");
  assert.ok(configRequest > identityPreflight, "identity preflight must precede Sidecar and all live task work");
  assert.ok(fixtureReadiness > identityPreflight, "identity preflight must precede fixture and all live task work");
});
