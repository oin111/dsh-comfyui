# Browser acceptance checklist

Run `scripts/start-browser.sh` after setup. Use the generated localhost URL printed by DSH (it contains an ephemeral launch token). The browser must share the server's network namespace. Do not expose the server or use a public tunnel for this test.

1. Open the generated URL. Add/select `runtime/workspace`, create a session, and open the ComfyUI panel.
2. Confirm Russian default, then switch ComfyUI language to English and back in settings. Confirm existing English selection survives reload.
3. Open Workflows, Assets, Queue. If you ran the integration suite, confirm its synthetic workflows/assets are visible. On a fresh setup, empty lists are expected. Confirm no error toast appears with the mock backend online.
4. Create two workflows, edit one, save repeatedly, and verify both remain after reload. Use `fixtures/workflow.json` for a synthetic API-format graph.
5. Run the fixture. Confirm completed asset preview and download filename `dsh-e2e.png`; verify workflow/queue states settle.
6. Open/close panel repeatedly while a queue request is in flight; navigate to another session and back. No late update should reopen the panel or replace the newer session's view.
7. Hide the tab for at least two polling intervals, then return. Confirm polling pauses while hidden and resumes without duplicate in-flight requests.
8. Exercise Queue refresh, cancel of a deliberately slow mock run, and retry. Confirm target-only cancellation and no duplicate jobs after repeated clicks.
9. Exercise Cancel/Close and browser Back/Forward around panel navigation. Dismissed dialogs remain dismissed and the selected session stays correct.
10. Start a PTC-preset session and send `E2E_PTC`; confirm `run_code` performs the synthetic workflow and completes. No real LLM/GPU calls are made.

Recorded historical cloud run: browser testing was BLOCKED (see validation-summary.json). Built-in cloud browser returned `ERR_CONNECTION_REFUSED` for a live executor-local DSH server on `127.0.0.1:13080`; separate shell calls also cannot see each other's server processes/loopback listeners. Same-invocation supervised HTTP and PTC tests are independent and can pass. No browser PASS is claimed from API checks. Standalone Chromium was not retried or launched with reduced security.
