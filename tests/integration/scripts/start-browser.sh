#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
export DSH_HOME="$ROOT/runtime/home"
export XDG_DATA_HOME="$ROOT/runtime/xdg-data"
export XDG_CONFIG_HOME="$ROOT/runtime/xdg-config"
export XDG_CACHE_HOME="$ROOT/runtime/xdg-cache"
export DSH_E2E_MOCK_KEY=mock-only-not-secret
mkdir -p runtime/workspace
node scripts/mock-server.mjs & mock=$!
trap 'kill "$mock" 2>/dev/null || true' EXIT
cd runtime/workspace
node "$ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" web --no-open --port "${DSH_E2E_PORT:-13080}"
