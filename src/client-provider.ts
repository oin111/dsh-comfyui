import { ComfyUIClient } from './comfyui.js'
import type { Config } from './config.js'
import type { ObjectInfoCache } from './object-info-cache.js'

/** Capture endpoint and credential reference before awaiting credentials.
 * A settings change during resolution must never send the old key to the new
 * server. Existing operations finish against their original server snapshot. */
export async function resolveClient(
  config: Config,
  resolveKey: (reference: string) => Promise<string | undefined>,
  cache?: ObjectInfoCache,
): Promise<ComfyUIClient> {
  const { baseUrl, apiKeyEnv, connectTimeoutMs, maxMediaBytes } = config
  const apiKey = await resolveKey(apiKeyEnv)
  return new ComfyUIClient(baseUrl, apiKey, connectTimeoutMs, maxMediaBytes, cache)
}
