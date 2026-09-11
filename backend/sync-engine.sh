#!/usr/bin/env bash
# Copies the single source-of-truth rule engine (../shared/gameEngine.js) into
# the Lambda source tree so SAM can bundle it. Run this before `sam build` if
# you have changed the shared engine.
#
#   ./sync-engine.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../shared/gameEngine.js"
DEST="$HERE/src/lib/gameEngine.js"
cp "$SRC" "$DEST"
echo "Synced engine: shared/gameEngine.js -> backend/src/lib/gameEngine.js"
