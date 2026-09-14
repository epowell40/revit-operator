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

## Team pilot

Start with ten recurring assignments across representative disposable project copies: note/tag revisions, sheet and schedule changes, then bounded MEP revisions. Record manual minutes, setup/prompting minutes, review minutes, corrections, and accepted results. Count machine runtime separately. Compare with the team's current scripts and other MCP tools where available.

Expand scope when independently accepted results save net staff time. A useful target is a 50% reduction in human time without reduced drawing or model quality; this is a pilot target, not a current measured claim. Keep first failures and rework in the totals.

This guide describes implementation behavior and an evaluation method. See the current candidate's qualification evidence before relying on a workflow in a production model.
