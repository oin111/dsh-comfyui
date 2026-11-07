# CUDA-free panel connection probe (local candidate)

## Endpoint research and scope

Inspected official ComfyUI source at commit `1332fabfcc507aa7c548cd5152071ed494c207e8`:

- [`server.py`](https://github.com/Comfy-Org/ComfyUI/blob/1332fabfcc507aa7c548cd5152071ed494c207e8/server.py): `GET /queue` calls `prompt_queue.get_current_queue_volatile()`, removes sensitive queue fields, and returns `queue_running` / `queue_pending` arrays. It does not call model management or enqueue work. In contrast, `/system_stats` reads device total/free memory.
- [`execution.py`](https://github.com/Comfy-Org/ComfyUI/blob/1332fabfcc507aa7c548cd5152071ed494c207e8/execution.py): `get_current_queue_volatile()` takes the scheduler mutex and copies in-memory running/pending lists; no device access.

The panel connection toast (`src/client/connection.tsx`) and Settings test (`src/client/settings.tsx`) both use `POST /comfyui/test`. That route now calls a dedicated client reachability probe using `GET /queue`, not `systemStats()` and not a fallback after stats failure. Existing queue polling behavior is unchanged. Transport retains Bearer authentication, `/api` fallback, response byte limits, timeout, and redirect refusal. Host authentication and same-origin guards are unchanged.

The probe validates the two top-level queue arrays, rather than accepting arbitrary HTTP 200 JSON or using the queue UI parser's permissive defaults. It reports server reachability only, not GPU readiness or inference capability. The existing `{ ok, version, latencyMs, error? }` contract remains; `version` is `unknown` because `/queue` provides no version. The explicit `systemStats()` client API remains available but is not called by panel/Settings probes.

## Verification

- Strict TDD: new HTTP regression failed before production edits with `ok:false` and HTTP 500 `torch.cuda.OutOfMemoryError` from `/system_stats`. Repeated against exact `git archive a19c1ae` source: same failure. The fixed route returns success and the complete backend call list is exactly authenticated `GET /queue`; no stats request or generation submission.
- Four focused tests pass: safe success, learned `/api` fallback, unreachable/malformed/timeout/redirect errors, and auth/method/origin rejection without backend I/O.
- Root `npm test`, `npm run typecheck`, and `npm run test:localization:full` pass (including older-host contract tests and full ru/en checks).
- Packed local 0.6.8 candidate installed into fresh isolated DSH 0.2.2-rc.1 web/headless profiles. All 54 packaged files match each installation. All 15 real-host integrations pass, including native/PTC and full-enforcement sandbox checks. The actual authenticated probe returns `ok:true`, `version:unknown`, one additional `/queue` read, zero `/system_stats` or `/api/system_stats` calls, and no submitted prompt. Synthetic stats endpoint deliberately returns CUDA-style HTTP 500.

Reusing the existing isolated same-version installation initially retained stale package bytes despite a successful install command. Package-integrity verification caught this; preserving the previous runtime in scratch and creating fresh isolated profiles resolved it. No version bump was required.

No live user ComfyUI/GPU was contacted or changed. No browser DOM acceptance or real GPU generation is claimed. No publication, deployment, or user-host installation was performed.
