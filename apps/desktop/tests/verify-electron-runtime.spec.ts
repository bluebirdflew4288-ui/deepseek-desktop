import { describe, expect, it } from 'vitest'
import { verifyElectronRuntime } from '../scripts/verify-electron-runtime.ts'

describe('release Electron runtime verification', () => {
  it('rejects the older runtime even when its probe exits successfully', async () => {
    await expect(verifyElectronRuntime('/packaged/electron', '44.0.0', async () => ({
      exitCode: 0, signal: null, output: '43.4.0\n',
    }))).rejects.toThrow('Electron runtime reports 43.4.0, Desktop requires 44.0.0')
  })

  it('accepts only the exact pin under the isolated Electron Node environment', async () => {
    await verifyElectronRuntime('/packaged/electron', '44.0.0', async (request) => {
      expect(request.command).toBe('/packaged/electron')
      expect(request.args).toEqual(['-p', 'process.versions.electron'])
      expect(request.env.ELECTRON_RUN_AS_NODE).toBe('1')
      return { exitCode: 0, signal: null, output: '44.0.0\n' }
    })
  })

  it.each([
    { exitCode: 1, signal: null, output: '44.0.0' },
    { exitCode: null, signal: 'SIGTERM' as const, output: '44.0.0' },
    { exitCode: 0, signal: null, output: '44.0.0', outputTruncated: true },
  ])('rejects an incomplete probe: %j', async (result) => {
    await expect(verifyElectronRuntime('/packaged/electron', '44.0.0', async () => result))
      .rejects.toThrow('could not execute the runtime probe')
  })
})
