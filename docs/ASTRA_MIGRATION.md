# GPT-6 Astra migration decision

Decision on 2026-09-13: retain GPT-5.6 Sol as the default for EPIC-0462. Prepare a separate migration after qualifying the new visual-input and research behavior. Do not overwrite a user's chosen model or migrate every auxiliary interpreter to the flagship.

The installed Codex app-server is exactly 0.149.0, with no compatibility override. A fresh `model/list` returned Sol, Terra and Luna, with no Astra entry and no next page. This establishes what this runtime advertises; it does not establish account-wide Astra unavailability. Verify the selected runtime before a cutover.

## Official guidance reviewed

The [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra) supports text/image input and structured tool work. The [migration and prompting guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) calls for preserving effective reasoning effort, replacing `none`/`minimal` with `low`, using Responses for tool calls, and removing unsupported sampling/logprob settings. Review cached-prefix behavior when changing effort. Audit conflicting skill instructions, unnecessary approval pauses, response length and testing effort. These are compatibility requirements and prompt considerations, not proof that Astra improves this application.

## Concrete implementation boundary

- Keep the canonical Codex harness. Check its protocol and advertised models; if a runtime update is required, regenerate the pinned protocol and qualify it first. Do not bypass the existing compatibility check.
- Add `gpt-6-astra` to the Desktop model picker and normalization. The current integration checkout keeps these files at `operator-desktop/public/{index.html,app.js}`; verify their location when implementing the migration. Preserve saved Sol/Terra/Luna selections and existing reasoning preferences.
- Add model-specific effort validation at `apps/operator-backend/src/speed_config.ts`. Map unsupported `none` to `low` for Astra; do not silently change other model settings.
- Verify the actual start/resume/turn requests and model telemetry. Prevent silent fallback to Sol. Keep the existing mid-turn steering, durable effects, instruction receipts and compaction ownership.
- Review `codex_brain.ts`, loaded skills and project guidance together for contradictory permission, task-completion and engineering-default instructions. Keep authorization and transaction enforcement in code.
- Audit auxiliary Responses callers independently before changing their model. Preserve their output contracts and cost/latency role. Do not rewrite historical benchmark data or claim a global migration from a picker change.

## Cutover evidence

Run the same untouched inputs on Sol and Astra: image-only redline, multi-page PDF with stated coverage, manufacturer research with citations, engineering calculation with missing design inputs, generated-code compile/repair, MEP connectivity/readback, and an interrupted multi-step assignment. Record requested and effective model, reasoning, provider usage, wall time, human review/rework, verified native effects and the first failure.

Promote Astra only with no regression in unauthorized writes, duplicate effects, evidence integrity or user intent, and a practical quality or time benefit on the team's tasks. Use the same source revision and fixture resets for the comparison. Keep a documented one-setting rollback to Sol. The current branch has not performed this comparative qualification.
