# Marketplace listing material

Preparation notes for awesome-dsh-plugin and its downstream dshmarket listing. Publishing, pushing a repository, creating a release or submitting a listing requires explicit user approval. Version 0.6.1 is a local localization update, not yet published.

## Suggested English entry

```markdown
- [dsh-comfyui](https://github.com/oin111/dsh-comfyui) — Let the DeepSeek Harness agent drive a local or remote ComfyUI: agent tools (`comfyui_run`, `comfyui_object_info`, `comfyui_workflow`, `comfyui_skill`), workflow/asset/queue panel with graph extraction (all/per component/main flow), load-area media loader, per-workflow skill packs, SDXL & Wan 2.1 templates, a companion skill and a same-origin media proxy. Russian and English UI, Russian default. Supports DSH 0.2.0-rc.2–0.2.x.
```

## Pre-release checklist

- Verify npm pack contents: lib/, client/client.js, cordis.patch.yml, Russian/English READMEs, LICENSE, package.json, logo and README images.
- Confirm fork repository URL and package name in metadata; keep profile row id comfyui.
- Run full tests and host/client typecheck; test the exact packed artifact on both target hosts, including native/PTC and browser settings/cards/panel.
- Live ComfyUI smoke: extract a saved graph (including multiple independent components), run it and txt2img; verify media cards/downloads. Video template requires ComfyUI-WanVideoWrapper.
- Obtain approval before npm publish, push/release or marketplace submission.
- Follow the listing repository contribution rules; downstream indexing may take approximately a day (historical expectation, not a verified guarantee).

## dshmarket prerequisites

- dsh.bundle.patch points to cordis.patch.yml with an inserted plugin row.
- dsh.client.platform is web; client module id equals package name. Profile row id remains comfyui for settings compatibility.
- dsh-settings peer range is enforced by host install compatibility checks; it is not marked optional even though runtime settings gracefully degrade in headless hosts.

Local install after npm pack:

```sh
dsh plugin --profile web add ./oin111-dsh-comfyui-0.6.1.tgz
dsh plugin --profile desktop add ./oin111-dsh-comfyui-0.6.1.tgz
```
