#!/usr/bin/env bash
# In-process fake e2e (createTestApp). Does not start Docker / compose.
set -euo pipefail
cd "$(dirname "$0")/.."
export AMAZING_CLI_ENABLE_FAKE=true
exec node --import tsx scripts/e2e-fake.mjs
