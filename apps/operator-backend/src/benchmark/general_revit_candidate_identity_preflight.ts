import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256File, sha256Value } from "./protocol_v2_hash.js";
import { GENERAL_REVIT_EVALUATOR_V2 } from "./protocol_v2_types.js";

export type GeneralRevitCandidatePolicyHashes = {
  tool_registry_sha256: string;
  tool_exposure_sha256: string;
  certification_policy_sha256: string;
};

type CandidateIdentityDraft = {
  corpus: {
    sha256: string;
    original_case_manifest_sha256: string;
    case_hashes: Record<string, string>;
  };
  evaluator_version: string;
  fixture_adapter: {
    version: string;
    fixtures: Array<{ identity: string; rvt_sha256: string }>;
  };
  requested_agent: { model: string; reasoning_effort: string };
  policy_hashes: GeneralRevitCandidatePolicyHashes;
  source_revisions: { public: string; private: string };
};

type CandidateIdentityResult = {
  policy_hashes: GeneralRevitCandidatePolicyHashes;
  corpus_sha256: string;
  selected_case_ids: string[];
  selected_fixture_ids: string[];
  source_revisions: { public: string; private: string | null };
};

export type GeneralRevitCandidateSourceIdentity = {
  public_revision: string;
  private_revision: string | null;
  private_public_pin: string | null;
  worktree_clean: boolean;
};

