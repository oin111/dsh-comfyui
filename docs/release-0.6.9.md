# v0.6.9 — CUDA-free connection probe

- Connection checks now use the read-only `GET /queue` endpoint instead of `/system_stats`. This avoids the GPU/CUDA statistics call that can fail even when ComfyUI is reachable. The check neither submits a prompt nor interrupts the queue.
- A successful check reports `version: unknown`: the queue endpoint does not provide a ComfyUI version. This is expected, not a connection failure.
- This change does **not** cure an existing CUDA out-of-memory condition, unload models, repair GPU state, or establish that generation will succeed.

## Verification and limits

The exact local 0.6.9 archive is checked against fresh isolated web and headless installations on real DSH **0.2.2-rc.1**. All **15** integration scenarios pass using deterministic mock LLM/ComfyUI backends, including native and PTC execution and full-enforcement OS sandbox checks. The authenticated connection check succeeds while the synthetic statistics endpoint returns a CUDA-style HTTP 500; it reads `/queue` without calling `/system_stats` or submitting a prompt.

Root tests, typechecking, full localization checks and exact package-member comparisons are also release gates. These results are **not real-GPU generation or browser UI proof**. No npm publication or user-host installation is part of this release preparation.

## Install after GitHub release publication

```sh
dsh plugin --profile web add https://github.com/oin111/dsh-comfyui/releases/download/v0.6.9/oin111-dsh-comfyui-0.6.9.tgz
```
