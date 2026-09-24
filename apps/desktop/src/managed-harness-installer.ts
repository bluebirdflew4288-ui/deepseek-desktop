/**
 * Installs one official Harness release into a staging directory.
 *
 * The installer runs the package manager the desktop ships, under the same
 * Electron Node runtime that later launches the Harness, so a managed install
 * never reaches for a Node, npm, or npx the user installed. The registry is
 * pinned and both npm configuration slots point at empty files the desktop owns,
 * so a personal registry mirror or a relaxed integrity setting cannot reach a
 * managed install.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureEmptyManagedFile, ensureSafeDirectoryTree } from './managed-harness-files.ts'
import {
  harnessCliEntry,
  harnessFrontendEntry,
  harnessManifest,
  type ManagedHarnessLayout,
} from './managed-harness-paths.ts'
import {
  managedProcessEnvironment,
  parentBoundEnvironment,
  runManagedProcess,
  type ManagedProcessOutcome,
  type ManagedProcessRunner,
} from './managed-harness-process.ts'
import { HARNESS_PACKAGE, HARNESS_REGISTRY } from './managed-harness-registry.ts'

/** Bound on one install before the desktop abandons it. */
const DEFAULT_INSTALL_TIMEOUT_MS = 900_000

/**
 * Root manifest an install target carries so the package manager has one root
 * project and one compatible Cordis loader closure. The published rc.2 ranges
 * otherwise mix loader 1.0.3 / Cordis 4.0.2 in the DSH subtree with loader
 * 1.0.5 / Cordis 4.0.4 at the root. Recursive loader entries cross those
 * implementations and fail during boot. Keep the DSH subtree's pair unified:
 * this combination passed the synthetic Windows boot and HTTP health probe.
 */
const STAGING_MANIFEST = `${JSON.stringify({
  name: 'dsh-managed-harness',
  private: true,
  version: '0.0.0',
  overrides: {
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/cordis-plugin-loader': '1.0.3',
  },
})}\n`

/** One release the desktop installs. */
export interface HarnessInstallRequest {
  /** Fresh directory receiving the install; an existing target is rejected. */
  readonly directory: string
  /** Exact version to install. */
  readonly version: string
  /**
   * Signal abandoning the install. It is offered only because the package
   * manager writes nothing outside `directory` and the desktop-owned npm cache:
   * `--prefix` confines the tree, both configuration slots name empty files, and
   * `--ignore-scripts` means no child of the package manager outlives it to write
   * anywhere else.
   */
  readonly signal?: AbortSignal
}

/** Installs official Harness releases into staging directories. */
export interface HarnessPackageInstaller {
  /**
   * Install one exact version into one directory.
   * @param request - Target directory, exact version, and optional abort signal.
   * @returns The installer's outcome. A non-zero exit code leaves the target
   * unusable; the caller discards it rather than promoting it.
   */
  install(request: HarnessInstallRequest): Promise<ManagedProcessOutcome>
}

/** Dependencies one npm-backed installer needs. */
export interface NpmHarnessInstallerOptions {
  /** Managed layout supplying the cache and configuration paths. */
  readonly layout: ManagedHarnessLayout
  /** Executable that runs the package manager, normally the Electron binary. */
  readonly nodeExecutable: string
  /** Package manager CLI entry the desktop ships. */
  readonly npmCliEntry: string
  /** Process runner, injectable for tests. */
  readonly runProcess?: ManagedProcessRunner
  /** Bound on one install. */
  readonly timeoutMs?: number
}

/**
 * Assemble the arguments installing one exact Harness version.
 *
 * Peer dependencies are resolved by the package manager's own default rules: the
 * Harness closure declares its Service Definition packages as peers, and
 * skipping peer resolution omits 24 modules the CLI imports at boot. Install
 * scripts are skipped because every native module in the closure ships a prebuilt
 * binary, so nothing needs to compile and no downloaded script runs.
 * @param npmCliEntry - Package manager CLI the desktop ships.
 * @param layout - Managed layout supplying cache and configuration paths.
 * @param request - Target directory and exact version.
 * @returns The argument vector, passed without a shell.
 */
