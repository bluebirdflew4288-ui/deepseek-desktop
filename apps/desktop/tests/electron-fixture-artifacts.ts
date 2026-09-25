/**
 * Preflight for the desktop's Electron fixtures.
 *
 * Each fixture is a real Electron application, so its `main.mjs` resolves the
 * desktop's compiled output with Node's own ESM loader rather than through
 * Vitest's TypeScript resolution. `apps/desktop/lib` is a build output and is
 * not tracked, so launching a fixture before the repository build kills
 * Electron's main process with a bare ERR_MODULE_NOT_FOUND — a modal crash
 * dialog on Windows and a lost test process everywhere else. Checking the same
 * edges here turns that into an actionable failure naming the artifact.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Relative module edges a fixture's own source declares.
 *
 * Both the `from './x'` form and the dynamic `import('./x')` form are matched
 * because those are the two ways a fixture can pull in desktop code; the
 * `.`-prefixed requirement keeps package specifiers such as `electron` out of
 * the result, since Node resolves those from `node_modules` instead.
 */
const RELATIVE_SPECIFIER_PATTERNS = [
  /\bfrom\s*['"](\.[^'"\n]*)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"\n]*)['"]\s*\)/g,
] as const

/** @returns every relative import specifier the fixture declares, in source order. */
export function fixtureRelativeImports(fixtureEntry: string): string[] {
  const source = readFileSync(fixtureEntry, 'utf8')
  const specifiers = RELATIVE_SPECIFIER_PATTERNS.flatMap(pattern =>
    [...source.matchAll(pattern)].map(match => match[1] as string))
  return [...new Set(specifiers)]
}

/**
 * Verify that everything a fixture imports is present before Electron starts.
 * @param fixtureEntry - the fixture's `main.mjs`, resolved to an absolute path.
 * @throws if a relative module edge does not resolve on disk.
 */
export function assertFixtureImportsResolve(fixtureEntry: string): void {
  const fixtureDirectory = dirname(fixtureEntry)
  for (const specifier of fixtureRelativeImports(fixtureEntry)) {
    const target = resolve(fixtureDirectory, specifier)
    if (!existsSync(target)) {
      throw new Error(`desktop Electron fixture entry is missing: ${target}; run pnpm run build first`)
    }
  }
}
