# EPIC-0439 evidence ingestion

Use `report-evidence` for receipt-backed campaigns:

```text
npm run benchmark:epic0439 -- report-evidence --cases <cases.json> --manifest <evidence.json> --evidence-root <dir> --output-dir <dir>
```

The evidence manifest follows `contracts/epic0439_evidence_manifest.v1.schema.json`. It binds one regular evidence file to every materialized case/config pair by SHA-256. The scorer verifies the canonical case materialization, exact campaign cardinality, unique pairs, receipt schemas, and the preview/admission/authorization/apply hash chain before writing `epic0439_scorer_owned_results.json`.

Current Dynamic Revit supervisor evidence does not authenticate a benchmark case or execution-config identity. Consequently, successfully ingested receipts are reported as `live_revit_unverified`; correctness, changed-element precision, and verification credit remain zero, and live acceptance remains false. Promoting evidence to `live_revit` requires a future independently authenticated campaign-binding receipt. Caller-authored result JSON cannot claim that tier.

The legacy `report --results` path remains available for source-only and mocked development comparisons. Those tiers never count as live acceptance.
