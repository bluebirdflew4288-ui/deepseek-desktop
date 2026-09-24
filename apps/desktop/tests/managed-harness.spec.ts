import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessHealthCheck } from '../src/managed-harness-health.ts'
import {
  createNpmHarnessInstaller,
  harnessInstallArgs,
  verifyHarnessInstall,
} from '../src/managed-harness-installer.ts'
import { createManagedHarnessDiagnostics, describeFailure } from '../src/managed-harness-log.ts'
import {
  harnessCliEntry,
  isManagedHarnessVersionName,
  managedHarnessLayout,
} from '../src/managed-harness-paths.ts'
import { managedProcessEnvironment, managedSearchPath } from '../src/managed-harness-process.ts'
import {
  createHarnessReleaseSource,
  readHarnessRelease,
  HARNESS_PACKAGE,
  HARNESS_REGISTRY,
} from '../src/managed-harness-registry.ts'
import {
  createManagedHarnessRuntime,
  type ManagedHarnessRuntime,
  type ManagedHarnessTransactionProgress,
} from '../src/managed-harness.ts'
import {
  parseManagedHarnessState,
  promoteManagedHarnessVersion,
  recoverManagedHarnessState,
  serializeManagedHarnessState,
} from '../src/managed-harness-state.ts'

vi.mock('node:child_process', { spy: true })

const HARNESS_HOME = '/Users/tester/.dsh'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'managed-harness-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

/** Write the three artifacts a real Harness install must contain. */
async function materializeHarness(directory: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/@deepseek-ai/dsh': { integrity: `sha512-${version}` },
  } }))
  const pkg = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await mkdir(join(directory, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), `${JSON.stringify({ name: HARNESS_PACKAGE, version })}\n`)
  await writeFile(join(pkg, 'lib', 'bin.js'), '// harness cli\n')
  await writeFile(
    join(directory, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    '<!doctype html>\n',
  )
}

/** Mark one fixture as a version directory installed by Desktop. */
async function markDesktopManagedVersion(directory: string, version: string, transactionId = '11111111-1111-4111-8111-111111111111'): Promise<void> {
  await writeFile(join(directory, '.dsh-desktop-managed.json'), JSON.stringify({
    schemaVersion: 1,
    package: HARNESS_PACKAGE,
    version,
    transactionId,
  }))
}

interface HarnessFixtures {
  runtime: ManagedHarnessRuntime
  readonly releases: string[]
  readonly latestCalls: number[]
  readonly installed: string[]
  readonly healthChecked: string[]
  /** Every stage report the runtime published, in the order it published them. */
  readonly stages: ManagedHarnessTransactionProgress[]
  /** Versions whose install the installer fails. */
  readonly failInstall: Set<string>
  /** Versions whose health check fails. */
  readonly failHealth: Set<string>
  /** Versions the installer materializes with a mismatched manifest. */
  readonly wrongVersion: Set<string>
  readonly processes: Array<{ command: string; args: readonly string[] }>
  /** Whether the next install waits for `releaseInstall` or an abandoned signal. */
  holdsInstall: boolean
  /** Let a held install finish, standing in for a package manager that exits. */
  releaseInstall(): void
  /** Whether the next registry round trip waits for `releaseLookup`. */
  holdsRelease: boolean
  /** Let a held registry round trip answer. */
  releaseLookup(): void
  /** Whether the next staging record cancels the transaction from inside it,
   * which is the last await before the package manager is started. */
  cancelOnStagingRecord: boolean
  failAfterBackup: boolean
  /** Whether the next health check waits for `releaseHealth`. */
  holdsHealth: boolean
  /** Let a held health check finish. */
  releaseHealth(): void
  /** Abandoning signals the installer received, one per install it ran. */
  readonly installSignals: Array<AbortSignal | undefined>
  /** Latest progress a registry round trip was asked to honor. */
  readonly releaseSignals: Array<AbortSignal | undefined>
}

/**
 * Build a runtime whose registry, installer, health check, and ownership probe
 * are all fakes, so a transaction is exercised against a real filesystem without
 * a network or a spawned Harness.
 * @param releases - Official versions the registry reports, newest last.
 * @returns The runtime and the record of every call its dependencies received.
 */
async function fixtures(
  releases: string[] = ['0.1.5-rc.1'],
  commandOutput?: string,
  runtimeRoot = root,
  rootBoundary?: string,
  rootAnchor?: string,
): Promise<HarnessFixtures> {
  let releaseHeldInstall: (() => void) | undefined
  let releaseHeldLookup: (() => void) | undefined
  let releaseHeldHealth: (() => void) | undefined
  const state: HarnessFixtures = {
    runtime: undefined as unknown as ManagedHarnessRuntime,
    releases: [...releases],
    latestCalls: [],
    installed: [],
    healthChecked: [],
    stages: [],
    failInstall: new Set<string>(),
    failHealth: new Set<string>(),
    wrongVersion: new Set<string>(),
    processes: [],
    holdsInstall: false,
    releaseInstall: () => { releaseHeldInstall?.() },
    holdsRelease: false,
    releaseLookup: () => { releaseHeldLookup?.() },
    cancelOnStagingRecord: false,
    failAfterBackup: false,
    holdsHealth: false,
    releaseHealth: () => { releaseHeldHealth?.() },
    installSignals: [],
    releaseSignals: [],
  }
  state.runtime = createManagedHarnessRuntime({
    platform: 'darwin',
    root: runtimeRoot,
    ...(rootBoundary === undefined ? {} : { rootBoundary }),
    ...(rootAnchor === undefined ? {} : { rootAnchor }),
    nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
    cwd: '/Users/tester',
    electronRunAsNode: true,
    releaseSource: {
      async latest(signal) {
        state.latestCalls.push(1)
        state.releaseSignals.push(signal)
        if (state.holdsRelease) {
          await new Promise<void>((resolve) => {
            const finish = (): void => { resolve() }
            releaseHeldLookup = finish
            signal?.addEventListener('abort', finish, { once: true })
          })
          releaseHeldLookup = undefined
        }
        if (signal?.aborted === true) throw new Error('The operation was aborted')
        const version = state.releases[state.releases.length - 1]
        if (version === undefined) throw new Error('registry publishes no latest release tag')
        return { version, integrity: `sha512-${version}` }
      },
    },
    installer: {
      async install(request) {
        state.installed.push(request.version)
        state.installSignals.push(request.signal)
        if (state.holdsInstall) {
          await new Promise<void>((resolve) => {
            const finish = (): void => { resolve() }
            releaseHeldInstall = finish
            request.signal?.addEventListener('abort', finish, { once: true })
          })
          releaseHeldInstall = undefined
        }
        // The real runner reports an abandoned child as one a signal ended.
        if (request.signal?.aborted === true) {
          return { exitCode: null, signal: 'SIGTERM', output: '' }
        }
        if (state.failInstall.has(request.version)) return { exitCode: 1, signal: null, output: 'EBADENGINE' }
        await materializeHarness(request.directory, state.wrongVersion.has(request.version) ? '9.9.9' : request.version)
        return { exitCode: 0, signal: null, output: '' }
      },
    },
    healthCheck: {
      async check(request) {
        state.healthChecked.push(request.version)
        if (state.holdsHealth) {
          await new Promise<void>((resolve) => {
            releaseHeldHealth = resolve
          })
          releaseHeldHealth = undefined
        }
        return state.failHealth.has(request.version)
          ? { healthy: false, failure: 'readiness timed out' }
          : { healthy: true }
      },
    },
    onTransactionStage: (progress) => { state.stages.push(progress) },
    diagnostics: {
      async record(entry) {
        if (state.cancelOnStagingRecord && entry.phase === 'staging') {
          state.cancelOnStagingRecord = false
          state.runtime.cancelTransaction()
        }
        if (state.failAfterBackup && entry.phase === 'backed-up') {
          state.failAfterBackup = false
          const layout = managedHarnessLayout(runtimeRoot)
          const pending = parseManagedHarnessState(await readFile(layout.stateFile, 'utf8')).pending
          if (pending?.transactionId !== undefined) {
            await rm(layout.backupDirectory(pending.transactionId), { recursive: true, force: true })
          }
          throw new Error('injected missing transaction backup')
        }
      },
    },
    runProcess: async (request) => {
      state.processes.push({ command: request.command, args: request.args })
      if (request.command === 'pgrep') return { exitCode: 1, signal: null, output: '' }
      // The ownership probe reads a command line naming a Harness the user
      // started themselves, which is exactly the process it must leave running.
      return {
        exitCode: 0,
        signal: null,
        output: commandOutput ?? 'node /Users/tester/.npm/_npx/xyz/node_modules/.bin/dsh web --port 3081\n',
      }
    },
  })
  return state
}

