# Media download filenames / Имена скачиваемых медиа — 0.6.4 (local / локально)

## Root cause / Причина

At baseline `1a598b3`, `src/proxy.ts`'s shared `relayViewStream` omitted Content-Disposition for passive media and emitted only `attachment` for active/unknown content. The browser or a download manager using `/comfyui/media` directly therefore had no suggested filename and could derive `media.png` from the route. Card anchors already set `download: item.filename`; the shared panel/card lightbox sets an empty download attribute, deferring to the HTTP filename. Random client renaming would not fix image context-menu saves or external download managers.

## Contract / Контракт

- Every successful relay response carries locally constructed Content-Disposition from `ref.filename`, never the upstream disposition.
- Passive media use `inline`; active/unknown media retain `attachment`, `application/octet-stream`, sandbox CSP and nosniff.
- ASCII `filename` fallback plus RFC 5987 UTF-8 `filename*`; ordinary generated basenames stay unchanged. Slash/backslash paths lose directories; control/format/surrogate/replacement characters and unsafe punctuation become underscores; leading/trailing dots/spaces are removed; empty names become `media`; Windows device names get a leading underscore. Names are bounded to 180 UTF-8 bytes, preserving a conventional final alphanumeric extension up to 16 characters.
- This suggestion does not change the reference sent upstream. Direct-file, legacy history, and archived-index fallback routes share the same relay. GET/HEAD and 206 status, length, range, and streaming behavior remain unchanged.
- Existing card links and shared panel/lightbox downloads need no production client change: they now receive the original filename through HTTP, also when no anchor filename exists.

## Evidence / Проверка

Scratch: `/home/hermes/.hermes/cache/scratch/comfy-media-names/`.

Tight loop: `npm run build:host && node --test scripts/test-media-filenames.mjs`.

RED: the first distinct-name HTTP regression failed on an exact Git archive of `1a598b3` because the passive response had no Content-Disposition (`red-normal.log`). After the basic filename slice went GREEN, UTF-8/sanitization tests failed on non-ASCII raw headers (HTTP 502); an ASCII fallback plus bounded safe basename resolved it. Final complete regression file also fails on that baseline: missing passive filenames and active response with only `attachment` (`red-all.log`).

GREEN: four focused tests pass (`green.log`). Synthetic backend and proxy are real local HTTP servers, using the real ComfyUIClient and mounted route. Coverage: different generated image/video/audio names; UTF-8; path traversal/backslashes; quotes/CRLF/NUL; reserved names; bidi and invalid Unicode; long names; hostile upstream disposition; SVG/HTML isolation; GET/HEAD 200/206, body and range preservation; live history and archived-index fallback. A transpiled actual card/lightbox element harness verifies their links against the HTTP response; it is not a browser download-event test.

Full gates: `npm test`, `npm run typecheck`, `npm run test:localization:full`, `git diff --check`.

## Limits / Ограничения

No actual ComfyUI generation, installed DSH host, browser download events, or third-party download manager was exercised for this fix. HTTP/header behavior is verified; managers that ignore Content-Disposition may still choose the route name. Identical basenames in different subfolders, sanitization collisions, and repeated downloads remain subject to browser/manager suffix/overwrite policy. No random renaming or uniqueness guarantee is introduced. Cached old responses may lack the new header until refreshed/expired.

Local-only version bump and install examples: 0.6.4. No push, release, npm publication or installed-profile changes.
