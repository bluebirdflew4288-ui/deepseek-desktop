import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

interface HarnessFixtures {
  runtime: ManagedHarnessRuntime
  readonly releases: string[]
  readonly latestCalls: number[]
  readonly installed: string[]
  readonly healthChecked: string[]
  /** Versions whose install the installer fails. */
  readonly failInstall: Set<string>
  /** Versions whose health check fails. */
  readonly failHealth: Set<string>
  /** Versions the installer materializes with a mismatched manifest. */
  readonly wrongVersion: Set<string>
  readonly processes: Array<{ command: string; args: readonly string[] }>
}

/**
 * Build a runtime whose registry, installer, health check, and ownership probe
 * are all fakes, so a transaction is exercised against a real filesystem without
 * a network or a spawned Harness.
 * @param releases - Official versions the registry reports, newest last.
 * @returns The runtime and the record of every call its dependencies received.
 */
async function fixtures(releases: string[] = ['0.1.5-rc.1'], commandOutput?: string): Promise<HarnessFixtures> {
  const state: HarnessFixtures = {
    runtime: undefined as unknown as ManagedHarnessRuntime,
    releases: [...releases],
    latestCalls: [],
    installed: [],
    healthChecked: [],
    failInstall: new Set<string>(),
    failHealth: new Set<string>(),
    wrongVersion: new Set<string>(),
    processes: [],
  }
  state.runtime = createManagedHarnessRuntime({
    root,
    nodeExecutable: '/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop',
    cwd: '/Users/tester',
    electronRunAsNode: true,
    releaseSource: {
      async latest() {
        state.latestCalls.push(1)
        const version = state.releases[state.releases.length - 1]
        if (version === undefined) throw new Error('registry publishes no latest release tag')
        return { version, integrity: `sha512-${version}` }
      },
    },
    installer: {
      async install(request) {
        state.installed.push(request.version)
        if (state.failInstall.has(request.version)) return { exitCode: 1, signal: null, output: 'EBADENGINE' }
        await materializeHarness(request.directory, state.wrongVersion.has(request.version) ? '9.9.9' : request.version)
        return { exitCode: 0, signal: null, output: '' }
      },
    },
    healthCheck: {
      async check(request) {
        state.healthChecked.push(request.version)
        return state.failHealth.has(request.version)
          ? { healthy: false, failure: 'readiness timed out' }
          : { healthy: true }
      },
    },
    diagnostics: { record: async () => undefined },
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

    expect(layout.healthHome('0.1.5-rc.1')).toBe(join(root, 'staging', '0.1.5-rc.1.health-home'))
    expect(layout.healthHome('0.1.5-rc.1').startsWith(root)).toBe(true)
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

  it('replaces the target wholesale and hands the package manager an empty root project', async () => {
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

    await installer.install({ directory: target, version: '0.1.5-rc.1' })

    expect(seen[0]?.command).toBe('/Applications/DeepSeek Desktop.app/Contents/MacOS/DeepSeek Desktop')
    expect(seen[0]?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(seen[0]?.env.PATH).toBe(managedSearchPath())
    await expect(readdir(target).then(entries => entries.sort())).resolves.toEqual(['package.json'])
    expect(await readFile(layout.npmUserConfig, 'utf8')).toBe('')
    expect(await readFile(layout.npmGlobalConfig, 'utf8')).toBe('')
  })

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
    const healthHome = layout.healthHome('0.1.5-rc.1')
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

    await expect(check.check({ versionDirectory: layout.versionDirectory('0.1.5-rc.1'), version: '0.1.5-rc.1' }))
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

    await expect(check.check({ versionDirectory: layout.versionDirectory('0.1.5-rc.1'), version: '0.1.5-rc.1' }))
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
    // The version two updates back is program files only, so it is collected.
    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.2', '0.1.5-rc.3'])
  })

  it('collects a version directory no retained version references', async () => {
    const context = await fixtures(['0.1.5-rc.1'])
    const layout = managedHarnessLayout(root)
    await materializeHarness(layout.versionDirectory('0.0.1-orphan'), '0.0.1-orphan')
    await materializeHarness(layout.stagingDirectory('0.0.2-stale'), '0.0.2-stale')

    await context.runtime.recover()
    await context.runtime.install()

    await expect(retainedVersions()).resolves.toEqual(['0.1.5-rc.1'])
    await expect(stagedVersions()).resolves.toEqual([])
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
  })

  it('recovers an interrupted update, keeping the last verified version launchable', async () => {
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

    expect(context.runtime.status()).toEqual({ phase: 'ready', current: '0.1.5-rc.1' })
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
    expect(JSON.parse(await readFile(layout.stateFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      current: '0.1.5-rc.1',
    })
    await expect(stagedVersions()).resolves.toEqual([])
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

  it('restores the retained directory after a crash between replacement renames', async () => {
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
    expect(await readFile(join(current, 'retained-marker'), 'utf8')).toBe('original')
    expect(context.runtime.launch()?.version).toBe('0.1.5-rc.1')
  }, 10_000)
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