/** Names of the program directories currently retained on disk. */
async function retainedVersions(): Promise<string[]> {
  return readdir(managedHarnessLayout(root).versions).catch(() => [] as string[])
}

/**
 * Names of the candidates currently staged.
 *
 * An absent staging directory is empty: collection removes it wholesale and a
 * transaction recreates it on demand.
 * @returns the staged candidate names.
 */
async function stagedVersions(): Promise<string[]> {
  return readdir(managedHarnessLayout(root).staging).catch(() => [] as string[])
}

describe('managed Harness version state', () => {
  it('round-trips the retained versions and an in-flight transaction', () => {
    const serialized = serializeManagedHarnessState({
      current: '0.1.5-rc.1',
      previous: '0.1.5-rc.0',
      pending: { operation: 'update', version: '0.1.5-rc.2' },
    })

    expect(parseManagedHarnessState(serialized)).toEqual({
      current: '0.1.5-rc.1',
      previous: '0.1.5-rc.0',
      pending: { operation: 'update', version: '0.1.5-rc.2' },
    })
  })

  it.each([
    'not json',
    '[]',
    '{"current":"0.1.5-rc.1"}',
    '{"schemaVersion":2,"current":"0.1.5-rc.1"}',
    '{"schemaVersion":1,"current":"../../etc"}',
    '{"schemaVersion":1,"current":"0.1.5-rc.1","previous":"0.1.5-rc.1"}',
    '{"schemaVersion":1,"pending":{"operation":"sideload","version":"0.1.5-rc.1"}}',
  ])('rejects a state document it cannot trust: %s', (content) => {
    expect(() => parseManagedHarnessState(content)).toThrow(/managed Harness state/iu)
  })

  it('keeps the last verified version when an interrupted transaction is recovered', () => {
    const recovered = recoverManagedHarnessState({
      current: '0.1.5-rc.1',
      pending: { operation: 'update', version: '0.1.5-rc.2' },
    })

    expect(recovered).toEqual({ current: '0.1.5-rc.1' })
  })

  it('makes the outgoing current the rollback target, and keeps that target on a reinstall', () => {
    expect(promoteManagedHarnessVersion({ current: 'A' }, 'B')).toEqual({ current: 'B', previous: 'A' })
    expect(promoteManagedHarnessVersion({}, 'B')).toEqual({ current: 'B' })
    expect(promoteManagedHarnessVersion({ current: 'B', previous: 'A' }, 'B')).toEqual({ current: 'B', previous: 'A' })
  })
})

describe('managed Harness layout', () => {
  it('refuses a version that would escape the program directory', () => {
    const layout = managedHarnessLayout(root)

    expect(isManagedHarnessVersionName('0.1.5-rc.1')).toBe(true)
    expect(isManagedHarnessVersionName('../escape')).toBe(false)
    expect(isManagedHarnessVersionName('a/b')).toBe(false)
    expect(() => layout.versionDirectory('../escape')).toThrow(/safe directory name/iu)
    expect(() => managedHarnessLayout('relative/root')).toThrow(/must be absolute/iu)
  })

  it('keeps the disposable health home inside the managed root, away from Harness user data', () => {
    const layout = managedHarnessLayout(root)

    expect(layout.healthHome('11111111-1111-4111-8111-111111111111')).toBe(join(root, 'health', '11111111-1111-4111-8111-111111111111'))
    expect(layout.healthHome('11111111-1111-4111-8111-111111111111').startsWith(root)).toBe(true)
    expect(harnessCliEntry(layout.versionDirectory('0.1.5-rc.1')))
      .toBe(join(root, 'versions', '0.1.5-rc.1', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })
})

describe('official Harness release metadata', () => {
  it('reads only the latest tag, with the integrity value the registry publishes', () => {
    const release = readHarnessRelease({
      'dist-tags': { latest: '0.1.5-rc.1', alpha: '0.1.5-alpha.2', next: '0.1.5-rc.2' },
      versions: {
        '0.1.5-rc.1': {
          dist: { integrity: 'sha512-abc', tarball: `${HARNESS_REGISTRY}@deepseek-ai/dsh/-/dsh-0.1.5-rc.1.tgz` },
        },
      },
    })

    expect(release).toEqual({
      version: '0.1.5-rc.1',
      integrity: 'sha512-abc',
      tarball: `${HARNESS_REGISTRY}@deepseek-ai/dsh/-/dsh-0.1.5-rc.1.tgz`,
    })
  })

  it.each([
    [{}, 'no distribution tags'],
    [{ 'dist-tags': {} }, 'no latest release tag'],
    [{ 'dist-tags': { latest: '../escape' } }, 'not a usable version'],
    [{ 'dist-tags': { latest: '' } }, 'no latest release tag'],
    ['latest', 'unexpected document'],
  ])('rejects a registry document it cannot act on: %j', (packument, message) => {
    expect(() => readHarnessRelease(packument)).toThrow(new RegExp(message, 'iu'))
  })

  it('asks the pinned official registry and refuses a redirect', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ 'dist-tags': { latest: '0.1.5-rc.1' }, versions: { '0.1.5-rc.1': { dist: { integrity: 'sha512-abc' } } } }),
    })) as unknown as typeof fetch

    await expect(createHarnessReleaseSource({ fetchImpl }).latest()).resolves.toEqual({ version: '0.1.5-rc.1', integrity: 'sha512-abc' })
    expect(fetchImpl).toHaveBeenCalledWith(`${HARNESS_REGISTRY}@deepseek-ai%2fdsh`, expect.objectContaining({
      redirect: 'error',
    }))
  })

  it('reports a registry that answers with an error status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch

    await expect(createHarnessReleaseSource({ fetchImpl }).latest()).rejects.toThrow(/answered 503/iu)
  })
})

