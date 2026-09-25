import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertFixtureImportsResolve, fixtureRelativeImports } from './electron-fixture-artifacts.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const fixtureEntries = [
  join(desktopRoot, 'tests/fixtures/deepseek-memory-app/main.mjs'),
  join(desktopRoot, 'tests/fixtures/dual-mode-app/main.mjs'),
]
const TEXT_EXTENSIONS = /\.(?:ts|mjs|cjs|json|html|css|js|yml|yaml)$/

const tempRoots: string[] = []

/** Compare paths inside assertions without carrying a platform separator. */
function slashes(path: string): string {
  return path.split(sep).join('/')
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = join(directory, name)
    if (statSync(file).isDirectory()) return walk(file)
    return TEXT_EXTENSIONS.test(name) ? [file] : []
  })
}

/** Create a throwaway directory tree that stands in for an unbuilt checkout. */
function tempDirectory(prefix: string): string {
  const root = resolve(tmpdir(), `${prefix}-${Date.now().toString(36)}-${String(tempRoots.length)}`)
  tempRoots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}

function writeFixture(root: string, source: string): string {
  const entry = join(root, 'tests/fixtures/any-app/main.mjs')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, source)
  return entry
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop Electron fixture artifact preflight', () => {
  it('reports the missing compiled module and the command that produces it', () => {
    const root = tempDirectory('dsh-fixture-preflight-missing')
    const entry = writeFixture(
      root,
      "import { app } from 'electron'\nimport { DeepSeekMemoryRuntime } from '../../../lib/types/deepseek-memory-extension.js'\n",
    )

    expect(() => {
      assertFixtureImportsResolve(entry)
    }).toThrow(
      /fixture entry is missing: .*lib[\\/]types[\\/]deepseek-memory-extension\.js.*run pnpm run build first/,
    )
  })

  it('accepts a fixture once every relative edge resolves, in either import form', () => {
    const root = tempDirectory('dsh-fixture-preflight-resolved')
    const entry = writeFixture(
      root,
      [
        "import { app } from 'electron'",
        "import { DeepSeekMemoryRuntime } from '../../../lib/types/deepseek-memory-extension.js'",
        "const load = () => import('./sibling.mjs')",
        'void app; void DeepSeekMemoryRuntime; void load',
      ].join('\n'),
    )
    mkdirSync(resolve(root, 'lib/types'), { recursive: true })
    writeFileSync(resolve(root, 'lib/types/deepseek-memory-extension.js'), '')
    expect(() => {
      assertFixtureImportsResolve(entry)
    }).toThrow(/sibling\.mjs/)

    writeFileSync(join(root, 'tests/fixtures/any-app/sibling.mjs'), '')
    expect(() => {
      assertFixtureImportsResolve(entry)
    }).not.toThrow()
  })

  it('keeps every fixture edge pointed at a desktop build output', () => {
    // The preflight only earns its keep while the fixtures import the compiled
    // application rather than source or test siblings: lib/ is exactly what a
    // fresh checkout does not have yet, and it is the tree that ships.
    const edges = fixtureEntries.flatMap(entry =>
      fixtureRelativeImports(entry).map(specifier => slashes(relative(desktopRoot, resolve(dirname(entry), specifier)))))

    expect(edges).toEqual([
      'lib/types/deepseek-memory-extension.js',
      'lib/desktop-application.js',
      'lib/types/native-window-menu.js',
    ])
  })

  it('guards every Electron launch the desktop suite performs', () => {
    const launchCall = /_electron\.launch\(/
    const launchers = walk(join(desktopRoot, 'tests')).filter(file =>
      launchCall.test(readFileSync(file, 'utf8')))

    expect(launchers.map(file => relative(desktopRoot, file).split(sep).join('/')).sort()).toEqual([
      'tests/chat-completion.electron.spec.ts',
      'tests/deepseek-memory.electron.spec.ts',
      'tests/dual-mode.electron.spec.ts',
    ])
    for (const file of launchers) {
      const source = readFileSync(file, 'utf8')
      const guarded = source.match(/assertFixtureImportsResolve\(/g)?.length ?? 0
      const launches = source.match(new RegExp(launchCall.source, 'g'))?.length ?? 0
      expect(guarded).toBeGreaterThanOrEqual(launches)
    }
  })
})

describe('desktop launch paths', () => {
  it('keeps test fixtures out of the production entry and its resources', () => {
    const offenders = [...walk(join(desktopRoot, 'src')), ...walk(join(desktopRoot, 'resources'))]
      .filter(file => readFileSync(file, 'utf8').includes('tests/fixtures'))
      .map(file => relative(desktopRoot, file))

    expect(offenders).toEqual([])
    // The shipped main process is the bundle, so it carries no import of the
    // memory runtime module at all: nothing reaches out of lib/ at runtime.
    const packaged = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { readonly main: string }
    expect(packaged.main).toBe('lib/main.js')
  })

  it('carries no developer-machine absolute path', () => {
    // A drive-anchored route into a home, checkout, or scratch directory is the
    // signature of a path that only resolves on one machine. The Windows system
    // root fallbacks stay allowed because they are operating-system defaults.
    const machinePath = /[a-z]:[\\/]{1,2}(?:users|projects|home|workspace|temp|scratch)/i
    const offenders = ['src', 'tests', 'scripts'].flatMap(directory => walk(join(desktopRoot, directory)))
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return machinePath.test(source) || source.includes(repositoryRoot)
      })
      .map(file => relative(repositoryRoot, file))

    expect(offenders).toEqual([])
  })

  it('ships the Chat Memory extension as app resources, not as a test fixture', () => {
    // main.ts loads resources/deepseek-memory unpackaged and
    // desktop-resources/deepseek-memory packaged; both halves name the same
    // tracked directory, so no launch mode depends on a fixture copy.
    const extensionRoot = join(desktopRoot, 'resources/deepseek-memory')
    const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8')) as {
      readonly name: string
      readonly version: string
    }
    expect(manifest.name).toBeTruthy()
    expect(manifest.version).toBeTruthy()
    expect(walk(extensionRoot).some(file => file.includes(join('tests', 'fixtures')))).toBe(false)
  })
})
