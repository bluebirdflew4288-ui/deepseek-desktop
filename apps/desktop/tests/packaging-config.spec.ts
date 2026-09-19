import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  readonly scripts: Readonly<Record<string, string>>
  readonly build: {
    readonly appId: string
    readonly afterPack: string
    readonly asarUnpack: readonly string[]
    readonly electronDist: string
    readonly files: readonly string[]
    readonly extraResources: readonly {
      readonly from: string
      readonly to: string
    }[]
    readonly productName: string
    readonly mac: {
      readonly hardenedRuntime: boolean
      readonly icon: string
      readonly identity: string
      readonly notarize: boolean
    }
    readonly win: { readonly icon: string }
  }
}

interface RootPackage {
  readonly scripts: Readonly<Record<string, string>>
}

const REQUIRED_PACKAGED_SHELL_FILES = [
  'desktop-resources/shell.html',
  'desktop-resources/shell.css',
  'desktop-resources/mode-chrome.html',
  'desktop-resources/mode-chrome.css',
  'desktop-resources/deepseek-memory/manifest.json',
  'desktop-resources/deepseek-memory/host.html',
  'desktop-resources/deepseek-memory/host.js',
  'desktop-resources/deepseek-memory/main-world.js',
  'desktop-resources/deepseek-memory/content.js',
  'desktop-resources/deepseek-memory/memory-store.js',
  'desktop-resources/deepseek-memory/memory-selector.js',
  'desktop-resources/deepseek-memory/manager.html',
  'desktop-resources/deepseek-memory/manager.js',
  'desktop-resources/deepseek-memory/manager.css',
  'desktop-resources/deepseek-memory/LICENSE',
  'desktop-resources/deepseek-memory/NOTICE.md',
  'lib/shell-preload.cjs',
  'lib/mode-chrome-preload.cjs',
  'lib/harness-theme-preload.cjs',
  'lib/chat-theme-preload.cjs',
] as const

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const workspaceConfiguration = readFileSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
const builderPatch = readFileSync(resolve(repositoryRoot, 'patches/app-builder-lib@26.15.3.patch'), 'utf8')
const desktopPackage = JSON.parse(
  readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'),
) as DesktopPackage
const rootPackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
) as RootPackage

/** Check whether electron-builder's file and resource rules include one packaged path. */
function includesPackagedFile(relativePath: string): boolean {
  if (relativePath.startsWith('desktop-resources/')) {
    return desktopPackage.build.extraResources.some(({ from, to }) =>
      from === 'resources' && to === 'desktop-resources'
      && relativePath.startsWith(`${to}/`),
    )
  }
  return desktopPackage.build.files.some(pattern =>
    pattern === relativePath || (pattern === 'lib/**' && relativePath.startsWith('lib/')),
  )
}