describe('managed Harness installer', () => {
  it('pins the official registry, ignores scripts, and resolves peers by the default rules', () => {
    const layout = managedHarnessLayout(root)
    const args = harnessInstallArgs('/resources/npm/bin/npm-cli.js', layout, {
      directory: layout.stagingDirectory('0.1.5-rc.1'),
      version: '0.1.5-rc.1',
    })

    expect(args).toContain('--registry')
    expect(args[args.indexOf('--registry') + 1]).toBe(HARNESS_REGISTRY)
    expect(args).toContain('--ignore-scripts')
    expect(args).toContain('--no-update-notifier')
    expect(args).toContain(`${HARNESS_PACKAGE}@0.1.5-rc.1`)
    expect(args[args.indexOf('--prefix') + 1]).toBe(layout.stagingDirectory('0.1.5-rc.1'))
    // Both configuration slots point at distinct files the desktop owns, so a
    // personal registry mirror cannot reach a managed install, and npm does not
    // reject one file occupying both slots.
    expect(args[args.indexOf('--userconfig') + 1]).toBe(layout.npmUserConfig)
    expect(args[args.indexOf('--globalconfig') + 1]).toBe(layout.npmGlobalConfig)
    expect(layout.npmUserConfig).not.toBe(layout.npmGlobalConfig)
    // Skipping peer resolution omits Service Definition packages the CLI imports
    // at boot, so the installer must not ask for it.
    expect(args).not.toContain('--legacy-peer-deps')
  })

  it('gives the installer a search path with no user Node, npm, or npx on it', () => {
    const env = managedProcessEnvironment({ DSH_HOME: HARNESS_HOME })

    expect(env.PATH).toBe(managedSearchPath())
    expect(env.PATH).not.toContain('/opt/homebrew/bin')
    expect(env.PATH).not.toContain('/usr/local/bin')
    expect(env.DSH_HOME).toBe(HARNESS_HOME)
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('refuses an existing target without deleting its contents', async () => {
    const layout = managedHarnessLayout(root)
    const target = layout.stagingDirectory('0.1.5-rc.1')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'stale.js'), 'stale\n')
    const seen: Array<{ command: string; env: NodeJS.ProcessEnv }> = []
    const installer = createNpmHarnessInstaller({
      layout,
      nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
      npmCliEntry: '/resources/npm/bin/npm-cli.js',
      runProcess: async (request) => {
        seen.push({ command: request.command, env: request.env })
        return { exitCode: 0, signal: null, output: '' }
      },
    })

    await expect(installer.install({ directory: target, version: '0.1.5-rc.1' })).rejects.toThrow(/already exists/iu)

    expect(seen).toEqual([])
    await expect(readFile(join(target, 'stale.js'), 'utf8')).resolves.toBe('stale\n')
  })

  it('installs into a fresh exclusive transaction directory', async () => {
    const layout = managedHarnessLayout(root)
    const target = layout.stagingDirectory('11111111-1111-4111-8111-111111111111')
    const seen: Array<{ command: string; env: NodeJS.ProcessEnv }> = []
    const installer = createNpmHarnessInstaller({
      layout, nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
      npmCliEntry: '/resources/npm/bin/npm-cli.js',
      runProcess: async (request) => { seen.push({ command: request.command, env: request.env }); return { exitCode: 0, signal: null, output: '' } },
    })
    await mkdir(layout.staging, { recursive: true })
    await installer.install({ directory: target, version: '0.1.5-rc.1' })
    expect(seen[0]?.command).toBe('/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop')
    expect(seen[0]?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(seen[0]?.env.PATH).toBe(managedSearchPath())
    await expect(readdir(target).then(entries => entries.sort())).resolves.toEqual(['package.json'])
    const stagingManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      overrides?: Record<string, string>
    }
    expect(stagingManifest.overrides).toEqual({
      '@deepseek-ai/cordis': '4.0.2',
      '@deepseek-ai/cordis-plugin-loader': '1.0.3',
    })
    expect(await readFile(layout.npmUserConfig, 'utf8')).toBe('')
    expect(await readFile(layout.npmGlobalConfig, 'utf8')).toBe('')
  })

  it.each(['cache-root', 'config-root', 'user-config-file'] as const)(
    'refuses a reparse point at managed npm %s without changing the external sentinel',
    async (targetKind) => {
      const layout = managedHarnessLayout(root)
      const outside = join(root, 'outside-' + targetKind)
      await mkdir(outside, { recursive: true })
      const sentinel = join(outside, 'sentinel.txt')
      await writeFile(sentinel, 'preserve')
      const target = targetKind === 'cache-root' ? layout.npmCache
        : targetKind === 'config-root' ? dirname(layout.npmUserConfig)
          : layout.npmUserConfig
      await mkdir(join(root, 'staging'), { recursive: true })
      if (targetKind === 'user-config-file') {
        await mkdir(dirname(target), { recursive: true })
        await symlink(outside, target, 'junction')
      } else {
        await symlink(outside, target, 'junction')
      }
      const runProcess = vi.fn(async () => ({ exitCode: 0, signal: null, output: '' }))
      const installer = createNpmHarnessInstaller({
        layout,
        nodeExecutable: '/bin/true',
        npmCliEntry: '/npm-cli.js',
        runProcess,
      })

      await expect(installer.install({
        directory: join(root, 'staging', 'candidate'),
        version: '0.1.5-rc.1',
      })).rejects.toThrow(/reparse|symbolic link/iu)

      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve')
      expect(runProcess).not.toHaveBeenCalled()
    },
  )

  it('accepts the exact release it staged and rejects a substituted one', async () => {
    const directory = join(root, 'candidate')
    await materializeHarness(directory, '0.1.5-rc.1')

    await expect(verifyHarnessInstall(directory, '0.1.5-rc.1')).resolves.toBeUndefined()
    await expect(verifyHarnessInstall(directory, '0.1.5-rc.2')).rejects.toThrow(/expected 0.1.5-rc.2/iu)
    await expect(verifyHarnessInstall(join(root, 'absent'), '0.1.5-rc.1')).rejects.toThrow(/no package manifest/iu)

    const manifest = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    await writeFile(manifest, `${JSON.stringify({ name: 'some-other-package', version: '0.1.5-rc.1' })}\n`)
    await expect(verifyHarnessInstall(directory, '0.1.5-rc.1')).rejects.toThrow(/wrong package/iu)

    await writeFile(manifest, `${JSON.stringify({ name: HARNESS_PACKAGE, version: '0.1.5-rc.1' })}\n`)
    await rm(join(directory, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))
    await expect(verifyHarnessInstall(directory, '0.1.5-rc.1')).rejects.toThrow(/is missing/iu)
  })
})

