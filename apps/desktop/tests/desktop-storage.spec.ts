import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopStoragePaths, preserveDesktopPreferences } from '../src/desktop-storage.ts'
import { loadDesktopState } from '../src/desktop-state.ts'

describe('desktop program storage', () => {
  it('separates Windows program writes from browser user data and preserves other platforms', () => {
    const input = { userData: join('profile', 'browser'), home: 'home', explicitUserData: false }
    expect(desktopStoragePaths({ ...input, platform: 'win32' }).programRoot).toBe(join('home', '.deepseek-desktop'))
    expect(desktopStoragePaths({ ...input, platform: 'darwin' }).programRoot).toBe(input.userData)
  })
  it('keeps explicitly selected Windows profiles isolated from each other and the default home', () => {
    for (const userData of ['profile-one', 'profile-two']) {
      expect(desktopStoragePaths({ platform: 'win32', home: 'home', userData, explicitUserData: true }).programRoot).toBe(userData)
    }
  })
  it('imports only validated preferences once and never overwrites the selected new state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-storage-'))
    const oldState = join(root, 'old', 'desktop-state.json')
    const newState = join(root, 'new', 'desktop-state.json')
    try {
      await mkdir(join(root, 'old'))
      await writeFile(oldState, '{"version":2,"mode":"chat","theme":"dark","locale":"en-US","extra":"not a preference"}')
      await preserveDesktopPreferences(oldState, newState)
      expect(await loadDesktopState(newState)).toEqual({ mode: 'chat', theme: 'dark', locale: 'en-US' })
      await writeFile(oldState, '{"version":2,"mode":"harness"}')
      await preserveDesktopPreferences(oldState, newState)
      expect((await loadDesktopState(newState)).mode).toBe('chat')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
