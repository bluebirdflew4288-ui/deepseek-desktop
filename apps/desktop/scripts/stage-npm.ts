/**
 * Materialize the pinned npm CLI the managed Harness runtime installs with.
 *
 * The published npm tarball carries its own bundled `node_modules`, so one
 * digest-verified download is a complete package manager: nothing is installed,
 * no lockfile moves, and no workspace dependency tree is touched. The pin in
 * `apps/desktop/npm-runtime.json` is the source of truth, and the download is
 * checked against it twice — once against the metadata the official registry
 * publishes for that exact version, once against the bytes actually fetched — so
 * the staged tool cannot depend on whatever npm the build machine happens to have.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const pinFile = join(desktopRoot, 'npm-runtime.json')
const staging = join(desktopRoot, 'runtime-npm')

/** The pinned npm runtime, as `npm-runtime.json` declares it. */
export interface NpmRuntimePin {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly repository: string
  readonly registry: string
  readonly tarball: string
  readonly integrity: string
  readonly unpackedSize: number
  readonly cliEntry: string
  readonly licenseFile: string
}

/** Validate one pin document. */
function requireString(pin: Record<string, unknown>, field: string): string {
  const value = pin[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`npm runtime pin has no ${field}`)
  }
  return value
}

/**
 * Parse and validate the pinned npm runtime document.
 * @param text - JSON text of `npm-runtime.json`.
 * @returns The pin.
 * @throws When a field is missing, or the integrity value is not a sha512 SRI.
 */
export function parseNpmRuntimePin(text: string): NpmRuntimePin {
  const value = JSON.parse(text) as Record<string, unknown>
  const name = requireString(value, 'name')
  const version = requireString(value, 'version')
  const license = requireString(value, 'license')
  const repository = requireString(value, 'repository')
  const integrity = requireString(value, 'integrity')
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw new Error(`npm runtime pin integrity must be a sha512 SRI value: ${integrity}`)
  }
  const registry = requireString(value, 'registry')
  const tarball = requireString(value, 'tarball')
  if (!tarball.startsWith(registry)) {
    throw new Error(`npm runtime pin tarball ${tarball} is not served by the pinned registry ${registry}`)
  }
  const unpackedSize = value.unpackedSize
  if (typeof unpackedSize !== 'number' || !Number.isInteger(unpackedSize) || unpackedSize <= 0) {
    throw new Error('npm runtime pin has no positive unpackedSize')
  }
  return {
    name,
    version,
    license,
    repository,
    registry,
    tarball,
    integrity,
    unpackedSize,
    cliEntry: requireString(value, 'cliEntry'),
    licenseFile: requireString(value, 'licenseFile'),
  }
}

/**
 * Compute the SRI digest of one tarball.
 * @param tarball - Downloaded bytes.
 * @returns The `sha512-<base64>` value npm and the registry both use.
 */
export function tarballIntegrity(tarball: Uint8Array): string {
  return `sha512-${createHash('sha512').update(tarball).digest('base64')}`
}

/**
 * Read the metadata the official registry publishes for one pinned version.
 * @param pin - Pin naming the registry, package, and version.
 * @returns The published tarball URL and integrity value.
 * @throws When the registry does not publish that exact version.
 */
async function publishedMetadata(pin: NpmRuntimePin): Promise<{ tarball: string; integrity: string }> {
  const packument = `${pin.registry}${pin.name}`
  const response = await fetch(packument, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(`npm runtime staging: registry answered ${String(response.status)} for ${packument}`)
  }
  const document = await response.json() as { versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }> }
  const published = document.versions?.[pin.version]?.dist
  if (published?.tarball === undefined || published.integrity === undefined) {
    throw new Error(`npm runtime staging: registry publishes no dist metadata for ${pin.name}@${pin.version}`)
  }
  return { tarball: published.tarball, integrity: published.integrity }
}

/** Run one command to completion, rejecting on a non-zero exit. */
async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd: desktopRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`npm runtime staging failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${command} ${args.join(' ')}`))
    })
  })
}

/**
 * Assert one staged npm tree is the pinned version and is complete.
 * @param directory - Staged npm package root.
 * @param pin - Pin the tree must match.
 * @throws When the manifest, CLI entry, license text, or bundled tree is absent.
 */
export async function verifyStagedNpm(directory: string, pin: NpmRuntimePin): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (manifest.name !== pin.name || manifest.version !== pin.version) {
    throw new Error(`npm runtime staging produced ${String(manifest.name)}@${String(manifest.version)}, expected ${pin.name}@${pin.version}`)
  }
  for (const required of [pin.cliEntry, pin.licenseFile, 'node_modules']) {
    if (!existsSync(join(directory, required))) {
      throw new Error(`npm runtime staging is missing ${required}`)
    }
  }
}

async function main(): Promise<void> {
  const pin = parseNpmRuntimePin(await readFile(pinFile, 'utf8'))

  const published = await publishedMetadata(pin)
  if (published.tarball !== pin.tarball || published.integrity !== pin.integrity) {
    throw new Error(`npm runtime pin does not match the official registry metadata for ${pin.name}@${pin.version}`)
  }

  const response = await fetch(pin.tarball, { redirect: 'error' })
  if (!response.ok) {
    throw new Error(`npm runtime staging: download answered ${String(response.status)} for ${pin.tarball}`)
  }
  const tarball = new Uint8Array(await response.arrayBuffer())
  const digest = tarballIntegrity(tarball)
  if (digest !== pin.integrity) {
    throw new Error(`npm runtime staging: downloaded ${pin.name}@${pin.version} has integrity ${digest}, pin requires ${pin.integrity}`)
  }

  await rm(staging, { recursive: true, force: true })
  const target = join(staging, pin.name)
  await mkdir(target, { recursive: true, mode: 0o755 })
  const archive = join(staging, `${pin.name}-${pin.version}.tgz`)
  await writeFile(archive, tarball)
  try {
    await run('tar', ['-xzf', archive, '-C', target, '--strip-components=1', '--no-same-owner'])
  } finally {
    await rm(archive, { force: true })
  }

  await verifyStagedNpm(target, pin)
  console.log(`npm runtime staged at ${target} (${pin.name}@${pin.version}, ${pin.license}, integrity verified)`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
