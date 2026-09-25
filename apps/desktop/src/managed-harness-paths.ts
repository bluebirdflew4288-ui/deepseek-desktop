/** Filesystem layout of the desktop-managed Harness program directory. */

import { join } from 'node:path'

/**
 * Characters a Harness version may carry as a directory name. The registry
 * supplies the version, so it crosses a trust boundary before it reaches a
 * path; anything outside this set is rejected rather than escaped.
 */
const VERSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u

/** Directory names under the managed root. */
const DIRECTORIES = {
  versions: 'versions',
  staging: 'staging',
  health: 'health',
  backups: 'replacement-backups',
  npmCache: 'npm-cache',
  npmConfig: 'npm-config',
  logs: 'logs',
} as const

/** Diagnostic log file name inside the managed log directory. */
export const MANAGED_HARNESS_LOG_NAME = 'managed-harness.log'

/**
 * Resolved locations of every artifact the managed Harness owns.
 *
 * Program files live here and are replaceable. Harness user data does not: it
 * stays in the Harness home the CLI itself resolves, so switching a program
 * version never touches settings, credentials, or sessions.
 */
export interface ManagedHarnessLayout {
  /** Root directory holding every managed artifact. */
  readonly root: string
  /** Electron-resolved program path boundary and OS-selected trusted base. */
  readonly rootBoundary?: string
  readonly rootAnchor?: string
  /** Version state file, written atomically. */
  readonly stateFile: string
  /** Parent of every retained program version. */
  readonly versions: string
  /** Parent of in-progress installs, which are promoted by rename. */
  readonly staging: string
  readonly health: string
  readonly backups: string
  /** Package cache owned by the managed installer. */
  readonly npmCache: string
  /**
   * Empty npm user configuration the installer reads instead of the user's own,
   * so a personal registry mirror or relaxed integrity setting cannot reach a
   * managed install.
   */
  readonly npmUserConfig: string
  /**
   * Empty npm global configuration, distinct from {@link npmUserConfig} because
   * npm rejects one file occupying both slots.
   */
  readonly npmGlobalConfig: string
  /** Bounded diagnostic log. */
  readonly logFile: string
  /**
   * Directory of one promoted program version.
   * @param version - Exact installed version.
   * @returns The version's program directory.
   */
  versionDirectory(version: string): string
  /**
   * Directory one in-progress install occupies before promotion.
   * @param version - Exact version being installed.
   * @returns The staging directory for that version.
   */
  stagingDirectory(transactionId: string): string
  /**
   * Harness home a health check runs against, so promotion never writes to the
   * user's real Harness data.
   * @param version - Exact version being health-checked.
   * @returns The disposable Harness home for that check.
   */
  healthHome(transactionId: string): string
  backupDirectory(transactionId: string): string
}

/**
 * Test whether a version can name a directory under the managed root.
 * @param version - Candidate version string from an untrusted source.
 * @returns Whether the version is safe to use as one path segment.
 */
export function isManagedHarnessVersionName(version: string): boolean {
  return VERSION_NAME_PATTERN.test(version) && !version.includes('..')
}

/**
 * Resolve the managed layout under one root directory.
 * @param root - Directory the desktop application owns for managed Harness
 * artifacts, normally inside its own user-data directory.
 * @returns The layout, with every path derived from `root`.
 * @throws When `root` is not an absolute path.
 */
export function managedHarnessLayout(
  root: string,
  security?: { readonly rootBoundary?: string; readonly rootAnchor?: string },
): ManagedHarnessLayout {
  if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(root)) {
    throw new Error(`managed Harness root must be absolute: ${root}`)
  }
  const versions = join(root, DIRECTORIES.versions)
  const staging = join(root, DIRECTORIES.staging)
  const health = join(root, DIRECTORIES.health)
  const backups = join(root, DIRECTORIES.backups)
  const segment = (parent: string, version: string): string => {
    if (!isManagedHarnessVersionName(version)) {
      throw new Error(`managed Harness version is not a safe directory name: ${version}`)
    }
    return join(parent, version)
  }
  const npmConfig = join(root, DIRECTORIES.npmConfig)
  return {
    root,
    ...(security?.rootBoundary === undefined ? {} : { rootBoundary: security.rootBoundary }),
    ...(security?.rootAnchor === undefined ? {} : { rootAnchor: security.rootAnchor }),
    stateFile: join(root, 'state.json'),
    versions,
    staging,
    health,
    backups,
    npmCache: join(root, DIRECTORIES.npmCache),
    npmUserConfig: join(npmConfig, 'user.npmrc'),
    npmGlobalConfig: join(npmConfig, 'global.npmrc'),
    logFile: join(root, DIRECTORIES.logs, MANAGED_HARNESS_LOG_NAME),
    versionDirectory: version => segment(versions, version),
    stagingDirectory: transactionId => segment(staging, transactionId),
    healthHome: transactionId => segment(health, transactionId),
    backupDirectory: transactionId => segment(backups, transactionId),
  }
}

/**
 * Built Harness CLI entry inside one program directory.
 * @param versionDirectory - A promoted or staged program directory.
 * @returns The CLI entrypoint the supervisor spawns.
 */
export function harnessCliEntry(versionDirectory: string): string {
  return join(versionDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * Built Harness Web UI document inside one program directory.
 * @param versionDirectory - A promoted or staged program directory.
 * @returns The frontend entrypoint the Web Host serves.
 */
export function harnessFrontendEntry(versionDirectory: string): string {
  return join(versionDirectory, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
}

/**
 * Installed manifest inside one program directory.
 * @param versionDirectory - A promoted or staged program directory.
 * @returns The manifest whose `version` field identifies the install.
 */
export function harnessManifest(versionDirectory: string): string {
  return join(versionDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}
