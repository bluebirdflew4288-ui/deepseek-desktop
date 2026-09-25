/**
 * The desktop-managed Harness program directory.
 *
 * One module owns every transaction that changes which Harness program version
 * the desktop launches: first install, manual update, rollback, retention, and
 * recovery after a crash. Each transaction stages into a directory the desktop
 * owns, proves the candidate can serve its Web UI, and only then repoints the
 * version state — so an interrupted or failed transaction always leaves the last
 * verified version launchable.
 *
 * Harness user data is not this module's business. It stays in the Harness home
 * the CLI resolves, which no transaction here reads, moves, or deletes.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { assertWindowsRuntimeIdle } from './windows-runtime-recovery.ts'
import {
  createHostSupervisor,
  spawnDshWeb,
  type HostReadiness,
  type HostSupervisor,
} from './host-supervisor.ts'
import { type HarnessHealthCheck } from './managed-harness-health.ts'
import {
  verifyHarnessInstall,
  type HarnessPackageInstaller,
} from './managed-harness-installer.ts'
import {
  createManagedHarnessDiagnostics,
  describeFailure,
  type ManagedHarnessDiagnostics,
} from './managed-harness-log.ts'
import {
  harnessCliEntry,
  managedHarnessLayout,
  isManagedHarnessVersionName,
  type ManagedHarnessLayout,
} from './managed-harness-paths.ts'
import {
  managedProcessEnvironment,
  parentBoundEnvironment,
  runManagedProcess,
  type ManagedProcessRunner,
} from './managed-harness-process.ts'
import { HARNESS_PACKAGE, type HarnessRelease, type HarnessReleaseSource } from './managed-harness-registry.ts'
import {
  loadManagedHarnessState,
  promoteManagedHarnessVersion,
  saveManagedHarnessState,
  type ManagedHarnessOperation,
  type ManagedHarnessState,
} from './managed-harness-state.ts'

/** File recording the Harness process this desktop launch owns. */
const RUNTIME_RECORD_NAME = 'runtime.json'

/** Version-local ownership record required before garbage collection. */
const MANAGED_VERSION_MANIFEST_NAME = '.dsh-desktop-managed.json'