describe('managed Harness health check', () => {
  it('launches the candidate exactly as production does, against a Harness home it owns', async () => {
    const spawned = {
      stdout: { on: vi.fn(), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      off: vi.fn(),
      kill: vi.fn(),
      ownerNonce: '11111111-1111-4111-8111-111111111111',
      pid: 4242,
    }
    vi.mocked(spawn).mockReturnValue(spawned as never)
    const layout = managedHarnessLayout(root)
    await materializeHarness(layout.versionDirectory('0.1.5-rc.1'), '0.1.5-rc.1')
    const transactionId = '11111111-1111-4111-8111-111111111111'
    const healthHome = layout.healthHome(transactionId)
    const check = createHarnessHealthCheck({
      layout,
      nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
      cwd: '/Users/tester',
      electronRunAsNode: true,
      readinessTimeoutMs: 50,
      createSupervisor: (supervisorOptions) => {
        // Spawning is mocked, so invoking the factory is what reveals the launch.
        supervisorOptions.spawnHost()
        return {
          start: () => Promise.resolve({ origin: 'http://127.0.0.1:1', token: 'discarded' }),
          shutdown: () => Promise.resolve(),
          onUnexpectedExit: () => () => undefined,
        }
      },
    })

    await expect(check.check({ versionDirectory: layout.versionDirectory('0.1.5-rc.1'), version: '0.1.5-rc.1', transactionId }))
      .resolves.toEqual({ healthy: true })

    const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? []
    expect(command).toBe('/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop')
    expect(args).toContain('--no-open')
    expect(args).toContain('--expose-internals')
    expect(args).toContain(harnessCliEntry(layout.versionDirectory('0.1.5-rc.1')))
    const env = (options as { env: NodeJS.ProcessEnv }).env
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    // The check must not read or write the user's real Harness data.
    expect(env.DSH_HOME).toBe(healthHome)
    expect(env.DSH_HOME).not.toBe(HARNESS_HOME)
    expect(env.PATH).toBe(managedSearchPath())
    // The health home is disposable: nothing is left behind for the next run.
    await expect(readdir(healthHome)).rejects.toThrow()
  })

  it('reports an unhealthy candidate instead of throwing', async () => {
    const layout = managedHarnessLayout(root)
    const check = createHarnessHealthCheck({
      layout,
      nodeExecutable: '/bin/true',
      cwd: '/Users/tester',
      readinessTimeoutMs: 10,
      createSupervisor: () => ({
        start: () => Promise.reject(new Error('desktop Host exited before readiness (code 1, signal null)')),
        shutdown: () => Promise.resolve(),
        onUnexpectedExit: () => () => undefined,
      }),
    })

    await expect(check.check({ versionDirectory: layout.versionDirectory('0.1.5-rc.1'), version: '0.1.5-rc.1', transactionId: '11111111-1111-4111-8111-111111111111' }))
      .resolves.toEqual({ healthy: false, failure: 'desktop Host exited before readiness (code 1, signal null)' })
  })
})

describe('managed Harness diagnostics', () => {
  it('rotates at its cap so repeated failures cannot grow without bound', async () => {
    const file = join(root, 'logs', 'managed-harness.log')
    const diagnostics = createManagedHarnessDiagnostics({
      file,
      maxBytes: 200,
      now: () => new Date('2026-09-10T00:00:00.000Z'),
    })

    for (let index = 0; index < 12; index += 1) {
      await diagnostics.record({ operation: 'update', version: '0.1.5-rc.1', phase: `phase-${String(index)}` })
    }

    const live = await readFile(file, 'utf8')
    const rotated = await readFile(`${file}.1`, 'utf8')
    expect(live.length).toBeLessThanOrEqual(400)
    expect(rotated.length).toBeLessThanOrEqual(400)
    expect(live.split('\n').filter(line => line !== '').length).toBeLessThan(12)
    expect(JSON.parse(live.trim().split('\n').at(-1) ?? '{}')).toEqual({
      time: '2026-09-10T00:00:00.000Z',
      operation: 'update',
      version: '0.1.5-rc.1',
      phase: 'phase-11',
    })
  })

  it('records the first line of a failure, never its stack', () => {
    const error = new Error('first line\n    at SomeFrame (/private/path:1:1)')

    expect(describeFailure(error)).toBe('first line')
    expect(describeFailure('plain')).toBe('plain')
  })

  it('refuses a log-directory junction without writing outside the managed root', async () => {
    const outside = join(root, 'outside-log')
    await mkdir(outside, { recursive: true })
    const sentinel = join(outside, 'sentinel.txt')
    await writeFile(sentinel, 'preserve')
    const logDirectory = join(root, 'logs')
    await symlink(outside, logDirectory, 'junction')
    const diagnostics = createManagedHarnessDiagnostics({ file: join(logDirectory, 'managed-harness.log') })

    await expect(diagnostics.record({ operation: 'test' })).rejects.toThrow(/reparse|symbolic link/iu)

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve')
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt'])
  })

  it('refuses an existing log-file symlink without appending to its target', async () => {
    const outside = join(root, 'outside-log-file.txt')
    await writeFile(outside, 'sentinel')
    const logDirectory = join(root, 'logs')
    await mkdir(logDirectory, { recursive: true })
    await symlink(outside, join(logDirectory, 'managed-harness.log'), 'junction')
    const diagnostics = createManagedHarnessDiagnostics({ file: join(logDirectory, 'managed-harness.log') })

    await expect(diagnostics.record({ operation: 'test' })).rejects.toThrow(/reparse|symbolic link/iu)

    await expect(readFile(outside, 'utf8')).resolves.toBe('sentinel')
  })
})

describe('managed Harness transactions', () => {
  it('installs the first version and makes it launchable', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()

    expect(context.runtime.status()).toEqual({ phase: 'not-installed' })
    expect(context.runtime.availability()).toEqual({ available: false, reason: 'not-installed' })
    expect(context.runtime.launch()).toBeUndefined()

    await expect(context.runtime.install()).resolves.toEqual({ outcome: 'promoted', version: '0.1.5-rc.1' })

    expect(context.runtime.status()).toEqual({ phase: 'ready', current: '0.1.5-rc.1' })
    expect(context.runtime.availability()).toEqual({ available: true })
    expect(context.runtime.launch()).toEqual({
      cliEntry: harnessCliEntry(managedHarnessLayout(root).versionDirectory('0.1.5-rc.1')),
      version: '0.1.5-rc.1',
      suppressBrowserHandoff: true,
    })
    expect(context.installed).toEqual(['0.1.5-rc.1'])
    expect(context.healthChecked).toEqual(['0.1.5-rc.1'])
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual([])
  })

  it('never asks the registry before the user asks it to', async () => {
    const context = await fixtures(['0.1.5-rc.1'])

    await context.runtime.recover()

    // No startup check, no schedule: reading the registry is the user's action.
    expect(context.latestCalls).toEqual([])
    expect(context.installed).toEqual([])
    expect(context.runtime.status()).toEqual({ phase: 'not-installed' })
  })

  it('reports an already installed version as up to date without reinstalling', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()

    await expect(context.runtime.install()).resolves.toEqual({ outcome: 'up-to-date', version: '0.1.5-rc.1' })

    expect(context.installed).toEqual(['0.1.5-rc.1'])
  })

  it('answers an update check from the registry alone', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')

    await expect(context.runtime.checkForUpdate())
      .resolves.toEqual({ state: 'available', latest: '0.1.5-rc.2', current: '0.1.5-rc.1' })
    expect(context.installed).toEqual(['0.1.5-rc.1'])
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')

    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'promoted', version: '0.1.5-rc.2' })
    expect(context.runtime.status()).toEqual({ phase: 'ready', current: '0.1.5-rc.2', previous: '0.1.5-rc.1' })
    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.2', previous: '0.1.5-rc.1' })
    await expect(stagedVersions()).resolves.toEqual([])
  })

  it('reports up to date when the official latest is already promoted', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()

    await expect(context.runtime.checkForUpdate()).resolves.toEqual({ state: 'up-to-date', current: '0.1.5-rc.1' })
    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'up-to-date', version: '0.1.5-rc.1' })
    expect(context.installed).toEqual(['0.1.5-rc.1'])
  })

  it('reports the official latest when nothing is installed yet', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()

    await expect(context.runtime.checkForUpdate())
      .resolves.toEqual({ state: 'not-installed', latest: '0.1.5-rc.1' })
  })

  it('keeps the promoted version when the installer fails', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    context.failInstall.add('0.1.5-rc.2')

    const transaction = await context.runtime.update()

    expect(transaction.outcome).toBe('failed')
    expect(context.runtime.status()).toEqual({
      phase: 'failed',
      reason: 'Harness 0.1.5-rc.2 did not install (exit 1)',
      current: '0.1.5-rc.1',
    })
    // The outgoing version is still the one the desktop launches.
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual([])
  })

  it('keeps the promoted version when the downloaded release is not the one it asked for', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    context.wrongVersion.add('0.1.5-rc.2')

    const transaction = await context.runtime.update()

    expect(transaction.outcome).toBe('failed')
    if (transaction.outcome === 'failed') expect(transaction.reason).toMatch(/expected 0.1.5-rc.2/iu)
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    // A rejected candidate leaves nothing staged behind.
    await expect(stagedVersions()).resolves.toEqual([])
  })

  it('keeps the promoted version when the candidate fails its health check', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    context.failHealth.add('0.1.5-rc.2')

    await expect(context.runtime.update()).resolves.toEqual({
      outcome: 'failed',
      reason: 'Harness 0.1.5-rc.2 failed its health check',
    })

    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.1' })
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
  })

  it('keeps the promoted version when the registry is unreachable', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.length = 0

    const transaction = await context.runtime.update()

    expect(transaction.outcome).toBe('failed')
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
  })

  it('retains exactly the promoted version and its rollback target', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    await context.runtime.update()
    context.releases.push('0.1.5-rc.3')

    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'promoted', version: '0.1.5-rc.3' })

    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.3', previous: '0.1.5-rc.2' })
    // Keep old versions because a copied ownership marker cannot distinguish an
    // obsolete install from a user's manual backup.
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3'])
  })

  it('preserves a version directory no retained version references', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    const orphan = layout.versionDirectory('0.0.1-orphan')
    await materializeHarness(orphan, '0.0.1-orphan')
    await markDesktopManagedVersion(orphan, '0.0.1-orphan')
    await materializeHarness(layout.stagingDirectory('0.0.2-stale'), '0.0.2-stale')

    await context.runtime.recover()
    await context.runtime.install()

    await expect(retainedVersions()).resolves.toEqual(['0.0.1-orphan', '0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual(['0.0.2-stale'])
  })

  it('preserves old versions, copied markers, backups, and unknown entries', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    const orphan = layout.versionDirectory('0.0.1-orphan')
    await materializeHarness(orphan, '0.0.1-orphan')
    await markDesktopManagedVersion(orphan, '0.0.1-orphan')

    const backup = layout.versionDirectory('0.0.2-backup')
    await materializeHarness(backup, '0.0.2-backup')
    const missingTransactionId = layout.versionDirectory('0.0.7-no-transaction-id')
    await materializeHarness(missingTransactionId, '0.0.7-no-transaction-id')
    await writeFile(join(missingTransactionId, '.dsh-desktop-managed.json'), JSON.stringify({
      schemaVersion: 1, package: HARNESS_PACKAGE, version: '0.0.7-no-transaction-id',
    }))
    await mkdir(layout.versionDirectory('manual-backup'), { recursive: true })
    await writeFile(join(layout.versionDirectory('manual-backup'), 'preserve.txt'), 'manual data')
    await writeFile(join(layout.versions, 'notes.txt'), 'manual file')

    const mismatched = layout.versionDirectory('0.0.3-mismatched')
    await materializeHarness(mismatched, '0.0.3-mismatched')
    await markDesktopManagedVersion(mismatched, '0.0.9-other')

    const wrongPackage = layout.versionDirectory('0.0.5-wrong-package')
    await materializeHarness(wrongPackage, '0.0.5-wrong-package')
    await markDesktopManagedVersion(wrongPackage, '0.0.5-wrong-package')
    await writeFile(join(wrongPackage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
      name: '@unexpected/package',
      version: '0.0.5-wrong-package',
    }))

    const invalidSemver = join(layout.versions, '0.0.6-invalid.01')
    await materializeHarness(invalidSemver, '0.0.6-invalid.01')
    await markDesktopManagedVersion(invalidSemver, '0.0.6-invalid.01')

    const linkTarget = join(root, 'manual-link-target')
    await materializeHarness(linkTarget, '0.0.4-linked')
    await markDesktopManagedVersion(linkTarget, '0.0.4-linked')
    const linkPath = layout.versionDirectory('0.0.4-linked')
    await mkdir(layout.versions, { recursive: true })
    await symlink(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    const manualStage = join(layout.staging, 'manual-backup')
    await mkdir(manualStage, { recursive: true })
    await writeFile(join(manualStage, 'preserve.txt'), 'manual staging data')

    await context.runtime.recover()
    await context.runtime.install()

    await expect(readdir(layout.versions)).resolves.toEqual(expect.arrayContaining([
      '0.0.2-backup',
      '0.0.3-mismatched',
      '0.0.4-linked',
      '0.0.5-wrong-package',
      '0.0.6-invalid.01',
      '0.0.7-no-transaction-id',
      'manual-backup',
      'notes.txt',
      '0.1.5-rc.1',
    ]))
    await expect(readdir(layout.versions)).resolves.toContain('0.0.1-orphan')
    await expect(readFile(join(linkTarget, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      .resolves.toContain('0.0.4-linked')
    await expect(readFile(join(manualStage, 'preserve.txt'), 'utf8')).resolves.toBe('manual staging data')
  })

  it('rolls back to the retained version and swaps the retention', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    await context.runtime.update()

    await expect(context.runtime.rollback()).resolves.toEqual({ outcome: 'rolled-back', version: '0.1.5-rc.1' })

    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.1', previous: '0.1.5-rc.2' })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    expect(context.runtime.status()).toEqual({
      phase: 'ready',
      current: '0.1.5-rc.1',
      previous: '0.1.5-rc.2',
    })
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1', '0.1.5-rc.2'])
  })

  it('keeps the promoted version when the rollback target cannot serve its Web UI', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    await context.runtime.update()
    context.failHealth.add('0.1.5-rc.1')

    const transaction = await context.runtime.rollback()

    expect(transaction.outcome).toBe('failed')
    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.2', previous: '0.1.5-rc.1' })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.2')
  })

  it('refuses a rollback with no retained target and changes nothing', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()

    await expect(context.runtime.rollback()).resolves.toEqual({
      outcome: 'failed',
      reason: 'no previous Harness version is retained',
    })

    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
  })

  it('replaces program files on a reinstall while keeping the rollback target', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    context.releases.push('0.1.5-rc.2')
    await context.runtime.update()

    await expect(context.runtime.reinstall()).resolves.toEqual({ outcome: 'promoted', version: '0.1.5-rc.2' })

    expect(context.installed).toEqual(['0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.2'])
    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.2', previous: '0.1.5-rc.1' })
    await expect(stagedVersions()).resolves.toEqual([])
  })

  it('preserves legacy pending artifacts, allows current read-only launch, and blocks new transactions', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)
    // A crash between staging and promotion leaves this on disk and in the state.
    await writeFile(layout.stateFile, `${JSON.stringify({
      schemaVersion: 1,
      current: '0.1.5-rc.1',
      pending: { operation: 'update', version: '0.1.5-rc.2' },
    })}\n`)
    await materializeHarness(layout.stagingDirectory('0.1.5-rc.2'), '0.1.5-rc.2')

    await context.runtime.recover()

    expect(context.runtime.status()).toMatchObject({ phase: 'failed', current: '0.1.5-rc.1', reason: /legacy.*preserved/iu })
    expect(context.runtime.availability()).toEqual({ available: true })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(context.runtime.update()).resolves.toMatchObject({ outcome: 'failed' })
    expect(context.installed).toEqual(['0.1.5-rc.1'])
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8'))).toMatchObject({
      schemaVersion: 1, current: '0.1.5-rc.1', pending: { operation: 'update', version: '0.1.5-rc.2' },
    })
    await expect(stagedVersions()).resolves.toContain('0.1.5-rc.2')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
  }, 10_000)

  it('reports an unusable state file instead of guessing a version', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await mkdir(layout.root, { recursive: true })
    await writeFile(layout.stateFile, 'not json\n')

    await context.runtime.recover()

    expect(context.runtime.status()).toEqual({ phase: 'invalid' })
    expect(context.runtime.availability()).toEqual({ available: false, reason: 'invalid' })
    expect(context.runtime.launch()).toBeUndefined()
    await expect(context.runtime.install()).resolves.toEqual({
      outcome: 'failed',
      reason: 'managed Harness state is unusable',
    })
    // Nothing was installed on the strength of a state file it could not read.
    expect(context.installed).toEqual([])
  })

  it('fails closed when the managed root is replaced by an external junction', async () => {
    const parent = join(root, 'controlled-parent')
    const outside = join(tmpdir(), `managed-harness-external-${Date.now()}`)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'sentinel.txt'), 'preserve')
    await symlink(outside, parent, 'junction')
    const context = await fixtures(['0.1.5-rc.1'], undefined, join(parent, 'managed-harness'), parent, root)

    await expect(context.runtime.recover()).rejects.toThrow(/reparse point/iu)

    await expect(readFile(join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('preserve')
    await rm(parent, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('writes the version directory before the state names it', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)

    // A promoted version's directory exists and its manifest names it, so a
    // crash after the state write can never point at an absent program.
    await expect(verifyHarnessInstall(layout.versionDirectory('0.1.5-rc.1'), '0.1.5-rc.1')).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      current: '0.1.5-rc.1',
    })
  })
})

