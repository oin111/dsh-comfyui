# LoRA parameters / Параметры LoRA — 0.6.3 (local / локально)

## Scope / Область

- Exact `Power Lora Loader (rgthree)` class, numbered `lora_N` inputs only.
- Typed `lora` values retain `on`, `lora`, finite `strength`, optional finite/null `strengthTwo`, and unknown authored fields.
- Partial overrides merge supported fields; false, zero and null are meaningful. Empty string/object keeps the authored row; omitted parameters use saved defaults. Invalid values, unknown/unsafe override fields, unsafe prototypes and scalar replacements of object inputs fail before submission.
- File choices use `LoraLoader` with `LoraLoaderModelOnly`, `LoraLoaderBypass`, `LoraLoaderBypassModelOnly` fallbacks. Unavailable authored files survive until changed explicitly. Refresh updates choices without changing saved values/type.
- Russian/English structured editor: enable, file, model strength, optional CLIP strength (blank = null/inherit). Advanced creation excludes unsupported object/array/null inputs and routes valid LoRA rows to the structured type.
- Store save/edit/reload and preset export/import retain objects. Agent list output has a host-supported typed schema, JSON defaults and partial-object guidance.
- Graph conversion is unchanged: named maps, existing keyed-object legacy widgets, positional/DynamicCombo behavior and malformed guards remain in scope of the existing tests. No broader legacy LoRA inference was added.

## Evidence / Проверки

Observed RED before production changes:

1. Typed detection/run: detected 0 instead of 3 rows.
2. Legacy scalar corruption and refresh: missing refusal; 0 refreshed rows instead of 3.
3. Preset transfer: imported LoRA parameters disappeared.
4. Structured editor: missing enable control.
5. Advanced picker: unsupported object offered as scalar input.
6. Agent list: opaque schema; LoRA shape not available to the SDK.
7. Unsafe prototype override: missing refusal.
8. Malformed persisted editor default: null dereference.

GREEN: `npm test`, `npm run typecheck`, `npm run test:localization:full`, `git diff --check`. Localization behavior/guards unchanged; only expected package version advanced to 0.6.3. Synthetic tests cover conversion → recognition → application, partial edits, fallback/refresh, store/transfer and actual editor callbacks (offline hook/element harness, not a browser).

The original private graph was probed locally only: 3 typed LoRA parameters; untouched payload deep-equal to extracted API JSON; an edited payload changes only the intended fields of the first row; source graph/API workflow unmodified. Offline recovered node contracts, not live backend inventory. Private graph and payloads are not committed or packaged.

## Limitations / Ограничения

Real-browser editor save/reload/run on both DSH hosts remains a required follow-up gate. No browser verification, GPU generation or real backend compatibility is claimed for this change. Independent spec/security review is also pending. This is a local bug-fix artifact, not a release: no push, GitHub issue changes, npm publication or live-profile modification.

После обновления перезапустите DSH и повторно распознайте параметры уже извлечённого процесса. Если старый конвертер потерял строки, переизвлеките оригинальный граф. / Restart DSH after upgrading and recognize parameters again; re-extract the original graph if an older converter lost the rows.