/** Strict Semantic Versioning names accepted as direct managed-version children. */
const SEMVER_VERSION_PATTERN = new RegExp([
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`,
  String.raw`(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?`,
  String.raw`(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`,
].join(''), 'u')

/** Bound on the ownership probe that reads one process's command line. */
const OWNERSHIP_PROBE_TIMEOUT_MS = 10_000

/** What the shell needs to launch the managed Harness. */
export interface ManagedHarnessLaunch {
  /** Built CLI entry inside the promoted program directory. */
  readonly cliEntry: string
  /** Exact version the entry belongs to. */
  readonly version: string
  /**
   * Whether the launched Harness registers `--no-open`. Every managed version is
   * health-checked with the arguments it is launched with, so a promoted version
   * always accepts this one.
   */
  readonly suppressBrowserHandoff: true
}

/** Whether the Harness surface can start, and why not when it cannot. */
export type ManagedHarnessAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'not-installed' | 'invalid' | 'busy' }

/** What the shell and menus render about the managed Harness. */
export type ManagedHarnessStatus =
  | { readonly phase: 'not-installed' }
  | { readonly phase: 'ready'; readonly current: string; readonly previous?: string }
  | {
    readonly phase: 'busy'
    readonly operation: ManagedHarnessOperation
    readonly current?: string
    readonly previous?: string
  }
  | {
    readonly phase: 'failed'
    readonly reason: string
    readonly current?: string
    readonly previous?: string
  }
  | { readonly phase: 'invalid' }

/** What one manual update check found. */
export type ManagedHarnessUpdateCheck =
  | { readonly state: 'up-to-date'; readonly current: string }
  | { readonly state: 'available'; readonly latest: string; readonly current?: string }
  | { readonly state: 'not-installed'; readonly latest: string }
  | { readonly state: 'failed'; readonly reason: string }

/**
 * Observable stage of a transaction that stages a candidate. Each value names
 * one real step: `preparing` reads the registry and marks the transaction
 * durable, `installing` runs the package manager, `verifying` proves the staged
 * tree is the release it asked for, and `health` launches it. The package
 * manager resolves, downloads, and writes in one child process that reports
 * nothing structured, so downloading is not a stage of its own.
 */
export type ManagedHarnessTransactionStage = 'preparing' | 'installing' | 'verifying' | 'health'

/**
 * One stage a staging transaction reached, as the shell reports it.
 *
 * `cancellable` is the runtime's own verdict at that stage rather than something
 * a view infers, so the control that would cancel never claims a safety the
 * transaction does not provide.
 */
export interface ManagedHarnessTransactionProgress {
  /** Stage the transaction entered. */
  readonly stage: ManagedHarnessTransactionStage
  /** Whether stopping now leaves no work half-done. */
  readonly cancellable: boolean
}

/** What a cancel request against the running staging transaction did. */
export type ManagedHarnessCancellation = 'accepted' | 'refused' | 'idle'

/** Live progress of the staging transaction, shared with cancel requests. */
interface StagingTransaction {
  /** Whether stopping at the stage reached leaves no work half-done. */
  cancellable: boolean
  /** Whether the shell has asked this transaction to stop. */
  cancelRequested: boolean
  /** Controller abandoning the registry round trip and the package manager. */
  readonly abort: AbortController
}

/** What one transaction produced. */
export type ManagedHarnessTransaction =
  | { readonly outcome: 'promoted'; readonly version: string }
  | { readonly outcome: 'up-to-date'; readonly version: string }
  | { readonly outcome: 'rolled-back'; readonly version: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'failed'; readonly reason: string }

/** Process ownership the desktop records for one launch it owns. */
export interface ManagedHarnessRuntimeRecord {
  /** Process identifier of the Harness this launch started. */
  readonly pid: number
  /** Exact managed CLI entry that process was spawned with. */
  readonly cliEntry: string
  /** Version that entry belongs to. */
  readonly version: string
  /** Loopback port the Harness reported at readiness. */
  readonly port: number
  /** Random identity inherited by this child only. Legacy records cannot authorize termination. */
  readonly ownerNonce: string
}

/** The managed Harness runtime the desktop composition root drives. */
export interface ManagedHarnessRuntime {
  /**
   * Recover from an interrupted transaction, drop unreferenced program
   * directories, stop any Harness a previous crashed launch still owns, and
   * cache the launch descriptor.
   *
   * Runs once at startup before the Harness surface is created.
   */
  recover(): Promise<void>
  /** Launch descriptor for the promoted version, when one is promoted. */
  launch(): ManagedHarnessLaunch | undefined
  /** Whether the Harness surface can start now. */
  availability(): ManagedHarnessAvailability
  /** Status the shell and menus render. */
  status(): ManagedHarnessStatus
  /**
   * The two program versions currently retained.
   * @returns the promoted version and the rollback target, either absent when
   * that many installs have not completed.
   */
  retained(): { readonly current?: string; readonly previous?: string }
  /**
   * Install the official release the registry's `latest` tag names.
   * @returns What the transaction produced. Already having a promoted version is
   * reported as up to date rather than reinstalling it.
   */
  install(): Promise<ManagedHarnessTransaction>
  /**
   * Read the official `latest` tag and compare it with the promoted version.
   * @returns Whether an update is available. This only reads the registry; it
   * installs nothing and starts no background schedule.
   */
  checkForUpdate(): Promise<ManagedHarnessUpdateCheck>
  /**
   * Install and promote the official `latest` release, keeping the outgoing
   * version as the rollback target.
   * @returns What the transaction produced.
   */
  update(): Promise<ManagedHarnessTransaction>
  /**
   * Ask the staging transaction that is running to stop.
   *
   * The request takes effect before the package manager starts, and while it
   * runs, because both write only inside the transaction's staging directory and
   * that directory is discarded on the way out. The promoted program directory
   * is never open for writing at those stages, so stopping cannot damage the
   * Harness in use. Once verification begins the request is refused: the
   * candidate is already being judged against promotion, and the remaining
   * stages are short and bounded on their own.
   * @returns Whether the request will take effect. `idle` means no staging
   * transaction is running.
   */
  cancelTransaction(): ManagedHarnessCancellation
  /**
   * Download and promote the official `latest` release again, replacing the
   * program files even when the promoted version already matches. The retained
   * rollback target survives, and Harness user data is untouched.
   * @returns What the transaction produced.
   */
  reinstall(): Promise<ManagedHarnessTransaction>
  /**
   * Promote the retained previous version, keeping the outgoing current as the
   * new rollback target. Harness user data is never rolled back.
   * @returns What the transaction produced.
   */
  rollback(): Promise<ManagedHarnessTransaction>
  /**
   * Create a supervisor launching the promoted version, recording ownership
   * while it runs and clearing that record when it stops.
   *
   * The launched Harness inherits the desktop's environment so its own shell and
   * file tools see the user's machine, unlike the installer and the health check,
   * which run hermetically.
   * @param hostApiToken - Per-launch bearer for a Harness that authenticates by
   * spawn environment rather than by a readiness-URL token.
   * @returns A supervisor the Harness surface owns.
   * @throws When no version is promoted.
   */
  createHostSupervisorForLaunch(hostApiToken: string): HostSupervisor
  /**
   * Drop the ownership record for the Harness this launch owns.
   *
   * A transaction still running is left to its own timeout rather than joined, so
   * quitting is never held open by an install; its pending marker is what lets the
   * next launch recover it.
   */
  dispose(): Promise<void>
}

/** Dependencies the managed runtime needs. */
export interface ManagedHarnessRuntimeOptions {
  /** Host platform; tests may exercise another platform protocol. */
  readonly platform?: NodeJS.Platform
  /** Directory the desktop owns for managed Harness artifacts. */
  readonly root: string
  /** Electron-resolved profile/program root; ancestors above it are OS-selected paths. */
  readonly rootBoundary?: string
  /** Trusted OS-selected base; controlled ancestors between it and root are checked. */
  readonly rootAnchor?: string
  /** Executable that runs both the package manager and the Harness. */
  readonly nodeExecutable: string
  /** Working directory the Harness inherits. */
  readonly cwd: string
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode?: boolean
  /** Official release metadata source. */
  readonly releaseSource: HarnessReleaseSource
  /** Installer producing staged program directories. */
  readonly installer: HarnessPackageInstaller
  /** Health check gating promotion. */
  readonly healthCheck: HarnessHealthCheck
  /**
   * Observe the stage each staging transaction reaches, so the shell can show
   * what the transaction is doing while it is doing it. Called once per stage,
   * and never after the transaction settles.
   */
  readonly onTransactionStage?: (progress: ManagedHarnessTransactionProgress) => void
  /** Diagnostics sink, defaulting to the managed rotating log. */
  readonly diagnostics?: ManagedHarnessDiagnostics
  /** Process runner used by the ownership probe, injectable for tests. */
  readonly runProcess?: ManagedProcessRunner
  /** Supervisor factory, injectable for tests. */
  readonly createSupervisor?: (options: Parameters<typeof createHostSupervisor>[0]) => HostSupervisor
}

/**
 * Create the managed Harness runtime.
 * @param options - Layout root, runtime executable, and transaction dependencies.
 * @returns The runtime the desktop composition root drives.
 */
export function createManagedHarnessRuntime(options: ManagedHarnessRuntimeOptions): ManagedHarnessRuntime {
  const layout: ManagedHarnessLayout = managedHarnessLayout(options.root, {
    ...(options.rootBoundary === undefined ? {} : { rootBoundary: options.rootBoundary }),
    ...(options.rootAnchor === undefined ? {} : { rootAnchor: options.rootAnchor }),
  })
  const diagnostics = options.diagnostics ?? createManagedHarnessDiagnostics({
    file: layout.logFile,
    trustedAnchor: layout.rootAnchor ?? layout.rootBoundary ?? layout.root,
  })
  const createSupervisor = options.createSupervisor ?? createHostSupervisor
  const runProcess = options.runProcess ?? runManagedProcess
  const recordFile = join(layout.root, RUNTIME_RECORD_NAME)

  let tail: Promise<void> = Promise.resolve()
  let busy: ManagedHarnessOperation | undefined
  let cachedLaunch: ManagedHarnessLaunch | undefined
  let cachedState: ManagedHarnessState = {}
  let invalid = false
  let failure: string | undefined
  let recoveryBlocked = (options.platform ?? process.platform) === 'win32'

  /**
   * The staging transaction currently running, absent when none is. Its stage is
   * what a cancel request is judged against, and its controller is what stops the
   * registry round trip and the package manager.
   */
  let transaction: StagingTransaction | undefined

  /**
   * Report the stage a staging transaction reached.
   * @param stage - Stage the transaction is entering.
   * @param cancellable - Whether stopping at this stage leaves no work half-done.
   */
  function publishStage(stage: ManagedHarnessTransactionStage, cancellable: boolean): void {
    const running = transaction
    if (running === undefined) return
    running.cancellable = cancellable
    try {
      options.onTransactionStage?.({ stage, cancellable })
    } catch {
      // A listener cannot present a stage the transaction never reached, so a
      // failing listener costs the shell its view and nothing else.
    }
  }

  /**
   * Open the observable window of a staging transaction, which starts with the
   * registry read and ends when the transaction settles.
   * @param operation - Transaction the shell started.
   */
  function beginStaging(operation: ManagedHarnessOperation): void {
    transaction = { cancellable: true, cancelRequested: false, abort: new AbortController() }
    busy = operation
    publishStage('preparing', true)
  }

  /** Close the observable window a staging transaction opened. */
  function endStaging(): void {
    transaction = undefined
    busy = undefined
  }

  /** Whether the running staging transaction was asked to stop. */
  function cancelRequested(): boolean {
    return transaction?.cancelRequested === true
  }

  /** Run one transaction after every previously queued one, keeping its result. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  async function readState(): Promise<ManagedHarnessState> {
    const state = await loadManagedHarnessState(layout.stateFile)
    cachedState = state
    invalid = false
    return state
  }

  async function writeState(state: ManagedHarnessState): Promise<void> {
    await saveManagedHarnessState(layout.stateFile, state)
    cachedState = state
  }

  /** Prove a direct version child is a complete program directory created here. */
  async function isDesktopManagedVersionDirectory(directory: string, version: string): Promise<boolean> {
    if (!SEMVER_VERSION_PATTERN.test(version)) return false
    try {
      const directoryMetadata = await lstat(directory)
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) return false

      const ownershipPath = join(directory, MANAGED_VERSION_MANIFEST_NAME)
      const ownershipMetadata = await lstat(ownershipPath)
      if (!ownershipMetadata.isFile() || ownershipMetadata.isSymbolicLink()) return false
      const ownership = JSON.parse(await readFile(ownershipPath, 'utf8')) as {
        schemaVersion?: unknown
        package?: unknown
        version?: unknown
        transactionId?: unknown
      }
      if (ownership.schemaVersion !== 1 || ownership.package !== HARNESS_PACKAGE || ownership.version !== version
        || typeof ownership.transactionId !== 'string' || !/^[0-9a-f-]{36}$/u.test(ownership.transactionId)) {
        return false
      }

      const harnessDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
      for (const path of [
        join(directory, 'node_modules'),
        join(directory, 'node_modules', '@deepseek-ai'),
        harnessDirectory,
      ]) {
        const metadata = await lstat(path)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false
      }
      const packagePath = join(harnessDirectory, 'package.json')
      const packageMetadata = await lstat(packagePath)
      if (!packageMetadata.isFile() || packageMetadata.isSymbolicLink()) return false
      const installed = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown }
      return installed.name === HARNESS_PACKAGE && installed.version === version
    } catch {
      return false
    }
  }

  /** Write ownership only after the candidate has passed verification and health. */
  async function markDesktopManagedVersion(directory: string, version: string): Promise<void> {
    await writeFile(join(directory, MANAGED_VERSION_MANIFEST_NAME), JSON.stringify({
      schemaVersion: 1,
      package: HARNESS_PACKAGE,
      version,
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  }

  async function ownedInstallId(directory: string, expectedVersion: string): Promise<string | undefined> {
    try {
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined
      const path = join(directory, MANAGED_VERSION_MANIFEST_NAME)
      const markerMetadata = await lstat(path)
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) return undefined
      const marker = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: unknown; package?: unknown; version?: unknown; transactionId?: unknown }
      const manifest = JSON.parse(await readFile(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (marker.schemaVersion !== 1 || marker.package !== HARNESS_PACKAGE || marker.version !== expectedVersion
        || manifest.version !== expectedVersion
        || manifest.name !== HARNESS_PACKAGE || typeof marker.transactionId !== 'string'
        || !/^[0-9a-f-]{36}$/u.test(marker.transactionId)) return undefined
      return marker.transactionId
    } catch { return undefined }
  }

  async function removeOwnedPath(path: string, markerName: string, txId: string): Promise<boolean> {
    try {
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false
      const markerPath = join(path, markerName)
      const markerMetadata = await lstat(markerPath)
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) return false
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { transactionId?: unknown }
      if (marker.transactionId !== txId) return false
      await rm(path, { recursive: true, force: false })
      return true
    } catch { return false }
  }

  async function ensureManagedDirectory(path: string): Promise<void> {
    try {
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`managed Harness directory is not a real directory: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(path, { recursive: false, mode: 0o700 })
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`managed Harness directory is not a real directory: ${path}`)
    }
  }

  async function assertManagedPathHasNoReparseAncestors(path: string): Promise<void> {
    const absolute = resolve(path)
    const rootPath = parse(absolute).root
    const boundary = resolve(options.rootBoundary ?? rootPath)
    const anchor = resolve(options.rootAnchor ?? rootPath)
    const isDescendant = (parent: string, child: string): boolean => {
      const fromParent = relative(parent, child)
      return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
    }
    if (!isDescendant(boundary, absolute) || !isDescendant(anchor, boundary)) {
      throw new Error('managed Harness root is outside its trusted program directory')
    }
    const chain: string[] = []
    let current = absolute
    while (true) {
      chain.push(current)
      if (relative(anchor, current) === '') break
      if (current === rootPath) throw new Error('managed Harness trust anchor is not an ancestor')
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const entry of chain.reverse()) {
      try {
        const metadata = await lstat(entry)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error(`managed Harness path contains a reparse point or non-directory: ${entry}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    if (rootPath === '') throw new Error('managed Harness root is not absolute')
  }

  /** Launch descriptor for one promoted version, or undefined when none is. */
  function describeLaunch(state: ManagedHarnessState): ManagedHarnessLaunch | undefined {
    if (state.current === undefined) return undefined
    return {
      cliEntry: harnessCliEntry(layout.versionDirectory(state.current)),
      version: state.current,
      suppressBrowserHandoff: true,
    }
  }

  function retain(state: ManagedHarnessState): void {
    cachedLaunch = describeLaunch(state)
  }

  /**
   * Diagnose program directories no retained version references without deleting them.
   *
   * Only the program tree is swept. The Harness home holding settings,
   * credentials, and sessions is never enumerated here, so retention can never
   * cost the user data.
   * @param state - State naming the two retained versions.
   */
  async function collectGarbage(state: ManagedHarnessState): Promise<void> {
    const retained = new Set([state.current, state.previous].filter((v): v is string => v !== undefined))
    const versionsRoot = await lstat(layout.versions).catch(() => undefined)
    if (versionsRoot === undefined || !versionsRoot.isDirectory() || versionsRoot.isSymbolicLink()) return
    const versions = await readdir(layout.versions)
    for (const entry of versions) {
      if (retained.has(entry)) continue
      const directory = join(layout.versions, entry)
      if (!await isDesktopManagedVersionDirectory(directory, entry)) {
        await diagnostics.record({ operation: 'gc', version: entry, phase: 'preserved-unmanaged' })
        continue
      }
      await diagnostics.record({ operation: 'gc', version: entry, phase: 'preserved-managed-orphan' })
    }
    // A copied ownership marker cannot prove a version directory is disposable.
    // Keep all version paths; journaled transaction artifacts have separate IDs.
  }

  /** Discard one staged version that never earned promotion. */
  async function discardStaging(transactionId: string): Promise<boolean> {
    const safelyAbsentOrRemoved = async (path: string, marker: string): Promise<boolean> => {
      try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; return false }
      return removeOwnedPath(path, marker, transactionId)
    }
    return await safelyAbsentOrRemoved(layout.stagingDirectory(transactionId), '.dsh-desktop-transaction.json')
      && await safelyAbsentOrRemoved(layout.healthHome(transactionId), '.dsh-desktop-health.json')
  }

  /**
   * Read the ownership record a previous launch wrote.
   * @returns The record, or undefined when it is absent or malformed.
   */
  async function readRuntimeRecord(): Promise<ManagedHarnessRuntimeRecord | undefined> {
    const content = await readFile(recordFile, 'utf8').catch(() => undefined)
    if (content === undefined) return undefined
    try {
      const parsed = JSON.parse(content) as Partial<ManagedHarnessRuntimeRecord>
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 1
        || typeof parsed.pid !== 'number'
        || typeof parsed.cliEntry !== 'string'
        || typeof parsed.version !== 'string'
        || typeof parsed.port !== 'number'
        || typeof parsed.ownerNonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(parsed.ownerNonce)
        || !isManagedHarnessVersionName(parsed.version)
        || parsed.cliEntry !== harnessCliEntry(layout.versionDirectory(parsed.version))) return undefined
      return { pid: parsed.pid, cliEntry: parsed.cliEntry, version: parsed.version, port: parsed.port, ownerNonce: parsed.ownerNonce }
    } catch {
      return undefined
    }
  }

  /**
   * Read one process's command line.
   * @param pid - Process to describe.
   * @returns Its command line, or undefined when it cannot be read.
   */
  async function commandLineOf(pid: number): Promise<string | undefined> {
    const outcome = await runProcess({
      command: 'ps',
      args: ['eww', '-p', String(pid), '-o', 'command='],
      env: managedProcessEnvironment(),
      timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
    }).catch(() => undefined)
    if (outcome === undefined || outcome.outputTruncated || outcome.exitCode !== 0) return undefined
    const line = outcome.output.trim()
    return line === '' ? undefined : line
  }

  /**
   * Stop a Harness a previous crashed launch still owns.
   *
   * Ownership needs more than the recorded process identifier: the live process's
   * command line must still name the exact managed CLI entry that was spawned. A
   * Harness the user started, one belonging to another desktop instance, and any
   * unrelated process reusing the identifier all fail that check and are left
   * running.
   */
  async function reclaimOwnedOrphan(): Promise<void> {
    const record = await readRuntimeRecord()
    await rm(recordFile, { force: true })
    if (record === undefined) return
    const command = await commandLineOf(record.pid)
    if (command === undefined) {
      await diagnostics.record({ operation: 'reclaim', version: record.version, phase: 'not-running' })
      return
    }
    const expected = `${options.nodeExecutable} --expose-internals ${record.cliEntry} web --host 127.0.0.1 --port 0 --no-open`
    if (!command.startsWith(`${expected} `)
      || !command.split(' ').includes(`DSH_DESKTOP_OWNER_NONCE=${record.ownerNonce}`)) {
      await diagnostics.record({ operation: 'reclaim', version: record.version, phase: 'not-owned' })
      return
    }
    const outcome = await runProcess({
      command: 'kill',
      args: ['-TERM', String(record.pid)],
      env: managedProcessEnvironment(),
      timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
    }).catch(() => undefined)
    await diagnostics.record({
      operation: 'reclaim',
      version: record.version,
      phase: 'stopped',
      ...(typeof outcome?.exitCode === 'number' ? { exitCode: outcome.exitCode } : {}),
    })
  }

  /**
   * Stage, verify, health-check, and promote one version.
   *
   * The program directory is renamed into place before the state names it, so a
   * crash between those two steps leaves the previous version promoted and the
   * new one unreferenced, where collection removes it.
   * @param operation - Transaction kind recorded in diagnostics and in the
   * pending marker a crash would recover from.
   * @param version - Exact version to promote.
   * @param state - State before the transaction.
   * @param integrity - Registry integrity value the version was resolved with.
   * @returns What the transaction produced. A cancellation requested before the
   * package manager is reached, or one that ends its run, discards the candidate
   * and leaves the promoted version untouched.
   */
  async function stageAndPromote(
    operation: ManagedHarnessOperation,
    version: string,
    state: ManagedHarnessState,
    integrity: string | undefined,
  ): Promise<ManagedHarnessTransaction> {
    busy = operation
    const transactionId = randomUUID()
    const transactionRoot = layout.stagingDirectory(transactionId)
    const staging = join(transactionRoot, 'candidate')
    let promoted = false
    let pending: NonNullable<ManagedHarnessState['pending']> = { operation, version, transactionId, phase: 'prepared' }
    let backupInstallId: string | undefined
    try {
      await assertManagedPathHasNoReparseAncestors(layout.root)
      if (cancelRequested()) return { outcome: 'cancelled' }
      await writeState({ ...state, pending })
      await ensureManagedDirectory(layout.staging)
      await mkdir(transactionRoot, { recursive: false, mode: 0o700 })
      await writeFile(join(transactionRoot, '.dsh-desktop-transaction.json'), JSON.stringify({ schemaVersion: 1, transactionId }), { flag: 'wx', mode: 0o600 })
      pending = { ...pending, phase: 'staging' }
      await writeState({ ...state, pending })
      await diagnostics.record({
        operation,
        version,
        phase: 'staging',
        ...(integrity === undefined ? {} : { integrity }),
      })

      // A cancel that landed during the durable write above stops the transaction
      // here, so no package manager is started whose exit the next check would
      // have to explain away.
      if (cancelRequested()) return { outcome: 'cancelled' }
      publishStage('installing', true)
      const installed = await options.installer.install({
        directory: staging,
        version,
        ...(transaction === undefined ? {} : { signal: transaction.abort.signal }),
      })
      if (cancelRequested()) {
        await diagnostics.record({ operation, version, phase: 'cancelled' })
        return { outcome: 'cancelled' }
      }
      if (installed.exitCode !== 0) {
        const reason = installed.exitCode === null
          ? `Harness ${version} was interrupted by ${String(installed.signal)}`
          : `Harness ${version} did not install (exit ${String(installed.exitCode)})`
        await diagnostics.record({
          operation,
          version,
          phase: 'install',
          ...(installed.exitCode === null ? {} : { exitCode: installed.exitCode }),
          failure: reason,
        })
        return { outcome: 'failed', reason }
      }

      publishStage('verifying', false)
      try {
        await verifyHarnessInstall(staging, version, integrity)
      } catch (error) {
        const reason = describeFailure(error)
        await diagnostics.record({ operation, version, phase: 'verify', failure: reason })
        return { outcome: 'failed', reason }
      }

      publishStage('health', false)
      const health = await options.healthCheck.check({ versionDirectory: staging, version, transactionId })
      await diagnostics.record({
        operation,
        version,
        phase: 'health',
        health: health.healthy ? 'pass' : 'fail',
        ...(health.healthy ? {} : { failure: health.failure }),
      })
      if (!health.healthy) {
        return { outcome: 'failed', reason: `Harness ${version} failed its health check` }
      }

      await markDesktopManagedVersion(staging, version)
      const markerPath = join(staging, MANAGED_VERSION_MANIFEST_NAME)
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
      marker.transactionId = transactionId
      await writeFile(markerPath, JSON.stringify(marker), { flag: 'w', mode: 0o600 })
      pending = { ...pending, phase: 'verified' }
      await writeState({ ...state, pending })

      const target = layout.versionDirectory(version)
      await ensureManagedDirectory(layout.versions)
      const backup = layout.backupDirectory(transactionId)
      if (existsSync(target)) {
        if (state.current !== version) throw new Error(`managed Harness target already exists and is not current: ${version}`)
        backupInstallId = await ownedInstallId(target, version)
        if (backupInstallId === undefined) throw new Error(`managed Harness current version has no trusted ownership marker: ${version}`)
        await ensureManagedDirectory(layout.backups)
        if (existsSync(backup)) throw new Error(`managed Harness transaction backup path already exists: ${transactionId}`)
        pending = { ...pending, phase: 'backup-planned', backupInstallId }
        await writeState({ ...state, pending })
        await rename(target, backup)
        pending = { ...pending, phase: 'backed-up' }
        await writeState({ ...state, pending })
        await diagnostics.record({ operation, version, phase: 'backed-up' })
      }
      await rename(staging, target)
      pending = { ...pending, phase: 'promoted' }
      await writeState({ ...state, pending })
      const next = promoteManagedHarnessVersion(state, version)
      await writeState({ ...next, pending: { ...pending, phase: 'committed' } })
      promoted = true
      failure = undefined
      retain(next)
      if (backupInstallId !== undefined && await ownedInstallId(backup, version) === backupInstallId) {
        await rm(backup, { recursive: true, force: false })
      }
      // Keep the committed journal until both transaction-owned scratch roots
      // are gone. If cleanup fails, recovery can retry it on the next launch.
      if (!await discardStaging(transactionId)) throw new Error(`managed Harness transaction artifacts could not be safely cleaned: ${transactionId}`)
      const { pending: _committed, ...committed } = next
      await writeState(committed)
      await collectGarbage(next)
      await diagnostics.record({ operation, version, phase: 'promoted' })
      promoted = true
      failure = undefined
      retain(next)
      return { outcome: 'promoted', version }
    } catch (error) {
      const reason = describeFailure(error)
      await diagnostics.record({ operation, version, phase: promoted ? 'cleanup-failed' : 'failed', failure: reason }).catch(() => undefined)
      return promoted ? { outcome: 'promoted', version } : { outcome: 'failed', reason }
    } finally {
      busy = undefined
      let rollbackSafe = true
      if (!promoted && backupInstallId !== undefined) {
        const target = layout.versionDirectory(version)
        const backup = layout.backupDirectory(transactionId)
        const targetId = await ownedInstallId(target, version)
        const backupId = await ownedInstallId(backup, version)
        const oldAtTarget = targetId === backupInstallId
        const oldAtBackup = backupId === backupInstallId
        if ((!oldAtTarget && !oldAtBackup)
          || (existsSync(target) && !oldAtTarget && targetId !== transactionId)) {
          rollbackSafe = false
          cachedLaunch = undefined
        } else {
          if (targetId === transactionId) await rm(target, { recursive: true, force: false }).catch(() => { rollbackSafe = false })
          if (rollbackSafe && oldAtBackup && !existsSync(target)) await rename(backup, target).catch(() => { rollbackSafe = false })
        }
      }
      const artifactsClean = await discardStaging(transactionId).catch(() => false)
      if (!promoted && artifactsClean && rollbackSafe
        && (backupInstallId === undefined || !existsSync(layout.backupDirectory(transactionId)))) {
        const { pending: _pending, ...rest } = state
        await writeState(rest).catch(() => { recoveryBlocked = true })
      } else if (!promoted) {
        recoveryBlocked = true
        if (!artifactsClean) {
          failure = 'managed Harness transaction did not complete; its owned scratch data could not be safely cleared, so further changes are blocked until recovery succeeds'
          await diagnostics.record({ operation, version, phase: 'scratch-cleanup-failed', failure }).catch(() => undefined)
        }
        if (rollbackSafe) retain(state)
        else cachedLaunch = undefined
      }
    }
  }

  /** Load state for a transaction, recording an unusable state file as one. */
  async function stateForTransaction(recovering = false): Promise<ManagedHarnessState | undefined> {
    if (recoveryBlocked && !recovering) {
      failure = 'managed Harness recovery is incomplete; restart Desktop to retry'
      return undefined
    }
    try {
      await assertManagedPathHasNoReparseAncestors(layout.root)
      return await readState()
    } catch (error) {
      invalid = true
      cachedLaunch = undefined
      failure = 'managed Harness state is unusable'
      await diagnostics.record({ operation: 'recover', phase: 'invalid-state', failure: describeFailure(error) })
      return undefined
    }
  }

  /** Resolve the official release, recording a registry failure as one. */
  async function resolveRelease(operation: ManagedHarnessOperation): Promise<HarnessRelease | undefined> {
    try {
      const release = await options.releaseSource.latest(transaction?.abort.signal)
      await diagnostics.record({
        operation,
        version: release.version,
        phase: 'resolved',
        ...(release.integrity === undefined ? {} : { integrity: release.integrity }),
      })
      return release
    } catch (error) {
      if (cancelRequested()) return undefined
      failure = describeFailure(error)
      await diagnostics.record({ operation, phase: 'registry', failure })
      return undefined
    }
  }

  /**
   * Resolve the official `latest` release and promote it.
   * @param operation - Transaction kind, recorded in diagnostics and state.
   * @param force - Promote even when the release already matches the promoted
   * version, replacing program files the user suspects are damaged.
   * @returns What the transaction produced.
   */
  function acquireLatest(operation: 'update' | 'reinstall', force: boolean): Promise<ManagedHarnessTransaction> {
    return enqueue(async (): Promise<ManagedHarnessTransaction> => {
      beginStaging(operation)
      try {
        const state = await stateForTransaction()
        if (state === undefined) return { outcome: 'failed', reason: 'managed Harness state is unusable' }
        const release = await resolveRelease(operation)
        if (release === undefined) {
          return cancelRequested()
            ? { outcome: 'cancelled' }
            : { outcome: 'failed', reason: failure ?? 'registry lookup failed' }
        }
        if (cancelRequested()) return { outcome: 'cancelled' }
        if (!force && state.current === release.version) {
          failure = undefined
          retain(state)
          return { outcome: 'up-to-date', version: release.version }
        }
        const result = await stageAndPromote(operation, release.version, state, release.integrity)
        if (result.outcome === 'failed') failure = result.reason
        return result
      } finally {
        endStaging()
      }
    })
  }

  return {
    async recover() {
      recoveryBlocked = true
      cachedLaunch = undefined
      failure = 'managed Harness recovery is incomplete; restart Desktop to retry'
      await assertManagedPathHasNoReparseAncestors(layout.root)
      const windows = (options.platform ?? process.platform) === 'win32'
      if (windows) await assertWindowsRuntimeIdle(layout.root, runProcess)
      await mkdir(layout.root, { recursive: true, mode: 0o700 })
      const state = await stateForTransaction(true)
      if (state === undefined) return
      let recovered = state
      if (state.pending !== undefined) {
        if (state.pending.transactionId === undefined) {
          failure = 'legacy managed Harness transaction is unresolved; artifacts were preserved and new transactions are blocked'
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'legacy-pending-unresolved', failure })
          const currentDirectory = state.current === undefined ? undefined : layout.versionDirectory(state.current)
          if (currentDirectory !== undefined) {
            try {
              const metadata = await lstat(currentDirectory)
              const packagePath = join(currentDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
              const packageMetadata = await lstat(packagePath)
              const installed = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown }
              const cliMetadata = await lstat(harnessCliEntry(currentDirectory))
              if (metadata.isDirectory() && !metadata.isSymbolicLink() && packageMetadata.isFile()
                && !packageMetadata.isSymbolicLink() && installed.name === HARNESS_PACKAGE
                && installed.version === state.current && cliMetadata.isFile() && !cliMetadata.isSymbolicLink()) retain(state)
            } catch { /* Keep the launch descriptor absent when current is unavailable. */ }
          }
          return
        }
        // A live installer retains its staging directory even if its parent has exited.
        const deadline = Date.now() + OWNERSHIP_PROBE_TIMEOUT_MS
        for (; !windows;) {
          const candidates = await runProcess({ command: 'pgrep', args: ['-f', 'npm(-cli.js| install)'],
            env: managedProcessEnvironment(), timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS })
          if (candidates.outputTruncated || (candidates.exitCode !== 0 && candidates.exitCode !== 1)) {
            throw new Error('cannot establish whether a managed installer is still running')
          }
          let installing = false
          if (candidates.exitCode === 0) {
            for (const pidText of candidates.output.trim().split(/\s+/u)) {
              if (!/^\d+$/u.test(pidText)) throw new Error('invalid installer process identity')
              const probe = await runProcess({ command: 'ps', args: ['eww', '-p', pidText, '-o', 'command='],
                env: managedProcessEnvironment(), timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS })
              if (probe.outputTruncated) throw new Error('installer ownership probe exceeded its output limit')
              if (probe.exitCode === 0 && probe.output.includes(`DSH_DESKTOP_INSTALL_ROOT=${layout.root}`)) installing = true
              else if (probe.exitCode !== 0 && probe.exitCode !== 1) throw new Error('installer ownership probe failed')
            }
          }
          if (!installing) break
          if (Date.now() >= deadline) throw new Error('managed installer is still running; recovery deferred')
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        const txId = state.pending.transactionId
        await ensureManagedDirectory(layout.versions)
        await ensureManagedDirectory(layout.backups)
        await ensureManagedDirectory(layout.staging)
        await ensureManagedDirectory(layout.health)
        const target = layout.versionDirectory(state.pending.version)
        const backup = layout.backupDirectory(txId)
        const targetInstallId = await ownedInstallId(target, state.pending.version)
        const backupInstallId = await ownedInstallId(backup, state.pending.version)
        const committed = state.pending.phase === 'committed'
        const beforeBackup = state.pending.phase === undefined
          || state.pending.phase === 'prepared' || state.pending.phase === 'staging' || state.pending.phase === 'verified'
        const untouchedCurrent = beforeBackup && state.current === state.pending.version && targetInstallId !== undefined
        const backupExpected = state.pending.backupInstallId
        const oldAtTarget = backupExpected !== undefined && targetInstallId === backupExpected
        const oldAtBackup = backupExpected !== undefined && backupInstallId === backupExpected
        if (!committed && backupExpected !== undefined && !oldAtTarget && !oldAtBackup) {
          failure = 'managed Harness recovery cannot prove the previous install; artifacts were preserved and launch is unavailable'
          cachedLaunch = undefined
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'missing-previous-install-preserved', failure })
          return
        }
        if (existsSync(backup) && backupInstallId !== state.pending.backupInstallId) {
          failure = 'managed Harness recovery found an unknown backup; artifacts were preserved'
          cachedLaunch = undefined
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'unknown-backup-preserved', failure })
          return
        }
        if (committed && targetInstallId !== txId) {
          failure = 'managed Harness recovery cannot prove the committed target; artifacts were preserved'
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'unknown-target-preserved', failure })
          return
        }
        if (!committed && targetInstallId === txId) {
          await rm(target, { recursive: true, force: false })
        } else if (existsSync(target) && (committed ? targetInstallId !== txId
          : targetInstallId !== state.pending.backupInstallId && !untouchedCurrent)) {
          failure = 'managed Harness recovery found an unknown target; artifacts were preserved'
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'unknown-target-preserved', failure })
          return
        }
        if (backupInstallId !== undefined) {
          if (backupInstallId !== state.pending.backupInstallId) {
            failure = 'managed Harness recovery found an unknown backup; artifacts were preserved'
            await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'unknown-backup-preserved', failure })
            return
          }
          if (!committed && !existsSync(target)) await rename(backup, target)
          else if (committed) await rm(backup, { recursive: true, force: false })
        } else if (existsSync(backup)) {
          failure = 'managed Harness recovery found an unowned backup; artifacts were preserved'
          cachedLaunch = undefined
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'unknown-backup-preserved', failure })
          return
        }
        if (!await discardStaging(txId)) {
          failure = 'managed Harness recovery found unowned transaction scratch data; the committed install was kept and recovery is deferred'
          recoveryBlocked = true
          retain(state)
          await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: 'committed-scratch-preserved', failure })
          return
        }
        await diagnostics.record({ operation: 'recover', version: state.pending.version, phase: committed ? 'completed-transaction' : 'rolled-back-transaction' })
        const { pending: _discarded, ...rest } = state
        recovered = committed ? state : rest
        // A committed transaction's current/previous were persisted before the
        // phase; a non-committed transaction keeps the original state versions.
        if (committed) {
          const { pending: _committed, ...withoutPending } = state
          recovered = withoutPending
        }
        await writeState(recovered)
      }
      await collectGarbage(recovered)
      if (windows) await rm(recordFile, { force: true })
      else await reclaimOwnedOrphan()
      failure = undefined
      recoveryBlocked = false
      retain(recovered)
    },

    launch() {
      return cachedLaunch
    },

    availability() {
      if (invalid) return { available: false, reason: 'invalid' }
      if (busy !== undefined) return { available: false, reason: 'busy' }
      if (cachedLaunch === undefined) return { available: false, reason: 'not-installed' }
      return { available: true }
    },

    retained() {
      return {
        ...(cachedState.current === undefined ? {} : { current: cachedState.current }),
        ...(cachedState.previous === undefined ? {} : { previous: cachedState.previous }),
      }
    },

    status() {
      if (invalid) return { phase: 'invalid' }
      const retained = {
        ...(cachedState.current === undefined ? {} : { current: cachedState.current }),
        ...(cachedState.previous === undefined ? {} : { previous: cachedState.previous }),
      }
      if (busy !== undefined) return { phase: 'busy', operation: busy, ...retained }
      if (failure !== undefined) return { phase: 'failed', reason: failure, ...retained }
      if (cachedState.current === undefined) return { phase: 'not-installed' }
      return {
        phase: 'ready',
        current: cachedState.current,
        ...(cachedState.previous === undefined ? {} : { previous: cachedState.previous }),
      }
    },

    install() {
      return enqueue(async (): Promise<ManagedHarnessTransaction> => {
        beginStaging('install')
        try {
          const state = await stateForTransaction()
          if (state === undefined) return { outcome: 'failed', reason: 'managed Harness state is unusable' }
          if (state.current !== undefined) {
            failure = undefined
            retain(state)
            return { outcome: 'up-to-date', version: state.current }
          }
          const release = await resolveRelease('install')
          if (release === undefined) {
            return cancelRequested()
              ? { outcome: 'cancelled' }
              : { outcome: 'failed', reason: failure ?? 'registry lookup failed' }
          }
          if (cancelRequested()) return { outcome: 'cancelled' }
          const result = await stageAndPromote('install', release.version, state, release.integrity)
          if (result.outcome === 'failed') failure = result.reason
          return result
        } finally {
          endStaging()
        }
      })
    },

    async checkForUpdate() {
      let release
      try {
        release = await options.releaseSource.latest()
      } catch (error) {
        return { state: 'failed', reason: describeFailure(error) }
      }
      if (cachedState.current === undefined) return { state: 'not-installed', latest: release.version }
      if (cachedState.current === release.version) return { state: 'up-to-date', current: cachedState.current }
      return { state: 'available', latest: release.version, current: cachedState.current }
    },

    update() {
      return acquireLatest('update', false)
    },

    cancelTransaction() {
      const running = transaction
      if (running === undefined) return 'idle'
      if (!running.cancellable) return 'refused'
      running.cancelRequested = true
      running.abort.abort()
      return 'accepted'
    },

    reinstall() {
      return acquireLatest('reinstall', true)
    },

    rollback() {
      return enqueue(async (): Promise<ManagedHarnessTransaction> => {
        await assertManagedPathHasNoReparseAncestors(layout.root)
        const state = await stateForTransaction()
        if (state === undefined) return { outcome: 'failed', reason: 'managed Harness state is unusable' }
        if (state.previous === undefined || state.current === undefined) {
          failure = 'no previous Harness version is retained'
          await diagnostics.record({ operation: 'rollback', phase: 'no-previous' })
          return { outcome: 'failed', reason: failure }
        }
        const previous = state.previous
        busy = 'rollback'
        try {
          const health = await options.healthCheck.check({
            versionDirectory: layout.versionDirectory(previous),
            version: previous,
            transactionId: randomUUID(),
          })
          await diagnostics.record({
            operation: 'rollback',
            version: previous,
            phase: 'health',
            health: health.healthy ? 'pass' : 'fail',
            ...(health.healthy ? {} : { failure: health.failure }),
          })
          if (!health.healthy) {
            // The outgoing current stays promoted: a rollback target that cannot
            // serve its Web UI is not a usable fallback.
            failure = `previous Harness ${previous} failed its health check`
            return { outcome: 'failed', reason: failure }
          }
          const swapped: ManagedHarnessState = { current: previous, previous: state.current }
          await writeState(swapped)
          failure = undefined
          retain(swapped)
          await collectGarbage(swapped).catch(async (error: unknown) => {
            await diagnostics.record({ operation: 'rollback', phase: 'cleanup-failed', failure: describeFailure(error) })
          })
          await diagnostics.record({ operation: 'rollback', version: previous, phase: 'promoted' })
          return { outcome: 'rolled-back', version: previous }
        } finally {
          busy = undefined
        }
      })
    },

    createHostSupervisorForLaunch(hostApiToken) {
      const launch = cachedLaunch
      if (launch === undefined) throw new Error('managed Harness has no promoted version to launch')
      let ownedPid: number | undefined
      const ownerNonce = randomUUID()
      const supervisor = createSupervisor({
        spawnHost: () => {
          const child = spawnDshWeb({
            nodeExecutable: options.nodeExecutable,
            cliEntry: launch.cliEntry,
            cwd: options.cwd,
            env: parentBoundEnvironment({ ...process.env, DSH_DESKTOP: '1', DSH_DESKTOP_API_TOKEN: hostApiToken, DSH_DESKTOP_OWNER_NONCE: ownerNonce }),
            ...(options.electronRunAsNode === undefined ? {} : { electronRunAsNode: options.electronRunAsNode }),
            suppressBrowserHandoff: launch.suppressBrowserHandoff,
          })
          ownedPid = child.pid
          return child
        },
      })
      return {
        async start(): Promise<HostReadiness> {
          const readiness = await supervisor.start()
          if (ownedPid !== undefined) {
            const record: ManagedHarnessRuntimeRecord = {
              pid: ownedPid,
              ownerNonce,
              cliEntry: launch.cliEntry,
              version: launch.version,
              port: Number(new URL(readiness.origin).port),
            }
            await writeFile(recordFile, `${JSON.stringify(record)}\n`, { mode: 0o600 }).catch(() => undefined)
          }
          return readiness
        },
        onUnexpectedExit: listener => supervisor.onUnexpectedExit(listener),
        async shutdown(): Promise<void> {
          await supervisor.shutdown()
          await rm(recordFile, { force: true }).catch(() => undefined)
        },
      }
    },

    async dispose() {
      // Deliberately does not join the transaction queue: an in-flight install is
      // bounded by its own timeout, and waiting for it would hold quit open. Its
      // pending marker is what makes the next launch recover it.
      await rm(recordFile, { force: true }).catch(() => undefined)
    },
  }
}
