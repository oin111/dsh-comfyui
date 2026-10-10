/**
 * Every /comfyui/* route goes through DSH's own browser trust check before
 * its handler runs. DSH 0.2 routes plugins onto the same web server as `/api`
 * but does not authenticate them: the `connection` service owns the Host/Origin
 * fence and the launch-token cookie (`requestRejection`), and each route has to
 * ask it — exactly as `@deepseek-ai/dsh-open-in-app` does. Without it any LAN
 * peer, local user, or DNS-rebinding page could rewrite the config (and point
 * the API key at its own server), write skill packs, delete assets, or read
 * media.
 *
 * A host with a web server but no connection service fails closed (403).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BodyTooLargeError, sendJson } from './http.js'

/** The trust surface consumed here (the connection package is browser-side). */
export interface ConnectionTrust {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

export interface RouteSpec {
  kind: string
  path: string
  handler: RouteHandler
}

export interface RouteRegistrar {
  register(route: RouteSpec): () => void
}

/**
 * Wrap the web server's route registry so every handler first passes the
 * connection's rejection check, and only then records the host hint.
 * @param webServer - the host web server (route registry).
 * @param connection - reads the DSH connection service (live; may be absent).
 * @param onAdmitted - runs for each admitted request before the handler.
 */
export function guardedRegistrar(
  webServer: RouteRegistrar,
  connection: () => ConnectionTrust | undefined,
  onAdmitted: (request: IncomingMessage) => void,
): RouteRegistrar {
  return {
    register(route) {
      return webServer.register({
        ...route,
        handler: async (request, response) => {
          let rejection: 401 | 403 | undefined
          try {
            const trust = connection()
            rejection = trust === undefined ? 403 : trust.requestRejection(request)
          } catch {
            rejection = 403
          }
          if (rejection !== undefined) {
            // Drain any body so the refusal is a readable response.
            request.resume?.()
            sendJson(response, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          onAdmitted(request)
          try {
            await route.handler(request, response)
          } catch (error) {
            if (!(error instanceof BodyTooLargeError)) throw error
            if (!response.headersSent) sendJson(response, 413, { error: error.message })
          }
        },
      })
    },
  }
}
