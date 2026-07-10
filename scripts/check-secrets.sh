#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

echo "Checking secrets in: $(pwd)"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-git --source .
else
  echo "gitleaks not installed; skipping."
fi

if command -v trufflehog >/dev/null 2>&1; then
  trufflehog filesystem . --only-verified
else
  echo "trufflehog not installed; skipping."
fi

echo "Running fallback tracked-content pattern scan..."
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git grep -n -I -E 'OPENAI_API_KEY|AWS_ACCESS_KEY|AWS_SECRET|SECRET_KEY|JWT_SECRET|DATABASE_URL|PRIVATE_KEY|BEGIN RSA|BEGIN OPENSSH|password|api_key|apikey|token' -- \
    ':!*.md' \
    ':!**/node_modules/*' \
    ':!**/dist/*' \
    ':!**/bin/*' \
    ':!**/obj/*' || true
else
  grep -RIn \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=bin \
    --exclude-dir=obj \
    -E 'OPENAI_API_KEY|AWS_ACCESS_KEY|AWS_SECRET|SECRET_KEY|JWT_SECRET|DATABASE_URL|PRIVATE_KEY|BEGIN RSA|BEGIN OPENSSH|password|api_key|apikey|token' . || true
fi

echo "Secret check complete. Review all fallback hits before public release."
