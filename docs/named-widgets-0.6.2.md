# Local 0.6.2 named-widget extraction fix

## Root cause and contract

Graph normalization discarded `widgets_values_named`. The positional converter could only derive widget names from graph `inputs[].widget` or `/object_info`; rgthree Power Lora Loader declares only optional model/clip inputs and generates its LoRA widgets dynamically. Therefore conversion returned success with zero LoRA inputs.

Public upstream sources used for offline contract verification:

- [rgthree backend](https://github.com/rgthree/rgthree-comfy/blob/main/py/power_lora_loader.py): `INPUT_TYPES` uses flexible optional inputs with model/clip; `load_loras(model=None, clip=None, **kwargs)` consumes `LORA_` keys, preserving separate model/clip strength semantics.
- [rgthree frontend](https://github.com/rgthree/rgthree-comfy/blob/main/src_web/comfyui/power_lora_loader.ts): dynamically creates numbered `lora_` widgets; saved positional arrays also include UI-only widgets.
- [ComfyUI built-ins](https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py) and [conditioning node](https://github.com/nova452/ComfyUI-ConditioningKrea2Rebalance/blob/main/krea2.py): contracts for the offline full-graph probe. Model-file combos are representative, not a live backend inventory.

## Mapping policy

- A plain-object named map is authoritative, independent of map insertion order or positional array disagreement. Empty/partial maps are not supplemented from potentially misaligned positional arrays. Missing required values fail existing validation; missing optional values remain absent.
- Missing/malformed map containers (null, array, primitive) retain legacy positional/object-widget conversion.
- Resolved links win. Broken links are not replaced with named saved widget values.
- Named keys must be declared backend inputs, graph-declared widget names, or numbered dynamic LoRA keys on the exact rgthree Power Lora Loader class. Known divider/header/add-button/control-after-generate UI entries are excluded.
- Named LoRA objects must have boolean `on`, string `lora`, finite numeric `strength`, and optional null/finite numeric `strengthTwo`. Values are passed unchanged, including false, zero, negative strengths and null. Malformed values fail with the node/input name.
- Reserved prototype names are never assigned as API input keys, including linked and legacy widget paths. No recursive merging of widget payloads occurs.
- Legacy DynamicCombo master/child ordering, flat API values and seed controls remain unchanged.

## Evidence and limits

The exact privately supplied 11-node graph was exercised only from local scratch, with offline public-source-based object_info contracts. Baseline returned 11 API nodes but zero LoRAs (assertion `0 !== 3`). The fix returns 11 API nodes, three LoRAs with strengths `[1, 0.25, 0.2]`, `strengthTwo` `[null, null, null]`, and `on` `[true, true, true]`; all three complete values equal their saved named values. The original graph, filenames, models and prompts are not added to regression fixtures or this document. Tests use only synthetic public-safe data.

Five vertical RED→GREEN slices cover LoRA preservation, generic named mapping/link precedence, hostile names/UI metadata, malformed LoRAs, and broken links. Additional characterization tests cover partial/malformed map policy and legacy DynamicCombo/seed/object widget behavior. `npm test` includes the named-widget regression script.

The npm lock was refreshed against the manifest; the inherited pnpm lock targeted obsolete 0.1 host packages, so it was reimported from the npm lock for a coherent 0.2 dependency graph. No dependency ranges were changed.

This is local extraction evidence only: no live backend validation, installed-profile change, generation, publication or push is claimed. Independent specification/security review and live extraction probes remain release gates. Other dynamically generated custom-node widget families without declared names are not inferred; the explicit undeclared-input exception is limited to rgthree's numbered LoRA widgets. An incomplete map that omits optional dynamic LoRAs cannot reconstruct their names from a UI-padded positional array and remains authoritative.
