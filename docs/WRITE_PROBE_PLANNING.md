# Write-probe planning

Revit Operator keeps every registered tool visible while separating registration from proof. The write-probe planner assigns every live registry entry one safe validation lane before any mutation audit begins.

From `apps/operator-backend` while Revit is open:

```powershell
npm run plan:live-revit-write-probes -- --output-dir ..\..\..\local-work\tool-registry-audit
```

The command reads the authenticated local `/revit/tool-registry` endpoint and writes:

- `write_probe_plan.json` for automation and evidence joins;
- `write_probe_plan.md` for human review.

It does not execute any Revit action.

## Validation lanes

- `read_only`: bounded read-only call.
- `plan_only`: planning or transaction-validation route without apply.
- `safe_read_action`: an exact documented non-writing action such as `list`, `audit`, or `analyze`.
- `dry_run_or_preview`: explicit `dryRun:true` or `previewOnly:true` request.
- `rollback_transaction`: an explicit bounded transaction-group rollback with affected-element evidence.
- `state_restore`: capture, bounded change, restore, and independent verification.
- `controlled_external_fixture`: disposable model plus controlled source/output fixture; never a production model, central file, printer, or user artifact.
- `human_supervised`: never autonomous; requires a human decision at action time.
- `contract_only`: schema/docs validation only until a safe route-specific fixture or rollback contract exists.

Dry-run or preview success is not committed-write usefulness. A committed-write capability claim requires a disposable detached model, exact affected IDs, independent readback, and restoration or disposal of that copy.

High risk does not automatically mean "model write." Application-state routes such as open, close, sync, and computer-use action remain human-supervised and use their own acceptance receipts. Restorable policy/guard state uses capture-change-restore evidence. Controlled import, export, family, link, print, and save routes require a real operation against an isolated fixture and verification of the resulting model or output artifact.

Every failure needs a classified receipt. A tool is quarantined only for a reproducible defect or unacceptable safety behavior, not because it lacks live evidence or depends on a model-specific fixture. Active quarantines remain in the generated matrix with their reason, but autonomous probe eligibility is forced off until the quarantine is explicitly cleared after a verified repair.
