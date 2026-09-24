import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyPackagedRuntime } from '../scripts/verify-packaged-runtime.ts'

const desktopRoot = resolve(import.meta.dirname, '..')

type PackContext = Parameters<typeof verifyPackagedRuntime>[0]

interface NpmPin {
  readonly name: string
  readonly version: string
  readonly cliEntry: string
  readonly licenseFile: string
}

async function pin(): Promise<NpmPin> {
  return JSON.parse(await readFile(join(desktopRoot, 'npm-runtime.json'), 'utf8')) as NpmPin
}

function context(appOutDir: string, electronPlatformName = 'darwin'): PackContext {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DeepSeek Desktop' } },
  } as PackContext
}

async function createMemoryAssets(shell: string): Promise<void> {
  const memory = join(shell, 'deepseek-memory')
  await mkdir(memory, { recursive: true })
  for (const file of ['manifest.json', 'host.html', 'host.js', 'main-world.js', 'content.js', 'memory-store.js', 'memory-selector.js', 'memory-call-parser.js', 'manager.html', 'manager.js', 'manager.css', 'LICENSE', 'NOTICE.md']) {
    await writeFile(join(memory, file), '')
  }
}

/**
 * Build a packaged application tree holding every shell asset.
 * @param platform - bundle layout to imitate.
 * @returns the output directory and its resources root.
 */
async function packagedApp(platform: 'darwin' | 'win32' = 'darwin'): Promise<{ appOutDir: string; resources: string }> {
  const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
  const resources = platform === 'darwin'
    ? join(appOutDir, 'DeepSeek Desktop.app', 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  const shell = join(resources, 'desktop-resources')
  const unpacked = join(resources, 'app.asar.unpacked', 'lib')
  await mkdir(shell, { recursive: true })
  await mkdir(unpacked, { recursive: true })
  await createMemoryAssets(shell)
  for (const file of ['shell.html', 'shell.css', 'mode-chrome.html', 'mode-chrome.css']) {
    await writeFile(join(shell, file), '')
  }
  for (const file of ['shell-preload.cjs', 'mode-chrome-preload.cjs', 'harness-theme-preload.cjs', 'chat-theme-preload.cjs']) {
    await writeFile(join(unpacked, file), '')
  }
  return { appOutDir, resources }
}

/**
 * Build a staged npm runtime tree for the hook to copy.
 *
 * Names and version come from the pin the staging script owns, so this fixture
 * cannot drift into asserting a different package manager than the build ships.
 * @param options - `version` overrides the pin to exercise a mismatch, and
 * `bundled: false` omits the dependency tree npm needs to resolve itself.
 * @returns the staged root to pass to the hook.
 */
async function stagedNpm(options: { version?: string; bundled?: boolean } = {}): Promise<string> {
  const current = await pin()
  const stagedRoot = await mkdtemp(join(tmpdir(), 'staged-npm-'))
  const npm = join(stagedRoot, current.name)
  await mkdir(join(npm, current.cliEntry, '..'), { recursive: true })
  await writeFile(join(npm, current.cliEntry), '')
  await writeFile(join(npm, 'package.json'), `${JSON.stringify({
    name: current.name,
    version: options.version ?? current.version,
  })}\n`)
  await writeFile(join(npm, current.licenseFile), '')
  if (options.bundled !== false) {
    await mkdir(join(npm, 'node_modules', 'abbrev'), { recursive: true })
    await writeFile(join(npm, 'node_modules', 'abbrev', 'package.json'), '{}\n')
  }
  return stagedRoot
}

describe('packaged desktop runtime verification', () => {
  it.runIf(process.platform === 'win32')('executes the Windows binary and rejects a broken npm CLI', async () => {
    const { appOutDir } = await packagedApp('win32')
    const stagedRoot = await stagedNpm()
    try {
      await copyFile(process.execPath, join(appOutDir, 'DeepSeek Desktop.exe'))
      await writeFile(join(stagedRoot, 'npm', 'bin', 'npm-cli.js'), 'process.exit(17)')
      await expect(verifyPackagedRuntime(context(appOutDir, 'win32'), stagedRoot)).rejects.toThrow(/did not execute/)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })
  it('accepts shell assets and the pinned npm runtime without bundled Harness files', async () => {
    const { appOutDir, resources } = await packagedApp()
    const stagedRoot = await stagedNpm()
    try {
      await expect(verifyPackagedRuntime(context(appOutDir), stagedRoot)).resolves.toBeUndefined()

      const current = await pin()
      const placed = join(resources, current.name)
      // The hook copies the tree verbatim, including the nested dependency tree
      // Electron Builder's own resource copy drops.
      await expect(readFile(join(placed, current.cliEntry), 'utf8')).resolves.toBe('')
      await expect(readFile(join(placed, 'package.json'), 'utf8')).resolves.toContain(current.version)
      expect((await readFile(join(placed, 'node_modules', 'abbrev', 'package.json'), 'utf8')).length).toBeGreaterThan(0)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })

  it('accepts the same contract in a Windows resources directory', async () => {
    const { appOutDir } = await packagedApp('win32')
    const stagedRoot = await stagedNpm()
    try {
      await expect(verifyPackagedRuntime(context(appOutDir, 'win32'), stagedRoot)).resolves.toBeUndefined()
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a package built before the npm runtime was staged', async () => {
    const { appOutDir } = await packagedApp()
    const stagedRoot = await mkdtemp(join(tmpdir(), 'staged-npm-'))
    try {
      await expect(verifyPackagedRuntime(context(appOutDir), stagedRoot))
        .rejects.toThrow(/no bundled dependency tree/iu)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a staged npm runtime that is not the pinned version', async () => {
    const { appOutDir } = await packagedApp()
    const stagedRoot = await stagedNpm({ version: '0.0.0-not-the-pin' })
    try {
      await expect(verifyPackagedRuntime(context(appOutDir), stagedRoot)).rejects.toThrow(/pin requires npm@/u)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })

  it('rejects an npm runtime whose bundled dependency tree was dropped', async () => {
    const { appOutDir } = await packagedApp()
    const stagedRoot = await stagedNpm({ bundled: false })
    try {
      // This is the defect a plain resource copy produces: every named file is
      // present, and npm still cannot resolve itself. The guard refuses to copy it.
      await expect(verifyPackagedRuntime(context(appOutDir), stagedRoot))
        .rejects.toThrow(/no bundled dependency tree/iu)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })

  it('rejects an npm runtime missing the license text it must distribute', async () => {
    const { appOutDir } = await packagedApp()
    const current = await pin()
    const stagedRoot = await stagedNpm()
    await rm(join(stagedRoot, current.name, current.licenseFile))
    try {
      await expect(verifyPackagedRuntime(context(appOutDir), stagedRoot)).rejects.toThrow(/missing LICENSE/iu)
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
      await rm(stagedRoot, { recursive: true, force: true })
    }
  })
})
