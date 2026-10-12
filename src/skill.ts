/**
 * Companion skill: graph analysis, extraction, parameter snapshots and skill
 * pack disclosure. Runtime rank 250 lets user/project skills override it.
 */
export const COMFYUI_SKILL = {
  name: 'dsh-comfyui-workflows',
  source: 'runtime',
  description: 'Manage ComfyUI workflows: distinguish source UI graphs from runnable API workflows, analyze independent connected components, extract graph-to-API workflows, and guide panel operations. Includes local ComfyUI directories, TTS-Audio-Suite voice discovery and parameter snapshot refresh. Load for comfyui_workflow, saved ComfyUI graphs, local file/voice lookup, or workflow skill packs.',
  whenToUse: 'When running or managing saved ComfyUI workflows; when list shows unextracted graphs; when explaining independent flows or why a graph cannot run directly; when finding local ComfyUI directories or TTS-Audio-Suite voices and refreshing their parameter snapshots; or when a chosen workflow has a skill pack to read before running.',
  content: `# ComfyUI workflow management

Respond to the user in Russian by default, or English when requested. Plugin UI languages are Russian and English only. Do not infer a response language from upstream filenames, node names, media or user-authored workflow documents.

## Two workflow subjects

- **Source graph**: a UI canvas saved on ComfyUI (nodes/links/widgets). It cannot run directly and may contain several independent flows.
- **Runnable API workflow**: an executable API-format prompt, extracted from a graph or imported directly. Execution always uses this subject.

\`comfyui_workflow action: list\` returns runnable library entries in \`workflows\` and server-side graphs in \`comfyuiWorkflows\`, with \`extracted\` and \`derived\` library references.

## Local environment: check first, do not repeatedly ask the user

Every list call returns fresh \`env.baseUrl\` and \`env.comfyuiDirs\`. The latter are installation roots configured in settings, possibly multiple mapped, independent or portable installs. Read env before looking for models, custom nodes, voices or output files. Settings changes take effect immediately.

Empty comfyuiDirs means not configured: ask the user or inspect common locations such as C:\\ComfyUI, D:\\ComfyUI or the desktop installation under ComfyUI-Installs/ComfyUI/ComfyUI. Below, {comfyuiDir} means each configured root and {baseUrl} means env.baseUrl.

## TTS-Audio-Suite: refresh the snapshot BEFORE querying

Character Voices (\`CharacterVoicesNode\`) in \`{comfyuiDir}/custom_nodes/tts_audio_suite\` selects \`voice_name\`. Two independent caches become stale: the TTS process cache (dropdown/object_info COMBO) and the plugin's saved parameter snapshot in workflows.json (options, numberKind, min/max/step copied on save, not automatically updated). Querying without refreshing can return voices the saved workflow rejects.

### Step 1: refresh after adding voices or changing node definitions

- \`comfyui_workflow action: refresh { id: "<workflow-id>" }\` handles one workflow. It first force-rescans TTS via \`?refresh=1\`, then reads current object_info and writes updated options/numberKind/min/max/step back to the workflow snapshot. Only derived metadata changes: the complete parameter set (including manually added advanced parameters) and defaults stay intact. \`changed\` reports parameter names actually changed; list then shows the updated options.
- Other callers can use same-origin \`POST /comfyui/workflows/refresh-params\`, body \`{ "id": "<workflow-id>" }\`, returning \`{ ok, parameters, changed }\`. Call after successfully designing a voice; no need to re-save the workflow.
- A new voice rejected as "parameter ... is not one of the allowed options" indicates a stale workflow snapshot even if the live dropdown already shows it.
- Calling \`?refresh=1\` alone (or pressing R in ComfyUI) refreshes only the TTS process cache, NOT saved snapshots. Refresh each relevant workflow using action: refresh / refresh-params.

### Step 2: query current voices, metadata and previews

1. Prefer HTTP while ComfyUI runs. The custom node's endpoint on the ComfyUI server returns the complete dropdown key list; its first key, \`"none"\`, means no voice / supply audio directly.
   - PowerShell: \`Invoke-RestMethod "{baseUrl}/api/tts-audio-suite/voice-library"\`
   - curl: \`curl -s "{baseUrl}/api/tts-audio-suite/voice-library"\`
   - Adding \`?refresh=1\` rescans TTS only; it does not replace step 1.
   - Metadata: \`{baseUrl}/api/tts-audio-suite/voice-info?voice_name=<key>\`
   - Preview: \`{baseUrl}/api/tts-audio-suite/voice-preview?voice_name=<key>\`
2. Filesystem lookup, in priority order:
   - \`{comfyuiDir}/models/voices\` (preferred location for new voices)
   - \`{comfyuiDir}/models/TTS/voices\`
   - \`{comfyuiDir}/custom_nodes/tts_audio_suite/voices_examples/\`
   - Additional \`voices:\` mappings in \`{comfyuiDir}/extra_model_paths.yaml\`; include mapped roots.
   - PowerShell example: \`Get-ChildItem "{comfyuiDir}\\models\\voices" -Recurse -File | Where-Object { $_.Extension -match '\\.(wav|mp3|flac|ogg)$' }\`

A voice needs BOTH an audio file (.wav/.mp3/.flac/.ogg/.m4a/.aac) and nonempty matching text (same-basename.reference.txt preferred, otherwise same-basename.txt). Only complete pairs appear in voice_name and HTTP results. Keys are relative paths such as voices_examples/xxx.wav, TTS/voices/xxx.wav or subdir/voice.wav. Use the returned key unchanged, never invent one. Copy new audio/text pairs into models/voices, then perform step 1.

## Canvas analysis

1. Visual groups are rectangles (title/bounding box), NOT execution boundaries.
2. Fast Groups Bypasser (rgthree) activation itself is not serialized; node \`mode: 4\` reliably means bypass. Extraction skips inactive blocks automatically.
3. Executable units are connected components of active linked nodes. Ignore isolated UI-only/unused nodes (Markdown, Fast Groups Bypasser, unconnected Primitive).
4. One connected component means one workflow; multiple groups can just be functional sections. Several components mean independent flows. Do not choose on the user's behalf: offer all-as-one (everything executes), per component (recommended) or main flow only (largest, usually the test block). The extraction dialog shows each component's node count and groups.
5. When asked to run a saved graph, if extracted is false, explain that the user must Extract it in the panel and choose a mode. Never run the UI graph itself. If extracted, use a libraryId from derived.

## Graph-to-API technical rules

- Node references must use strings: \`[String(nodeId), outputSlot]\`; numeric references cause server dictionary KeyError.
- A valid widgets_values_named map is authoritative: map API/widget names explicitly, let links win, omit UI-only entries; do not guess missing keys from positional values. Power Lora Loader (rgthree) also accepts numbered lora_* objects with exact on/off and strengths. Malformed containers use legacy conversion; malformed named LoRA values are errors.
- Without a valid named map, widget order follows the graph node's own inputs array, entries with widget.name, NOT object_info order. Dynamic children (e.g. sampling_mode.temperature) and linked widgets still occupy widgets_values positions. object_info supplies INT control_after_generate metadata.
- The UI's control_after_generate dropdown after seed/noise_seed INT (or explicit declaration) occupies a widget slot but has no API input. Consume without writing, otherwise subsequent widgets shift (e.g. seed followed by "fixed" in TTS).
- Object-shaped widgets_values (e.g. VHS_VideoCombine) use names; skip hidden internal state such as videopreview.
- Reroute and bypass mode 4 pass through the first linked input.
- Resolve virtual nodes before analysis AND conversion. KJNodes SetNode/GetNode pair by name: a getter connects to the setter's upstream; with duplicates choose the greatest order less than the getter's. No matching setter leaves consumers unconnected. rgthree Mute / Bypass Relay/Repeater links propagate mode, not data; discard them (modes are already serialized).
- DynamicCombo V3 must stay FLAT: master input is the chosen option key, children are sibling master.child keys (e.g. codec: "auto"). Never wrap as { key, inputs }; the server rebuilds nesting, and wrappers lose inputs at execute time.
- Subgraph instances are unsupported: ask the user to convert them to ordinary nodes before extraction.
- Unregistered UI-only Primitive* nodes inline their first widget value; a non-Primitive with used outputs is an error.
- Out-of-range output slots are disconnected with warnings (saved graphs may claim more outputs than the server provides).
- Missing required inputs are explicit errors, not silently runnable-looking output. COMFY_AUTOGROW_V3, template and lazy inputs are exempt.
- Extracted runnable workflows must pass POST /prompt validation with no nodeErrors before extraction is successful.

## Adjustable parameters

Extraction detects text/prompt, EmptyLatentImage width/height, KSampler steps/seed (random by default), duration/length/frames, aspect_ratio and media loaders (image/video/audio server filenames). Detection is generic via upload flags and file lists, not hardcoded node classes. For unsupported composite inputs such as MiniMaxH3 media_state JSON, guide the user to Advanced parameters. Media JSON arrays split into media_1/media_2/... reference slots: use subfolder filenames; empty string removes a reference. cfg/denoise and model selection otherwise remain unchanged. The workflow editor changes defaults/random switches or exposes arbitrary node inputs.

Read the list's structured parameters before use: name is the API key, label the display meaning, default the fallback, random indicates per-run randomization, numberKind int rounds decimals and float accepts them (missing means unknown; decimals are permitted), options lists valid choices, upload identifies media type. Use values from options, or ask the user to upload new loader files.

Pass only parameter overrides such as \`{"prompt": "new prompt", "seed": 42, "width": 1024}\`. Explicit values take precedence; omitted seeds follow random settings. Use exact listed name keys (prompt/seed/width/height/steps/duration/aspect_ratio), never invent names. Options are validated. Changing aspect_ratio alone updates size to the new ratio's default (e.g. 9:16 → 768×1376); explicit size overrides it.

## Load area and uploads: user guidance

The bottom of the runnable workflow tab contains load slots, full-width for one or equal-width for several. Click a slot for the picker: All / Imported / Generated filters, paste/upload area and waterfall list. Add slot creates one, its hover × removes it, and the first None tile empties it while retaining the slot.

Imported means loadable image/video/audio in ComfyUI input. Generated means prior output (automatically copied to input when selected). All merges them. Video/audio previews can play. Pasting/uploading refreshes the list; selecting a filename fills the slot and closes the picker. Pixel sizes are recorded during upload and shown under previews; old files without recorded sizes are neither displayed with dimensions nor used for size matching.

Filled slots supply unset loader parameters in order, matching media types: first image slot to first image parameter, etc.; explicit values always win and absent matching slots retain original workflow values. list.loadArea exposes slots/loaded/items. Read it instead of repeatedly asking what the user loaded. Chat upload markers likewise indicate files already in ComfyUI input; preserve subfolder/ prefixes unchanged.

For image-to-image, recorded source dimensions automatically supply output width/height only when not explicitly overridden. Upload names use content hashes (original_shortHash.ext, e.g. image_3f9a2b1c0d.png); repeated identical content reuses files instead of creating image(1).png. Selecting generated media copies it from output to input with the same name for loader compatibility.

## Workflow skill packs: scope and progressive disclosure

A workflow may attach SKILL.md plus arbitrary ONE-LEVEL subdirectories (references/scripts/assets/templates/agents or custom names), under skills/<slug>/. The user edits these in the panel; you can maintain them with comfyui_skill.

Two scopes:
- comfyui_workflow manages the library. list returns ALL runnable workflows, graphs, load area and env, not an all-packs listing. Attached packs contribute only a summary with file count/required flag, never their body. action: skill { id } reads one workflow's SKILL.md. Discover via summaries, fetch details individually.
- comfyui_skill always requires workflow_id and operates INSIDE that ONE pack. action: list lists its files/directories/bytes, not every pack in the library.

Three disclosure steps; do not skip or eagerly read everything:
1. Discover a pack from its summary in workflow list (required packs are marked).
2. After choosing the workflow, BEFORE running, call \`comfyui_workflow action: skill { id: "<workflow-id>" }\`. Read its <skill_content> and absolute resource base.
3. Read a reference only when the body names it; resolve against Base directory. Images in assets are likewise on-demand using an image-capable reader. Do not read the entire tree.

Required-before-run is a boolean set by panel or \`comfyui_skill action: require { workflow_id, required: true }\` (false disables). It blocks ONLY workflow action: run; list/skill/get/refresh remain available. The gate is session × workflow: action: skill or comfyui_skill read SKILL.md unlocks that workflow for the current live Agent session. New sessions must read again; other workflows are unaffected. Workflow-specific user instructions take precedence over generic advice here. Without a pack marker, do not guess or call skill (it errors); enable creates one if useful.

### Maintaining a pack with comfyui_skill

Every action includes workflow_id:
- list: existing pack's files, byte sizes, directories (including empty), summary, required flag, absolute base.
- read { path }: one file, e.g. references/styles.md; over 40k characters is truncated and marked. Reading SKILL.md unlocks the gate.
- write { path, content }: create or REPLACE a whole file. Use for new/just-created files; existing content is lost. To extend user documents use append. Writing SKILL.md with summary updates its discovery line.
- append { path, content }: add separated text at the end, preserving existing content. Use for verified pitfalls and notes.
- mkdir { name }: create a one-level directory (letters/digits/CJK/underscore/dash). Create before writing inside it.
- rename { path, to }: bare filename keeps its directory; directory/ prefix moves it. SKILL.md cannot be renamed.
- delete { path }: one file, never SKILL.md. There is no agent destroy action: whole-pack destruction is the user's panel decision.
- enable: the ONLY creation path for a workflow without a pack; attaches a directory and seeds SKILL.md with parameter placeholders. Other actions require an existing pack. Fill in the skeleton rather than replacing it.
- require { required: true/false }: toggle read-before-run, same as panel checkbox.

After encountering a verified failure (parameter combinations, missing voices, async requirements), append the conclusion or write a focused reference. Reusable styles/templates/recipes go in separate directories, linked from SKILL.md. Enable a missing pack when worthwhile. SKILL.md enters context WHOLE, so keep it to selection/parameters/pitfalls and a reference index. Include a one-line summary explaining when to use the workflow. Record only verified conclusions, not guesses: later sessions treat it as authority. Preserve user-authored text; prefer append. Never destroy a whole pack through agent actions.

## Token-efficient execution

1. list: choose by name, description, tags (image-to-image/text-to-image/text-to-video/image-to-video/reference-to-video/text-to-audio/reference-to-audio or custom) and listed parameter labels/defaults. Panel tags filter workflows.
2. Read the chosen pack if present, before running; required packs refuse unread runs. Skip only when no pack is attached.
3. Choose values from the listed parameters; there is no need to inspect internal nodes.
4. \`comfyui_workflow action: run { id, parameters: {...} }\` submits saved JSON automatically. NEVER output/copy complete workflow JSON into your reply.
   - ALL video/audio workflows use \`mode: "async"\`: generation takes minutes and sync can abort on timeout. Async returns a job id. Do not block with wait: true; continue other work, then collect with job_output (without wait) after completion notification.
   - Images can use sync (usually under a minute); uncertain output types should use async.
   - action: get is diagnostic only, produces full expensive JSON and is NOT the run path.

## Panel guidance

Saved ComfyUI graphs show not-extracted or their derived library entries. Extract handles a single component directly; multiple components open the report/mode selector. View shows nodes/JSON. New workflow or Import JSON accepts API-format JSON directly.

Export presets packs selected runnable workflows, parameters and skill packs into .zip. Import creates NEW workflows, never overwrites existing ones; name conflicts get a localized imported suffix, skill packs are restored, and skipped over-limit files are reported. Recommend these controls for backup, sharing or moving machines.
`,
}
