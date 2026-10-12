# @oin111/dsh-comfyui

[Русский](README.md) | **English**

<p align="center">
  <img src="logo.png" width="480" alt="dsh-comfyui logo" />
</p>

<h1 align="center">dsh-comfyui</h1>

<p align="center">Let the DeepSeek Harness agent smartly drive a local or remote ComfyUI to generate anything — with workflow and asset management panels, per-workflow skill packs, a companion skill and a same-origin media proxy.</p>


> **This is `@oin111/dsh-comfyui`, a fork of [fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui) for DeepSeek Harness 0.2.x.**
>
> | Version | Paired DeepSeek Harness | Notes |
> | --- | --- | --- |
> | **@oin111/dsh-comfyui 0.6.x** | **0.2.0-rc.2 – 0.2.x** (incl. 0.2.1 alphas) | Background jobs follow the 0.2 contract (owner = SessionId, outcome in `result`); cancel only touches this plugin's prompt; works in PTC mode |
> | upstream dsh-comfyui 0.5.x | 0.1.2 – 0.1.7 | Use upstream on older hosts |
>
> Install: `dsh plugin --profile web add ./oin111-dsh-comfyui-0.6.3.tgz`

## Backend safety and transfer limits

- Backend JSON responses are limited to **8 MiB** and error bodies to **64 KiB**. Declared Content-Length is checked, but actual bytes are counted too, including chunked or misleading-length bodies.
- Buffered and streamed media bodies (HTTP 200 and 206) are limited to `maxMediaBytes` per transfer. A single Range is capped to that budget, preserving its start (or shortening a suffix); malformed/multipart ranges and inconsistent `Content-Range` responses are refused. This still allows bounded seeking within larger files. HEAD reads no body; 416 bodies are discarded.
- `connectTimeoutMs` remains active for the whole media transfer, not just response headers. Oversize/refused bodies and downstream stream cancellation close the upstream body. A streaming failure after headers closes the download rather than returning an error JSON.
- All backend HTTP endpoints, including uploads and the `/api` fallback, refuse redirects (`redirect`); configure the final backend URL directly. The native WebSocket progress handshake also does not follow redirects.
- Cancellation aborts an in-flight history fetch. Even if history fails concurrently, the plugin awaits a targeted `cancelPrompt` attempt before reporting killed/interrupted or removing tracking. Cleanup is best-effort: an unreachable backend may continue work. Only a queue-confirmed matching running prompt is interrupted; unrelated prompts are not intentionally stopped.
- Media origins use only an admitted request's Host and the host server's protocol, never Referer. The fallback is the concrete bind address; LAN detection is used only for wildcard binds. Asset deletion attempts file removal only under an explicitly configured absolute, accessible `outputDir`; otherwise it removes only the index record.

Version **0.6.3** is a local-only LoRA parameter/editor fix, not yet published. Run `npm pack` before the local install commands below. UI defaults to Russian; English preferences are preserved and old `zh` preferences migrate to Russian. Agent tool descriptions and the companion skill use English, with Russian as the default response language.

## Features

### Agent tools

The agent drives ComfyUI directly, no canvas work needed:

- `comfyui_run` — submit an API-format workflow or a built-in template (`txt2img` / `img2img` / `video`) and get media back; `mode: "sync"` waits for the result, `mode: "async"` runs a background job (recommended for video).
- `comfyui_object_info` — list the node definitions your ComfyUI server supports, so the agent can build valid workflows on the fly.
- `comfyui_workflow` — manage the plugin's runnable-workflow library: `list` (server address, local ComfyUI dirs, load-area media, per-workflow parameter lists), `run` (by id + parameter overrides), `skill` (on-demand read of a workflow's skill pack), `refresh` (re-derive a parameter snapshot).
- `comfyui_skill` — read and write workflow skill packs (`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`); the agent can write its lessons back into a pack and reuse them across sessions.

### UI panel

A right-docked panel with three tabs:

- **Workflows** — the runnable workflow library (create / edit / run / delete / import `.json`, tag classification with a dropdown filter); **preset export / import**: bundle selected workflows (all pre-selected; pack-bearing rows are annotated) with their parameters and skill packs into one `.zip` preset package — the completion notice reports what was actually packaged: workflow names, file name, size, and warnings; drag a preset package **onto the dialog** (or pick a file) to analyze it and import the selection, with skill packs restored byte-for-byte (thousand-file template packs included). Imports always create new workflows — nothing in the library is overwritten; auto-detects graphs saved on the ComfyUI server and can **extract** them into runnable workflows (whole / per component / main flow only when a canvas holds several independent flows).
- **Assets** — every generated result with preview, download, and hover-to-delete (the file is also removed from the ComfyUI output directory when `outputDir` is configured; otherwise only the record goes).
- **Queue** — live queue plus full history in five states, with delete / interrupt / rerun / clear / free-memory actions; plugin-submitted jobs show a progress bar and preview.

Clicking the "ComfyUI Panel" button in the session header probes the backend's connection to ComfyUI: when it cannot connect, the panel closes again (the button does not stay highlighted) and a toast at the top of the page explains why (with the concrete reason), asking you to start the local ComfyUI (so the backend can see its port) or check the remote server URL in settings; a healthy connection stays silent, with a brief "Connected" note only when it recovers from a failure.


### LoRA parameters (0.6.3)

Only the exact `Power Lora Loader (rgthree)` class and numbered `lora_N` inputs expose object parameters with `type: lora`. The editor offers enable, file, model strength, and optional CLIP strength; blank CLIP strength means `null` (inherit model strength). File choices come from `LoraLoader`, then `LoraLoaderModelOnly`, `LoraLoaderBypass`, `LoraLoaderBypassModelOnly`. An unavailable authored file is preserved until explicitly changed. `refresh` updates choices while retaining type and values. Save/edit and preset export/import preserve objects.

