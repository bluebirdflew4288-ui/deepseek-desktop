/**
 * Constrained child-process primitives shared by every managed Harness
 * transaction.
 *
 * Each one spawns with an explicit environment and an explicit search path
 * rather than inheriting the launching shell's, so a managed install, health
 * check, or Harness launch behaves the same on every machine and cannot pick up
 * a Node, package manager, registry, or proxy the user happens to have.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

/** Retained tail of one child's combined output. */
const MAX_PROCESS_OUTPUT_CHARS = 32_768

/** Grace between SIGTERM and SIGKILL when a child overruns its bound. */
export const KILL_GRACE_MS = 5_000

/**
 * Search path handed to every managed child.
 *
 * It names only operating-system directories, so no child can resolve a Node,
 * npm, or npx the user installed.
 * @returns The platform's system directories.
 */
export function managedSearchPath(): string {
  return process.platform === 'win32'
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\system32`
    : '/usr/bin:/bin:/usr/sbin:/sbin'
}

/**
 * Environment for one managed child.
 * @param extra - Variables the operation owns, such as the Harness home a health
 * check isolates. They override the defaults, never the reverse.
 * @returns The complete environment, with nothing inherited from the shell.
 */
export function managedProcessEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = homedir()
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: managedSearchPath(),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...extra,
  }
}

/** One spawned managed child, as the desktop observes it. */
export interface ManagedProcessOutcome {
  /** Exit code, or null when a signal ended the process. */
  readonly exitCode: number | null
  /** Signal that ended the process, when one did. */
  readonly signal: NodeJS.Signals | null
  /** Retained tail of combined stdout and stderr. */
  readonly output: string
  /** Whether output exceeded the retained limit; ownership probes must reject it. */
  readonly outputTruncated?: boolean
}

/** What one managed child needs to run. */
export interface ManagedProcessRequest {
  /** Executable to spawn. */
  readonly command: string
  /** Arguments, passed without a shell. */
  readonly args: readonly string[]
  /** Complete environment for the child. */
  readonly env: NodeJS.ProcessEnv
  /** Bound before the child is terminated. */
  readonly timeoutMs: number
  /**
   * Abandoning signal. Aborting terminates the child the way an overrun does:
   * `SIGTERM`, then `SIGKILL` one grace period later. A caller may abort only a
   * child whose entire work it can discard, and it must own every directory the
   * child writes to.
   */
  readonly signal?: AbortSignal
}

/** Runs one managed child to completion. */
export type ManagedProcessRunner = (request: ManagedProcessRequest) => Promise<ManagedProcessOutcome>

/**
 * Run one child process to completion with a bounded output tail.
 *
 * The child is terminated at `timeoutMs` and killed one grace period later, so
 * an operation that stalls cannot hold a transaction open indefinitely. An
 * aborting `signal` produces the same escalation on request rather than on
 * elapsed time, and the promise still settles with the child's exit outcome.
 * @param request - Executable, arguments, environment, bound, and abort signal.
 * @returns The exit outcome and the retained output tail.
 */
export function runManagedProcess(request: ManagedProcessRequest): Promise<ManagedProcessOutcome> {
  return new Promise<ManagedProcessOutcome>((resolve, reject) => {
    let output = ''
    let outputTruncated = false
    let killTimer: NodeJS.Timeout | undefined
    const child = spawn(request.command, [...request.args], {
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const append = (chunk: string | Buffer): void => {
      const combined = `${output}${chunk.toString()}`
      outputTruncated ||= combined.length > MAX_PROCESS_OUTPUT_CHARS
      output = combined.slice(-MAX_PROCESS_OUTPUT_CHARS)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const terminate = (): void => {
      child.kill('SIGTERM')
      if (killTimer === undefined) {
        killTimer = setTimeout(() => { child.kill('SIGKILL') }, KILL_GRACE_MS)
      }
    }
    const terminateTimer = setTimeout(terminate, request.timeoutMs)
    const release = (): void => {
      clearTimeout(terminateTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', terminate)
    }
    request.signal?.addEventListener('abort', terminate, { once: true })
    // A signal that aborted before the child started never fires a later event.
    if (request.signal?.aborted === true) terminate()
    child.once('error', (error) => {
      release()
      reject(error)
    })
    child.once('close', (code, signal) => {
      release()
      resolve({ exitCode: code, signal, output, ...(outputTruncated ? { outputTruncated: true } : {}) })
    })
  })
}

/**
 * Bind a Node child to this parent even when the parent crashes before recording readiness.
 * @param env - Child environment.
 * @returns Environment loading a parent-death watchdog before the CLI entry.
 */
export function parentBoundEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const script = `delete process.env.NODE_OPTIONS;const parent=${process.pid};const timer=setInterval(()=>{if(process.ppid!==parent){clearInterval(timer);setTimeout(()=>process.kill(process.pid,'SIGKILL'),5000).unref();process.kill(process.pid,'SIGTERM')}},250);timer.unref()`
  const guard = `--import=data:text/javascript,${encodeURIComponent(script).replaceAll("'", '%27')}`
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} ${guard}`.trim() }
}
