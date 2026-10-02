/** Bounded POSIX login-shell discovery; only exported development paths leave the probe. */

import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { DEVELOPMENT_PATH_VARIABLES, isHarnessStartupVariable } from './harness-host-environment.ts'

/** Framing separates rc-file chatter from the NUL-delimited environment. */
export const LOGIN_SHELL_MARKER = '_DSH_DEVELOPMENT_ENVIRONMENT_'
const FRAME = `\0${LOGIN_SHELL_MARKER}\0`
const DUMP = `printf '\\0%s\\0' '${LOGIN_SHELL_MARKER}'; /usr/bin/env -0 || exit; printf '\\0%s\\0' '${LOGIN_SHELL_MARKER}'; exit`
const PROBE_ENV = { DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true', ZSH_TMUX_AUTOSTART: 'false' }
const MAX_OUTPUT_BYTES = 1_048_576

/** Discovery outcome, containing no credentials or complete shell environment. */
export interface DevelopmentDiscovery {
  readonly environment: NodeJS.ProcessEnv
  readonly failures: readonly { readonly shell: string; readonly reason: string }[]
}

/** Bounded discovery settings; callers normally supply only cancellation. */
export interface LoginShellDiscoveryOptions {
  readonly platform?: NodeJS.Platform
  readonly shells?: readonly string[]
  /** Total budget across candidates, default 10 seconds. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * Extract only PATH and approved SDK variables from a complete framed dump.
 * @param stdout - NUL-delimited stdout, possibly surrounded by rc-file chatter.
 * @returns Development paths, or undefined for malformed/unframed output.
 */
export function parseDevelopmentEnvironment(stdout: string): NodeJS.ProcessEnv | undefined {
  const first = stdout.indexOf(FRAME)
  if (first === -1) return undefined
  const start = first + FRAME.length
  const last = stdout.indexOf(FRAME, start)
  if (last === -1) return undefined
  const entries = stdout.slice(start, last).split('\0').filter(entry => entry !== '')
  const allowed = new Set<string>(['PATH', ...DEVELOPMENT_PATH_VARIABLES])
  const result: NodeJS.ProcessEnv = {}
  for (const entry of entries) {
    const equal = entry.indexOf('=')
    if (equal < 1) return undefined
    const key = entry.slice(0, equal)
    if (allowed.has(key)) result[key] = entry.slice(equal + 1)
  }
  return result
}

function candidates(): readonly string[] {
  let account: string | null = null
  try { account = userInfo().shell } catch { /* Fixed shells work when the account record is unavailable. */ }
  return [...new Set([...account ? [account] : [], '/bin/zsh', '/bin/bash', '/bin/sh'])]
}

function readShell(shell: string, base: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<NodeJS.ProcessEnv | string> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve('aborted'); return }
    const env = Object.fromEntries(Object.entries(base).filter(([name]) => !isHarnessStartupVariable(name)))
    const child = spawn(shell, ['-ilc', DUMP], {
      cwd: homedir(), env: { ...env, ...PROBE_ENV }, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
    })
    let settled = false
    let bytes = 0
    const chunks: Buffer[] = []
    const killGroup = (): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* An exited probe has no remaining process group. */ }
    }
    const finish = (result: NodeJS.ProcessEnv | string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      child.stdout.removeAllListeners('data')
      child.stdout.destroy()
      killGroup()
      resolve(result)
    }
    const abort = (): void => { finish('aborted') }
    const timer = setTimeout(() => { finish('timeout') }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) { finish('output-limit'); return }
      chunks.push(chunk)
      const output = Buffer.concat(chunks).toString('utf8')
      if (output.indexOf(FRAME, output.indexOf(FRAME) + FRAME.length) !== -1 && output.includes(FRAME)) {
        finish(parseDevelopmentEnvironment(output) ?? 'malformed')
      }
    })
    child.once('error', () => { finish('spawn-failed') })
    child.once('close', (code) => {
      finish(code === 0 ? parseDevelopmentEnvironment(Buffer.concat(chunks).toString('utf8')) ?? 'unparsed' : `exit ${String(code)}`)
    })
  })
}

/**
 * Discover exported development paths once, falling back to the inherited environment on failure.
 * Windows uses its inherited environment without running a POSIX shell. No global env is changed.
 * @param base - Desktop inherited environment.
 * @param options - Total timeout, cancellation, and platform/candidate overrides for tests.
 * @returns Filtered discovery and bounded failure categories; never raw shell output.
 */
export async function discoverDevelopmentEnvironment(
  base: NodeJS.ProcessEnv, options: LoginShellDiscoveryOptions = {},
): Promise<DevelopmentDiscovery> {
  if ((options.platform ?? process.platform) === 'win32') return { environment: {}, failures: [] }
  const budget = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 2_147_483_647) throw new Error('Invalid login-shell discovery timeout')
  const deadline = Date.now() + budget
  const failures: Array<{ shell: string; reason: string }> = []
  for (const shell of options.shells ?? candidates()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = await readShell(shell, base, remaining, options.signal)
    if (typeof result !== 'string') return { environment: result, failures }
    failures.push({ shell, reason: result })
    if (result === 'aborted' || result === 'timeout') break
  }
  return { environment: {}, failures }
}
