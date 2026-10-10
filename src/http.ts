/**
 * Small HTTP helpers for the dsh-comfyui routes, mirroring the shapes the
 * dshmarket bundle uses for its own same-origin API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Send a JSON response with no-store caching. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Thrown when a request body exceeds its route's ceiling (answer 413). */
export class BodyTooLargeError extends Error {
  readonly status = 413
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/** JSON bodies: workflows with embedded graphs are large, but not this large. */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024
/** Raw bodies (media uploads, preset zips, skill imports). */
export const MAX_RAW_BODY_BYTES = 128 * 1024 * 1024

/**
 * Read a request body into memory with a hard ceiling: a declared
 * Content-Length over the limit is refused before reading, and a chunked body
 * is cut off as soon as it crosses the limit (the rest is drained).
 */
export async function readRawBody(request: IncomingMessage, limit = MAX_RAW_BODY_BYTES): Promise<Buffer> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    request.resume?.()
    throw new BodyTooLargeError(limit)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > limit) {
      request.resume?.()
      throw new BodyTooLargeError(limit)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

/** Read and parse a JSON request body; undefined when the body is empty. */
export async function readJsonBody(request: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const text = (await readRawBody(request, limit)).toString('utf8')
  if (text === '') return undefined
  return JSON.parse(text) as unknown
}

/** Whether a request originates from the page that served it (Origin vs Host). */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined) return true
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/** Human-readable error message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
