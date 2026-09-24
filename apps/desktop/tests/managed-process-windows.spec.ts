import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedProcessEnvironment, parentBoundEnvironment } from '../src/managed-harness-process.ts'

describe('Windows managed process environment', () => {
  it.runIf(process.platform === 'win32')('retains Windows OS locations but excludes ambient secrets and Node paths', () => {
    vi.stubEnv('DSH_TEST_SECRET', 'must-not-inherit')
    try {
      const env = managedProcessEnvironment()
      expect(env.SystemRoot).toBe(process.env.SystemRoot)
      expect(env.TEMP).toBe(process.env.TEMP)
      expect(env.DSH_TEST_SECRET).toBeUndefined()
      expect(env.PATH).toBe(`${process.env.SystemRoot}\\system32`)
    } finally { vi.unstubAllEnvs() }
  })
  it.runIf(process.platform === 'win32')('terminates its child after the parent exits', async () => {
    const script = `const {spawn}=require('node:child_process'); const env=(${parentBoundEnvironment.toString()})({}); const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{console.log(child.pid);child.disconnect();process.exit(0)});`
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { windowsHide: true, timeout: 10_000 })
    const pid = Number(stdout.trim())
    const alive = (): boolean => {
      try { process.kill(pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    try { await expect.poll(alive, { timeout: 7_000 }).toBe(false) }
    finally { if (alive()) process.kill(pid) }
  }, 20_000)
})