describe('managed Harness process ownership', () => {
  it('leaves a Harness the user started running, even when it holds the recorded identifier', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await mkdir(layout.root, { recursive: true })
    await writeFile(layout.stateFile, `${JSON.stringify({ schemaVersion: 1, current: '0.1.5-rc.1' })}\n`)
    await materializeHarness(layout.versionDirectory('0.1.5-rc.1'), '0.1.5-rc.1')
    await writeFile(join(layout.root, 'runtime.json'), `${JSON.stringify({
      ownerNonce: '11111111-1111-4111-8111-111111111111',
      pid: 3081,
      cliEntry: harnessCliEntry(layout.versionDirectory('0.1.5-rc.1')),
      version: '0.1.5-rc.1',
      port: 3081,
    })}\n`)

    await context.runtime.recover()

    // The probe read the process but the command line names a Harness the user
    // started from their own npx cache, so no signal was sent.
    expect(context.processes.map(process => process.command)).toEqual(['ps'])
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(readFile(join(layout.root, 'runtime.json'), 'utf8')).rejects.toThrow()
  })

  it('stops a Harness its own recorded entry identifies, and not on the identifier alone', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    const cliEntry = harnessCliEntry(layout.versionDirectory('0.1.5-rc.1'))
    await mkdir(layout.root, { recursive: true })
    await writeFile(layout.stateFile, `${JSON.stringify({ schemaVersion: 1, current: '0.1.5-rc.1' })}\n`)
    await materializeHarness(layout.versionDirectory('0.1.5-rc.1'), '0.1.5-rc.1')
    await writeFile(join(layout.root, 'runtime.json'), `${JSON.stringify({
      ownerNonce: '11111111-1111-4111-8111-111111111111',
      pid: 4242,
      cliEntry,
      version: '0.1.5-rc.1',
      port: 51234,
    })}\n`)
    const ownedCommandLine = `/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop --expose-internals ${cliEntry} web --host 127.0.0.1 --port 0 --no-open DSH_DESKTOP_OWNER_NONCE=11111111-1111-4111-8111-111111111111`
    const runtime = createManagedHarnessRuntime({
      platform: 'darwin',
      root,
      nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
      cwd: '/Users/tester',
      releaseSource: { latest: async () => ({ version: '0.1.5-rc.1' }) },
      installer: { install: async () => ({ exitCode: 0, signal: null, output: '' }) },
      healthCheck: { check: async () => ({ healthy: true }) },
      diagnostics: { record: async () => undefined },
      runProcess: async (request) => {
        context.processes.push({ command: request.command, args: request.args })
        return request.command === 'ps'
          ? { exitCode: 0, signal: null, output: `${ownedCommandLine}\n` }
          : { exitCode: 0, signal: null, output: '' }
      },
    })

    await runtime.recover()

    expect(context.processes).toEqual([
      { command: 'ps', args: ['eww', '-p', '4242', '-o', 'command='] },
      { command: 'kill', args: ['-TERM', '4242'] },
    ])
  })

  it('leaves a process alone when the recorded identifier is no longer running', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await mkdir(layout.root, { recursive: true })
    await writeFile(layout.stateFile, `${JSON.stringify({ schemaVersion: 1, current: '0.1.5-rc.1' })}\n`)
    await writeFile(join(layout.root, 'runtime.json'), `${JSON.stringify({
      ownerNonce: '11111111-1111-4111-8111-111111111111',
      pid: 9999,
      cliEntry: harnessCliEntry(layout.versionDirectory('0.1.5-rc.1')),
      version: '0.1.5-rc.1',
      port: 51234,
    })}\n`)
    const runtime = createManagedHarnessRuntime({
      platform: 'darwin',
      root,
      nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
      cwd: '/Users/tester',
      releaseSource: { latest: async () => ({ version: '0.1.5-rc.1' }) },
      installer: { install: async () => ({ exitCode: 0, signal: null, output: '' }) },
      healthCheck: { check: async () => ({ healthy: true }) },
      diagnostics: { record: async () => undefined },
      runProcess: async (request) => {
        context.processes.push({ command: request.command, args: request.args })
        return { exitCode: 1, signal: null, output: '' }
      },
    })

    await runtime.recover()

    expect(context.processes.map(process => process.command)).toEqual(['ps'])
  })
})


