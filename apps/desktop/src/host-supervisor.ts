/** Supervise the loopback Web Host used by the first desktop application. */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

const READINESS_PREFIX = 'dsh web: '
const DEFAULT_READINESS_TIMEOUT_MS = 90_000
/**
 * Grace after SIGTERM before SIGKILL. The Harness CLI arms its own 5s
 * force-exit timer on shutdown, so this stays strictly above it: escalating
 * earlier would race a child that is still completing its own bounded teardown.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000
const MAX_STARTUP_OUTPUT_CHARS = 32_768

/** Credential charset the Host mints for its browser handoff. */
const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u

/** Loopback address the Host reported at readiness. */
export interface HostReadiness {
  /** Loopback HTTP origin, without a path, query, or fragment. */
  readonly origin: string
  /**
   * Single-use credential the Host embedded in its readiness URL, exchanged by
   * the first document load for an authority-bound cookie. Absent on Harness
   * versions that authenticate the embedded view by a spawn-environment bearer
   * instead. Process-scoped: it never outlives the launch that minted it, so it
   * is not persisted, logged, or reused across restarts.
   */
  readonly token?: string
}

/** Incremental parser for the Web Host's canonical readiness line. */
export interface ReadinessParser {
  /**
   * Consume one stdout chunk.
   * @param chunk - Text emitted by the Host.
   * @returns The loopback readiness once a complete readiness line is observed.
   */
  push(chunk: string): HostReadiness | undefined
  /**
   * Finish the stream and require a readiness line.
   * @returns The parsed loopback readiness.
   */
  finalize(): HostReadiness
}

/**
 * Assert and normalize one readiness line.
 *
 * The Host prints the readiness URL before any informational line sharing the
 * same prefix, and the supervisor stops reading once this returns, so a later
 * line can never be mistaken for the address.
 * @param line - One complete stdout line, without its terminator.
 * @returns The loopback readiness, or undefined for an unrelated line.
 */
function parseReadinessLine(line: string): HostReadiness | undefined {
  if (!line.startsWith(READINESS_PREFIX)) return undefined
  const token = line.slice(READINESS_PREFIX.length).split(/\s/u, 1)[0]
  if (token === undefined) throw new Error(`desktop Host readiness line has no URL: ${line}`)

  let url: URL
  try {
    url = new URL(token)
  } catch {
    throw new Error(`desktop Host readiness URL is invalid: ${token}`)
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.pathname !== '/'
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535) {
    throw new Error(`desktop Host readiness URL must be loopback HTTP with an explicit port: ${token}`)
  }

  const params = [...url.searchParams.keys()]
  if (params.length === 0) return { origin: url.origin }
  if (params.length > 1 || params[0] !== 'token') {
    throw new Error(`desktop Host readiness URL carries unexpected query parameters: ${params.join(', ')}`)
  }
  const launchToken = url.searchParams.get('token') ?? ''
  if (!LAUNCH_TOKEN_PATTERN.test(launchToken)) {
    throw new Error('desktop Host readiness URL carries a malformed launch token')
  }
  return { origin: url.origin, token: launchToken }
}

/**
 * Create a line parser whose result is stable after readiness.
 * @returns A fresh incremental parser.
 */
export function createReadinessParser(): ReadinessParser {
  let pending = ''
  let ready: HostReadiness | undefined

  const sameReadiness = (left: HostReadiness, right: HostReadiness): boolean =>
    left.origin === right.origin && left.token === right.token

  const accept = (line: string): HostReadiness | undefined => {
    const parsed = parseReadinessLine(line.replace(/\r$/u, ''))
    if (parsed === undefined) return undefined
    if (ready !== undefined && !sameReadiness(ready, parsed)) {
      throw new Error(`desktop Host emitted conflicting readiness URLs: ${ready.origin} and ${parsed.origin}`)
    }
    ready = parsed
    return ready
  }

  return {
    push(chunk) {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline === -1) return ready
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const parsed = accept(line)
        if (parsed !== undefined) return parsed
      }
    },
    finalize() {
      if (pending !== '') accept(pending)
      if (ready === undefined) throw new Error('desktop Host exited before emitting its readiness URL')
      return ready
    },
  }
}

/** Child process operations the supervisor owns. */
export interface HostChild {
  readonly pid?: number
  readonly stdout: { onData(listener: (chunk: string) => void): () => void }
  readonly stderr: { onData(listener: (chunk: string) => void): () => void }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Configuration and platform operations for one Host supervisor. */
export interface HostSupervisorOptions {
  /** Spawn one Host process. */
  readonly spawnHost: () => HostChild
  /** Maximum startup time before the Host is terminated. */
  readonly readinessTimeoutMs?: number
  /** Grace after SIGTERM before SIGKILL. */
  readonly shutdownTimeoutMs?: number
  /** Receives bounded Host output for desktop diagnostics. */
  readonly log?: (line: string) => void
  /** Called when a ready Host exits outside an application-owned shutdown. */
  readonly onUnexpectedExit?: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void
}

/** Handle for the desktop-owned Host process. */
export interface HostSupervisor {
  /** Start once, or join the in-flight start. */
  start(): Promise<HostReadiness>
  /** Subscribe to a ready Host exiting outside owned shutdown. */
  onUnexpectedExit(listener: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void
  /** Gracefully stop once, escalating after the configured timeout. */
  shutdown(): Promise<void>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/**
 * Create a single-owner Host supervisor.
 * @param options - Child-process operations and bounded lifecycle timings.
 * @returns A supervisor that coalesces concurrent start and shutdown calls.
 */
export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let child: HostChild | undefined
  let startPromise: Promise<HostReadiness> | undefined
  let shutdownPromise: Promise<void> | undefined
  let exited: Promise<void> | undefined
  let exitResult: Deferred<void> | undefined
  let ready = false
  let shuttingDown = false
  let output = ''
  const unexpectedExitListeners = new Set<NonNullable<HostSupervisorOptions['onUnexpectedExit']>>()
  if (options.onUnexpectedExit !== undefined) unexpectedExitListeners.add(options.onUnexpectedExit)

  const reportUnexpectedExit = (detail: { code: number | null; signal: NodeJS.Signals | null }): void => {
    for (const listener of unexpectedExitListeners) {
      try {
        listener(detail)
      } catch (error) {
        console.error('desktop Host exit listener failed:', error)
      }
    }
  }

  const appendOutput = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-MAX_STARTUP_OUTPUT_CHARS)
    options.log?.(chunk)
  }