const POLICY_FILES: Readonly<Record<keyof GeneralRevitCandidatePolicyHashes, string>> = Object.freeze({
  tool_registry_sha256: "tool_certification_candidates.v1.json",
  tool_exposure_sha256: "tool_exposure_policy.v1.json",
  certification_policy_sha256: "tool_certification_evidence.v1.json"
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function gitText(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).trim();
}

function enclosingGitRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No enclosing Git checkout owns ${start}.`);
    current = parent;
  }
}

/**
 * Reads the exact commits which own the runner source. In the private
 * composition this also proves that the checked-out public core equals the
 * private gitlink, so the envelope cannot bind one public revision while the
 * process executes another.
 */
export function generalRevitCandidateSourceIdentity(backendRoot: string): GeneralRevitCandidateSourceIdentity {
  const root = enclosingGitRoot(backendRoot);
  const privateComposition = fs.existsSync(path.join(root, ".gitmodules"))
    && fs.existsSync(path.join(root, "public", ".git"));
  const rootRevision = gitText(root, ["rev-parse", "HEAD"]).toLowerCase();
  const dirty = gitText(root, ["status", "--porcelain=v1", "--untracked-files=normal"]).length > 0;
  if (!privateComposition) {
    return { public_revision: rootRevision, private_revision: null, private_public_pin: null, worktree_clean: !dirty };
  }
  const publicRoot = path.join(root, "public");
  return {
    public_revision: gitText(publicRoot, ["rev-parse", "HEAD"]).toLowerCase(),
    private_revision: rootRevision,
    private_public_pin: gitText(root, ["rev-parse", "HEAD:public"]).toLowerCase(),
    worktree_clean: !dirty
  };
}

/**
 * Derives the run-envelope policy identity from the exact source-controlled
 * bytes used by certification. These are intentionally byte digests rather
 * than parsed/canonical JSON digests: the envelope binds an exact candidate,
 * not merely a semantically similar policy object.
 */
export function generalRevitCandidatePolicyHashes(backendRoot: string): GeneralRevitCandidatePolicyHashes {
  const configRoot = path.resolve(backendRoot, "config");
  return {
    tool_registry_sha256: sha256File(path.join(configRoot, POLICY_FILES.tool_registry_sha256)),
    tool_exposure_sha256: sha256File(path.join(configRoot, POLICY_FILES.tool_exposure_sha256)),
    certification_policy_sha256: sha256File(path.join(configRoot, POLICY_FILES.certification_policy_sha256))
  };
}

export function generalRevitCandidateFixtureFiles(
  fixtureRoot: string,
  fixtures: Record<string, { sample_filename: string }>,
  identities: Iterable<string>
): Array<{ identity: string; file_path: string }> {
  return [...identities].map((identity) => {
    const filename = fixtures[identity]?.sample_filename;
    if (!filename) throw new Error(`General Revit candidate fixture identity '${identity}' is undefined.`);
    return { identity, file_path: path.isAbsolute(filename) ? filename : path.join(fixtureRoot, filename) };
  });
}

export function assertGeneralRevitCandidatePolicyIdentity(input: {
  backend_root: string;
  declared: unknown;
  rescore_only: boolean;
}): GeneralRevitCandidatePolicyHashes | null {
  // A retained historical run is scored against its bound envelope. It must
  // not be relabeled as today's checkout merely because the repository moved.
  if (input.rescore_only) return null;

  const declared = record(input.declared);
  let actual: GeneralRevitCandidatePolicyHashes;
  try {
    actual = generalRevitCandidatePolicyHashes(input.backend_root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "General Revit candidate policy identity preflight failed before fixture, Assignment, provider, or Revit work: "
      + `authoritative policy bytes were unavailable (${detail}).`
    );
  }

  const mismatches = (Object.keys(POLICY_FILES) as Array<keyof GeneralRevitCandidatePolicyHashes>)
    .filter((key) => {
      const candidate = String(declared[key] || "").trim().toLowerCase();
      return !/^[a-f0-9]{64}$/.test(candidate) || candidate !== actual[key];
    });
  if (mismatches.length > 0) {
    throw new Error(
      "General Revit candidate policy identity preflight failed before fixture, Assignment, provider, or Revit work: "
      + `envelope does not bind current ${mismatches.join(", ")}.`
    );
  }
  return actual;
}

/**
 * Verifies every run-envelope identity that can be reproduced locally before
 * a qualification flight contacts Sidecar or opens a fixture. Runtime-only
 * identities (for example the installed process and provider receipts) are
 * checked at their authoritative boundaries later in the flight.
 */
export function assertGeneralRevitCandidateIdentity(input: {
  backend_root: string;
  draft: CandidateIdentityDraft;
  corpus_value: unknown;
  original_manifest_path: string;
  selected_cases: ReadonlyArray<{ case_id: string }>;
  fixture_adapter_version: string;
  selected_fixtures: ReadonlyArray<{ identity: string; file_path: string }>;
  requested_agent: { model: string | null; reasoning_effort: string | null };
  source_identity: GeneralRevitCandidateSourceIdentity | null;
  rescore_only: boolean;
}): CandidateIdentityResult | null {
  if (input.rescore_only) return null;
  if (input.source_identity === null) throw new Error("Live candidate identity requires current source identity.");

  const policyHashes = assertGeneralRevitCandidatePolicyIdentity({
    backend_root: input.backend_root,
    declared: input.draft.policy_hashes,
    rescore_only: false
  })!;
  const mismatches: string[] = [];
  const corpusSha256 = sha256Value(input.corpus_value);
  if (String(input.draft.corpus.sha256).toLowerCase() !== corpusSha256) mismatches.push("corpus.sha256");
  try {
    if (String(input.draft.corpus.original_case_manifest_sha256).toLowerCase()
      !== sha256File(input.original_manifest_path)) {
      mismatches.push("corpus.original_case_manifest_sha256");
    }
  } catch {
    mismatches.push("corpus.original_case_manifest_sha256(unavailable)");
  }

  const selectedCaseIds = input.selected_cases.map((candidate) => candidate.case_id);
  if (new Set(selectedCaseIds).size !== selectedCaseIds.length) mismatches.push("selected_cases(duplicate)");
  for (const candidate of input.selected_cases) {
    if (String(input.draft.corpus.case_hashes[candidate.case_id] || "").toLowerCase() !== sha256Value(candidate)) {
      mismatches.push(`corpus.case_hashes.${candidate.case_id}`);
    }
  }
  if (input.draft.evaluator_version !== GENERAL_REVIT_EVALUATOR_V2) mismatches.push("evaluator_version");
  if (input.draft.fixture_adapter.version !== input.fixture_adapter_version) mismatches.push("fixture_adapter.version");

  const fixtureClaims = new Map<string, string>();
  for (const fixture of input.draft.fixture_adapter.fixtures) {
    if (fixtureClaims.has(fixture.identity)) mismatches.push(`fixture_adapter.fixtures.${fixture.identity}(duplicate)`);
    fixtureClaims.set(fixture.identity, String(fixture.rvt_sha256 || "").toLowerCase());
  }
  const selectedFixtureIds = input.selected_fixtures.map((fixture) => fixture.identity);
  if (new Set(selectedFixtureIds).size !== selectedFixtureIds.length) mismatches.push("selected_fixtures(duplicate)");
  for (const fixture of input.selected_fixtures) {
    try {
      if (fixtureClaims.get(fixture.identity) !== sha256File(fixture.file_path)) {
        mismatches.push(`fixture_adapter.fixtures.${fixture.identity}.rvt_sha256`);
      }
    } catch {
      mismatches.push(`fixture_adapter.fixtures.${fixture.identity}.rvt_sha256(unavailable)`);
    }
  }

  if (input.draft.requested_agent.model !== input.requested_agent.model) mismatches.push("requested_agent.model");
  if (input.draft.requested_agent.reasoning_effort !== input.requested_agent.reasoning_effort) {
    mismatches.push("requested_agent.reasoning_effort");
  }
  const declaredPublic = String(input.draft.source_revisions.public || "").toLowerCase();
  const declaredPrivate = String(input.draft.source_revisions.private || "").toLowerCase();
  if (declaredPublic !== input.source_identity.public_revision) mismatches.push("source_revisions.public");
  if (input.source_identity.private_revision !== null
    && declaredPrivate !== input.source_identity.private_revision) mismatches.push("source_revisions.private");
  if (input.source_identity.private_public_pin !== null
    && input.source_identity.private_public_pin !== input.source_identity.public_revision) {
    mismatches.push("source_revisions.private_public_pin");
  }
  if (!input.source_identity.worktree_clean) mismatches.push("source_revisions.worktree_dirty");
  if (mismatches.length > 0) {
    throw new Error(
      "General Revit candidate identity preflight failed before fixture, Assignment, provider, or Revit work: "
      + `envelope does not bind current ${mismatches.join(", ")}.`
    );
  }
  return {
    policy_hashes: policyHashes,
    corpus_sha256: corpusSha256,
    selected_case_ids: selectedCaseIds,
    selected_fixture_ids: selectedFixtureIds,
    source_revisions: {
      public: input.source_identity.public_revision,
      private: input.source_identity.private_revision
    }
  };
}
