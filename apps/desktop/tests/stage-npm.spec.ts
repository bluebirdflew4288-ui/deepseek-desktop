import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNpmRuntimePin, tarballIntegrity, verifyStagedNpm } from '../scripts/stage-npm.ts'

const desktopRoot = resolve(import.meta.dirname, '..')
const pinFile = join(desktopRoot, 'npm-runtime.json')

/** The pin the staging script and the packaging gate both read. */
async function committedPin(): Promise<string> {
  return readFile(pinFile, 'utf8')
}

/** A complete pin, so each rejection case can break exactly one field. */
function validPin(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'npm',
    version: '11.12.1',
    license: 'Artistic-2.0',
    repository: 'https://github.com/npm/cli',
    registry: 'https://registry.npmjs.org/',
    tarball: 'https://registry.npmjs.org/npm/-/npm-11.12.1.tgz',
    integrity: `sha512-${'A'.repeat(86)}==`,
    unpackedSize: 10993397,
    cliEntry: 'bin/npm-cli.js',
    licenseFile: 'LICENSE',
    ...overrides,
  })
}

describe('pinned npm runtime staging', () => {
  it('accepts the committed pin, which is the one the packaging gate enforces', async () => {
    const pin = parseNpmRuntimePin(await committedPin())

    expect(pin.name).toBe('npm')
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(pin.license).toBe('Artistic-2.0')
    expect(pin.registry).toBe('https://registry.npmjs.org/')
    expect(pin.tarball).toBe(`${pin.registry}npm/-/npm-${pin.version}.tgz`)
    expect(pin.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/u)
    expect(pin.cliEntry).toBe('bin/npm-cli.js')
  })

  it('accepts a complete pin', () => {
    expect(parseNpmRuntimePin(validPin()).version).toBe('11.12.1')
  })

  it.each([
    ['{}', 'no name'],
    [validPin({ name: '' }), 'no name'],
    [validPin({ version: undefined }), 'no version'],
    [validPin({ license: undefined }), 'no license'],
    [validPin({ integrity: 'sha1-abc' }), 'sha512 SRI'],
    [validPin({ integrity: 'sha512-short' }), 'sha512 SRI'],
    [validPin({ unpackedSize: 0 }), 'positive unpackedSize'],
    [validPin({ cliEntry: undefined }), 'no cliEntry'],
    [validPin({ tarball: 'https://mirror.example/npm/-/npm-11.12.1.tgz' }), 'not served by the pinned registry'],
  ])('rejects a pin it cannot act on: %s', (pin, message) => {
    expect(() => parseNpmRuntimePin(pin)).toThrow(new RegExp(message, 'iu'))
  })

  it('digests tarball bytes as a stable SRI value that changes with the bytes', () => {
    const first = tarballIntegrity(new Uint8Array([1, 2, 3]))

    expect(first).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/u)
    expect(tarballIntegrity(new Uint8Array([1, 2, 3]))).toBe(first)
    expect(tarballIntegrity(new Uint8Array([1, 2, 4]))).not.toBe(first)
  })

  it('accepts a staged tree matching the pin and rejects a substituted one', async () => {
    const pin = parseNpmRuntimePin(await committedPin())
    const directory = await mkdtemp(join(tmpdir(), 'staged-npm-'))
    try {
      await mkdir(join(directory, 'bin'), { recursive: true })
      await writeFile(join(directory, pin.cliEntry), '')
      await writeFile(join(directory, pin.licenseFile), '')
      await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: pin.name, version: pin.version })}\n`)
      await mkdir(join(directory, 'node_modules'), { recursive: true })

      await expect(verifyStagedNpm(directory, pin)).resolves.toBeUndefined()

      // A tarball that unpacks to another version must not pass as the pin.
      await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: pin.name, version: '0.0.0-other' })}\n`)
      await expect(verifyStagedNpm(directory, pin)).rejects.toThrow(/expected npm@/u)

      // The license text is a distribution requirement, not an optional extra.
      await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: pin.name, version: pin.version })}\n`)
      await rm(join(directory, pin.licenseFile))
      await expect(verifyStagedNpm(directory, pin)).rejects.toThrow(/missing LICENSE/iu)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
