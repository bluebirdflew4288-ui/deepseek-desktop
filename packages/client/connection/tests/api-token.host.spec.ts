/** Behavior of the per-launch desktop bearer credential check. */

import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { hasApiToken, tokenMatches } from '../src/api-token.ts'

const TOKEN = 'per-launch-credential-0123456789'

describe('tokenMatches', () => {
  it('accepts an exact match and refuses any difference', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    expect(tokenMatches('', TOKEN)).toBe(false)
  })

  it('refuses a same-length credential that differs in one position', () => {
    const flipped = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('9') ? '8' : '9'}`
    expect(flipped).toHaveLength(TOKEN.length)
    expect(tokenMatches(flipped, TOKEN)).toBe(false)
  })
})

describe('hasApiToken', () => {
  it('accepts the credential under the Bearer scheme', () => {
    expect(hasApiToken({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true)
    expect(hasApiToken(new Headers({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true)
  })

  it('refuses a request carrying no credential at all', () => {
    expect(hasApiToken({}, TOKEN)).toBe(false)
    expect(hasApiToken(new Headers(), TOKEN)).toBe(false)
  })

  it('refuses the right credential under another scheme', () => {
    expect(hasApiToken({ authorization: `Basic ${TOKEN}` }, TOKEN)).toBe(false)
    expect(hasApiToken({ authorization: TOKEN }, TOKEN)).toBe(false)
  })

  it('refuses a wrong credential', () => {
    expect(hasApiToken({ authorization: 'Bearer not-the-token' }, TOKEN)).toBe(false)
  })

  it('refuses a repeated Authorization header rather than picking one', () => {
    // Node delivers a repeated header as an array even though the typed shape
    // for `authorization` says string; the check refuses instead of choosing.
    const repeated = { authorization: [`Bearer ${TOKEN}`, 'Bearer other'] } as unknown as IncomingHttpHeaders
    expect(hasApiToken(repeated, TOKEN)).toBe(false)
  })
})