  const start = (): Promise<HostReadiness> => {
    if (startPromise !== undefined) return startPromise
    if (shutdownPromise !== undefined) return Promise.reject(new Error('desktop Host cannot start after shutdown'))

    startPromise = new Promise<HostReadiness>((resolve, reject) => {
      const parser = createReadinessParser()
      const spawned = options.spawnHost()
      child = spawned
      exitResult = deferred<void>()
      exited = exitResult.promise
      let settled = false
      const startupCleanups: Array<() => void> = []

      const cleanupStartup = (): void => {
        clearTimeout(timer)
        for (const dispose of startupCleanups.splice(0)) dispose()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanupStartup()
        const diagnostic = output === '' ? '' : `\nHost output:\n${output}`
        reject(new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic}`))
      }
      const acceptChunk = (chunk: string): void => {
        appendOutput(chunk)
        try {
          const readiness = parser.push(chunk)
          if (readiness === undefined || settled) return
          settled = true
          ready = true
          cleanupStartup()
          resolve(readiness)
        } catch (error) {
          fail(error)
          spawned.kill('SIGTERM')
        }
      }

      const timer = setTimeout(() => {
        fail(new Error(`desktop Host readiness timed out after ${String(readinessTimeoutMs)}ms`))
        spawned.kill('SIGTERM')
      }, readinessTimeoutMs)
      startupCleanups.push(spawned.stdout.onData(acceptChunk))
      startupCleanups.push(spawned.stderr.onData(appendOutput))
      spawned.onError((error) => {
        fail(new Error(`desktop Host failed to spawn: ${error.message}`))
        exitResult?.resolve()
      })
      spawned.onExit((code, signal) => {
        exitResult?.resolve()
        if (ready) {
          if (!shuttingDown) reportUnexpectedExit({ code, signal })
          return
        }
        fail(new Error(`desktop Host exited before readiness (code ${String(code)}, signal ${String(signal)})`))
      })
    })
    return startPromise
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      shuttingDown = true
      unexpectedExitListeners.clear()
      const spawned = child
      if (spawned === undefined) return
      spawned.kill('SIGTERM')
      const closed = exited ?? Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, shutdownTimeoutMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === 'timeout') {
        spawned.kill('SIGKILL')
        await closed
      }
    })()
    return shutdownPromise
  }

  const onUnexpectedExit: HostSupervisor['onUnexpectedExit'] = (listener) => {
    if (shuttingDown) return () => undefined
    unexpectedExitListeners.add(listener)
    return () => { unexpectedExitListeners.delete(listener) }
  }

  return { start, onUnexpectedExit, shutdown }
}

/** Options for the real `dsh web` child. */
export interface SpawnDshWebOptions {
  /** Node-compatible executable selected by the desktop app. */
  readonly nodeExecutable: string
  /** Built dsh CLI entry. */
  readonly cliEntry: string
  /** Working directory inherited by user-created sessions and tools. */
  readonly cwd: string
  /** Frozen environment for the Host process. */
  readonly env: NodeJS.ProcessEnv
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode?: boolean
  /**
   * Pass `--no-open` so the Host does not hand its Web UI to the user's default
   * browser. Only set it for a Harness version that registers the option: a
   * version without browser handoff rejects the unknown flag as a usage error.
   */
  readonly suppressBrowserHandoff?: boolean
}

function streamAdapter(stream: NodeJS.ReadableStream): HostChild['stdout'] {
  return {
    onData(listener) {
      const accept = (chunk: string | Buffer): void => { listener(chunk.toString()) }
      stream.on('data', accept)
      return () => { stream.off('data', accept) }
    },
  }
}

/**
 * Spawn the production Web Host on an OS-assigned loopback port.
 * @param options - Node runtime, built CLI and process environment.
 * @returns The child handle consumed by {@link createHostSupervisor}.
 */
export function spawnDshWeb(options: SpawnDshWebOptions): HostChild {
  const env = options.electronRunAsNode
    ? { ...options.env, ELECTRON_RUN_AS_NODE: '1' }
    : options.env
  const args = [
    '--expose-internals', options.cliEntry, 'web', '--host', '127.0.0.1', '--port', '0',
    ...(options.suppressBrowserHandoff === true ? ['--no-open'] : []),
  ]
  const process = spawn(options.nodeExecutable, args, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return nodeChildAdapter(process)
}

/** Adapt Node's event overloads to the supervisor's explicit ownership API. */
function nodeChildAdapter(child: ChildProcessByStdio<null, Readable, Readable>): HostChild {
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: streamAdapter(child.stdout),
    stderr: streamAdapter(child.stderr),
    onExit(listener) {
      child.on('exit', listener)
      return () => { child.off('exit', listener) }
    },
    onError(listener) {
      child.on('error', listener)
      return () => { child.off('error', listener) }
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}
