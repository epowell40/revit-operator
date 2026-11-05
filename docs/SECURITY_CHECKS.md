# Source secret checks and support export redaction

The existing `scripts/check-secrets.sh` entry point now requires a pinned local
Gitleaks scanner. It fails on findings, tool/version errors, incomplete reports,
unsupported file shapes, or scan-capacity failures. It prints neither source
lines nor raw scanner findings. There is no successful grep-only fallback.

Install the checksum-pinned standalone tool explicitly; ordinary checks never
download or install executables:

```sh
node scripts/install-gitleaks.mjs
bash scripts/check-secrets.sh .
```

For an explicit cache location, set `GITLEAKS_PATH` to the installed executable.
CI installs the fixed release into its temporary directory. The archive digest
is pinned in `scripts/gitleaks-release.json`; update the version, digests and
regressions together after reviewing an intentional tool update. Developer
global packages and PATH are not changed.

The scan covers the current bytes of tracked regular files, including staged
additions and modified tracked files. It uses a bounded temporary snapshot that
is removed after success, failure or timeout. Submodules are counted and must be
scanned separately. Ignored/untracked local files, Git history and embedded
binary/archive content are outside this gate's assurance. Those require
separate review before broader confidentiality claims. A clean result is not
proof that a repository contains no confidential project information.

Reviewed false positives are restricted to a file, detector rule and SHA256 of
the entire matched source span in `secret-scan-reviewed-matches.json`, with a
reason. Known public test vectors and model discriminator keys are not service
credentials. Changing a value within the span, adding a different finding, or
moving it to another file does not inherit that review. There is no blanket
test-directory exclusion or automatically generated passing baseline.

Support/improvement export redaction removes values under credential field
names, including short values and nested/header records, plus common labelled
text forms. Diagnostic IDs, counts, flags and unrelated model properties remain
available. Redaction applies to outgoing payloads without rewriting the local
task/effect history. Upload enablement and destination behavior are unchanged.
Pattern/field redaction is not general anonymization or a guarantee that free
text, images or arbitrary confidential content is safe to share.