describe('managed runtime final safety regressions', () => {
  it('rejects installed lock integrity that differs from the resolved release', async () => {
    await materializeHarness(root, '0.1.5-rc.1')
    await expect(verifyHarnessInstall(root, '0.1.5-rc.1', 'sha512-substituted'))
      .rejects.toThrow('integrity differs')
    await expect(verifyHarnessInstall(root, '0.1.5-rc.1', 'sha512-0.1.5-rc.1'))
      .resolves.toBeUndefined()
  })

  it.each(['', '/usr/bin', '../escape'])('never signals from an untrusted record entry: %s', async (cliEntry) => {
    const context = await fixtures()
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      pid: 4242, version: '0.1.5-rc.1', port: 51234, cliEntry,
      ownerNonce: '11111111-1111-4111-8111-111111111111',
    }))
    await context.runtime.recover()
    expect(context.processes).toEqual([])
  })

  it('preserves a legacy fixed backup after a crash because ownership is unknown', async () => {
    const context = await fixtures()
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)
    const current = layout.versionDirectory('0.1.5-rc.1')
    await writeFile(join(current, 'retained-marker'), 'original')
    await rename(current, join(root, 'replacement-backup'))
    await writeFile(layout.stateFile, JSON.stringify({ schemaVersion: 1, current: '0.1.5-rc.1',
      pending: { operation: 'reinstall', version: '0.1.5-rc.1' } }))
    await context.runtime.recover()
    expect(await readFile(join(root, 'replacement-backup', 'retained-marker'), 'utf8')).toBe('original')
    expect(context.runtime.launch()).toBeUndefined()
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toEqual({ operation: 'reinstall', version: '0.1.5-rc.1' })
  }, 10_000)

  it('restores only a transaction-identified backup after a promoted-but-uncommitted crash', async () => {
    const context = await fixtures()
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)
    const version = '0.1.5-rc.1'
    const target = layout.versionDirectory(version)
    const oldMarker = JSON.parse(await readFile(join(target, '.dsh-desktop-managed.json'), 'utf8')) as { transactionId: string }
    const txId = '22222222-2222-4222-8222-222222222222'
    const backup = layout.backupDirectory(txId)
    await mkdir(layout.backups, { recursive: true })
    await writeFile(join(target, 'retained-marker'), 'original')
    await rename(target, backup)
    await materializeHarness(target, version)
    await markDesktopManagedVersion(target, version, txId)
    await writeFile(layout.stateFile, JSON.stringify({ schemaVersion: 1, current: version,
      pending: { operation: 'reinstall', version, transactionId: txId, phase: 'promoted', backupInstallId: oldMarker.transactionId } }))

    await context.runtime.recover()

    await expect(readFile(join(target, 'retained-marker'), 'utf8')).resolves.toBe('original')
    await expect(readdir(backup)).rejects.toThrow()
    expect(context.runtime.launch()?.version).toBe(version)
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toBeUndefined()
  }, 10_000)

  it.each(['staging', 'health'] as const)(
    'preserves a committed journal when %s scratch ownership does not match and retries cleanup later', async (scratch) => {
      const context = await fixtures()
      await context.runtime.recover()
      await context.runtime.install()
      const layout = managedHarnessLayout(root)
      const version = '0.1.5-rc.1'
      const target = layout.versionDirectory(version)
      const managed = JSON.parse(await readFile(join(target, '.dsh-desktop-managed.json'), 'utf8')) as { transactionId: string }
      const transactionId = managed.transactionId
      const scratchPath = scratch === 'staging' ? layout.stagingDirectory(transactionId) : layout.healthHome(transactionId)
      const marker = scratch === 'staging' ? '.dsh-desktop-transaction.json' : '.dsh-desktop-health.json'
      await mkdir(scratchPath, { recursive: true })
      await writeFile(join(scratchPath, marker), JSON.stringify({ transactionId: '99999999-9999-4999-8999-999999999999' }))
      await writeFile(layout.stateFile, JSON.stringify({ schemaVersion: 1, current: version,
        pending: { operation: 'update', version, transactionId, phase: 'committed' } }))

      await context.runtime.recover()

      expect(context.runtime.launch()?.version).toBe(version)
      expect(context.runtime.availability()).toEqual({ available: true })
      expect(context.runtime.status()).toMatchObject({ phase: 'failed', reason: /scratch data.*recovery is deferred/iu })
      expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toMatchObject({ transactionId, phase: 'committed' })
      await expect(readFile(join(scratchPath, marker), 'utf8')).resolves.toContain('99999999')

      await writeFile(join(scratchPath, marker), JSON.stringify({ transactionId }))
      await context.runtime.recover()

      expect(context.runtime.launch()?.version).toBe(version)
      expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toBeUndefined()
      await expect(readdir(scratchPath)).rejects.toThrow()
    },
  )

  it('keeps an owned current install when a reinstall crashed before backup began', async () => {
    const context = await fixtures()
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)
    const version = '0.1.5-rc.1'
    const txId = '33333333-3333-4333-8333-333333333333'
    const staging = layout.stagingDirectory(txId)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, '.dsh-desktop-transaction.json'), JSON.stringify({ transactionId: txId }))
    await writeFile(layout.stateFile, JSON.stringify({ schemaVersion: 1, current: version,
      pending: { operation: 'reinstall', version, transactionId: txId, phase: 'verified' } }))

    await context.runtime.recover()

    expect(context.runtime.status()).toEqual({ phase: 'ready', current: version })
    expect(context.runtime.launch()?.version).toBe(version)
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toBeUndefined()
    await expect(readdir(staging)).rejects.toThrow()
  }, 10_000)

  it.each(['backup-planned', 'backed-up', 'promoted'] as const)(
    'blocks recovery when the expected previous install is missing in phase %s', async (phase) => {
      const context = await fixtures()
      await context.runtime.recover()
      await context.runtime.install()
      const layout = managedHarnessLayout(root)
      const version = '0.1.5-rc.1'
      const target = layout.versionDirectory(version)
      const oldMarker = JSON.parse(await readFile(join(target, '.dsh-desktop-managed.json'), 'utf8')) as { transactionId: string }
      const txId = '44444444-4444-4444-8444-444444444444'
      if (phase === 'promoted') {
        await rm(target, { recursive: true, force: false })
        await materializeHarness(target, version)
        await markDesktopManagedVersion(target, version, txId)
      } else {
        await rm(target, { recursive: true, force: false })
      }
      await writeFile(layout.stateFile, JSON.stringify({ schemaVersion: 1, current: version,
        pending: { operation: 'reinstall', version, transactionId: txId, phase, backupInstallId: oldMarker.transactionId } }))

      await context.runtime.recover()

      expect(context.runtime.launch()).toBeUndefined()
      expect(context.runtime.availability()).toEqual({ available: false, reason: 'not-installed' })
      expect(context.runtime.status()).toMatchObject({ phase: 'failed', reason: /previous install/iu })
      expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toMatchObject({ transactionId: txId, phase })
      if (phase === 'promoted') await expect(readFile(join(target, '.dsh-desktop-managed.json'), 'utf8')).resolves.toContain(txId)
    },
  )

  it('blocks launch if a reinstall loses its identified backup during cleanup', async () => {
    const context = await fixtures()
    await context.runtime.recover()
    await context.runtime.install()
    context.failAfterBackup = true

    await expect(context.runtime.reinstall()).resolves.toMatchObject({ outcome: 'failed' })

    const layout = managedHarnessLayout(root)
    expect(context.runtime.launch()).toBeUndefined()
    expect(context.runtime.availability()).toEqual({ available: false, reason: 'not-installed' })
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toMatchObject({ phase: 'backed-up' })
    await expect(readdir(layout.backups).then(entries => entries.length)).resolves.toBe(0)
  })

  it('preserves an unowned exact-version target collision during install', async () => {
    const context = await fixtures()
    const layout = managedHarnessLayout(root)
    const target = layout.versionDirectory('0.1.5-rc.1')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'human-backup.txt'), 'keep')

    await expect(context.runtime.install()).resolves.toMatchObject({ outcome: 'failed' })

    await expect(readFile(join(target, 'human-backup.txt'), 'utf8')).resolves.toBe('keep')
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8')).pending).toBeUndefined()
  })

  it('keeps a legacy current install launchable when same-version reinstall lacks ownership proof', async () => {
    const context = await fixtures()
    await context.runtime.recover()
    await context.runtime.install()
    const layout = managedHarnessLayout(root)
    await rm(join(layout.versionDirectory('0.1.5-rc.1'), '.dsh-desktop-managed.json'))

    await expect(context.runtime.reinstall()).resolves.toMatchObject({
      outcome: 'failed', reason: expect.stringMatching(/no trusted ownership marker/iu),
    })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')

    context.releases.push('0.1.5-rc.2')
    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'promoted', version: '0.1.5-rc.2' })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.2')
    expect(context.runtime.retained()).toEqual({ current: '0.1.5-rc.2', previous: '0.1.5-rc.1' })
  })
})


