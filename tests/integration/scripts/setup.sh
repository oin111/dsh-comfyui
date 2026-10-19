#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
# Resolve the argument before changing directory, so relative paths work from
# either the repository root or tests/integration. Node avoids GNU realpath.
TGZ="${1:?Usage: scripts/setup.sh /path/to/plugin.tgz}"
TGZ="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$TGZ")"
test -f "$TGZ" || { printf 'Plugin archive not found: %s\n' "$TGZ" >&2; exit 1; }
cd "$ROOT"
export npm_config_cache="${DSH_E2E_NPM_CACHE:-$ROOT/.npm-cache}"
export DSH_HOME="$ROOT/runtime/home"
export XDG_DATA_HOME="$ROOT/runtime/xdg-data"
export XDG_CONFIG_HOME="$ROOT/runtime/xdg-config"
export XDG_CACHE_HOME="$ROOT/runtime/xdg-cache"
mkdir -p "$DSH_HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" runtime/workspace runtime/outside reports
npm ci --no-audit --no-fund
export PATH="$ROOT/node_modules/.bin:$PATH"
for profile in web headless; do
  ./node_modules/.bin/dsh "$profile" --help >/dev/null
  ./node_modules/.bin/dsh plugin --profile "$profile" add "$TGZ"
done
node scripts/configure.mjs
node -p "JSON.stringify({node:process.version,dsh:require('./node_modules/@deepseek-ai/dsh/package.json').version,pnpm:require('./node_modules/pnpm/package.json').version,platform:process.platform,arch:process.arch})" > reports/versions.json
printf 'Installed exact DSH and plugin archive into %s\n' "$DSH_HOME"
