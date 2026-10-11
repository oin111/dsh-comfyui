# Incident: injected message without id prevented session history loading

Historical incident date: 2026-08-20. This records the implementation at that time, not the current jobs-based completion path.

## Symptoms and findings

After restarting the web server, an old session could not load. Two plugin contract issues were investigated:

### Service injection (reported boot failure, excluded in this repository)

The report claimed ctx.tools was read without export const inject = ['tools'], which makes cordis refuse profile boot. Source and built output already declared that injection (then src/index.ts:37); the report may have examined an older version. The rule still applies: every ctx.<service> access must be declared in inject, or boot fails with `cannot get property "<name>" without inject`, far from the responsible code. Optional services should use ctx.get/child fibers.

### Actual incident: corrupted append-only session log

The former echoCompletion() in src/tools.ts notified the session through agent.inject() with a bare object:

```ts
owner.inject({ role: 'user', content: [...], source: {...} }) // missing id
```

The host requires a named Message. Its createUserMessage() helper (@deepseek-ai/dsh-llm) supplies id:crypto.randomUUID() and role:user. Bypassing the helper wrote a message event without id. On reload assertMessageEventShape (then packages/core/session/src/index.ts:301) validated the full log and rejected the entire session.

The malformed event identified its origin as source:{kind:"plugin",plugin:"comfyui",form:"notice",...}; its body matched echoCompletion's hardcoded notification. Of 2238 message events, exactly one lacked id.

## Historical repair and verification

1. echoCompletion was repaired to include UUID id, role, content and source, with a CONTRACT comment.
2. The damaged persisted log was rewritten by the repair operator.
3. Repository inspection then found only echoCompletion injecting messages, now with id; inject=['tools'] existed in source and lib.
4. Frame-by-frame decompression (node:zlib zstdDecompressSync and scanZstdFrames) checked three logs:
   - session-208c847a…: 575 frames / 860 lines / missingId=0
   - session-4f7331fb…: 30998 frames / 42584 lines / missingId=0
   - session-c10ba985…: 9431 frames / 12754 lines / missingId=0
5. Typecheck and build passed at the time.

Current 0.6.x no longer injects completion messages through echoCompletion; background results use the host jobs `result` contract.

## Mandatory lessons

- Every message written to a session/model context must contain nonempty UUID id, role, content and source. Prefer host createUserMessage(); otherwise construct the exact equivalent shape.
- Compilation may not detect these structural failures. Runtime failures can occur at boot or days later during log reload, making the host appear broken. Enforce contracts in the plugin.
- Logs are append-only persistent data: one invalid event can make the whole session unloadable. Repair requires stopping processes, backing up and rewriting/recompressing persisted files. Prefer a failed best-effort notification to corrupted data.
- After adding ANY message-injection path, run scripts/analyze-sessions.mjs to inspect real session logs.
