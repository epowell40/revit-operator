# EPIC-0441 scorer-owned campaign reporting

Run the frozen 30-task, paired scoreboard with:

```text
npm run benchmark:epic0441 -- init --campaign-seed <seed> --reviewer-packet <private-file> --output <evidence.json>
npm run benchmark:epic0441 -- score --manifest <evidence.json> --evidence-root <dir> --reviewer-packet <private-file> --output-dir <dir>
```

`init` creates an intentionally conservative 60-row source-calibration skeleton with the balanced ordering and reviewer-packet hash already bound. Replace a row only when the corresponding evidence or honest unsupported/blocked classification is available; the scorer still owns every accepted classification and rejects invented live tiers.

The input must contain exactly 60 unique task/config rows. Pair order is derived from the suite ID, campaign seed, and task ID; it is deterministically balanced to 15 typed-first and 15 dynamic-first tasks. The scorer rejects caller scores and invented live tiers.

The private reviewer packet is read only to recompute its SHA-256. Its content is never copied into results. Each `n28`-`n30` row remains `sealed_not_yet_run` in v1 and carries only that packet hash. Unsupported, blocked-safe, failed, source-only, and mocked rows require explicit classification and never contribute to live acceptance.

Receipt-backed rows use the shared EPIC-0439 evidence verifier. Current runtime receipts lack an authenticated EPIC-0441 task/config binding, so successful receipts are classified as unverified preview/apply evidence and remain unscored. The scoreboard reports source/mock calibration counts and mixed-tier pairs separately; broad live acceptance is always false until an authenticated campaign-binding contract is implemented.
