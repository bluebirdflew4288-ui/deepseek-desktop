import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertAuthenticodeEvidence,
  assertUnsignedAuthenticodeEvidence,
  assertWindowsReleaseSigningInputs,
  buildThenVerifyWindowsPackage,
  runWindowsReleaseCli,
  unsignedWindowsReleaseBuilderConfig,
  writeWindowsSigningManifest,
  windowsReleaseMode,
  windowsReleaseBuilderConfig,
  type AuthenticodeEvidence,
} from '../scripts/windows-release-build.ts'

const PFX = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(15)]).toString('base64')
const READY = {
  WINDOWS_CERTIFICATE_PFX_BASE64: PFX,
  WINDOWS_CERTIFICATE_PASSWORD: 'test-password',
  WINDOWS_EXPECTED_PUBLISHER: 'CN=DeepSeek Desktop, O=Example Org, C=US',
  WINDOWS_RFC3161_TIMESTAMP_SERVER: 'https://timestamp.example.test',
}

const VALID_EVIDENCE: AuthenticodeEvidence = {
  status: 'Valid',
  signerSubject: READY.WINDOWS_EXPECTED_PUBLISHER,
  timestampSubject: 'CN=Timestamp Authority',
  timestampEkus: ['1.3.6.1.5.5.7.3.8'],
  trustedChain: true,
  signtoolSucceeded: true,
}
const authenticodeScript = readFileSync(resolve(fileURLToPath(new URL('../scripts/verify-windows-authenticode.ps1', import.meta.url))), 'utf8')