export function harnessInstallArgs(
  npmCliEntry: string,
  layout: ManagedHarnessLayout,
  request: HarnessInstallRequest,
): string[] {
  return [
    npmCliEntry,
    'install',
    '--prefix', request.directory,
    '--cache', layout.npmCache,
    '--registry', HARNESS_REGISTRY,
    '--userconfig', layout.npmUserConfig,
    '--globalconfig', layout.npmGlobalConfig,
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--omit=dev',
    '--ignore-scripts',
    '--loglevel=error',
    '--fetch-retries=3',
    `${HARNESS_PACKAGE}@${request.version}`,
  ]
}

/**
 * Create an npm-backed installer for official Harness releases.
 * @param options - Layout, runtime executable, shipped package manager, and runner.
 * @returns An installer replacing its target directory on every call.
 */
export function createNpmHarnessInstaller(options: NpmHarnessInstallerOptions): HarnessPackageInstaller {
  const runProcess = options.runProcess ?? runManagedProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  return {
    async install(request) {
      const trustedAnchor = options.layout.rootAnchor ?? options.layout.rootBoundary ?? options.layout.root
      await ensureSafeDirectoryTree(options.layout.npmCache, trustedAnchor)
      await ensureEmptyManagedFile(options.layout.npmUserConfig, trustedAnchor)
      await ensureEmptyManagedFile(options.layout.npmGlobalConfig, trustedAnchor)
      // The runtime creates this directory exclusively beneath a transaction
      // marker. Never erase a colliding path from inside the installer.
      await ensureSafeDirectoryTree(dirname(request.directory), trustedAnchor)
      await mkdir(request.directory, { recursive: false, mode: 0o700 })
      await writeFile(`${request.directory}/package.json`, STAGING_MANIFEST, { mode: 0o600 })
      return runProcess({
        command: options.nodeExecutable,
        args: harnessInstallArgs(options.npmCliEntry, options.layout, request),
        env: parentBoundEnvironment(managedProcessEnvironment({ ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_INSTALL_ROOT: options.layout.root })),
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    },
  }
}

/**
 * Confirm one directory holds the exact release it was staged for.
 *
 * The package manager verifies each downloaded tarball against the integrity
 * value the official registry publishes. This check adds what that cannot: the
 * installed manifest is the package and version the desktop asked for, and both
 * entrypoints the Web Host needs are present.
 * @param directory - Installed program directory.
 * @param expectedVersion - Exact version the transaction targeted.
 * @param expectedIntegrity - Integrity resolved before installation, when supplied.
 * @throws When an entrypoint is absent or the manifest names another package or
 * version, which is what a substituted or truncated download looks like.
 */
export async function verifyHarnessInstall(directory: string, expectedVersion: string, expectedIntegrity?: string): Promise<void> {
  const manifest = await readFile(harnessManifest(directory), 'utf8').catch(() => {
    throw new Error(`managed Harness install has no package manifest: ${harnessManifest(directory)}`)
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    throw new Error('managed Harness install manifest is not JSON')
  }
  const record = parsed as { name?: unknown; version?: unknown }
  if (record.name !== HARNESS_PACKAGE) {
    throw new Error(`managed Harness install is the wrong package: ${String(record.name)}`)
  }
  if (record.version !== expectedVersion) {
    throw new Error(`managed Harness install is version ${String(record.version)}, expected ${expectedVersion}`)
  }
  if (expectedIntegrity !== undefined) {
    const lock = JSON.parse(await readFile(`${directory}/package-lock.json`, 'utf8')) as {
      packages?: Record<string, { integrity?: string }>
    }
    if (lock.packages?.['node_modules/@deepseek-ai/dsh']?.integrity !== expectedIntegrity) {
      throw new Error('managed Harness install integrity differs from the resolved release')
    }
  }
  for (const entry of [harnessCliEntry(directory), harnessFrontendEntry(directory)]) {
    await access(entry).catch(() => {
      throw new Error(`managed Harness install is missing ${entry}`)
    })
  }
}
