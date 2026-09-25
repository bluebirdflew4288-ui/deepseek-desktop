/**
 * Bounded diagnostics for managed Harness operations.
 *
 * The log carries operation facts only — no launch token, bearer credential,
 * cookie, chat content, or Memory content — because it is written from fields
 * this module names rather than from captured process output. Detail that a
 * user needs after a failure stays here; the shell surfaces a short message.
 */

import { appendFile, lstat, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSafeRegularFile, ensureSafeDirectoryTree } from './managed-harness-files.ts'

/** Cap on one log file before it rotates. */
const DEFAULT_MAX_BYTES = 1_048_576

/** Bound on one recorded failure description. */
const MAX_FAILURE_CHARS = 512

/** Outcome of one health check. */
export type ManagedHarnessHealth = 'pass' | 'fail'

/** One recorded operation fact. Every field is named here, so nothing else can enter the log. */
export interface ManagedHarnessLogEntry {
  /** ISO-8601 time the fact was recorded. */
  readonly time: string
  /** Operation the desktop performed. */
  readonly operation: string
  /** Version the operation targeted, when it names one. */
  readonly version?: string
  /** Transaction phase reached. */
  readonly phase?: string
  /**
   * Subresource integrity value the official registry published for the release
   * this operation resolved. Recorded so a promoted version is traceable to
   * official metadata; the package manager is what enforces it on download.
   */
  readonly integrity?: string
  /** Exit code of a spawned process, when one exited. */
  readonly exitCode?: number
  /** Health check outcome. */
  readonly health?: ManagedHarnessHealth
  /** Failure category, truncated. Never a raw stack trace. */
  readonly failure?: string
}

/** Sink for managed Harness operation facts. */
export interface ManagedHarnessDiagnostics {
  /**
   * Append one fact, rotating the log first when it would exceed its cap.
   * @param entry - Operation fact to record.
   */
  record(entry: Omit<ManagedHarnessLogEntry, 'time'>): Promise<void>
}

/** Dependencies one diagnostics sink needs. */
export interface ManagedHarnessDiagnosticsOptions {
  /** Log file path. */
  readonly file: string
  /** Trusted profile/program base containing the managed log path. */
  readonly trustedAnchor?: string
  /** Cap on one file before it rotates to a single backup. */
  readonly maxBytes?: number
  /** Clock producing each entry's timestamp. */
  readonly now?: () => Date
}

/**
 * Describe one failure for the log without carrying a stack trace.
 * @param error - Failure to summarize.
 * @returns The first line of its message, truncated.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0] ?? ''
  return firstLine.length > MAX_FAILURE_CHARS ? `${firstLine.slice(0, MAX_FAILURE_CHARS)}…` : firstLine
}

/**
 * Create a diagnostics sink writing one rotating JSON Lines file.
 *
 * Two files is the whole retention: the live log plus one backup, so the
 * directory cannot grow without bound across repeated failures.
 * @param options - Log path, per-file cap, and clock.
 * @returns A sink appending operation facts.
 */
export function createManagedHarnessDiagnostics(options: ManagedHarnessDiagnosticsOptions): ManagedHarnessDiagnostics {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const now = options.now ?? (() => new Date())
  const backup = `${options.file}.1`
  const trustedAnchor = options.trustedAnchor ?? dirname(dirname(options.file))
  return {
    async record(entry) {
      const line = `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`
      await ensureSafeDirectoryTree(dirname(options.file), trustedAnchor)
      await assertSafeRegularFile(options.file, trustedAnchor, true)
      await assertSafeRegularFile(backup, trustedAnchor, true)
      const size = await lstat(options.file).then(metadata => metadata.size, (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      })
      if (size > 0 && size + line.length > maxBytes) {
        await rm(backup, { force: true })
        await rename(options.file, backup).catch(() => undefined)
      }
      await appendFile(options.file, line, { mode: 0o600 })
    },
  }
}
