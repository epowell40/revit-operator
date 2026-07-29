# Safe Read threat and ACL boundary

The listener binds only numeric IPv4 loopback and accepts only one fixed POST
route/body. The startup token is a 32-byte random secret, published as exactly
43 base64url characters. Client, request, attempt, host, and document-session
identifiers are exact lowercase GUIDs. An admitted caller still cannot execute
Revit code without a fresh backend capability and a nonce-derived, two-second
final receipt that the host verifies and consumes once. The certified executor
contains no transport, authorization, cryptography, replay, threading,
ExternalEvent, document-session, or mutable host state.

Discovery lives under the current user's `%LOCALAPPDATA%` profile. The host
enforces a protected ACL granting only the owning user, SYSTEM, and local
administrators on the discovery directory, temporary publication, and final
record, then verifies the ACL after atomic replacement. Reparse points and
unsafe parents/files fail closed. The same checks protect the static runtime
manifest and pin before they are read. Copying those files to a shared or
broadly accessible directory is unsupported. The startup token must be treated
as a same-user bearer secret and must never appear in logs, responses, backend
requests, or static deployment attestation.

The authorization transport is frozen once at startup. Local, self-hosted, and
development modes may use one direct origin and exactly one direct credential;
HTTPS is mandatory except for numeric `127.0.0.1`. Hosted and production modes
instead require the fixed numeric-loopback Sidecar proxy and a fixed 32-byte
file secret. Direct credential settings are rejected in those modes and proxy
loss never falls back to the backend. The proxy secret is not accepted from an
environment variable, manifest, discovery record, command line, or loggable
configuration object. Its fixed local file and parent must be owned by the
current user, use protected rules containing only that owner, SYSTEM, and local
administrators, and contain no reparse traversal. Redirects, system proxies,
cookies, and automatic decompression are disabled for both transports. Static
deployment attestation is a deployment-owned, externally pinned exact manifest. It binds route contract,
policy, proof receipt, executor identity, and the measured certified-executor /
Revit API tuple. Dynamic host and document identities are carried separately on
each authorization request, so a static artifact cannot authorize another
process or document by itself.

Cancellation is fail-closed and CAS-owned. A pending item can be cancelled only
before the Revit handler claims it. A successful pending cancellation has a
known outcome. A failed cancellation after claim, raise/shutdown race, or
deadline is conservatively marked `request_dispatched=true`,
`outcome_unknown=true`, and `retryable=false`. CAS terminal ownership prevents
the timed-out request from clearing a newer request or enabling overlapping
execution.

Backend authorization uses the same truth boundary. Failure of a separate
pre-connect proof is known and may be retried. Once either authorization POST
is dispatched, response loss/reset/cancellation is unknown and cannot be
automatically retried. A complete structured backend denial is preserved
without replacing its safe error text or its dispatch flags.

Backend and attestation JSON use the same dependency-free strict parser on all
supported Revit targets. It has fixed byte/character, nesting, property, key,
and string bounds and supports only the value types present in the exact
contracts. It rejects duplicate/noncanonical keys, noncanonical ordering at
the contract boundary, invalid UTF-8 and Unicode surrogate sequences, and any
trailing content. Parsing cannot silently normalize a different payload into a
valid authorization receipt.

Document identity includes an internal monotonic revision and a rotating
session ID. Revit document-changed, save/save-as, switch, and close events
advance or clear this binding. Dirty-to-dirty changes therefore invalidate an
in-flight authorization, and the handler verifies the captured binding again
immediately before calling the certified executor.
