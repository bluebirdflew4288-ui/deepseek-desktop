/**
 * Bounded diagnostics for managed Harness operations.
 *
 * The log carries operation facts and allowlisted Host startup categories, not
 * raw process output, launch tokens, credentials, or user content. Detail that
 * a user needs after a failure stays here; the shell surfaces a short message.
 */

import { appendFile, lstat, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSafeRegularFile, ensureSafeDirectoryTree } from './managed-harness-files.ts'

/** Cap on one log file before it rotates. */
const DEFAULT_MAX_BYTES = 1_048_576

/** Bound on one recorded failure description. */
const MAX_FAILURE_CHARS = 512

const HOST_OUTPUT_MARKER = '\nHost output:\n'
const FAILURE_FALLBACK = 'managed Harness operation failed'
const HOST_ERROR_CODES = [
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
  'ERR_UNKNOWN_BUILTIN_MODULE',
] as const
const HOST_PACKAGES = [
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis',
  'node-addon-require-builtin-win32-x64-msvc',
  'node-addon-require-builtin',
  'node-addon-native-custom-loader',
] as const

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
 * Describe one failure for the log without carrying raw Host output.
 * @param error - Failure to summarize.
 * @returns A bounded summary with recognized Host errors classified.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0] ?? ''

  if (/^desktop Host readiness\b/iu.test(firstLine)) return 'desktop Host readiness failed'

  const hasHostOutput = message.includes(HOST_OUTPUT_MARKER)
  const hostExit = /^desktop Host exited before readiness \(code (-?\d+|null), signal (null|SIG[A-Z0-9]+)\)$/u.exec(firstLine)
  if (hasHostOutput || hostExit !== null || /^desktop Host failed to spawn\b/iu.test(firstLine)) {
    const prefix = hostExit === null
      ? 'desktop Host startup failed'
      : `desktop Host exited before readiness (code ${hostExit[1]}, signal ${hostExit[2]})`
    const category = classifyHostOutput(message)
    return capFailure(category === undefined ? prefix : `${prefix}; ${category}`)
  }

  return capFailure(sanitizeFailureSummary(firstLine))
}

/** Return only diagnostic labels selected from fixed allowlists. */
function classifyHostOutput(message: string): string | undefined {
  if (/\b(?:unknown|unrecognized|invalid)\s+(?:cli\s+)?(?:option|argument)\b/iu.test(message)) {
    return 'Host startup: unknown CLI option'
  }

  const packageName = HOST_PACKAGES.find(candidate => message.includes(candidate))
  const errorCode = HOST_ERROR_CODES.find(candidate => new RegExp(`\\b${candidate}\\b`, 'u').test(message))

  if (/node-addon-require-builtin.{0,100}\b(?:unsupported|no-context|no-getter|no-realm)\b/isu.test(message)) {
    return 'Host startup: native addon unsupported (node-addon-require-builtin)'
  }

  if (errorCode !== undefined) {
    return packageName === undefined
      ? `Host startup: ${errorCode}`
      : `Host startup: ${errorCode} (${packageName})`
  }

  if (packageName !== undefined && /\b(?:cannot|failed|failure|error|unsupported|not found|not exported)\b/iu.test(message)) {
    return `Host startup: package load failure (${packageName})`
  }

  return undefined
}

/** Redact common secrets from legacy non-Host first-line summaries. */
function sanitizeFailureSummary(value: string): string {
  if (/\b(?:chat|memory|prompt)(?:\s+content)?\s*[:=]/iu.test(value)) return FAILURE_FALLBACK
  if (/(?:\b[A-Z]:\\|\\\\|(?:^|\s)\/(?:Users|home|tmp|private|var|mnt)\/)/u.test(value)) return FAILURE_FALLBACK

  return value
    .replace(/\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]*/giu, 'Cookie: [redacted]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b((?:[A-Z0-9_-]*)(?:launch[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|token|api[-_ ]?key|authorization|password|credential|secret|cookie)(?:[A-Z0-9_-]*))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[redacted URL]')
}

/** Cap output including the ellipsis. */
function capFailure(value: string): string {
  return value.length > MAX_FAILURE_CHARS ? `${value.slice(0, MAX_FAILURE_CHARS - 1)}…` : value
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
