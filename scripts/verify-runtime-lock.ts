/**
 * Verify the packaged desktop Host closure resolves to lockfile-pinned versions.
 *
 * `apps/desktop/scripts/stage-runtime.ts` deploys the Host with
 * `pnpm deploy --legacy`, which pnpm itself warns "prohibits to read or write a
 * lockfile": the closure is re-resolved from the registry instead of the shared
 * `pnpm-lock.yaml`, so shipped third-party versions drift with build time and
 * the packaged release is not reproducible. This gate makes that drift
 * deterministic and loud instead of silent.
 *
 * First-party workspace packages are materialized from `link:` by
 * `materializeLinks()` and legitimately have no `packages:` entry, so only
 * third-party names are judged — counting workspace links as drift would bury
 * the real signal in false positives.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

interface Lockfile {
  importers?: Record<string, unknown>
  packages?: Record<string, unknown>
}

/** One package materialized in the deployed Host closure. */
export interface ClosurePackage {
  readonly name: string
  readonly version: string
}

/** The judged outcome for one closure package. */
export type ClosureJudgement =
  | { readonly kind: 'first-party' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'drift'; readonly expected: readonly string[] }
  | { readonly kind: 'unexpected' }

/**
 * Parse lockfile `packages:` keys (`name@version`) into pinned versions by name.
 * @param lockfile - parsed pnpm-lock.yaml.
 * @returns every pinned version, keyed by package name.
 */
export function lockedVersions(lockfile: Lockfile): Map<string, Set<string>> {
  const locked = new Map<string, Set<string>>()
  for (const key of Object.keys(lockfile.packages ?? {})) {
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (!/^\d/.test(version)) continue
    const versions = locked.get(name)
    if (versions === undefined) locked.set(name, new Set([version]))
    else versions.add(version)
  }
  return locked
}

/**
 * Classify one materialized closure package against the lockfile.
 * @param pkg - name and version found in the deployed `node_modules`.
 * @param locked - lockfile-pinned versions by package name.
 * @param firstParty - workspace package names, which deploy materializes from `link:`.
 * @returns first-party, locked, drifted (with the expected versions), or unexpected.
 */
export function classifyClosurePackage(
  pkg: ClosurePackage,
  locked: ReadonlyMap<string, ReadonlySet<string>>,
  firstParty: ReadonlySet<string>,
): ClosureJudgement {
  if (firstParty.has(pkg.name)) return { kind: 'first-party' }
  const expected = locked.get(pkg.name)
  if (expected === undefined) return { kind: 'unexpected' }
  if (expected.has(pkg.version)) return { kind: 'locked' }
  return { kind: 'drift', expected: [...expected].sort() }
}

/** Read the package names of every workspace importer the lockfile declares. */
async function firstPartyNames(root: string, lockfile: Lockfile): Promise<Set<string>> {
  const names = new Set<string>()
  for (const importer of Object.keys(lockfile.importers ?? {})) {
    let manifest: { name?: string }
    try {
      manifest = JSON.parse(await readFile(join(root, importer, 'package.json'), 'utf8')) as { name?: string }
    } catch {
      continue // an importer without a readable manifest cannot name itself
    }
    if (manifest.name !== undefined) names.add(manifest.name)
  }
  return names
}

/** Read the top level of a deployed `node_modules` tree, including scoped packages. */
async function readClosure(nodeModules: string): Promise<ClosurePackage[]> {
  const found: ClosurePackage[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        await walk(path, `${entry.name}/`)
        continue
      }
      let manifest: { name?: string; version?: string }
      try {
        manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { name?: string; version?: string }
      } catch {
        continue // a directory without a manifest is not a package
      }
      if (manifest.version === undefined) continue
      found.push({ name: manifest.name ?? `${prefix}${entry.name}`, version: manifest.version })
    }
  }
  await walk(nodeModules, '')
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

const root = resolve(import.meta.dirname, '..')

/**
 * Judge the deployed Host closure and report every divergence from the lockfile.
 * @returns the process exit code: 0 when pinned or unmaterialized, 1 on divergence.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      closure: { type: 'string' },
      lockfile: { type: 'string' },
    },
    strict: true,
  })
  const closureRoot = resolve(root, values.closure ?? 'apps/desktop/runtime-host/node_modules')
  const lockfilePath = resolve(root, values.lockfile ?? 'pnpm-lock.yaml')

  if (!existsSync(closureRoot)) {
    console.log(
      'verify-runtime-lock: SKIPPED — no packaged runtime closure at '
      + `${closureRoot}; run \`node --import tsx apps/desktop/scripts/stage-runtime.ts\` first.`,
    )
    return 0
  }

  const lockfile = yaml.load(await readFile(lockfilePath, 'utf8')) as Lockfile
  const locked = lockedVersions(lockfile)
  const firstParty = await firstPartyNames(root, lockfile)
  const closure = await readClosure(closureRoot)

  const drift: { pkg: ClosurePackage; expected: readonly string[] }[] = []
  const unexpected: ClosurePackage[] = []
  let firstPartyCount = 0
  let lockedCount = 0
  for (const pkg of closure) {
    const judgement = classifyClosurePackage(pkg, locked, firstParty)
    if (judgement.kind === 'first-party') firstPartyCount += 1
    else if (judgement.kind === 'locked') lockedCount += 1
    else if (judgement.kind === 'drift') drift.push({ pkg, expected: judgement.expected })
    else unexpected.push(pkg)
  }
  const thirdParty = closure.length - firstPartyCount

  console.log(`verify-runtime-lock: lockfile pins ${String(locked.size)} package name(s); closure materialized ${String(closure.length)}.`)
  console.log(`  first-party workspace link (no packages: entry expected): ${String(firstPartyCount)}`)
  console.log(`  third-party judged:                                       ${String(thirdParty)}`)
  console.log(`  version matches lockfile:                                 ${String(lockedCount)}`)
  console.log(`  drifted from lockfile:                                    ${String(drift.length)}`)
  console.log(`  unexpected third-party (no lockfile record):              ${String(unexpected.length)}`)

  if (drift.length > 0) {
    console.error('--- drift (packaged runtime actual -> lockfile expected) ---')
    for (const entry of drift) console.error(`  ${entry.pkg.name}: ${entry.pkg.version} -> ${entry.expected.join(' | ')}`)
  }
  if (unexpected.length > 0) {
    console.error('--- unexpected third-party dependencies (absent from the lockfile) ---')
    for (const pkg of unexpected) console.error(`  ${pkg.name}@${pkg.version}`)
  }
  if (drift.length > 0 || unexpected.length > 0) {
    console.error(
      `verify-runtime-lock: ${String(drift.length)} drifted and ${String(unexpected.length)} unexpected `
      + 'third-party package(s) in the packaged Host closure. `pnpm deploy --legacy` re-resolves '
      + 'instead of reading pnpm-lock.yaml, so this closure is not reproducible from the lockfile.',
    )
    return 1
  }
  console.log('verify-runtime-lock: every third-party closure version matches the lockfile pin.')
  return 0
}

if (import.meta.main) {
  process.exitCode = await main()
}
