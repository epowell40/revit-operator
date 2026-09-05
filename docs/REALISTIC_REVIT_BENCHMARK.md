# Realistic engineer-request benchmark

`revit-capability-acceptance.v2.json` is a new, explicit 100-case corpus. The
historical v1 corpus remains unchanged and is still the default for historical
tools. Select v2 with `-CorpusManifest` in `run_general_revit_benchmark.ps1`, or
`--corpus-manifest` in the runner and Protocol V2 projection/rescore utilities.
The envelope must bind the selected manifest bytes and canonical case hashes.
Never rescore an old trace against rewritten prompts.

The revision changes 57 production prompts, removes hidden prior-case work,
and retains 25 deliberately underspecified requests. Normal equipment Marks,
sheet numbers, selections and requested values are legitimate engineering
context. Internal IDs, lowest-ID instructions and prescribed API recipes are
not supplied to the candidate. Case IDs retain their historical taxonomy;
the fallback/code-execution cases now test useful deliverables without forcing
an implementation route. Forced-route diagnostics belong in separate runs.

Every case declares its starting view and selection state. Run against a
disposable directory containing pristine copies of the three Snowdon samples,
never the installed originals. Close without saving and reopen before every
committed case, including consecutive cases on the same model. Selection setup
is outside scored actions; model elements must have exact source-view evidence,
and annotations must not belong to a different view. Verify an exact selection
or an explicitly empty selection after setup. Preflight all declared views and
selection categories before freezing the live campaign.
The runner rechecks every envelope-bound fixture file before each case. An
explicitly saved mutation stops the campaign before it can contaminate another
case; retain the evidence and restore pristine files before a new run.

## Scoring

The runtime evaluator measures execution and verification signals. Its score
is provisional for this corpus. Each case also contains frozen independent
delivery criteria, collateral checks and intentional missing inputs. These
fields are evaluator-only; submit only the production prompt and the normal
view/selection context to the candidate.

The runner writes an `.independent-review.json` companion with every case
pending. An independent reviewer must inspect retained native before/after
records, actual artifacts and relevant UI evidence, and cite that evidence for
each passing criterion. A generic success receipt, candidate prose, or a
completed Assignment is insufficient. The review utility validates identity
and completeness; it does not judge whether a cited artifact proves a claim.
Keep the generated packet immutable and save filled reviews separately.

Report delivered, verified no-op, clarification, fixture-blocked, failed and
unverified separately. The strict delivery rate counts delivered cases over
all selected cases. Questions and fixture blockers are useful observations,
but do not earn delivery credit. Do not publish a final delivery percentage
while reviews are pending. The legacy preview assertions are preserved in v1;
v2 keeps only the unchanged project-inventory oracle and uses independent
review for the rewritten task semantics.

## Campaign

Freeze source revisions, installed candidate, corpus, fixture bytes, policy,
instructions, model/reasoning and limits. Qualify representative real UI tasks,
then run the same ten-case canary twice with fresh identities and clean models.
Inspect evidence completeness and consistent setup before running all 100.
Preserve unsuccessful trials. General repairs require regression coverage and
new candidate identities; targeted reruns never replace the original baseline.
Subsequent model comparisons reuse the exact corpus, fixtures and grading
criteria. Record any source or limit changes as a new campaign.
