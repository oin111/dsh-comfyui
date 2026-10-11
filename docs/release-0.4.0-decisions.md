# Historical 0.4.0 release decisions

Recorded near 2026-09-02 02:00. At that point code/manifest changes were applied locally and awaited the user's npm publication. These are historical upstream decisions, not the current 0.6.x compatibility range.

## Background

The user was concerned that distributing the 0.1.2 API migration to old hosts (0.1.1-rc.2) would fail the entire DSH boot rather than isolate the plugin. After confirming incompatibility in both directions, the user chose an install safety gate, explicit version ranges and removal of the beta label.

## Changes made at the time (D:\dsh-comfyui, then uncommitted)

1. Removed dsh-settings optional:true from peerDependenciesMeta, making its install peer mandatory. dshmarket compatibility.ts otherwise downgraded optional-peer conflicts to non-risk without warning. This enabled the soft-incompatible risk banner and one-click rollback on old hosts.
2. Set dsh-settings peer range to ^0.1.2-alpha.4, retaining the alpha baseline and covering later 0.1.x stable versions.
3. Changed 0.3.0-beta.6 to 0.4.0. The user's “0.40” was interpreted as 0.4.0 using semver convention, with the option to choose literal 0.40.0 communicated.
4. Added explicit >=0.1.2-alpha.4 requirements to Russian and English READMEs; old hosts stayed on 0.3.x.
5. pnpm typecheck passed both tsconfigs. Publication was to use npm publish (prepack automatically builds), only when the user authorized it.

## Release discipline

- Keep the old 0.3.x npm line available to old-host users; do not unpublish it.
- Do not force bypass dshmarket RELEASE_TOO_FRESH cooldown; allow its staged rollout window.
- Do not add a dual-version compatibility shim: prerelease 0.1.x hosts did not promise compatibility, and matched host/plugin versions were the ecosystem convention.
