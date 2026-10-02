import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { assertDevelopmentToolLaunchers, developmentLauncherOptions, developmentLauncherScripts, placeDevelopmentToolLaunchers } from '../src/development-tool-launchers.ts'
import { harnessHostEnvironment } from '../src/harness-host-environment.ts'

const run = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh development tools-'))
  roots.push(root)
  return root
}
const electron = process.platform === 'darwin'
  ? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

describe('Desktop development commands', () => {
  it('renders Windows shell commands with explicit Node mode and bundled npm/npx paths', () => {
    const scripts = developmentLauncherScripts({ directory: '/app/resources/development-bin', executable: '/app/DeepSeek Desktop.exe',
      npmCliEntry: '/app/resources/npm/bin/npm-cli.js', npxCliEntry: '/app/resources/npm/bin/npx-cli.js', platform: 'win32' })
    expect(Object.keys(scripts)).toEqual(['node.cmd', 'npm.cmd', 'npx.cmd'])
    expect(scripts['node.cmd']).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(scripts['node.cmd']).toContain('"%~dp0..\\..\\DeepSeek Desktop.exe" "--import=data:text/javascript;base64,')
    expect(scripts['npm.cmd']).toContain('"%~dp0..\\npm\\bin\\npm-cli.js" %*')
    expect(scripts['npx.cmd']).toContain('"%~dp0..\\npm\\bin\\npx-cli.js" %*')
    expect(scripts['node.cmd']).toContain('DisableDelayedExpansion')
    expect(scripts['node.cmd']).toContain('exit /b %errorlevel%')
  })

  it.skipIf(process.platform === 'win32')('runs fallback Node and npm lifecycle scripts without a local Node', async () => {
    const root = await directory()
    const bin = join(root, 'bin')
    const options = developmentLauncherOptions(bin, electron, join(desktop, 'runtime-npm/npm'))
    await placeDevelopmentToolLaunchers(options)
    await assertDevelopmentToolLaunchers(options)
    await symlink('/bin/sh', join(bin, 'sh'))
    const env = harnessHostEnvironment({ HOME: root, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /absent', NODE_PATH: '/absent' },
      {}, bin, {})
    // Omit OS development tools so the fixture also proves absence on Linux hosts with /usr/bin/node.
    env.PATH = bin
    const output = await run('/bin/sh', ['-c', 'command -v node; node -p "Boolean(process.versions.electron)"; npm --version; npx --version'], { env, cwd: root })
    expect(output.stdout.trim().split('\n')).toEqual([join(bin, 'node'), 'true', '11.12.1', '11.12.1'])
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'printf "%s\\n" "${ELECTRON_RUN_AS_NODE-unset}"; node -p "Boolean(process.versions.electron)"; node -p "process.env.ELECTRON_RUN_AS_NODE || \'unset\'"' } }))
    await writeFile(join(root, '.npmrc'), 'registry=https://project-registry.invalid/\n')
    expect((await run('/bin/sh', ['-c', 'npm --silent run verify; npm config get registry'], { env, cwd: root })).stdout.trim())
      .toBe('unset\ntrue\nunset\nhttps://project-registry.invalid/')
    expect((await run(join(bin, 'node'), ['-p', 'process.env.ELECTRON_RUN_AS_NODE || "unset"'], { env, cwd: root })).stdout.trim()).toBe('unset')
    const npxPackage = join(root, 'npx-package')
    await mkdir(npxPackage)
    await writeFile(join(npxPackage, 'package.json'), JSON.stringify({ name: 'npx-scope-fixture', version: '1.0.0', bin: { 'npx-scope': 'cli.js' } }))
    await writeFile(join(npxPackage, 'cli.js'), '#!/usr/bin/env node\nconsole.log(process.env.ELECTRON_RUN_AS_NODE || "npx-unset")\n', { mode: 0o755 })
    expect((await run(join(bin, 'npx'), ['--yes', '--offline', `--package=${npxPackage}`, 'npx-scope'], { env, cwd: root })).stdout.trim()).toBe('npx-unset')
    const argument = "中文 spaces ' quotes $ ` ;"
    expect((await run(join(bin, 'node'), ['-e', 'console.log(process.argv[1]);process.exit(7)', argument], { env, cwd: root }).catch((error: unknown) => error as { code: number; stdout: string })))
      .toMatchObject({ code: 7, stdout: `${argument}\n` })
    await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n')
    await expect(assertDevelopmentToolLaunchers(options)).rejects.toThrow('stale')
  }, 20_000)

  it.skipIf(process.platform === 'win32')('uses local Node with fallback npm/npx and keeps installs in the project or user home', async () => {
    const root = await directory()
    const userBin = join(root, 'user-bin')
    const bin = join(root, 'fallback')
    await mkdir(userBin)
    await symlink(process.execPath, join(userBin, 'node'))
    await symlink('/bin/sh', join(userBin, 'sh'))
    await placeDevelopmentToolLaunchers(developmentLauncherOptions(bin, electron, join(desktop, 'runtime-npm/npm')))
    const env = harnessHostEnvironment({ HOME: root }, { PATH: userBin }, bin, {})
    expect(env.PATH?.split(':')).toContain(join(root, '.local/bin'))
    env.PATH = `${userBin}:${join(root, '.local/bin')}:${bin}`
    const result = await run('/bin/sh', ['-c', 'command -v node; command -v npm; command -v npx; node -p "Boolean(process.versions.electron)"; npm --version; npx --version'], { env, cwd: root })
    expect(result.stdout.trim().split('\n')).toEqual([join(userBin, 'node'), join(bin, 'npm'), join(bin, 'npx'), 'false', '11.12.1', '11.12.1'])
    await writeFile(join(root, 'global-command.js'), '#!/usr/bin/env node\nconsole.log("installed-global-cli")\n', { mode: 0o755 })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fallback-prefix-fixture', version: '1.0.0', bin: { 'hybrid-global-cli': 'global-command.js' }, scripts: { verify: 'node -p "Boolean(process.versions.electron)"' } }))
    expect((await run(join(bin, 'npm'), ['--silent', 'run', 'verify'], { env, cwd: root })).stdout.trim()).toBe('false')
    expect((await run(join(bin, 'npm'), ['config', 'get', 'prefix'], { env, cwd: root })).stdout.trim()).toBe(join(root, '.local'))
    await run(join(bin, 'npm'), ['install', '--global', root, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { env, cwd: root })
    await access(join(root, '.local/lib/node_modules/fallback-prefix-fixture'))
    expect((await run('/bin/sh', ['-c', 'hybrid-global-cli'], { env, cwd: root })).stdout.trim()).toBe('installed-global-cli')
    const customPrefix = join(root, 'custom-prefix')
    await writeFile(join(root, '.npmrc'), `prefix=${customPrefix}\n`)
    expect((await run(join(bin, 'npm'), ['config', 'get', 'prefix'], { env, cwd: root })).stdout.trim()).toBe(customPrefix)
  }, 20_000)

  it.skipIf(process.platform === 'win32').each(['node', 'npm', 'npx'])('keeps local %s failures visible without retrying the fallback', async (command) => {
    const root = await directory()
    const userBin = join(root, 'user-bin')
    const bin = join(root, 'fallback')
    await mkdir(userBin)
    await writeFile(join(userBin, command), '#!/bin/sh\necho local-command-failed; exit 99\n', { mode: 0o755 })
    await placeDevelopmentToolLaunchers(developmentLauncherOptions(bin, electron, join(desktop, 'runtime-npm/npm')))
    const env = harnessHostEnvironment({ HOME: root, PATH: userBin }, {}, bin, {})
    await expect(run('/bin/sh', ['-c', `${command} --version`], { env, cwd: root }))
      .rejects.toMatchObject({ code: 99, stdout: 'local-command-failed\n' })
  })

  it.skipIf(process.platform === 'win32')('prefers all existing local commands over fallback commands', async () => {
    const root = await directory()
    const userBin = join(root, 'user-bin')
    const bin = join(root, 'fallback')
    await mkdir(userBin)
    for (const command of ['node', 'npm', 'npx']) {
      await writeFile(join(userBin, command), `#!/bin/sh\necho local-${command}\n`, { mode: 0o755 })
    }
    await placeDevelopmentToolLaunchers(developmentLauncherOptions(bin, electron, join(desktop, 'runtime-npm/npm')))
    const env = harnessHostEnvironment({ HOME: root }, { PATH: userBin }, bin, {})
    expect((await run('/bin/sh', ['-c', 'node --version; npm --version; npx --version'], { env, cwd: root })).stdout.trim().split('\n'))
      .toEqual(['local-node', 'local-npm', 'local-npx'])
  })

  it.skipIf(process.platform === 'win32')('keeps package targets valid after relocation without embedding build-machine paths', async () => {
    const root = await directory()
    const original = join(root, 'original')
    await mkdir(join(original, 'resources/npm/bin'), { recursive: true })
    await writeFile(join(original, 'Electron'), '#!/bin/sh\nprintf "%s" "$ELECTRON_RUN_AS_NODE"\n', { mode: 0o755 })
    for (const cli of ['npm-cli.js', 'npx-cli.js']) await writeFile(join(original, 'resources/npm/bin', cli), '')
    const options = developmentLauncherOptions(join(original, 'resources/development-bin'), join(original, 'Electron'), join(original, 'resources/npm'))
    await placeDevelopmentToolLaunchers(options)
    const relocated = join(root, "relocated ' app")
    await cp(original, relocated, { recursive: true })
    const node = join(relocated, 'resources/development-bin/node')
    await access(node)
    expect(await readFile(node, 'utf8')).not.toContain(original)
    expect((await run(node, [], { env: { PATH: '/usr/bin:/bin' } })).stdout).toBe('1')
  })

  it.runIf(process.platform === 'win32')('runs Windows shell commands against Electron without system Node', async () => {
    const root = await directory()
    const options = developmentLauncherOptions(join(root, 'bin'), electron, join(desktop, 'runtime-npm/npm'))
    await placeDevelopmentToolLaunchers(options)
    const env = harnessHostEnvironment(process.env, {}, options.directory, {})
    env.PATH = options.directory
    const output = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'node -p "Boolean(process.versions.electron)" && npm --version && npx --version'], { env, cwd: root })
    expect(output.stdout.trim().split(/\r?\n/u)).toEqual(['true', '11.12.1', '11.12.1'])
  }, 20_000)
})
