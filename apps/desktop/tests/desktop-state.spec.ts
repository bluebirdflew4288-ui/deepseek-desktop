import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDesktopState, saveDesktopState } from '../src/desktop-state.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function stateFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-state-'))
  roots.push(root)
  await mkdir(join(root, 'nested'))
  return join(root, 'nested', 'desktop-state.json')
}

describe('desktop state persistence', () => {
  it('defaults a missing file to Harness with no preferences chosen', async () => {
    await expect(loadDesktopState(await stateFile())).resolves.toEqual({ mode: 'harness' })
  })

  it('round-trips the complete state with owner-only permissions', async () => {
    const filename = await stateFile()
    await saveDesktopState(filename, { mode: 'chat', theme: 'dark', locale: 'zh-CN' })
    expect(await readFile(filename, 'utf8')).toBe('{"version":2,"mode":"chat","theme":"dark","locale":"zh-CN"}\n')
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'chat', theme: 'dark', locale: 'zh-CN' })
  })

  it('omits a preference the user has not chosen rather than persisting a default', async () => {
    const filename = await stateFile()
    await saveDesktopState(filename, { mode: 'harness' })
    expect(await readFile(filename, 'utf8')).toBe('{"version":2,"mode":"harness"}\n')
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'harness' })
  })

  it('migrates a version 1 document without losing the mode', async () => {
    const filename = await stateFile()
    await writeFile(filename, '{"version":1,"mode":"chat"}\n')
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'chat' })
    // The next write carries the new version, still with no invented preference.
    await saveDesktopState(filename, await loadDesktopState(filename))
    expect(await readFile(filename, 'utf8')).toBe('{"version":2,"mode":"chat"}\n')
  })

  it('keeps a migrated preference set once the user chooses', async () => {
    const filename = await stateFile()
    await writeFile(filename, '{"version":1,"mode":"chat"}\n')
    const migrated = await loadDesktopState(filename)
    await saveDesktopState(filename, { ...migrated, theme: 'light', locale: 'en-US' })
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'chat', theme: 'light', locale: 'en-US' })
  })

  it('drops an unrecognized preference instead of failing the load', async () => {
    const filename = await stateFile()
    await writeFile(filename, '{"version":2,"mode":"chat","theme":"neon","locale":"fr-FR"}\n')
    // A stale theme must not cost the user their selected mode.
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'chat' })
  })

  it('keeps one valid preference beside one invalid one', async () => {
    const filename = await stateFile()
    await writeFile(filename, '{"version":2,"mode":"harness","theme":"dark","locale":"fr-FR"}\n')
    await expect(loadDesktopState(filename)).resolves.toEqual({ mode: 'harness', theme: 'dark' })
  })

  it('rejects malformed or unknown durable state', async () => {
    const filename = await stateFile()
    for (const content of ['{', '{"version":2}', '{"version":3,"mode":"chat"}', '{"version":2,"mode":"shell"}', '[]']) {
      await writeFile(filename, `${content}\n`)
      await expect(loadDesktopState(filename), content).rejects.toThrow('desktop state is invalid')
    }
  })
})
