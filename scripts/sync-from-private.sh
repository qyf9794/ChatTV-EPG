#!/usr/bin/env bash
# Source-of-truth: VocalTV_ios private main. Explicit allowlist avoids leaking private files.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/sync-from-private.sh /absolute/path/to/VocalTV_ios" >&2
  exit 2
fi
SOURCE="$(cd "$1" && pwd -P)"
TARGET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
for required in backend/packages/public-epg-publisher/src/publish.ts backend/packages/public-epg-contract/src/index.ts backend/services/api/src/shared/public-epg-sources.ts; do
  test -f "$SOURCE/$required" || { echo "Missing expected source: $required" >&2; exit 2; }
done
for package in public-epg-publisher public-epg-contract; do
  rsync -a --delete --exclude=node_modules --exclude=dist --exclude='.DS_Store' \
    "$SOURCE/backend/packages/$package/" "$TARGET/backend/packages/$package/"
done
cp "$SOURCE/backend/services/api/src/shared/public-epg-sources.ts" \
  "$TARGET/backend/services/api/src/shared/public-epg-sources.ts"
(
  cd "$TARGET/backend"
  pnpm install --lockfile-only --ignore-scripts
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm run typecheck
  pnpm run test
)
git -C "$TARGET" diff --check
echo "EPG-only snapshot synchronized and validated. Review diff before pushing."