describe('managed Harness transaction stages and cancellation', () => {
  /** Install one release, then point the registry at a newer one. */
  async function installedThenNewer(context: HarnessFixtures, newer: string): Promise<void> {
    await context.runtime.recover()
    await context.runtime.install()
    context.stages.length = 0
    context.installSignals.length = 0
    context.releaseSignals.length = 0
    context.releases.push(newer)
  }

  it('reports each step a staging transaction really takes, with its own safety', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await installedThenNewer(context, '0.1.6')

    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'promoted', version: '0.1.6' })

    expect(context.stages).toEqual([
      { stage: 'preparing', cancellable: true },
      { stage: 'installing', cancellable: true },
      { stage: 'verifying', cancellable: false },
      { stage: 'health', cancellable: false },
    ])
  })

  it('reports no stage for an update check, which installs nothing', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()

    await context.runtime.checkForUpdate()

    expect(context.stages).toEqual([])
  })

  it('answers idle when no staging transaction is running', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await context.runtime.recover()

    expect(context.runtime.cancelTransaction()).toBe('idle')
  })

  it('holds a transaction busy across the registry round trip, so it cannot start twice', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await installedThenNewer(context, '0.1.6')
    context.holdsRelease = true

    const update = context.runtime.update()
    await vi.waitFor(() => {
      expect(context.releaseSignals).toHaveLength(1)
    })

    expect(context.runtime.status()).toMatchObject({ phase: 'busy', operation: 'update', current: '0.1.5-rc.1' })
    context.releaseLookup()
    await expect(update).resolves.toEqual({ outcome: 'promoted', version: '0.1.6' })
  })

  it('cancels while preparing, before any package manager starts', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await installedThenNewer(context, '0.1.6')
    context.holdsRelease = true

    const update = context.runtime.update()
    await vi.waitFor(() => {
      expect(context.releaseSignals).toHaveLength(1)
    })
    expect(context.runtime.cancelTransaction()).toBe('accepted')
    expect(context.releaseSignals[0]?.aborted).toBe(true)

    await expect(update).resolves.toEqual({ outcome: 'cancelled' })
    expect(context.installed).toEqual(['0.1.5-rc.1'])
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    expect(context.runtime.status()).toMatchObject({ phase: 'ready', current: '0.1.5-rc.1' })
  })

  it('stops before the package manager when a cancel lands during staging prep', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await installedThenNewer(context, '0.1.6')
    context.cancelOnStagingRecord = true

    await expect(context.runtime.update()).resolves.toEqual({ outcome: 'cancelled' })

    // The checkpoint is the point: no child was started in order to be killed.
    expect(context.installed).toEqual(['0.1.5-rc.1'])
    expect(context.stages.map(progress => progress.stage)).toEqual(['preparing'])
    expect(context.healthChecked).toEqual(['0.1.5-rc.1'])
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual([])
    expect(parseManagedHarnessState(await readFile(layout.stateFile, 'utf8')))
      .toEqual({ current: '0.1.5-rc.1' })
  })

  it('abandons a running package manager on cancel and discards only its staging', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await installedThenNewer(context, '0.1.6')
    context.holdsInstall = true

    const update = context.runtime.update()
    await vi.waitFor(() => {
      expect(context.installed).toHaveLength(2)
    })
    expect(context.runtime.cancelTransaction()).toBe('accepted')
    expect(context.installSignals[0]?.aborted).toBe(true)

    await expect(update).resolves.toEqual({ outcome: 'cancelled' })
    // The candidate never reached the promotion gate, so it was never launched.
    expect(context.healthChecked).toEqual(['0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual([])
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    await expect(readFile(layout.stateFile, 'utf8')).resolves.toContain('"current":"0.1.5-rc.1"')
    expect(parseManagedHarnessState(await readFile(layout.stateFile, 'utf8'))).not.toHaveProperty('pending')
  })

  it('refuses to stop once the candidate is being verified or health-checked', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await installedThenNewer(context, '0.1.6')
    context.holdsHealth = true

    const update = context.runtime.update()
    await vi.waitFor(() => {
      expect(context.healthChecked).toHaveLength(2)
    })

    expect(context.runtime.cancelTransaction()).toBe('refused')
    expect(context.stages.at(-1)).toEqual({ stage: 'health', cancellable: false })
    context.releaseHealth()
    await expect(update).resolves.toEqual({ outcome: 'promoted', version: '0.1.6' })
  })

  it('settles a cancelled transaction without recording a failure', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    await installedThenNewer(context, '0.1.6')
    context.holdsInstall = true

    const update = context.runtime.update()
    await vi.waitFor(() => {
      expect(context.installed).toHaveLength(2)
    })
    context.runtime.cancelTransaction()
    await update

    expect(context.runtime.status().phase).toBe('ready')
    expect(context.runtime.availability()).toEqual({ available: true })
  })
})

describe('managed process nonce validation', () => {
  it.each(['', '22222222-2222-4222-8222-222222222222'])('leaves an identical CLI with another launch identity alone: %s', async (nonce) => {
    const layout = managedHarnessLayout(root)
    const cliEntry = harnessCliEntry(layout.versionDirectory('0.1.5-rc.1'))
    const context = await fixtures(['0.1.5-rc.1'], `/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop --expose-internals ${cliEntry} web --host 127.0.0.1 --port 0 --no-open DSH_DESKTOP_OWNER_NONCE=${nonce}`)
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ pid: 4242, cliEntry, version: '0.1.5-rc.1', port: 51234,
      ownerNonce: '11111111-1111-4111-8111-111111111111' }))
    await context.runtime.recover()
    expect(context.processes.map(request => request.command)).toEqual(['ps'])
  })
})