Agents can pass partial overrides such as `{"lora_1":{"on":false,"strength":0,"strengthTwo":null}}`. Only `on` (boolean), `lora` (string), `strength` (finite number), and `strengthTwo` (finite number or null) are accepted. These merge into the authored row, preserving unknown authored fields. Empty objects/strings leave it unchanged; omitted parameters use saved defaults. Malformed, unknown and unsafe fields are refused; old scalar parameters cannot overwrite objects. Advanced creation supports primitives and these LoRA rows, not arbitrary objects. Restart DSH after upgrading and recognize parameters again for an already extracted workflow; if an old converter lost the rows, re-extract the original graph.

### Named widget extraction (0.6.2)

Saved graphs with `widgets_values_named` use explicit name-to-value mapping, not positional pairing. Linked inputs take priority; UI-only divider/header/add-button and `control_after_generate` entries are omitted. The rgthree Power Lora Loader supports its numbered `lora_*` inputs, preserving on/off, strengths and null clip strengths. Valid named maps are authoritative: missing keys are not guessed from the positional array (missing required inputs fail extraction). Malformed map containers fall back to legacy conversion; malformed named LoRA values fail explicitly. Graphs without a named map retain legacy positional conversion, including DynamicCombo and seed controls. This fixes extraction; it does not verify model availability or generation.

### Load area (media loader)

A media loader at the top of the Workflows tab, in the style of ComfyUI's LoadImage node: visual picking (with in-place playback for video/audio), paste/upload, and multiple slots. Filled slots fill the workflow's unset loader parameters in order — **the agent doesn't need to guess file names**; unset `width`/`height` auto-match the source image's size. Uploads are renamed by content hash (dedup).

The `loadArea` field of `comfyui_workflow list` exposes the slots and their contents to the agent.

### Workflow skill packs (a manual for the agent)

A parameter list tells the agent which knobs exist, not what the workflow is *for* or which step goes wrong. A complex workflow can carry a **skill pack** (enable it from the "Skill pack" button on the workflow card):

```
<data dir>/skills/<workflow>/
  SKILL.md          # main doc: when to use / key parameters / gotchas
  references/       # reference docs: style catalogs, troubleshooting
  assets/           # reference images etc (previewable in the panel)
```

- **Progressive disclosure, no resident context cost**: `comfyui_workflow list` shows one summary line → `action: skill` fetches the SKILL.md body once the workflow is chosen → a referenced document is read only when the body points at it. Dozens of workflows can carry full packs, and the daily context cost stays one line each.
- **Edited in the panel**: file list + editor, import (auto-bucketed by extension), custom subdirectories, image preview, and the whole pack root can be moved to another drive / a synced folder (the `Skill pack directory` setting).
- **The agent can write it too**: the `comfyui_skill` tool lets the agent read and author a pack — `append` a pitfall to SKILL.md and the next session (even another one) reuses that experience.
- **Read-before-run**: a "required" flag makes `run` refuse until the skill pack has been read in this session, with an error pointing to `action: skill`.

### Media proxy & settings

Generated files are served through a same-origin route (`/comfyui/media`) addressed by file name, independent of ComfyUI's in-memory history — old results keep opening after a restart or a history clear. The browser never touches ComfyUI directly: no CORS, no mixed content, and the API key never leaves the host.

The DH settings page gets a "ComfyUI" section: server address, API key env var name, local ComfyUI directories, media host, connection test and a ru/en UI language switch — applied immediately, no `cordis.yml` edits needed.

## Install

```sh
# web profile
dsh plugin --profile web add ./oin111-dsh-comfyui-0.6.3.tgz
# desktop profile
dsh plugin --profile desktop add ./oin111-dsh-comfyui-0.6.3.tgz
```

After restarting the app: a panel entry appears in the sidebar, a "ComfyUI" section in settings, and the agent gets all tools plus the companion skill right away.

## Usage

Just tell the agent, e.g.:

- "Draw a red cat with ComfyUI"
- "Turn this image into cyberpunk style"
- "Turn the anime image in the load area into a photorealistic portrait, same resolution"
- "Generate a 5-second clip: city at sunset"
- "Run my Krea-Afterlight saved in ComfyUI" (if the graph isn't extracted yet, the agent will ask you to **extract** it in the panel first)

For a remote ComfyUI behind an authenticated proxy, provide the key via credential storage or the `apiKeyEnv` env var (default `COMFYUI_API_KEY`) — it is resolved on the host and never sent to the browser.

## Configuration

`comfyui` section of `cordis.yml` (most is editable in the settings page):

| Key | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI server address |
| `apiKeyEnv` | `COMFYUI_API_KEY` | Optional API key env var / credential name |
| `dataDir` | *(DSH data dir)* | Where the workflow library and asset index live |
| `comfyuiDirs` | `[]` | Local ComfyUI install dirs (multiple allowed); the agent locates models, custom nodes, TTS voice libraries through these |
| `outputDir` | `''` | ComfyUI output dir (absolute). Deleting an asset removes files only here; empty = only the panel record is removed, files stay |
| `mediaHost` | `''` (auto) | External base URL for generated media |
| `skillsDir` | `''` (default `dataDir/skills`) | Skill pack root (absolute path; a synced folder or VCS works) |

## Requirements

- DeepSeek Harness (`web` / `desktop` profile)
- A running [ComfyUI](https://github.com/comfystack/ComfyUI) server (default `http://127.0.0.1:8188`)
- The `video` template needs [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) and Wan 2.1 models

## License

MIT
