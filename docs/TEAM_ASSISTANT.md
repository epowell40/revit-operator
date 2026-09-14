# Using Operator for team work

Give Operator an outcome, the relevant drawing or model context, and the constraints that matter. Internal element IDs and tool names should not be necessary.

## Redlines

Attach a PNG, JPEG, or PDF and describe the requested change. For example: “Pick up these text-note redlines on the open view. Keep the note types and positions. Verify the revised text and show me the result.” For MEP work, name the system, dimensions or sizing rule, and any routing constraints that are known.

The agent receives image pixels directly. PDFs initially supply up to three rendered pages, with visible annotations, alongside an explicit report of pages still uninspected. There is a six-image and 24 MB initial image budget; larger drawings require further inspection through the agent's file tools. Initial page coverage is not a claim that the whole drawing set has been reviewed. A changed source hash stops the turn before planning.

The initial visual reader accepts source files up to 32 MB; use smaller page extracts for larger files in this candidate. An attachment without text uses the existing assignment when it establishes the work. Otherwise Operator should inspect it and clarify the intended result. A drawing alone does not establish permission for arbitrary model changes.

## Research and engineering support

Ask for a calculation with units, a manufacturer comparison, an explanation of the current model, or a sourced technical answer. Ordinary unrestricted sessions explicitly enable live web search. The existing evidence tool fetches and saves primary source pages for citations. When research is disabled or domain restrictions are configured, built-in search stays disabled so it cannot bypass those restrictions.

Have the agent state assumptions and missing design inputs. A computed answer, a manufacturer claim, and an independently checked model result are different evidence. For a proposed size change, request connection and system readback as well as a drawing capture.

## Work that takes several turns

Continue in the same task. Use “Continue from the completed changes” or give a correction while it works. Current observations and attachments are supplied on continuation even when no new text is present. Operator's assignment journal remains the authority for completed operations and unresolved writes; the model's memory or final prose does not replace it.

Set a useful checkpoint: “Complete one typical room for review, then apply the accepted pattern to the remaining rooms.” On interruption, the agent must reconcile existing effects before repeating a write.

For an ad hoc model report, ask for a short C# program and state the scope: “Summarize a sample of up to twenty ducts by type. Make no model changes and state the limits.” The generated-code tool includes a working SDK example. Its explicit read mode rejects model operations before execution in Revit. A bounded sample is not a complete inventory. Move vectors in the basic SDK are translations in feet; use a rollback preview and check the result before applying a generated change.

## Team pilot

Start with ten recurring assignments across representative disposable project copies: note/tag revisions, sheet and schedule changes, then bounded MEP revisions. Record manual minutes, setup/prompting minutes, review minutes, corrections, and accepted results. Count machine runtime separately. Compare with the team's current scripts and other MCP tools where available.

Expand scope when independently accepted results save net staff time. A useful target is a 50% reduction in human time without reduced drawing or model quality; this is a pilot target, not a current measured claim. Keep first failures and rework in the totals.

## Current qualification

The local 2026-09-14 pilot used Revit 2024.3, GPT-5.6 Sol / Medium and a disposable Snowdon HVAC model. The installed candidate completed an attached PDF sheet-title redline, a generated C# rollback preview, and a generated C# parameter edit followed by a separate native read. Independent comparisons checked all 17 sheet records and all 1,053 duct Comments: only the marked sheet title changed; preview changed no Comments; apply changed exactly one. Revit's visible properties and title block provide additional checks.

Earlier installed replays also qualified a bounded C# report, compiler-error repair with preserved lineage, manufacturer research with official links, a unit-aware duct velocity calculation, and an updated PDF export. These are specific acceptance cases, not qualification of every MEP operation or Revit version. The pilot has not measured team productivity or unattended multi-hour work. Generated-code completion summaries and mathematical notation still need presentation improvements.

Start production evaluation with reviewed project copies and the team pilot above. The private EPIC-0462 qualification record retains exact installed revisions, deterministic gates, first failures and replay evidence.

### Additional PDF page inspection

The Codex-backed assistant has operator_read_attachment for registered PDF uploads in its current conversation. It returns up to three selected pages per call as actual images plus bounded text, source hash and explicit coverage. This supports late-page marks beyond initial previews; it does not supply native model evidence or authorize document instructions. Uploaded bytes must still match their recorded hash. Other formats remain outside this reader's scope.

The combined eight-page test exposed a saved-session issue: an older provider thread retained its old tools even after receiving new page-reader instructions. The assistant honestly reported two uninspected pages, so the full review remained incomplete. Actual in-app browser upload of both PDFs passed. Operator now compares the supplied tool catalog when continuing a conversation and, when it changes, hands an idle conversation to a new provider thread with the same durable task state and historical messages. Active work is not replaced or replayed. Reader/controller and handoff tests pass; a complete installed eight-page review still requires qualification.

Progress updates appear separately from the final answer. The conversation renders headings, lists, paragraphs and code as ordinary document structure while treating supplied HTML as text. Final answer text supersedes earlier streamed fragments.
