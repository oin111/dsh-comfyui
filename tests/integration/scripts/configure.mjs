import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The harness always uses its own DSH home, even if the caller has DSH_HOME set.
const home=path.join(root,'runtime/home');
const port=Number(process.env.MOCK_PORT||18188);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_PORT must be an integer from 1 to 65535');
for(const profile of ['web','headless']){
const patch=`# Synthetic test configuration; no real credentials or GPU.\n- id: llm-pi-ai\n  config:\n    providers:\n      dsh-e2e:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${port}/v1\n        apiKeyEnv: DSH_E2E_MOCK_KEY\n        models:\n          - id: dsh-e2e-mock\n            name: DSH E2E Mock\n            contextWindow: 131072\n            maxTokens: 4096\n        retryPolicy:\n          mode: normal\n          maxRetries: 0\n- id: agent-default-model\n  config:\n    provider: dsh-e2e\n    model: dsh-e2e-mock\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- insert:\n    - id: dsh-e2e-observer\n      name: ${JSON.stringify(path.join(root,'scripts/observe-tools.mjs'))}\n- id: comfyui\n  config:\n    baseUrl: http://127.0.0.1:${port}\n    apiKeyEnv: DSH_E2E_UNUSED_COMFY_KEY\n    dataDir: ${JSON.stringify(path.join(root,'runtime/data-'+profile))}\n    pollIntervalMs: 200\n    timeoutMs: 10000\n`;
await fs.writeFile(path.join(home,'profiles',profile,'cordis.patch.yml'),patch);
}
console.log('Wrote isolated mock profile patches.');
