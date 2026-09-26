/** Build a Windows x64 release only with complete, verifiable signing inputs. */

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-builder'
import { expectedDesktopAssetNames } from './release-assets.ts'
import { verifyWindowsPackagedRuntime } from './verify-packaged-runtime.ts'

export interface WindowsReleaseSigningInputs {
  readonly pfxBase64: string
  readonly password: string
  readonly publisher: string
  readonly timestampServer: string
}

export type WindowsReleaseMode = 'signed' | 'unsigned'

const WINDOWS_SIGNING_INPUT_NAMES = [
  'WINDOWS_CERTIFICATE_PFX_BASE64',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'WINDOWS_EXPECTED_PUBLISHER',
  'WINDOWS_RFC3161_TIMESTAMP_SERVER',
] as const

/** Complete the post-build verification only after the builder succeeds. */
export async function buildThenVerifyWindowsPackage<T>(
  buildPackage: () => Promise<T>,
  verifyPackage: () => Promise<void>,
): Promise<T> {
  const result = await buildPackage()
  await verifyPackage()
  return result
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') throw new Error(`Required Windows signing input is missing: ${name}`)
  return value
}

export function assertWindowsReleaseSigningInputs(env: NodeJS.ProcessEnv): WindowsReleaseSigningInputs {
  const pfxBase64 = requiredEnvironment(env, 'WINDOWS_CERTIFICATE_PFX_BASE64').replaceAll(/\s/gu, '')
  if (pfxBase64.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(pfxBase64)) {
    throw new Error('WINDOWS_CERTIFICATE_PFX_BASE64 is not valid Base64')
  }
  const pfx = Buffer.from(pfxBase64, 'base64')
  if (pfx.length < 16 || pfx[0] !== 0x30) throw new Error('WINDOWS_CERTIFICATE_PFX_BASE64 is not a PKCS#12 certificate')
  const password = requiredEnvironment(env, 'WINDOWS_CERTIFICATE_PASSWORD')
  const publisher = requiredEnvironment(env, 'WINDOWS_EXPECTED_PUBLISHER')
  const timestampServer = requiredEnvironment(env, 'WINDOWS_RFC3161_TIMESTAMP_SERVER')
  let timestampUrl: URL
  try { timestampUrl = new URL(timestampServer) } catch { throw new Error('WINDOWS_RFC3161_TIMESTAMP_SERVER must be an HTTP(S) URL') }
  if (timestampUrl.protocol !== 'https:' && timestampUrl.protocol !== 'http:') {
    throw new Error('WINDOWS_RFC3161_TIMESTAMP_SERVER must be an HTTP(S) URL')
  }
  return { pfxBase64, password, publisher, timestampServer }
}

export function windowsReleaseMode(env: NodeJS.ProcessEnv): WindowsReleaseMode {
  const present = WINDOWS_SIGNING_INPUT_NAMES.map((name) => {
    const value = env[name]
    return value !== undefined && value.trim() !== ''
  })
  if (present.every(Boolean)) return 'signed'
  if (present.every(value => !value)) return 'unsigned'
  throw new Error('Windows signing inputs must be complete or absent')
}

export function windowsReleaseBuilderConfig(inputs: Pick<WindowsReleaseSigningInputs, 'publisher' | 'timestampServer'>) {
  return {
    forceCodeSigning: true,
    artifactName: 'DeepSeek-Desktop-${version}-${os}-${arch}.${ext}',
    win: {
      signtoolOptions: {
        publisherName: inputs.publisher,
        rfc3161TimeStampServer: inputs.timestampServer,
        signingHashAlgorithms: ['sha256'] as ('sha256' | 'sha1')[],
      },
    },
  }
}

export function unsignedWindowsReleaseBuilderConfig() {
  return {
    forceCodeSigning: false,
    artifactName: 'DeepSeek-Desktop-${version}-${os}-${arch}.${ext}',
    win: {
      signExecutable: false,
    },
  }
}

export interface AuthenticodeEvidence {
  readonly status: string
  readonly signerSubject: string | null
  readonly timestampSubject: string | null
  readonly timestampEkus: readonly string[]
  readonly trustedChain: boolean
  readonly signtoolSucceeded: boolean
}

export function assertAuthenticodeEvidence(evidence: AuthenticodeEvidence, expectedPublisher: string): void {
  if (evidence.status !== 'Valid' || !evidence.trustedChain || !evidence.signtoolSucceeded) {
    throw new Error('Windows Authenticode signature chain verification failed')
  }
  if (evidence.signerSubject !== expectedPublisher) {
    throw new Error('Windows Authenticode publisher does not exactly match the configured full certificate Subject')
  }
  if (evidence.timestampSubject === null || !evidence.timestampEkus.includes('1.3.6.1.5.5.7.3.8')) {
    throw new Error('A trusted RFC 3161 code-signing timestamp is required')
  }
}

