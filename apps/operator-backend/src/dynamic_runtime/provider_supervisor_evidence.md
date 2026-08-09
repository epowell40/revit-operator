# Provider supervisor evidence trust

The provider Dynamic Revit lane remains available only when runtime mode is exactly `development`, exposure profile is exactly `laboratory`, and the runner is explicitly enabled. Supervisor execution still uses direct process spawning with `shell: false` and the existing sanitized environment allowlist.

Two explicit pins are mandatory:

- `OPERATOR_DYNAMIC_REVIT_SUPERVISOR_SHA256` is the SHA-256 of the configured supervisor executable. It must also match the launcher identity in worker admission and the host bootstrap receipt.
- `OPERATOR_DYNAMIC_REVIT_WORKER_PACKAGE_SHA256` is the runtime-image package identity. It must match top-level evidence and, for apply, the v1 admission package identity.

Successful completion additionally requires the exact evidence schema for the requested preview/apply mode, target Revit year and observed host executable, source/graph/document/session/runtime bindings, registration and snapshot bindings, the shared preview/apply verifier, and the ordered host receipt envelopes with exact embedded-receipt hashes.

Residual trust boundary: the supervisor generates an ephemeral host-session key and does not export it. The backend therefore cannot independently recompute `hostProofMac` or `host_receipt_mac`; it validates their canonical shape and every surrounding hash/binding, with the pinned supervisor package as the trust root. Independent host-MAC verification requires a future supervisor attestation/envelope interface that exposes a verifier-safe public proof without disclosing the session key.
