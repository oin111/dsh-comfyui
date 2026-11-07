# DSH 0.2.2-rc.1 harness validation

Fresh local run: 2026-11-07 UTC, plugin 0.6.8, Linux x64,
Node 26.8.1, npm 11.19.0, pnpm 11.25.0. This is a harness-only
maintenance delta from `667ccff`; production plugin sources, root Node/DSH
compatibility, and historical `validation-summary.json` are unchanged.

## Verified

- Root `npm ci`, `npm test`, `npm run typecheck`, and
  `npm run test:localization:full`: exit 0. Full localization: 5/5.
- Strict TDD: the selection regression first failed on the old
  `DSH_TOOLS_MODE` launch; new overlay/surface regressions failed before their
  helpers existed. A further regression rejected duplicate executor insertion.
  Final offline harness regressions: 85/85 (including 3 executor tests), also
  included in root `npm test` without installing DSH. An additional real-host
  reproduction of the old env-only PTC invocation returned `UNKNOWN_TOOL` /
  `unknown tool "run_code"`; the explicit-overlay integration passed.
- `npm pack`, fresh harness setup, and real DSH plugin installation into
  isolated `web` and `headless` profiles: exit 0.
- Package integrity: all 54 regular members match by SHA-256 in both profiles.
  Tested tarball SHA-256:
  `8ae441508c047658783583d77d2b1030056f6850e393b500f7cc8435376cc9ee`.
- All 12 harness script syntax checks: passed.
- Fresh real DSH integration: **15/15 passed**, including authenticated web
  bootstrap, icon metadata, route security, concurrent saves, workflow/media
  routes, native sync/async/cancel, real PTC SDK execution and OS sandbox denial.
- `--dump-config` confirms exactly one native and one PTC executor row:
  native overlay enables only native; PTC overlay enables only PTC. The
  existing Node PTC runtime remains loaded. No profile-wide mode mutation,
  legacy environment-mode selection, or sandbox bypass is used.
- Every observed model request exposes the expected surface: native contains
  ComfyUI/job tools without `run_code`; PTC exposes exactly `run_code`.
  Actual completed calls and canonical non-error results are also required.
- Both PTC scenarios: `bwrap`, `workspace-write`, `enforcement: full`, empty
  guest environment. Workspace write succeeded; sibling write returned `EROFS`
  and the sibling file remained absent. Cancellation cancelled exactly the
  newly submitted target while preserving the unrelated sentinel.

## Evidence and limits

Ignored local `reports/` contains `versions.json`, `package-integrity.json`,
`integration-report.json`, and each scenario's NDJSON, canonical JSONL and stderr.
Raw mock logs and runtime state are deliberately not committed: they can contain
local paths, session data and ephemeral browser credentials.

Deterministic LLM/ComfyUI mocks were used with the real DSH host and sandbox.
Interactive browser acceptance and real GPU generation were not run.
No production cancellation fix, push, release, or npm publication is included.
