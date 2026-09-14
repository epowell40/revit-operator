# Assistant conversation components

Generic local assistant components, independent of hosted authentication and deployment.

- `context_reply.mjs` recognizes only simple model, connection, view, and selection questions. It requires session authorization and reads native UI identity through the protected ping response within a five-second deadline. Revit publishes immutable model, view, and selection values from its UI events and invalidates them during document/view transitions. Older add-ins fall back to the ordinary context read. Caller-provided model identity is never used. Attachments, explicit task bindings, tool continuations, and mixed work requests retain the normal agent route.
- `conversation_ui.mjs` provides short progress summaries and inert inline text formatting.
- `conversation.css` supplies a conversation-first layout with optional work details and settings.

The Desktop integration copies these assets into its runtime so bundle dependency verification covers them. The backend test suite exercises the public modules; Desktop route and UI tests cover the integration. A direct context answer is conversational information, not an assignment completion or a model change receipt.

The ping snapshot has `authority: "ui_identity_only"`; its capture time records the last Revit UI update, not a new model inspection. Protected ping reads can bypass the serialized model-operation lane because they access only serialized values, never the Autodesk API from an HTTP thread. Detailed inspection and change verification still require ordinary native API work and its evidence contracts.