export function assertUnsignedAuthenticodeEvidence(evidence: AuthenticodeEvidence): void {
  if (evidence.status !== 'NotSigned') throw new Error('Unsigned Windows Authenticode evidence must be NotSigned')
  if (evidence.signerSubject !== null || evidence.timestampSubject !== null || evidence.timestampEkus.length > 0) {
    throw new Error('Unsigned Windows Authenticode evidence contains signing metadata')
  }
}

function inspectAuthenticode(
  paths: readonly string[],
  zipPath: string,
  zipExecutableName: string,
  expectedStatus: 'Valid' | 'NotSigned',
): AuthenticodeEvidence[] {
  const script = resolve('scripts/verify-windows-authenticode.ps1')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Path', ...paths, '-ZipPath', zipPath, '-ZipExecutableName', zipExecutableName,
    '-ExpectedStatus', expectedStatus,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Post-build Windows Authenticode status verification failed: expected ${expectedStatus}`)
  }
  let evidence: AuthenticodeEvidence[]
  try { evidence = JSON.parse(result.stdout) as AuthenticodeEvidence[] } catch {
    throw new Error('Windows signature verifier returned invalid evidence')
  }
  if (evidence.length !== paths.length + 1) throw new Error('Windows signature verifier did not inspect every required executable')
  return evidence
}

function verifyAuthenticode(paths: readonly string[], expectedPublisher: string, zipPath: string, zipExecutableName: string): void {
  const evidence = inspectAuthenticode(paths, zipPath, zipExecutableName, 'Valid')
  for (let index = 0; index < evidence.length; index++) {
    assertAuthenticodeEvidence(evidence[index]!, expectedPublisher)
    console.log(`Verified Authenticode chain, exact publisher, and trusted RFC 3161 timestamp: ${index < paths.length ? paths[index]!.split(/[\\/]/u).at(-1) : 'ZIP application executable'}`)
  }
}

function verifyUnsignedAuthenticode(paths: readonly string[], zipPath: string, zipExecutableName: string): void {
  const evidence = inspectAuthenticode(paths, zipPath, zipExecutableName, 'NotSigned')
  for (let index = 0; index < evidence.length; index++) {
    assertUnsignedAuthenticodeEvidence(evidence[index]!)
    const label = index === 0
      ? 'Installer Authenticode'
      : index === 1
        ? 'Application EXE Authenticode'
        : 'ZIP application EXE Authenticode'
    console.log(`${label}: ${evidence[index]!.status}`)
  }
}

export interface WindowsSigningManifest {
  readonly schemaVersion: 1
  readonly platform: 'win-x64'
  readonly version: string
  readonly mode: WindowsReleaseMode
  readonly authenticode: 'Valid' | 'NotSigned'
}

export function writeWindowsSigningManifest(
  mode: WindowsReleaseMode,
  version: string,
  outputPath = 'windows-signing-manifest.json',
): WindowsSigningManifest {
  const manifest: WindowsSigningManifest = {
    schemaVersion: 1,
    platform: 'win-x64',
    version,
    mode,
    authenticode: mode === 'signed' ? 'Valid' : 'NotSigned',
  }
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  return manifest
}

export async function buildSignedWindowsRelease(env: NodeJS.ProcessEnv): Promise<void> {
  const inputs = assertWindowsReleaseSigningInputs(env)
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Signed Windows x64 releases must be built on a Windows x64 runner')
  }
  const metadata = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown; build?: { productName?: unknown } }
  if (typeof metadata.version !== 'string' || typeof metadata.build?.productName !== 'string') {
    throw new Error('Desktop package version or product name is unavailable')
  }
  const productFilename = metadata.build.productName
  const pfxPath = join(env.RUNNER_TEMP ?? tmpdir(), `desktop-signing-${randomUUID()}.p12`)
  writeFileSync(pfxPath, Buffer.from(inputs.pfxBase64, 'base64'), { flag: 'wx', mode: 0o600 })
  const priorCscLink = process.env.CSC_LINK
  const priorCscPassword = process.env.CSC_KEY_PASSWORD
  const priorPfx = process.env.WINDOWS_CERTIFICATE_PFX_BASE64
  const priorPassword = process.env.WINDOWS_CERTIFICATE_PASSWORD
  try {
    // Electron Builder receives a path and password only in this signing step;
    // never put certificate bytes in config, arguments, generated artifacts, or logs.
    process.env.CSC_LINK = pfxPath
    process.env.CSC_KEY_PASSWORD = inputs.password
    delete process.env.WINDOWS_CERTIFICATE_PFX_BASE64
    delete process.env.WINDOWS_CERTIFICATE_PASSWORD
    await buildThenVerifyWindowsPackage(
      () => build({
        projectDir: process.cwd(),
        win: ['nsis', 'zip'],
        x64: true,
        publish: 'never',
        config: windowsReleaseBuilderConfig(inputs),
      }),
      () => verifyWindowsPackagedRuntime(resolve('dist', 'win-unpacked'), productFilename),
    )

    // The verification process does not inherit the PFX, certificate password,
    // or Electron Builder credential aliases.
    delete process.env.CSC_LINK
    delete process.env.CSC_KEY_PASSWORD
    const version = metadata.version
    const [installerName, zipName] = expectedDesktopAssetNames('win-x64', version)
    const installer = resolve('dist', installerName!)
    const archive = resolve('dist', zipName!)
    const applicationExe = resolve('dist', 'win-unpacked', `${metadata.build.productName}.exe`)
    verifyAuthenticode([installer, applicationExe], inputs.publisher, archive, `${metadata.build.productName}.exe`)
    writeWindowsSigningManifest('signed', metadata.version)
  } finally {
    if (priorCscLink === undefined) delete process.env.CSC_LINK
    else process.env.CSC_LINK = priorCscLink
    if (priorCscPassword === undefined) delete process.env.CSC_KEY_PASSWORD
    else process.env.CSC_KEY_PASSWORD = priorCscPassword
    if (priorPfx === undefined) delete process.env.WINDOWS_CERTIFICATE_PFX_BASE64
    else process.env.WINDOWS_CERTIFICATE_PFX_BASE64 = priorPfx
    if (priorPassword === undefined) delete process.env.WINDOWS_CERTIFICATE_PASSWORD
    else process.env.WINDOWS_CERTIFICATE_PASSWORD = priorPassword
    rmSync(pfxPath, { force: true })
  }
}

export async function buildUnsignedWindowsRelease(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Unsigned Windows x64 releases must be built on a Windows x64 runner')
  }
  const metadata = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown; build?: { productName?: unknown } }
  if (typeof metadata.version !== 'string' || typeof metadata.build?.productName !== 'string') {
    throw new Error('Desktop package version or product name is unavailable')
  }
  const productFilename = metadata.build.productName
  const suppressedEnvironmentNames = [
    'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_IDENTITY_AUTO_DISCOVERY',
  ] as const
  const priorEnvironment = new Map<string, string | undefined>()
  try {
    for (const name of suppressedEnvironmentNames) {
      priorEnvironment.set(name, process.env[name])
      delete process.env[name]
    }
    await buildThenVerifyWindowsPackage(
      () => build({
        projectDir: process.cwd(),
        win: ['nsis', 'zip'],
        x64: true,
        publish: 'never',
        config: unsignedWindowsReleaseBuilderConfig(),
      }),
      () => verifyWindowsPackagedRuntime(resolve('dist', 'win-unpacked'), productFilename),
    )

    const [installerName, zipName] = expectedDesktopAssetNames('win-x64', metadata.version)
    const installer = resolve('dist', installerName!)
    const archive = resolve('dist', zipName!)
    const applicationExe = resolve('dist', 'win-unpacked', `${metadata.build.productName}.exe`)
    verifyUnsignedAuthenticode([installer, applicationExe], archive, `${metadata.build.productName}.exe`)
    writeWindowsSigningManifest('unsigned', metadata.version)
  } finally {
    for (const name of suppressedEnvironmentNames) {
      const prior = priorEnvironment.get(name)
      if (prior === undefined) delete process.env[name]
      else process.env[name] = prior
    }
  }
}

export async function buildWindowsRelease(env: NodeJS.ProcessEnv): Promise<void> {
  const mode = windowsReleaseMode(env)
  if (mode === 'signed') await buildSignedWindowsRelease(env)
  else await buildUnsignedWindowsRelease()
}

export async function runWindowsReleaseCli(
  env: NodeJS.ProcessEnv,
  runner: (env: NodeJS.ProcessEnv) => Promise<void> = buildWindowsRelease,
): Promise<number> {
  try {
    await runner(env)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Windows release build failed')
    return 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void runWindowsReleaseCli(process.env).then((exitCode) => {
    if (exitCode !== 0) process.exit(exitCode)
  })
}
