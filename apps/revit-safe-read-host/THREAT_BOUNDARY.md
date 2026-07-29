# Safe Read threat and ACL boundary

The listener binds only numeric IPv4 loopback and accepts only one fixed POST
route/body. The startup token is a 32-byte random secret, published as exactly
43 base64url characters. Client, request, attempt, host, and document-session
identifiers are exact lowercase GUIDs. An admitted caller still cannot execute
Revit code without a fresh backend capability and a nonce-derived, two-second
final receipt that the certified assembly consumes once.

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
automatic decompression are disabled. Static deployment attestation contains
only the executor identity and measured runtime tuple. Dynamic host and document
identities are carried separately on each authorization request, so a static
artifact cannot authorize another process or document by itself.

Cancellation is fail-closed. A request deadline cancels an unclaimed ExternalEvent
item and releases capacity. If Revit already claimed the item, the HTTP request
may finish as cancelled but the certified slot remains occupied until the Revit
handler terminates, preventing overlapping execution.
