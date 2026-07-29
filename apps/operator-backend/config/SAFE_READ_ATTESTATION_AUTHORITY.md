# SafeRead runtime attestation authority

SafeRead uses two deliberately separate trust configurations.

- `local`, `self_hosted`, and `development` retain the single runtime-attestation manifest and exact `OPERATOR_SAFE_READ_RUNTIME_ATTESTATION_SHA256` content pin.
- Effective hosted mode (`REVIT_OPERATOR_MODE=hosted` or `OPERATOR_HOSTED_ENABLED=true`) requires a signed runtime-attestation set and a trusted-signer ring. Each file has its own absolute path and exact SHA-256 deployment pin. Hosted mode has no single-manifest fallback, and mixing the two configuration families is rejected.

The hosted set contains 1-16 entries sorted by attestation hash and 1-16 Ed25519 signatures sorted by key ID. Each entry carries the exact runtime-attestation file bytes as `attestation_json`; its hash must equal `runtime_attestation_sha256`, so pretty-printing and trailing-newline differences cannot be hidden. The signed payload is canonical JSON over `schema`, `sequence`, `issued_at_utc`, and `entries`; `signatures` is excluded. An entry is selected only when both its attestation hash and complete runtime tuple exactly match the request. Every supplied signature must verify under a currently `active` key in the pinned signer ring. A `revoked` signer never authorizes a set.

The capability database durably stores the highest accepted set sequence and its set-file hash. Lower sequences are rejected as rollback, while different content at the same sequence is rejected as equivocation. The set and signer ring are read, pin-checked, parsed, and signature-verified again immediately before the final capability compare-and-swap. High-water acceptance and capability mint/consume changes share the same SQLite transaction.

Configuration variables are documented in `.env.example`. The two checked-in `*.example.json` files contain only an ephemeral public test key, mark both signer and attestation revoked, and are intentionally incapable of authorizing a hosted request. They are schema illustrations, not deployment artifacts. Signing keys must never be placed in this repository or backend environment.
