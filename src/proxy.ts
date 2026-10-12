/**
 * Media proxy: serves generated ComfyUI files to the browser through the
 * same-origin route /comfyui/media?prompt=&node=&index=, so the client never
 * talks to the ComfyUI server directly (no CORS, no mixed content, no key in
 * the browser) and remote installs work unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ComfyUIClient } from './comfyui.js'
import { guessContentType } from './comfyui.js'
import type { ComfyUIMediaRef } from './comfyui.js'
import { errorMessage, sendJson } from './http.js'
import type { ComfyUIRuntime } from './tools.js'
import type { RouteRegistrar } from './guard.js'

/** Media types that cannot execute in the app origin. */
const PASSIVE_MEDIA = /^(image\/(png|jpeg|webp|gif|bmp|avif)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/

/** Download suggestion only; never changes the reference sent to ComfyUI. */
function safeDownloadFilename(input: string): string {
  let name = (input.split(/[\\/]/).pop() ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\uFFFD"<>:|?*%]/gu, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!name) name = 'media'
  // Windows device names remain reserved even with an extension.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name)) name = `_${name}`
  const extension = /\.[a-z0-9]{1,16}$/i.exec(name)?.[0] ?? ''
  const stem = extension ? name.slice(0, -extension.length) : name
  const budget = 180 - Buffer.byteLength(extension)
  let bounded = ''
  let bytes = 0
  for (const char of stem) {
    const size = Buffer.byteLength(char)
    if (bytes + size > budget) break
    bounded += char
    bytes += size
  }
  // Truncation can expose an internal dot or space as the final character.
  name = (bounded + extension).replace(/[. ]+$/g, '') || 'media'
  // Cleanup can also expose a bare device name; its short prefix fits the budget.
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name) ? `_${name}` : name
}

/**
 * Relay one ComfyUI /view download to the browser in streaming fashion.
 * Browser <audio>/<video> players seek with `Range: bytes=…` requests; without
 * 206 + Content-Range support the seekable range stays empty (progress bar
 * snaps back) and long audio's duration can be mis-derived. ComfyUI's /view
 * handles Range natively, so re-emit its status/headers and pipe the body
 * through — a 206 pass-through costs nothing extra.
 */
async function relayViewStream(
  client: ComfyUIClient,
  ref: ComfyUIMediaRef,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestMethod: 'GET' | 'HEAD' = request.method === 'HEAD' ? 'HEAD' : 'GET'
  const { status, headers, body } = await client.fetchViewStreamed(ref, request.headers.range, requestMethod)
  const upstreamType = (headers.get('content-type') ?? guessContentType(ref.filename)).split(';')[0]?.trim().toLowerCase() ?? ''
  const passive = PASSIVE_MEDIA.test(upstreamType)
  const head: Record<string, string | number> = {
    // ComfyUI output is not ours to trust (remote, compromised, or old
    // servers can answer text/html or SVG): only passive media types pass,
    // anything else downloads as opaque bytes, and the sandbox CSP blocks
    // script even if a browser renders it.
    'content-type': passive ? upstreamType : 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  }
  const filename = safeDownloadFilename(ref.filename)
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  // Build locally from the reference, not the untrusted upstream disposition.
  head['content-disposition'] = `${passive ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
  const contentLength = headers.get('content-length')
  if (contentLength !== null) head['content-length'] = contentLength
  const contentRange = headers.get('content-range')
  if (contentRange !== null) head['content-range'] = contentRange
  response.writeHead(status, head)
  if (requestMethod === 'HEAD' || body === null) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(body), response)
}

/**
 * Mount the media proxy route on the host web server.
 * @returns the disposer, or undefined when no web server is present.
 */
export function mountComfyUIProxy(ctx: Context, runtime: ComfyUIRuntime, webServer: RouteRegistrar): () => void {

  return webServer.register({
    kind: 'exact',
    path: '/comfyui/media',
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const prompt = url.searchParams.get('prompt')
      const node = url.searchParams.get('node')
      const indexText = url.searchParams.get('index')
      const file = url.searchParams.get('file')
      if (file !== null) {
        // Direct file lookup (e.g. job preview_output thumbnails).
        const ref = { filename: file, subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') ?? 'output' }
        try {
          const client = runtime.createClient(await runtime.getApiKey())
          await relayViewStream(client, ref, request, response)
        } catch (error) {
          if (response.headersSent) {
            // Headers already on the wire (mid-stream failure, e.g. the
            // browser closed the tab): just close, no error JSON possible.
            response.end()
          } else {
            sendJson(response, 502, { error: errorMessage(error) })
          }
        }
        return
      }
      if (prompt === null || node === null || indexText === null) {
        sendJson(response, 400, { error: 'prompt, node, and index query parameters are required (or file + subfolder + type)' })
        return
      }
      const index = Number(indexText)
      if (!Number.isInteger(index) || index < 0) {
        sendJson(response, 400, { error: 'index must be a non-negative integer' })
        return
      }
      try {
        const client = runtime.createClient(await runtime.getApiKey())
        const entry = await client.getHistory(prompt)
        const outputs = entry?.outputs ?? {}
        const nodeOutput = outputs[node]
        const collections: Array<Array<{ filename: string; subfolder: string; type: string }> | undefined> = [
          nodeOutput?.images,
          nodeOutput?.videos,
          nodeOutput?.gifs,
          nodeOutput?.audio,
        ]
        let ref = collections
          .flatMap((items) => items ?? [])
          [index]
        if (ref === undefined) {
          // ComfyUI's /history is in-memory: a server restart or a "clear
          // history" click drops the entry and this lookup fails even though
          // the file is still on disk. The plugin's own asset index keeps the
          // file reference for every run it submitted, so fall back to it —
          // this is what keeps older chat cards (whose URLs were minted before
          // the proxy addressed files directly) from going blank.
          const archived = await runtime.listAssets()
          const item = archived
            .find((asset) => asset.promptId === prompt)
            ?.media.find((entry) => entry.node === node && entry.index === index)
          if (item === undefined) {
            sendJson(response, 404, { error: `no media item ${node}[${index}] for prompt ${prompt} (history evicted and not in the asset index)` })
            return
          }
          ref = { filename: item.filename, subfolder: item.subfolder, type: item.type }
        }
        await relayViewStream(client, ref, request, response)
      } catch (error) {
        if (response.headersSent) {
          // Headers already on the wire (mid-stream failure): close quietly.
          response.end()
        } else {
          sendJson(response, 502, { error: errorMessage(error) })
        }
      }
    },
  })
}
