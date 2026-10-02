import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverDevelopmentEnvironment, LOGIN_SHELL_MARKER, parseDevelopmentEnvironment } from '../src/login-shell-discovery.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function shell(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-probe-'))
  roots.push(root)
  const file = join(root, 'shell')
  await writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return file
}

const framed = (body: string): string => `rc chatter\n\0${LOGIN_SHELL_MARKER}\0${body}\0${LOGIN_SHELL_MARKER}\0logout chatter`

describe('development discovery parser', () => {
  it('accepts framed NUL output including equals/newlines in exported paths', () => {
    expect(parseDevelopmentEnvironment(framed('PATH=/dev/bin:/usr/bin\0JAVA_HOME=/jdk=a\nb\0NODE_OPTIONS=--bad\0SECRET=hidden\0')))
      .toEqual({ PATH: '/dev/bin:/usr/bin', JAVA_HOME: '/jdk=a\nb' })
  })
  it.each(['PATH=/bad\n', `\0${LOGIN_SHELL_MARKER}\0PATH=/bad`, framed('broken-entry')])('rejects malformed output', (output) => {
    expect(parseDevelopmentEnvironment(output)).toBeUndefined()
  })
  it('does not invoke POSIX shells on Windows', async () => {
    expect(await discoverDevelopmentEnvironment({ Path: 'C:\\Dev' }, { platform: 'win32', shells: ['/not-a-shell'] }))
      .toEqual({ environment: {}, failures: [] })
  })
})

describe.skipIf(process.platform === 'win32')('bounded login-shell discovery processes', () => {
  it('falls back after spawn, nonzero exit, and malformed output without changing process.env', async () => {
    const fail = await shell('exit 9')
    const malformed = await shell('printf malformed')
    const success = await shell(`printf '\\0${LOGIN_SHELL_MARKER}\\0PATH=/user/bin:/usr/bin\\0NODE_PATH=/bad\\0\\0${LOGIN_SHELL_MARKER}\\0'`)
    const before = { ...process.env }
    const result = await discoverDevelopmentEnvironment({ HOME: tmpdir(), PATH: '/usr/bin:/bin' }, {
      shells: ['/does-not-exist', fail, malformed, success], timeoutMs: 2_000,
    })
    expect(result.environment).toEqual({ PATH: '/user/bin:/usr/bin' })
    expect(result.failures.map(failure => failure.reason)).toEqual(['spawn-failed', 'exit 9', 'unparsed'])
    expect(process.env).toEqual(before)
  })
  it('bounds the whole read and kills background members of a timed-out probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-login-timeout-'))
    roots.push(root)
    const pidFile = join(root, 'pid')
    const stalled = await shell(`sleep 30 &\nprintf '%s' "$!" > '${pidFile}'\nwait`)
    const start = Date.now()
    const result = await discoverDevelopmentEnvironment({ PATH: '/usr/bin:/bin' }, { shells: [stalled, '/bin/sh'], timeoutMs: 1_500 })
    expect(result.environment).toEqual({})
    expect(result.failures[0]?.reason).toBe('timeout')
    expect(Date.now() - start).toBeLessThan(4_000)
    const pid = Number(await readFile(pidFile, 'utf8'))
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  })
  it('supports cancellation and skips remaining candidates', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await discoverDevelopmentEnvironment({}, { shells: ['/bin/sh', '/bin/bash'], signal: controller.signal })
    expect(result.failures.map(failure => failure.reason)).toEqual(['aborted'])
    expect(result.environment).toEqual({})
  })
  it('reads a real POSIX login shell with the production dump command', async () => {
    const result = await discoverDevelopmentEnvironment({ PATH: '/usr/bin:/bin' }, { shells: ['/bin/sh'], timeoutMs: 2_000 })
    expect(result.environment.PATH).toContain('/usr/bin')
    expect(Object.keys(result.environment).every(key => ['PATH', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME'].includes(key))).toBe(true)
  })
})
