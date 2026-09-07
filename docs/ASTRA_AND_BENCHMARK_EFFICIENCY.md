# Model comparison readiness and context efficiency

Reviewed 2026-09-06. This is implementation guidance, not a benchmark result.

The planned configurations are `gpt-5.6-sol` / `medium`, `gpt-5.6-luna` / `max`,
and `gpt-6-astra` / `medium`. Keep the ordinary Sol default. Run targeted
qualification first and report readiness before starting expensive full runs.
Freeze the same corpus, fixtures, scoring, prompt policy and budgets across
comparisons. Record any model-specific changes as a separate configuration.

## Official Astra guidance applied to Operator

[Astra's model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
supports medium reasoning. Standard list prices per million tokens are $10
input, $1 cache read, $12.50 cache write and $50 output; input/cache rates double
and output rises 50% above 272,000 input tokens. These are estimates, not invoices.

The [official model guide](https://developers.openai.com/api/docs/guides/latest-model)
recommends explicit follow-through, auditing skill instructions for conflicting
approval rules, concise reporting, and verification proportionate to the work.
For Operator: resolve routine details from model evidence, perform authorized
work, verify once with independent evidence, and ask only for consequential
missing information. Preserve requested review checkpoints and uncertain-edit
recovery. Avoid adding a mandatory preview or repeated approval stage.

Astra tool calling uses Responses; unsupported sampling parameters must be
omitted. Operator's benchmark uses Codex app-server 0.149.0, not direct Responses
requests. Verify model availability and actual model/effort receipts on that
pinned runtime before qualification. Do not copy newer API fields into its
generated protocol types or assume app-server exposes every API feature.

## Cache and compaction policy

[Prompt caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching)
requires matching rendered prefixes and eligible breakpoints. Keep instructions
and tool definitions stable, append new conversation items, and measure actual
cache reads and writes. A shared prefix alone does not guarantee reuse between
different tasks. Compaction can reduce cache hits while still lowering total
cost. Do not pad prompts, share task histories across benchmark cases, or add
unsupported cache controls to chase a higher hit rate.

The [app-server reference](https://learn.chatgpt.com/docs/app-server)
documents `thread/compact/start` and `contextCompaction` lifecycle events. Manual
compaction is asynchronous. Do not trigger it during unresolved native work or
replace the canonical assignment ledger with a generated summary.

## Repository mechanisms and audit findings

- `codex_thread_lifecycle.ts` persists and resumes a session's thread. A loaded
  thread is reused rather than recreated for every continuation. Missing threads
  are recorded explicitly before replacement.
- `codex_brain.ts` keeps changing environment summaries in per-turn input rather
  than duplicating them in base instructions. A regression changes recorded
  environment failures and verifies the base prefix remains identical. Audit
  changing reference-library content and tool ordering before assuming prefix
  stability across restarts or different tasks. Installed cache improvement
  still needs measurement; a source-level stability check is not a savings claim.
- `evidence/model_context_budget.ts` bounds projections to 8 KiB per item and
  32 KiB per request by default. Full evidence remains stored with focused
  retrieval. These byte limits are not the Codex context-compaction threshold.
- `codex_dynamic_result_adapter.ts` preserves focused evidence retrieval and
  error details. Compaction must retain truncation markers; a shortened result
  cannot prove absence or full inventory coverage.
- `model_call_telemetry.ts` retains provider cache-read/write and reasoning usage.
  The benchmark summary now reports cache-write totals, measured read fraction,
  missing/invalid counters, peak input and long-context calls. Missing counters
  leave cost incomplete rather than silently becoming zero.
- `codex_turn_model_telemetry.ts` records completed compactions for the observed
  turn with duplicate protection. These events are diagnostics, not proof of a
  completed edit or an additional provider call. Manual compactions outside an
  observed turn are not included by this observer.

## Qualification still required

Measure fresh targeted tasks before and after changes: provider calls, total
input, cache reads/writes, output/reasoning, repeated discovery, compaction
events, retained-evidence retrieval and verified work. Include failed work in
cost totals. Preserve nulls when counters are absent. Keep list-price estimates
separate from account billing and tools/services charged separately.

Exercise a long task across actual compaction and controller restart, checking
that target identities, requested values, outstanding verification, user answers
and unknown effects survive without duplicate edits. Check fresh-task isolation
separately from within-task cache reuse. Do not lower the compaction threshold
or increase context length without measured cost and completion evidence.

Before Astra's full run, inspect the exact runtime-visible skills and instruction
bundle, verify actual model selection on a small case, and retain that bundle's
hash. Documentation review does not establish model access, live compatibility,
cost savings, or readiness of the complete benchmark.

The workstation's read-only `model/list` check on Codex CLI 0.149.0 on
2026-09-07 listed Sol/medium and Luna/max but did not list Astra. Resolve
supported runtime availability before a paid Astra turn. Do not enable an
unreviewed compatibility override or treat model documentation as access proof.

Request coverage is separate from receipt integrity. The Sidecar records each
Codex delegation attempt before transport, and the backend returns a bound
provider-turn record on normal and interrupted completion. The benchmark retains
coverage across clarification turns and requires matching raw response IDs and
turn IDs. Missing or contradictory turn records make comparison and total-cost
accounting incomplete; previously observed cost is retained separately. Old
traces lacking these records do not acquire completeness during rescoring.

This detects missing whole turns and missing declared receipts. It cannot prove
that the provider runtime emitted every internal response event. In particular,
a resumed or compacted turn with no raw receipts remains unqualified even when
cumulative usage snapshots exist. These snapshots are diagnostics, never
synthetic response receipts, summed billable usage, or a zero-cost claim. This
coverage currently qualifies the direct Codex delegation lane; it does not
establish equivalent request coverage for other provider execution lanes.
