# Assistant conversation components

Generic local assistant components, independent of hosted authentication and deployment.

- `conversation_intake.mjs` sends the complete request, after session authorization, to the backend's model-based intake agent. The agent can answer conversational questions from bounded live UI identity and recent conversation, or hand the unchanged request to the working agent for inspection or a longer task. There is no phrase or keyword classifier in this route. Attachments, explicit task bindings and tool continuations retain their existing execution lifecycle. An unavailable, uncertain or timed-out classifier falls back to the working agent.
- `context_reply.mjs` supplies native snapshot validation and legacy context-reply compatibility. Current Desktop intake uses the semantic agent above. Revit publishes immutable model, view and selection values from UI events and invalidates them during transitions; old add-ins fall back to the ordinary context read. Caller-provided model identity is never used.
- `conversation_ui.mjs` provides short progress summaries and inert inline text formatting.
- `conversation.css` supplies a conversation-first layout with optional work details and settings.
- `composer_draft.mjs` saves unsent text and attachment bytes in local, per-tab IndexedDB recovery records. Records expire after 24 hours, are bounded to eight attachments and 144 MiB of encoded string storage, and contain no execution grants or task controls. The UI clears the record after submission, new chat or sign-out, reports failed recovery honestly, and never resends a recovered draft automatically.
- `revit_health_display.mjs` identifies cached health as display-only. Idle polling returns an empty display state when no cache exists; explicit actions use their normal model checks.

The Desktop integration copies these assets into its runtime so bundle dependency verification covers them. The backend test suite exercises the public modules; Desktop route and UI tests cover the integration. A direct context answer is conversational information, not an assignment completion or a model change receipt.

The ping snapshot has `authority: "ui_identity_only"`; its capture time records the last Revit UI update, not a new model inspection. Protected ping reads can bypass the serialized model-operation lane because they access only serialized values, never the Autodesk API from an HTTP thread. Detailed inspection and change verification still require ordinary native API work and its evidence contracts.

The backend uses an isolated, tool-free Codex turn with structured output and low
reasoning effort. `OPERATOR_INTAKE_MODEL` optionally selects a separate intake
model; by default it follows the backend's Codex/OpenAI model setting.
`OPERATOR_INTAKE_REASONING_EFFORT` can override the low reasoning default. The existing Codex login
is sufficient. A configured Responses backend uses its existing API credentials.
Each intake gets a fresh provider context with bounded, session-owned historical
messages; it cannot inherit another session's model thread or change a saved
assignment. A quick answer is saved as historical conversation, not canonical
model evidence. A title suggesting "HVAC" supports a labeled inference, not proof
of model contents. The classifier's deadline is eight seconds; late results cannot
append an answer after the handoff.

A handoff immediately updates the existing compact progress line (for example,
"Let me check."). The working agent receives the original request and produces
the final reply. Progress text is not a saved answer or task-completion receipt.

- composer_intake.mjs captures the exact Send text/attachment bytes before asynchronous recovery or freshness work and excludes duplicate pending/backend submissions. Computer steering remains available after intake.
