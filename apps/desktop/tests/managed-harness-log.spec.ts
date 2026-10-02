import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedHarnessDiagnostics, describeFailure } from '../src/managed-harness-log.ts'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'managed-harness-log-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed Harness failure diagnostics', () => {
  it('classifies the observed Host native-addon startup failure without copying Host output', () => {
    const error = new Error(
      'desktop Host exited before readiness (code 1, signal null)\n' +
      'Host output:\n' +
      'dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context ' +
      '(unsupported Electron runtime fingerprint: Node 24.18.1, V8 15.0.245.28-electron.0 ' +
      '(supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))',
    )

    const failure = describeFailure(error)

    expect(failure).toContain('Host exited before readiness')
    expect(failure).toContain('native addon')
    expect(failure).toContain('node-addon-require-builtin')
    expect(failure).not.toContain('Host output')
    expect(failure).not.toContain('24.18.1')
    expect(failure).not.toContain('15.0.245.28')
  })

  it('normalizes Host readiness URL errors before recording their first line', () => {
    const failure = describeFailure(new Error(
      'desktop Host readiness URL is invalid: http://127.0.0.1:3080/?token=readiness-secret&api_key=api-secret',
    ))

    expect(failure).toBe('desktop Host readiness failed')
    expect(failure).not.toContain('http://')
    expect(failure).not.toContain('readiness-secret')
    expect(failure).not.toContain('api-secret')
  })

  it.each([
    ['MODULE_NOT_FOUND', "Cannot find module 'node-addon-require-builtin'"],
    ['ERR_PACKAGE_PATH_NOT_EXPORTED', "Package subpath './internal' is not defined by exports in @deepseek-ai/cordis/package.json"],
  ])('keeps allowlisted startup categories for %s', (code, message) => {
    const failure = describeFailure(new Error(`desktop Host exited before readiness (code 1, signal null)\nHost output:\n${message}\ncode: '${code}'`))

    expect(failure).toContain(code)
    expect(failure).not.toContain(message)
    expect(failure.length).toBeLessThanOrEqual(512)
  })

  it('classifies unknown CLI options without recording their values', () => {
    const failure = describeFailure(new Error(
      'desktop Host exited before readiness (code 1, signal null)\nHost output:\nUnknown option --api-key=super-secret',
    ))

    expect(failure).toContain('unknown CLI option')
    expect(failure).not.toContain('--api-key')
    expect(failure).not.toContain('super-secret')
  })

  it('redacts credentials and URLs from non-Host first-line summaries while preserving the summary', () => {
    const failure = describeFailure(new Error(
      'installer failed for https://user:pass@example.test/path?token=launch-token Bearer bearer-secret api_key=api-secret DEEPSEEK_API_KEY=env-secret Cookie: session=secret-cookie\nextra output',
    ))

    expect(failure).toContain('installer failed for')
    expect(failure).toContain('[redacted')
    expect(failure).not.toContain('https://')
    expect(failure).not.toContain('user:pass')
    expect(failure).not.toContain('launch-token')
    expect(failure).not.toContain('bearer-secret')
    expect(failure).not.toContain('api-secret')
    expect(failure).not.toContain('env-secret')
    expect(failure).not.toContain('secret-cookie')
    expect(failure).not.toContain('extra output')
  })

  it('caps failure text and still preserves ordinary non-Host first lines', () => {
    expect(describeFailure(new Error('first line\nsecond line'))).toBe('first line')
    expect(describeFailure('plain')).toBe('plain')
    expect(describeFailure('x'.repeat(600))).toHaveLength(512)
  })

  it('omits non-Host failure summaries that contain absolute user paths', () => {
    const syntheticUserPath = ['C:', 'Users', 'Example', 'private-notes'].join('\\')
    expect(describeFailure(new Error(`failed to load DSH data from ${syntheticUserPath}`)))
      .toBe('managed Harness operation failed')
  })

  it('writes only the classified Host summary through the diagnostics sink', async () => {
    const directory = await createTemporaryDirectory()
    const file = join(directory, 'managed-harness.log')
    const diagnostics = createManagedHarnessDiagnostics({ file, trustedAnchor: directory })
    const failure = describeFailure(new Error(
      'desktop Host exited before readiness (code 1, signal null)\nHost output:\n' +
      'dsh: host preparation failed: node-addon-require-builtin unsupported; ' +
      'https://127.0.0.1:12345/?token=readiness-secret Authorization: Bearer bearer-secret ' +
      'Cookie: session=secret-cookie API_KEY=api-secret prompt=private-user-prompt ' +
      'chat content=private-chat-content memory content=private-memory-content',
    ))

    await diagnostics.record({ operation: 'update', version: '0.1.7-rc.2', phase: 'health', health: 'fail', failure })
    const contents = await readFile(file, 'utf8')
    const entry = JSON.parse(contents) as { readonly failure: string }

    expect(entry.failure).toContain('native addon')
    expect(entry.failure).toContain('node-addon-require-builtin')
    expect(entry.failure).not.toContain('Host output')
    expect(entry.failure).not.toContain('https://')
    expect(entry.failure).not.toContain('readiness-secret')
    expect(entry.failure).not.toContain('bearer-secret')
    expect(entry.failure).not.toContain('secret-cookie')
    expect(entry.failure).not.toContain('api-secret')
    expect(entry.failure).not.toContain('private-user-prompt')
    expect(entry.failure).not.toContain('private-chat-content')
    expect(entry.failure).not.toContain('private-memory-content')
    expect(entry.failure.length).toBeLessThanOrEqual(512)
  })
})
