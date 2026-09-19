/** The bounded child-process primitive managed Harness transactions run on. */

import { describe, expect, it } from 'vitest'
import {
  KILL_GRACE_MS,
  managedProcessEnvironment,
  runManagedProcess,
  type ManagedProcessOutcome,
  type ManagedProcessRequest,
} from '../src/managed-harness-process.ts'

/**
 * A child that outlives its test would be orphaned by a failing assertion, so
 * every long-lived script here exits on its own well before the suite ends.
 */
const SELF_LIMIT_MS = 30_000

/** Whether one process identifier still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A foreign process would answer with a permission error, not an absence one.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Run one disposable child of this test's own Node runtime. */
function run(script: string, input: Partial<Pick<ManagedProcessRequest, 'timeoutMs' | 'signal'>> = {}): Promise<ManagedProcessOutcome> {
  return runManagedProcess({
    command: process.execPath,
    args: ['-e', `process.stdout.write(String(process.pid) + "\\n");${script}`],
    env: managedProcessEnvironment(),
    timeoutMs: input.timeoutMs ?? SELF_LIMIT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

/** Read the process identifier a child reported as its first output. */
function childPid(outcome: ManagedProcessOutcome): number {
  const pid = Number(outcome.output.trim().split(/\s+/u)[0])
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
  return pid
}

describe('managed Harness child process runner', () => {
  it('runs a child to completion when nothing abandons it', async () => {
    const outcome = await run('console.log("done")')

    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
    expect(outcome.output).toContain('done')
    expect(alive(childPid(outcome))).toBe(false)
  })

  it('abandons a running child on abort and leaves nothing alive', async () => {
    const controller = new AbortController()
    const pending = run(`setTimeout(() => {}, ${String(SELF_LIMIT_MS)});`, { signal: controller.signal })
    await new Promise((resolve) => { setTimeout(resolve, 250) })

    controller.abort()
    const outcome = await pending

    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).not.toBeNull()
    expect(alive(childPid(outcome))).toBe(false)
  })

  it('never escalates a child that honors SIGTERM', async () => {
    const controller = new AbortController()
    const pending = run(
      'process.on("SIGTERM", () => { console.log("graceful"); process.exit(0) });'
      + `setTimeout(() => {}, ${String(SELF_LIMIT_MS)});`,
      { signal: controller.signal },
    )
    await new Promise((resolve) => { setTimeout(resolve, 250) })

    controller.abort()
    const outcome = await pending

    // The handler's own line and a voluntary exit are the proof: a killed child
    // can print neither.
    expect(outcome.output).toContain('graceful')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
    expect(alive(childPid(outcome))).toBe(false)
  })

  it('escalates to SIGKILL one grace period after an ignored SIGTERM', { timeout: 40_000 }, async () => {
    const controller = new AbortController()
    const pending = run(
      'process.on("SIGTERM", () => { console.log("ignored"); });'
      + `setTimeout(() => {}, ${String(SELF_LIMIT_MS)});`,
      { signal: controller.signal },
    )
    await new Promise((resolve) => { setTimeout(resolve, 250) })

    const started = Date.now()
    controller.abort()
    const outcome = await pending

    expect(outcome.output).toContain('ignored')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe('SIGKILL')
    // A lower bound on real elapsed time: the child cannot be gone before the
    // grace period it was given to leave on its own.
    expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MS)
    expect(alive(childPid(outcome))).toBe(false)
  })

  it('terminates a stalled child at its own bound without any abort', async () => {
    const started = Date.now()
    const outcome = await run(`setTimeout(() => {}, ${String(SELF_LIMIT_MS)});`, { timeoutMs: 1_000 })

    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe('SIGTERM')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(alive(childPid(outcome))).toBe(false)
  })
})
