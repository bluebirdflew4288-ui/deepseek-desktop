/**
 * Place and prove the npm runtime inside a packaged application.
 *
 * Electron Builder's resource copy omits a nested `node_modules` under every
 * filter tried, and npm's published tarball keeps its own dependencies there, so a
 * package can hold an npm that is file-present and still cannot resolve itself.
 * The tree is therefore copied verbatim here, and then executed with the packaged
 * Electron binary, which is how the managed Harness installer invokes it.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')

/** Identity the packaged npm runtime must carry. */
export interface NpmRuntimePin {
  readonly name: string
  readonly version: string
  readonly cliEntry: string
  readonly licenseFile: string
}

/**
 * Read the pin the staging script owns.
 * @returns the pinned npm identity.
 */
export async function readNpmRuntimePin(): Promise<NpmRuntimePin> {
  return JSON.parse(await readFile(join(desktopRoot, 'npm-runtime.json'), 'utf8')) as NpmRuntimePin
}

/**
 * Copy the staged npm runtime into the packaged resources verbatim.
 * @param resourcesRoot - the packaged application's resources directory.
 * @param stagedRoot - parent of the staged runtime tree.
 * @returns The pin the copy must satisfy.
 * @throws When the runtime was never staged.
 */
export async function placeNpmRuntime(resourcesRoot: string, stagedRoot: string): Promise<NpmRuntimePin> {
  const pin = await readNpmRuntimePin()
  const source = join(stagedRoot, pin.name)
  await readdir(join(source, 'node_modules')).catch(() => {
    throw new Error(`npm runtime at ${source} has no bundled dependency tree; run the desktop stage:npm script first`)
  })
  await cp(source, join(resourcesRoot, pin.name), { recursive: true, dereference: true, force: true })
  return pin
}

/**
 * Assert the packaged npm runtime is the pinned version and actually executes.
 *
 * The execution check runs the packaged application's own Electron binary in Node
 * mode with a search path holding only operating-system directories, so it proves
 * the shipped copy is self-contained and needs no Node, npm, or npx the user
 * installed. It is skipped where no executable is present, which only happens in a
 * fixture; a real bundle always has one.
 * @param resourcesRoot - the packaged application's resources directory.
 * @param pin - the pin the copy must satisfy.
 * @param electronExecutable - the packaged Electron binary, or undefined on a
 * platform whose bundle layout this check does not yet know.
 * @throws When a required file is absent, the bundled dependency tree is empty,
 * the version differs from the pin, or the CLI reports another version.
 */
export async function assertNpmRuntime(
  resourcesRoot: string,
  pin: NpmRuntimePin,
  electronExecutable: string | undefined,
): Promise<void> {
  const npm = join(resourcesRoot, pin.name)
  for (const required of [pin.cliEntry, 'package.json', pin.licenseFile]) {
    if (!existsSync(join(npm, required))) {
      throw new Error(`packaged npm runtime is missing ${required}`)
    }
  }
  const manifest = JSON.parse(await readFile(join(npm, 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (manifest.name !== pin.name || manifest.version !== pin.version) {
    throw new Error(`packaged npm runtime is ${String(manifest.name)}@${String(manifest.version)}, pin requires ${pin.name}@${pin.version}`)
  }
  const bundled = await readdir(join(npm, 'node_modules')).catch(() => {
    throw new Error('packaged npm runtime has no bundled dependency tree; it cannot resolve itself')
  })
  if (bundled.length === 0) {
    throw new Error('packaged npm runtime has an empty bundled dependency tree; it cannot resolve itself')
  }
  if (electronExecutable === undefined || !existsSync(electronExecutable)) return

  const reported = await new Promise<string>((accept, reject) => {
    let output = ''
    const child = spawn(electronExecutable, [join(npm, pin.cliEntry), '--version'], {
      env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept(output.trim())
      else reject(new Error(`packaged npm runtime did not execute (exit ${String(code)}): ${output.trim().split('\n')[0]}`))
    })
  })
  if (reported !== pin.version) {
    throw new Error(`packaged npm runtime reports ${reported}, pin requires ${pin.version}`)
  }
}
