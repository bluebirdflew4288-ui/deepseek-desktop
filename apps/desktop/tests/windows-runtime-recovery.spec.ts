import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedHarnessRuntime } from '../src/managed-harness.ts'
import type { ManagedProcessRunner } from '../src/managed-harness-process.ts'
import { assertWindowsRuntimeIdle } from '../src/windows-runtime-recovery.ts'

describe('Windows runtime recovery', () => {
  it.each([1, 2])('blocks every mutation after recovery probe exit %s until recovery succeeds', async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), 'windows-recovery-'))
    const stagedFile = join(root, 'staging', 'keep.txt')
    await mkdir(join(root, 'staging'))
    await writeFile(stagedFile, 'owned by the previous installer')
    const install = vi.fn(async () => ({ exitCode: 1, signal: null, output: '' }))
    const latest = vi.fn(async () => ({ version: '1.0.0' }))
    const run = vi.fn(async () => ({ exitCode, signal: null, output: '' }))
    const runtime = createManagedHarnessRuntime({
      platform: 'win32', root, nodeExecutable: process.execPath, cwd: root,
      releaseSource: { latest }, installer: { install },
      healthCheck: { check: async () => ({ healthy: true }) }, runProcess: run,
    })
    try {
      // Make the live-process deadline expire immediately without slowing this test.
      if (exitCode === 2) vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20_000)
      await expect(runtime.recover()).rejects.toThrow('recovery deferred')
      vi.restoreAllMocks()
      for (const action of ['install', 'update', 'reinstall', 'rollback'] as const) {
        expect((await runtime[action]()).outcome).toBe('failed')
      }
      expect(runtime.launch()).toBeUndefined()
      expect(runtime.status().phase).toBe('failed')
      expect(install).not.toHaveBeenCalled()
      expect(latest).not.toHaveBeenCalled()
      expect(await readFile(stagedFile, 'utf8')).toBe('owned by the previous installer')
      run.mockResolvedValue({ exitCode: 0, signal: null, output: '' })
      await runtime.recover()
      expect(runtime.status().phase).toBe('not-installed')
    } finally {
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('refuses cleanup when process enumeration fails', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, signal: null, output: '' }))
    await expect(assertWindowsRuntimeIdle('C:\\owned', run)).rejects.toThrow('recovery deferred')
  })
  it('waits for a live process to leave without sending a kill command', async () => {
    const run = vi.fn<ManagedProcessRunner>().mockResolvedValueOnce({ exitCode: 2, signal: null, output: '' }).mockResolvedValue({ exitCode: 0, signal: null, output: '' })
    await expect(assertWindowsRuntimeIdle('C:\\owned', run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.every(([request]) => request.command.endsWith('powershell.exe'))).toBe(true)
  })
})
