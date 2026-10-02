import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { developmentLauncherOptions, placeDevelopmentToolLaunchers } from '../src/development-tool-launchers.ts'
import { harnessHostEnvironment } from '../src/harness-host-environment.ts'
import { createHostSupervisor, spawnDshWeb } from '../src/host-supervisor.ts'
import { parentBoundEnvironment } from '../src/managed-harness-process.ts'

describe.skipIf(process.platform === 'win32')('assembled desktop Host task environment', () => {
  it('runs a keyless task transcript through Electron, Harness shell and subprocess providers', async () => {
    const desktop = resolve(import.meta.dirname, '..')
    const root = await mkdtemp(join(tmpdir(), 'dsh-hybrid-transcript-'))
    const userBin = join(root, 'user-bin')
    await mkdir(userBin)
    await writeFile(join(userBin, 'git'), '#!/bin/sh\necho user-development-git\n', { mode: 0o755 })
    await symlink(process.execPath, join(userBin, 'node'))
    await symlink('/bin/bash', join(userBin, 'bash'))
    await symlink('/bin/sh', join(userBin, 'sh'))
    await writeFile(join(root, '.npmrc'), 'registry=https://project-registry.invalid/\n')
    const electron = process.platform === 'darwin'
      ? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : join(desktop, 'node_modules/electron/dist/electron')
    const bin = join(root, 'bin')
    const before = { ...process.env }
    const env = harnessHostEnvironment({ HOME: root, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /missing.cjs', NODE_PATH: '/bad' },
      { PATH: userBin }, bin, { DSH_DESKTOP: '1', DSH_DESKTOP_API_TOKEN: 'fixture' })
    env.PATH = `${userBin}:${bin}`
    let output = ''
    const supervisor = createHostSupervisor({
      spawnHost: () => {
        const child = spawnDshWeb({ nodeExecutable: electron, cliEntry: join(desktop, 'tests/fixtures/hybrid-environment.mjs'),
          cwd: root, env: parentBoundEnvironment(env), electronRunAsNode: true })
        child.stdout.onData((chunk) => { output += chunk })
        return child
      },
    })
    try {
      await placeDevelopmentToolLaunchers(developmentLauncherOptions(bin, electron, join(desktop, 'runtime-npm/npm')))
      await supervisor.start()
      await vi.waitFor(() => { expect(output).toContain('task-transcript:') }, { timeout: 15_000 })
      expect(output).toContain('host-electron-runtime:true')
      expect(output).toContain('host-node-mode:unset')
      const line = output.split('\n').find(value => value.startsWith('task-transcript:'))!
      expect(JSON.parse(line.slice('task-transcript:'.length))).toMatchInlineSnapshot(`
        {
          "exitCode": 0,
          "stdout": [
            "false",
            "task-unset",
            "11.12.1",
            "11.12.1",
            "user-development-git",
            "https://project-registry.invalid/",
          ],
        }
      `)
      expect(process.env).toEqual(before)
    } finally {
      await supervisor.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }, 25_000)
})
