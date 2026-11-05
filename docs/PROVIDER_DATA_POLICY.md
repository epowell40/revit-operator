# Explicit OpenAI Responses storage

Server operators can set `OPERATOR_OPENAI_RESPONSE_STORAGE=host` for newly
started work. The default `provider` keeps the previous Responses storage
behavior and now sends it explicitly. Existing explicit `store:false` requests
(including intake) stay false. Chat Completions keep their nonstored default.

In `host` mode the existing client factory sets Responses `store:false`, keeps
encrypted reasoning/compaction in the host's existing conversation window and
rejects remote response cursors, Conversations, remote item references,
background mode and attempts to set `store:true`. The ordinary owner rebuilds
validated closed input arrays before requesting the next response. SDK streaming
uses the same checked create method; SDK response helpers are retained.
When the General Agent uses the Codex brain, host mode also selects intake's
existing tool-free Responses branch so that classification cannot silently use
the CLI's separate authentication/transport. Default provider mode keeps the
existing CLI intake route. No second agent/controller is added.

Host mode requires HTTPS, except loopback HTTP for isolated local tests. The
factory checks the configured destination/project/organization and rejects HTTP
redirects. This covers requests made through this factory, not workstation or
browser egress, optional providers, arbitrary code or an OS network policy.

An optional `OPERATOR_OPENAI_ACCOUNT_ALIAS` is a non-secret deployment label
(letters, digits, dot, underscore, dash; at most64characters). Do not put a key
in it. A durable task-bound policy receipt contains that label and a configuration
digest of storage, endpoint and organization/project selection. Both owner and
reviewer must retain the same configuration across restart. Credential rotation
is not prevented; a label/digest does not verify what account owns the key.

Changing storage/account configuration for an existing task fails before a new
dispatch rather than silently replacing its policy. Historical tasks without a
policy pin cannot silently opt into host mode. Preserve their current setup and
results; migration needs a separately reviewed reconciliation. A failed or
interrupted provider request remains governed by the existing custody, usage,
Pause and unknown-effect checks. A policy receipt does not grant model writes,
settle effects, prove a drawing or complete a task.

This option controls Responses/Chat application-state flags. It does **not**
establish Zero Data Retention, abuse-log deletion, cache residency, vendor
approval, training settings or local erasure. Audio, embeddings, optional
providers, direct development integrations and other data stores require their
own account/feature review. Do not enable a corporate mode on a live task just
to experiment. Verify the employer-approved account, endpoint and feature
support, then exercise fresh task/continuation/compaction/recovery and UI
behavior before release. Production settings are not changed by this source.

Official interfaces: [Responses data controls](https://developers.openai.com/api/docs/guides/your-data),
[stateless compaction](https://developers.openai.com/api/docs/guides/compaction).
