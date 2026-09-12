/**
 * Proves one Harness program directory can actually serve its Web UI before the
 * desktop promotes it.
 *
 * The check launches the candidate with the same executable, arguments, and
 * environment the production launch uses, against a Harness home the desktop
 * owns and deletes afterwards. Promotion therefore never writes to the user's
 * real Harness data, and a version that cannot boot is never switched to.
 */

import { mkdir, rm } from 'node:fs/promises'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { describeFailure } from './managed-harness-log.ts'
import { harnessCliEntry, type ManagedHarnessLayout } from './managed-harness-paths.ts'
import { managedProcessEnvironment, parentBoundEnvironment } from './managed-harness-process.ts'

/** Bound on one health check's readiness wait. */
const DEFAULT_HEALTH_READINESS_TIMEOUT_MS = 120_000

/** One program directory to prove runnable. */
export interface HarnessHealthRequest {
  /** Installed program directory holding the Harness closure. */
  readonly versionDirectory: string
  /** Exact version, naming the disposable Harness home for this check. */
  readonly version: string
}

/** Outcome of one health check. It never carries the launch token. */
export type HarnessHealthResult =
  | { readonly healthy: true }
  | { readonly healthy: false; readonly failure: string }

/** Runs health checks against candidate program directories. */
export interface HarnessHealthCheck {
  /**
   * Launch one candidate, wait for readiness, then stop it.
   * @param request - Program directory and version to check.
   * @returns Whether the candidate served its readiness line in time.
   */
  check(request: HarnessHealthRequest): Promise<HarnessHealthResult>
}

/** Dependencies one health check needs. */
export interface HarnessHealthCheckOptions {
  /** Managed layout supplying the disposable Harness home. */
  readonly layout: ManagedHarnessLayout
  /** Executable that runs the Harness, normally the Electron binary. */
  readonly nodeExecutable: string
  /** Working directory the Harness inherits. */
  readonly cwd: string
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode?: boolean
  /** Bound on the readiness wait. */
  readonly readinessTimeoutMs?: number
  /** Grace after SIGTERM before SIGKILL. */
  readonly shutdownTimeoutMs?: number
  /** Supervisor factory, injectable for tests. */
  readonly createSupervisor?: (options: Parameters<typeof createHostSupervisor>[0]) => HostSupervisor
}

/**
 * Create a health check launching candidates exactly as production does.
 * @param options - Layout, runtime executable, and lifecycle bounds.
 * @returns A check that leaves no process and no Harness home behind.
 */
export function createHarnessHealthCheck(options: HarnessHealthCheckOptions): HarnessHealthCheck {
  const createSupervisor = options.createSupervisor ?? createHostSupervisor
  return {
    async check(request) {
      const home = options.layout.healthHome(request.version)
      await rm(home, { recursive: true, force: true })
      await mkdir(home, { recursive: true, mode: 0o700 })
      const supervisor = createSupervisor({
        spawnHost: () => spawnDshWeb({
          nodeExecutable: options.nodeExecutable,
          cliEntry: harnessCliEntry(request.versionDirectory),
          cwd: options.cwd,
          env: parentBoundEnvironment(managedProcessEnvironment({ DSH_HOME: home })),
          ...(options.electronRunAsNode === undefined ? {} : { electronRunAsNode: options.electronRunAsNode }),
          suppressBrowserHandoff: true,
        }),
        ...(options.readinessTimeoutMs === undefined
          ? { readinessTimeoutMs: DEFAULT_HEALTH_READINESS_TIMEOUT_MS }
          : { readinessTimeoutMs: options.readinessTimeoutMs }),
        ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      })
      try {
        await supervisor.start()
        return { healthy: true }
      } catch (error) {
        return { healthy: false, failure: describeFailure(error) }
      } finally {
        await supervisor.shutdown().catch(() => undefined)
        await rm(home, { recursive: true, force: true })
      }
    },
  }
}
