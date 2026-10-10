/**
 * Host hint: remember the origin browsers use to reach this web server, so
 * generated media URLs (tool results) point at an address the requesting
 * browser can actually load (LAN IP, domain, reverse proxy).
 *
 * Only requests the DSH connection already admitted are recorded (see
 * guard.ts): their Host header passed the Host/Origin fence, so it names this
 * server. The scheme comes from the web server itself, never from request
 * headers, and Referer is ignored — both are attacker-controlled on an
 * unauthenticated request and used to let any page steer media URLs (or a
 * `javascript:` scheme into a download link).
 *
 * Loopback origins never displace an already-seen external origin: local
 * debug requests must not overwrite the address remote browsers use.
 */
import type { IncomingMessage } from 'node:http'
import { networkInterfaces } from 'node:os'

/**
 * The server's own first reachable LAN origin (e.g. http://192.168.1.5:3080),
 * used only for wildcard binds. Picks the first non-internal IPv4 that is not
 * loopback or link-local.
 */
export function detectLanOrigin(port: number, protocol = 'http:'): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    if (list === undefined) continue
    for (const net of list) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address
      if (ip === '127.0.0.1' || ip.startsWith('169.254.')) continue
      return `${protocol}//${ip}:${port}`
    }
  }
  return undefined
}

export interface HostHint {
  /** Record the origin of one admitted request (Host header + server scheme). */
  record(request: IncomingMessage): void
  /** The best-known origin: the last external one, else the last loopback one, else undefined. */
  origin(): string | undefined
}

/** RFC 3986 authority (host[:port]) without userinfo, path, or odd characters. */
const AUTHORITY = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/

/** Whether an authority names the local machine. */
function isLoopback(authority: string): boolean {
  const bare = authority.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
}

/**
 * Create a host hint accumulator.
 * @param protocol - the web server's scheme (`http:` / `https:`), read live.
 */
export function createHostHint(protocol: () => string = () => 'http:'): HostHint {
  let loopback: string | undefined
  let external: string | undefined
  return {
    record(request) {
      const host = request.headers.host
      if (typeof host !== 'string' || !AUTHORITY.test(host)) return
      const scheme = protocol() === 'https:' ? 'https:' : 'http:'
      const origin = `${scheme}//${host}`
      if (isLoopback(host)) loopback = origin
      else external = origin
    },
    origin() {
      return external ?? loopback
    },
  }
}
