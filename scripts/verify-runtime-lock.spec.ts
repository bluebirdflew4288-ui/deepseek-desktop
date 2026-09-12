/**
 * Classification coverage for the runtime closure lock gate: the gate must be
 * able to both pass and fail, so a first-party workspace link is never judged
 * as drift and a version outside the pinned set always is.
 */

import { describe, expect, it } from 'vitest'
import { classifyClosurePackage, lockedVersions } from './verify-runtime-lock.ts'

const LOCKED = lockedVersions({
  packages: {
    'zod@4.4.3': {},
    '@hono/node-server@1.19.14': {},
    '@hono/node-server@2.1.1': {},
    'koffi@3.1.1': {},
  },
})
const FIRST_PARTY = new Set(['@deepseek-ai/dsh-atomic-write'])

describe('lockedVersions', () => {
  it('splits scoped keys on the last @ so the version survives the scope', () => {
    expect([...(LOCKED.get('@hono/node-server') ?? [])].sort()).toEqual(['1.19.14', '2.1.1'])
    expect(LOCKED.get('zod')).toEqual(new Set(['4.4.3']))
  })

  it('ignores keys that carry no numeric version', () => {
    expect(lockedVersions({ packages: { 'bad-key': {}, '@scope/only@': {} } }).size).toBe(0)
  })
})

describe('classifyClosurePackage', () => {
  it('passes a closure version the lockfile pins', () => {
    expect(classifyClosurePackage({ name: 'zod', version: '4.4.3' }, LOCKED, FIRST_PARTY)).toEqual({ kind: 'locked' })
  })

  it('accepts any one of several pinned versions for the same name', () => {
    expect(classifyClosurePackage({ name: '@hono/node-server', version: '2.1.1' }, LOCKED, FIRST_PARTY)).toEqual({ kind: 'locked' })
  })

  it('fails a closure version outside the pinned set, reporting what was expected', () => {
    expect(classifyClosurePackage({ name: 'koffi', version: '3.2.1' }, LOCKED, FIRST_PARTY))
      .toEqual({ kind: 'drift', expected: ['3.1.1'] })
  })

  it('fails a third party the lockfile never recorded', () => {
    expect(classifyClosurePackage({ name: 'left-pad', version: '1.3.0' }, LOCKED, FIRST_PARTY)).toEqual({ kind: 'unexpected' })
  })

  it('never judges a first-party workspace link, whatever version it materialized', () => {
    expect(classifyClosurePackage({ name: '@deepseek-ai/dsh-atomic-write', version: '9.9.9' }, LOCKED, FIRST_PARTY))
      .toEqual({ kind: 'first-party' })
  })
})
