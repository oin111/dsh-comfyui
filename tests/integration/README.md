# DSH 0.2.1-rc.2 + dsh-comfyui integration harness

This harness installs the pinned official DSH npm package locally, installs a plugin tarball through the real DSH plugin command, and runs actual DSH web/headless/PTC code against deterministic ComfyUI and OpenAI-compatible LLM mocks. No GPU, real credentials, user data, global installation, or npm publication is needed.

## Requirements

- Node.js >=22.19 (24.19.0 tested) and npm (11.9.0 tested).
- Bash, `tar`, and Linux with an operational DSH-supported sandbox backend. The recorded run used `bwrap` with full enforcement. The suite intentionally fails if the sandbox cannot provide full enforcement; do not disable the sandbox to make it pass.
- Registry access for dependencies. The lockfile pins DSH **0.2.1-rc.2** and locally installed pnpm **11.25.0**.
- Free loopback ports 18188 (mock) and 13080 (DSH), or overrides as described below.
- A shared process/network namespace for the mock, DSH, and test client. The test runner supervises them together.

## Build, pack, configure, and run

Start at the repository root:

```sh
npm ci
# npm pack runs this repository's prepack build. It does not publish.
npm pack --pack-destination tests/integration
cd tests/integration

# setup runs npm ci here, initializes isolated web/headless profiles,
# installs the archive into both, and generates the mock configuration.
npm run setup -- ./oin111-dsh-comfyui-0.6.5.tgz
npm run test:syntax
npm run test:package -- ./oin111-dsh-comfyui-0.6.5.tgz
npm test
```

Use the filename printed by `npm pack` if the package version changes. The setup script accepts relative or absolute archive paths, resolved from the caller's directory. Do not use an archive downloaded from an untrusted source: package installation can run lifecycle scripts.

All harness paths are resolved relative to this directory. DSH state, generated patches, workspaces, and XDG directories stay under `runtime/`; dependency caches stay in `.npm-cache/` by default. The harness does not use the caller's `DSH_HOME`. The repository root and this harness have separate dependency installations. `package-lock.json` pins the harness npm graph; DSH generates separate pnpm locks for its plugin profiles. The package check compares every packaged regular file's SHA-256 with the installed file in **both** profiles.

To use different ports, export the same values before setup and all later commands:

```sh
export MOCK_PORT=18189
export DSH_E2E_PORT=13081
```

Rerun `node scripts/configure.mjs` if changing `MOCK_PORT` after setup. For an existing npm cache, `DSH_E2E_NPM_CACHE=/path/to/cache npm run setup -- ./plugin.tgz` is supported; that cache is the one explicit exception to the local-cache default.

## Coverage and limitations

The 14 checks cover:

- Authenticated DSH web-server bootstrap and delivery of application HTML
- Unauthenticated plugin-route 401 and cross-origin 403 responses
- Plugin configuration, backend probe, and 20 concurrent workflow saves
- Browser-facing workflow execution, completed asset indexing, authenticated PNG proxy, and download filename
- Actual headless model-dispatched sync run, async run with `job_output`, and target-only `job_kill`
- Real `run_code` PTC execution with `workspace-write` and `enforcement: full`
- An OS boundary test: a workspace write succeeds, a disposable sibling-directory write is denied, and no sibling file appears
- ComfyUI workflow/object-info/generation calls through the PTC SDK

`E2E_SYNC`, `E2E_ASYNC`, `E2E_CANCEL`, `E2E_SANDBOX`, and `E2E_PTC` select deterministic mock-model responses. Mock ComfyUI serves a fixed tiny PNG. These checks do not perform inference or validate real GPU workflows.

Native trace validation requires the exact expected tool sequence, a completed NDJSON result for every call ID, and matching non-error canonical results. Sync runs must contain a completed prompt and output media; async runs must return a background job and a completed `job_output` for that same job/prompt with parsed generation results. Cancellation must target the returned job and cancel exactly the newly submitted mock prompt, preserving the unrelated running sentinel. Before/after mock state rejects stale or unrelated prompt evidence.

`npm run test:validation` runs the offline malformed-trace regressions, including a VM reproduction of the verbatim pre-fix assertions from `7ba991b`. Both this harness's `npm test` and the repository root's `npm test` run these regressions automatically, without needing DSH dependencies for the offline tests.

`observe-tools.mjs` observes canonical tool results and asks DSH's sandbox provider which backend it selects. It does not replace the runner, mock the sandbox, disable security, or expand permissions. A `sandbox.denied` diagnostic of `false` does not invalidate the boundary test: guest code deliberately catches the filesystem exception, and the test independently verifies both the denial code and the absence of the file.

## Recorded result

`validation-summary.json` is a sanitized historical summary of the run on source snapshot `38e9105f9d6cb8201e950e4baee8bdb8fdbf7d40`. The published source is [5f80e3b](https://github.com/oin111/dsh-comfyui/commit/5f80e3b5820dca5451702fe428cdb6be0ec71581), verified to have the identical Git tree; publication changed commit metadata only. It records **14/14 passing mock integrations**, all 54 packaged files matching in each profile, and real **bwrap / workspace-write / full-enforcement PTC success**. The sibling write was denied with `EROFS`.

The browser E2E was **blocked**, not passed: the built-in cloud browser could not reach the executor's loopback listener (`ERR_CONNECTION_REFUSED`), and independently invoked executor commands did not share the listener's process/network view. The passing HTTP checks ran in one supervised invocation. **Real GPU generation was not tested.** The summary is evidence for that earlier snapshot, not an automatic result for future code changes. After relocating the harness into this repository, a fresh setup, all 8 script syntax checks, both-profile package verification, and all 14 integration checks passed again against the same archive; the summary records that rerun separately.

## Browser acceptance

After setup, run:

```sh
npm run start:browser
```

Open DSH's printed local URL in a browser sharing the server's network, then follow [BROWSER-CHECKLIST.md](BROWSER-CHECKLIST.md). That URL contains an ephemeral launch token; never paste it into issues, public logs, or screenshots. Keep the server local. No public tunnel or browser/sandbox security bypass is part of this harness.

## Generated outputs and publication safety

Local `reports/integration-report.json` records the latest run. Per-scenario NDJSON, canonical JSONL, stderr, `package-integrity.json`, and `versions.json` help diagnose it. `runtime/` also contains temporary DSH browser credentials. **All generated reports, runtime state, dependencies, caches, logs, and tarballs are ignored and must stay out of Git.** Only the manually sanitized historical summary is checked in; review any new summary before publication.

Public references:

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Pinned DSH npm release](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.2)
