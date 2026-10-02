/** Verify the actual Electron executable against the Desktop package's runtime pin. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { managedProcessEnvironment, runManagedProcess, type ManagedProcessRunner } from '../src/managed-harness-process.ts'

/**
 * Execute Electron in Node mode and reject a different or unusable runtime.
 * @param executable - Installed or packaged Electron executable.
 * @param expectedVersion - Exact runtime version declared by the Desktop package.
 * @param runProcess - Process runner, injectable for focused verification tests.
 * @returns A promise rejecting when the executable cannot report the pinned version.
 */
export async function verifyElectronRuntime(
  executable: string,
  expectedVersion: string,
  runProcess: ManagedProcessRunner = runManagedProcess,
): Promise<void> {
  const result = await runProcess({
    command: executable,
    args: ['-p', 'process.versions.electron'],
    env: managedProcessEnvironment({ ELECTRON_RUN_AS_NODE: '1' }),
    timeoutMs: 30_000,
  })
  if (result.exitCode !== 0 || result.signal !== null || result.outputTruncated === true) {
    throw new Error('Electron runtime verification could not execute the runtime probe')
  }
  const actual = result.output.trim()
  if (actual !== expectedVersion) {
    throw new Error(`Electron runtime reports ${actual}, Desktop requires ${expectedVersion}`)
  }
  console.log(`Verified Electron runtime: ${actual}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const executable = process.argv[2]
    if (executable === undefined) throw new Error('Expected Electron executable path')
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      devDependencies: { electron: string }
    }
    await verifyElectronRuntime(resolve(executable), metadata.devDependencies.electron)
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Electron runtime verification failed')
    process.exitCode = 1
  })
}