describe('desktop packaging configuration', () => {
  it('uses the DeepSeek Desktop product identity', () => {
    expect(desktopPackage.build.appId).toBe('ai.deepseek.harness.desktop')
    expect(desktopPackage.build.productName).toBe('DeepSeek Desktop')
  })

  it('packages the installed Electron distribution', () => {
    expect(desktopPackage.build.electronDist).toBe('node_modules/electron/dist')
    expect(workspaceConfiguration).toContain("'app-builder-lib@26.15.3>@electron/get': '3.1.0'")
  })

  it('packages the managed npm runtime without a fixed Harness closure', () => {
    expect(desktopPackage.build.extraResources).toEqual(expect.arrayContaining([
      { from: 'resources', to: 'desktop-resources' },
      { from: 'build/zh_CN.lproj', to: 'zh_CN.lproj' },
    ]))
    expect(desktopPackage.build.extraResources.some(({ to }) => to === 'host')).toBe(false)
    // The bundle localization is what lets the operating system render the menu
    // items it inserts itself in the shell locale instead of English.
    expect(existsSync(resolve(desktopRoot, 'build/zh_CN.lproj/InfoPlist.strings'))).toBe(true)
    for (const packagedFile of REQUIRED_PACKAGED_SHELL_FILES) {
      expect(includesPackagedFile(packagedFile)).toBe(true)
    }
    expect(existsSync(resolve(desktopRoot, 'resources/shell.html'))).toBe(true)
    expect(existsSync(resolve(desktopRoot, 'resources/shell.css'))).toBe(true)
    expect(desktopPackage.build.files).toContain('lib/**')
    expect(desktopPackage.build.asarUnpack).toContain('lib/shell-preload.cjs')
    expect(desktopPackage.build.asarUnpack).toContain('lib/mode-chrome-preload.cjs')
    expect(desktopPackage.build.asarUnpack).toContain('lib/harness-theme-preload.cjs')
    expect(desktopPackage.build.asarUnpack).toContain('lib/chat-theme-preload.cjs')
    expect(desktopPackage.build.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
  })

  it('unlocks the temporary signing Keychain with its own password', () => {
    expect(workspaceConfiguration).toContain(
      'app-builder-lib@26.15.3: patches/app-builder-lib@26.15.3.patch',
    )
    expect(builderPatch).toContain('cscPasswords, keychainPassword')
    expect(builderPatch).toContain('"-k", keychainPassword, keychainFile')
  })

  it('keeps the supplied image byte-for-byte and shares it across macOS and Windows', () => {
    const icon = readFileSync(resolve(desktopRoot, 'build/icon.png'))

    expect(createHash('sha256').update(icon).digest('hex'))
      .toBe('e9fa2ac692491c051536fb5d322e7eefe874d3977892e82852295d137bf27d91')
    expect(desktopPackage.build.mac.icon).toBe('build/icon.png')
    expect(desktopPackage.build.win.icon).toBe('build/icon.png')
  })

  it('builds and stages the complete workspace before local packaging', () => {
    for (const name of ['package', 'dist']) {
      const command = desktopPackage.scripts[name]
      if (command === undefined) throw new Error(`missing desktop ${name} script`)
      expect(command).toContain('pnpm --workspace-root run build')
      expect(command).toContain('scripts/stage-npm.ts')
      expect(command).toContain('pnpm run materialize:electron')
      expect(command.indexOf('pnpm --workspace-root run build'))
        .toBeLessThan(command.indexOf('scripts/stage-npm.ts'))
      expect(command.indexOf('scripts/stage-npm.ts'))
        .toBeLessThan(command.indexOf('pnpm run materialize:electron'))
      expect(command.indexOf('pnpm run materialize:electron'))
        .toBeLessThan(command.indexOf('electron-builder'))
    }
    expect(desktopPackage.scripts['materialize:electron'])
      .toBe('node node_modules/electron/install.js')
    expect(desktopPackage.scripts.package).toContain('electron-builder --dir')
    expect(desktopPackage.scripts.package).not.toContain('release-preflight.ts')
  })

  it('makes the macOS DMG path signed, hardened, and notarized', () => {
    const command = desktopPackage.scripts['dist:mac']

    expect(command).toBe('node --import tsx scripts/release-mac.ts')
    expect(readFileSync(resolve(desktopRoot, 'scripts/release-mac.ts'), 'utf8'))
      .toContain("run('pnpm', ['run', 'materialize:electron'], desktopRoot, buildEnvironment)")
    expect(desktopPackage.build.mac.hardenedRuntime).toBe(true)
    expect(desktopPackage.build.mac.notarize).toBe(true)
  })

  it('ad-hoc signs macOS by default so the bundle identifier is the signing identifier', () => {
    // Without an explicit identity Electron Builder skips signing entirely and the
    // packaged app keeps the Electron stub signature (`Identifier=Electron`), which
    // macOS rejects for notifications. Ad-hoc signing is the safe default because
    // the signing identifier then matches CFBundleIdentifier.
    expect(desktopPackage.build.mac.identity).toBe('-')
  })

  it('keeps a real Developer ID release from inheriting the ad-hoc default', () => {
    const releaseScript = readFileSync(resolve(desktopRoot, 'scripts/release-mac.ts'), 'utf8')
    // Electron Builder resolves `mac.identity` before CSC_NAME, so the release must
    // name its Developer ID explicitly or the config default would win.
    expect(releaseScript).toContain('electronBuilderIdentity')
    expect(releaseScript).toContain('--config.mac.identity=')
    expect(readFileSync(resolve(desktopRoot, 'scripts/release-preflight.ts'), 'utf8'))
      .toContain('export function electronBuilderIdentity')
  })

  it('exposes generic and macOS release commands at the repository root', () => {
    expect(rootPackage.scripts['dist:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run dist')
    expect(rootPackage.scripts['dist:mac:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run dist:mac')
  })
})
