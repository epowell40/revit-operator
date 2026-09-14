# Assistant conversation components

Generic local assistant components, independent of hosted authentication and deployment.

- `context_reply.mjs` recognizes only simple model, connection, view, and selection questions. It requires session authorization and a fresh native context read, enforces a five-second deadline, and never falls back to caller-provided model identity. Attachments, explicit task bindings, tool continuations, and mixed work requests retain the normal agent route.
- `conversation_ui.mjs` provides short progress summaries and inert inline text formatting.
- `conversation.css` supplies a conversation-first layout with optional work details and settings.

The Desktop integration copies these assets into its runtime so bundle dependency verification covers them. The backend test suite exercises the public modules; Desktop route and UI tests cover the integration. A direct context answer is conversational information, not an assignment completion or a model change receipt.
