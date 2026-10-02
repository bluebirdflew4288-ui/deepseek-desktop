import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { assertFixtureImportsResolve } from './electron-fixture-artifacts.ts'

// This smoke consumes the Desktop build and launches its real main entry with an isolated profile.
describe.skipIf(process.platform === 'win32')('source-development Desktop startup', () => {
  it('honors the developer Node override without staged npm or generated fallback commands', async () => {
    const desktop = resolve(import.meta.dirname, '..')
    const root = await mkdtemp(join(tmpdir(), 'dsh-source-development-'))
    const copy = join(root, 'apps/desktop')
    const cli = join(root, 'apps/cli/lib')
    const profile = join(root, 'profile')
    const probe = join(root, 'node-probe.json')
    const selected = join(root, 'selected-node')
    let application: ElectronApplication | undefined
    try {
      assertFixtureImportsResolve(join(desktop, 'lib/main.js'))
      await mkdir(copy, { recursive: true })
      await mkdir(cli, { recursive: true })
      await mkdir(profile)
      await cp(join(desktop, 'lib'), join(copy, 'lib'), { recursive: true })
      await cp(join(desktop, 'resources'), join(copy, 'resources'), { recursive: true })
      await symlink(join(desktop, 'node_modules'), join(copy, 'node_modules'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
      const node = `'${process.execPath.replaceAll("'", "'\\''")}'`
      await writeFile(selected, `#!/bin/sh\nexport SOURCE_SELECTED_NODE=1\nexec ${node} "$@"\n`, { mode: 0o755 })
      await writeFile(join(cli, 'bin.js'), [
        'import { writeFileSync } from "node:fs";',
        'import { createServer } from "node:http";',
        'writeFileSync(process.env.SOURCE_NODE_PROBE, JSON.stringify({ selected: process.env.SOURCE_SELECTED_NODE, electron: Boolean(process.versions.electron), tlsOverride: process.env.NODE_TLS_REJECT_UNAUTHORIZED }));',
        'const server = createServer((_request, response) => response.end("source fixture"));',
        'server.listen(0, "127.0.0.1", () => console.log(`dsh web: http://127.0.0.1:${server.address().port}`));',
        'process.on("SIGTERM", () => server.close());',
        '',
      ].join('\n'))
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ))
      application = await _electron.launch({
        executablePath: process.platform === 'darwin'
          ? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
          : join(desktop, 'node_modules/electron/dist/electron'),
        args: [join(copy, 'lib/main.js'), `--user-data-dir=${profile}`],
        env: { ...env, HOME: root, DSH_HOME: join(root, 'harness-home'), DSH_DESKTOP_NODE_EXECUTABLE: selected,
          SOURCE_NODE_PROBE: probe, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      })
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(probe, 'utf8'))).toEqual({ selected: '1', electron: false })
      }, { timeout: 20_000 })
      expect(existsSync(join(copy, 'runtime-npm'))).toBe(false)
      expect(existsSync(join(copy, '.desktop-build/development-bin'))).toBe(false)
    } finally {
      await application?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)
})
