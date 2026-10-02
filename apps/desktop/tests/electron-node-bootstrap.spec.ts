import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { electronNodeBootstrapArgument } from '../src/electron-node-bootstrap.ts'

const run = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..')
const electron = process.platform === 'darwin'
  ? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : join(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

describe('Electron Node startup scope', () => {
  it('clears ambient mode and keeps self-spawn, synchronous, promisified and forked Node children working', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-node-scope-'))
    try {
      const child = join(root, 'child.cjs')
      await writeFile(child, 'process.send({ node: Boolean(process.versions.electron), mode: process.env.ELECTRON_RUN_AS_NODE ?? null });process.disconnect()\n')
      const program = String.raw`
        const cp = require('node:child_process');
        const { promisify } = require('node:util');
        const script = 'console.log(JSON.stringify({node:Boolean(process.versions.electron),mode:process.env.ELECTRON_RUN_AS_NODE??null}))';
        (async () => {
          console.log(process.env.ELECTRON_RUN_AS_NODE ?? 'unset');
          console.log(cp.spawnSync(process.execPath, ['-e', script], { env: { DSH_SUBPROCESS_RUNNER: 'windows' } }).stdout.toString().trim());
          console.log(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
          console.log((await promisify(cp.execFile)(process.execPath, ['-e', script])).stdout.trim());
          await new Promise((resolve, reject) => {
            const child = cp.fork(process.argv[1], { execArgv: [], env: {} });
            child.on('error', reject);
            child.on('message', message => console.log(JSON.stringify(message)));
            child.on('exit', code => code === 0 ? resolve() : reject(new Error('fork exit ' + code)));
          });
          const nested = 'const cp=require("node:child_process");console.log(cp.spawnSync(process.execPath,["-e",'+JSON.stringify(script)+']).stdout.toString().trim())';
          console.log(cp.spawnSync(process.execPath, ['-e', nested]).stdout.toString().trim());
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `
      const result = await run(electron, [electronNodeBootstrapArgument(), '-e', program, child], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, timeout: 15_000,
      })
      expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
        'unset', ...Array.from({ length: 5 }, () => '{"node":true,"mode":null}'),
      ])
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 20_000)

  it.skipIf(process.platform === 'win32')('lets an external Electron development command start in application mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-electron-task-'))
    try {
      const external = join(root, 'project-electron')
      await symlink(electron, external)
      const project = join(root, 'project.cjs')
      await writeFile(project, 'const {app}=require("electron");app.whenReady().then(()=>{console.log("electron-project-gui");app.quit()})\n')
      const program = 'require("node:child_process").execFile(process.argv[1],[process.argv[2]],(error,stdout)=>{if(error)throw error;console.log(stdout.trim())})'
      const result = await run(electron, [electronNodeBootstrapArgument(), '-e', program, external, project], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, timeout: 15_000,
      })
      expect(result.stdout.trim()).toBe('electron-project-gui')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 20_000)
})
