/**
 * Per-launch bearer credential for the desktop-embedded Host.
 *
 * The browser-trust fence ([api-request-trust](./api-request-trust.ts)) binds a
 * request to this server's authority and refuses cross-site initiators, but it
 * is explicitly not an auth layer: any process on this machine can open a
 * loopback socket and present a clean Host header, which is enough to reach the
 * configuration plane. When the deployment configures a token, every `/api`
 * request must carry it, so an unauthenticated local client is refused instead
 * of served.
 *
 * This is a capability barrier, not a hard security boundary. A process already
 * running arbitrary code as the same OS user can read the credential out of this
 * process; closing that needs an OS-level sandbox, not a userspace secret.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/** The Authorization scheme the credential travels under. */
const BEARER_PREFIX = 'Bearer '

/**
 * Compare a supplied credential against the configured token in constant time.
 * @param supplied - credential as received, with the scheme already stripped.
 * @param token - the configured non-empty token.
 * @returns true only on an exact match. A length mismatch is refused before any
 *   comparison, because `timingSafeEqual` requires equal-length buffers and
 *   padding to equalize them would make a prefix guess comparable.
 */
export function tokenMatches(supplied: string, token: string): boolean {
  const suppliedBytes = Buffer.from(supplied)
  const tokenBytes = Buffer.from(token)
  if (suppliedBytes.length !== tokenBytes.length) return false
  return timingSafeEqual(suppliedBytes, tokenBytes)
}

/**
 * Whether one request carries the configured bearer credential.
 * @param headers - Node HTTP or Fetch request headers.
 * @param token - the configured non-empty token.
 * @returns true when the Authorization header is a Bearer credential matching
 *   the token; a repeated header is refused rather than guessed between.
 */
export function hasApiToken(headers: IncomingHttpHeaders | Headers, token: string): boolean {
  const raw = headers instanceof Headers ? headers.get('authorization') : headers.authorization
  if (typeof raw !== 'string' || !raw.startsWith(BEARER_PREFIX)) return false
  return tokenMatches(raw.slice(BEARER_PREFIX.length), token)
}