describe('Windows release signing gate', () => {
  it('verifies the packaged runtime only after the builder succeeds', async () => {
    const steps: string[] = []

    await buildThenVerifyWindowsPackage(
      async () => { steps.push('build') },
      async () => { steps.push('verify') },
    )

    expect(steps).toEqual(['build', 'verify'])
  })

  it('does not verify a package when the builder fails', async () => {
    const verify = vi.fn(async () => undefined)

    await expect(buildThenVerifyWindowsPackage(
      async () => { throw new Error('builder failed') },
      verify,
    )).rejects.toThrow('builder failed')

    expect(verify).not.toHaveBeenCalled()
  })

  it('accepts complete, well-formed signing inputs without exposing their values', () => {
    expect(assertWindowsReleaseSigningInputs(READY)).toEqual({
      pfxBase64: PFX,
      password: 'test-password',
      publisher: READY.WINDOWS_EXPECTED_PUBLISHER,
      timestampServer: READY.WINDOWS_RFC3161_TIMESTAMP_SERVER,
    })
  })

  it('selects signed mode only when every trusted signing input exists', () => {
    expect(windowsReleaseMode(READY)).toBe('signed')
    expect(windowsReleaseMode({})).toBe('unsigned')
    expect(() => windowsReleaseMode({ WINDOWS_CERTIFICATE_PASSWORD: READY.WINDOWS_CERTIFICATE_PASSWORD }))
      .toThrow('must be complete or absent')
  })

  it('configures unsigned Windows packaging without forcing code signing', () => {
    expect(unsignedWindowsReleaseBuilderConfig()).toEqual({
      forceCodeSigning: false,
      artifactName: 'DeepSeek-Desktop-${version}-${os}-${arch}.${ext}',
      win: { signExecutable: false },
    })
  })

  it('returns a non-zero CLI result when the release build fails', async () => {
    const error = new Error('verification failed')
    await expect(runWindowsReleaseCli({}, async () => { throw error })).resolves.toBe(1)
  })

  it('writes an explicit Windows signing manifest for release-note generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-windows-signing-manifest-test-'))
    const output = join(root, 'windows-signing-manifest.json')
    try {
      expect(writeWindowsSigningManifest('unsigned', '1.0.5', output)).toEqual({
        schemaVersion: 1,
        platform: 'win-x64',
        version: '1.0.5',
        mode: 'unsigned',
        authenticode: 'NotSigned',
      })
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ mode: 'unsigned', authenticode: 'NotSigned' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sets the electron-builder v26 fail-closed and RFC 3161 signtool options', () => {
    expect(windowsReleaseBuilderConfig({
      publisher: READY.WINDOWS_EXPECTED_PUBLISHER,
      timestampServer: READY.WINDOWS_RFC3161_TIMESTAMP_SERVER,
    })).toEqual({
      forceCodeSigning: true,
      artifactName: 'DeepSeek-Desktop-${version}-${os}-${arch}.${ext}',
      win: { signtoolOptions: {
        publisherName: READY.WINDOWS_EXPECTED_PUBLISHER,
        rfc3161TimeStampServer: READY.WINDOWS_RFC3161_TIMESTAMP_SERVER,
        signingHashAlgorithms: ['sha256'],
      } },
    })
  })

  it.each([
    'WINDOWS_CERTIFICATE_PFX_BASE64',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'WINDOWS_EXPECTED_PUBLISHER',
    'WINDOWS_RFC3161_TIMESTAMP_SERVER',
  ])('fails closed when %s is absent', (name) => {
    const env = { ...READY, [name]: '' }
    expect(() => assertWindowsReleaseSigningInputs(env)).toThrow(`Required Windows signing input is missing: ${name}`)
  })

  it('rejects invalid PKCS#12 input and non-HTTP timestamp endpoints', () => {
    expect(() => assertWindowsReleaseSigningInputs({ ...READY, WINDOWS_CERTIFICATE_PFX_BASE64: 'AA==' }))
      .toThrow('not a PKCS#12 certificate')
    expect(() => assertWindowsReleaseSigningInputs({ ...READY, WINDOWS_RFC3161_TIMESTAMP_SERVER: 'file:///tmp/tsa' }))
      .toThrow('HTTP(S) URL')
  })

  it('requires valid Authenticode trust, exact full Subject, and trusted timestamp evidence', () => {
    expect(() => { assertAuthenticodeEvidence(VALID_EVIDENCE, READY.WINDOWS_EXPECTED_PUBLISHER) }).not.toThrow()
    expect(() => { assertAuthenticodeEvidence({ ...VALID_EVIDENCE, status: 'NotSigned' }, READY.WINDOWS_EXPECTED_PUBLISHER) })
      .toThrow('chain verification failed')
    expect(() => { assertAuthenticodeEvidence({ ...VALID_EVIDENCE, signerSubject: 'CN=Different Publisher' }, READY.WINDOWS_EXPECTED_PUBLISHER) })
      .toThrow('does not exactly match')
    expect(() => { assertAuthenticodeEvidence({ ...VALID_EVIDENCE, timestampSubject: null }, READY.WINDOWS_EXPECTED_PUBLISHER) })
      .toThrow(/RFC 3161.*timestamp/iu)
    expect(() => { assertAuthenticodeEvidence({ ...VALID_EVIDENCE, trustedChain: false }, READY.WINDOWS_EXPECTED_PUBLISHER) })
      .toThrow('chain verification failed')
  })

  it('accepts only explicit NotSigned evidence for the unsigned path', () => {
    expect(() => assertUnsignedAuthenticodeEvidence({
      status: 'NotSigned',
      signerSubject: null,
      timestampSubject: null,
      timestampEkus: [],
      trustedChain: false,
      signtoolSucceeded: false,
    })).not.toThrow()
    expect(() => assertUnsignedAuthenticodeEvidence({ ...VALID_EVIDENCE, status: 'Valid' }))
      .toThrow('must be NotSigned')
  })

  it('extracts the ZIP executable, compares its SHA-256 to the loose executable, and verifies its signature', () => {
    expect(authenticodeScript).toContain('Expand-Archive -LiteralPath $ZipPath')
    expect(authenticodeScript).toContain('Get-FileHash -LiteralPath $Path[-1] -Algorithm SHA256')
    expect(authenticodeScript).toContain('Get-FileHash -LiteralPath $zipExecutable -Algorithm SHA256')
    expect(authenticodeScript).toContain('$Path += $zipExecutable')
    expect(authenticodeScript).toContain('Remove-Item -LiteralPath $tempRoot -Recurse -Force')
    expect(authenticodeScript).toContain('[ValidateSet(\'Valid\', \'NotSigned\')]')
  })
})
