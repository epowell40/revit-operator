# Safe Read threat and ACL boundary

The listener binds only numeric IPv4 loopback and accepts only one fixed POST
route/body. The startup token is a 32-byte random secret, published as exactly
43 base64url characters. Client, request, attempt, host, and document-session
identifiers are exact lowercase GUIDs. An admitted caller still cannot execute
Revit code without a fresh backend capability and a nonce-derived, two-second
final receipt that the host verifies and consumes once. The certified executor
contains no transport, authorization, cryptography, replay, threading,
ExternalEvent, document-session, or mutable host state.

Discovery lives under the current user's `%LOCALAPPDATA%` profile and relies on
the profile directory's Windows ACL. Deployment must preserve an ACL granting
only the owning user, SYSTEM, and local administrators access; copying the
instance files to a shared or broadly readable directory is unsupported. The
publisher writes a same-directory temporary file and atomically replaces the
record. It never follows or publishes a caller-selected path. The startup token
must be treated as a same-user bearer secret and must never appear in logs,
responses, backend requests, or static deployment attestation.

The backend origin and exactly one credential are read once at startup. HTTPS
is mandatory except for numeric `127.0.0.1`; redirects, proxies, cookies, and
automatic decompression are disabled. Static deployment attestation is a
deployment-owned, externally pinned exact manifest. It binds route contract,
policy, proof receipt, executor identity, and the measured certified-executor /
Revit API tuple. Dynamic host and document identities are carried separately on
each authorization request, so a static artifact cannot authorize another
process or document by itself.

Cancellation is fail-closed and CAS-owned. A pending item can be cancelled only
before the Revit handler claims it. Once an ExternalEvent was accepted, a
deadline response is conservatively marked `request_dispatched=true`,
`outcome_unknown=true`, and `retryable=false`. A claimed item keeps the
capacity-one slot occupied until the Revit handler terminates, preventing
overlapping execution.
