#!/usr/bin/env bash
set -euo pipefail

# Keep the existing entry point; never downgrade to a non-enforcing grep.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/check-secrets.mjs" "${1:-.}"
