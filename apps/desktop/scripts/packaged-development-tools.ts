/** Prove the packaged Agent commands execute the package's runtime without a system Node. */

import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { assertDevelopmentToolLaunchers, developmentLauncherOptions } from '../src/development-tool-launchers.ts'
import { managedProcessEnvironment, runManagedProcess } from '../src/managed-harness-process.ts'

/**
 * Execute node/npm/npx through the packaged command directory with only OS fallback paths.
 * @param resources - Completed application resources directory.
 * @param executable - Package's Electron executable; absent only in asset-only fixtures.
 * @param npmVersion - Pinned npm version both npm and npx must report.
 * @returns Completion after all commands and runtime ownership have been proved.
 */
export async function assertPackagedDevelopmentTools(resources: string, executable: string | undefined, npmVersion: string): Promise<void> {
  if (executable === undefined || !existsSync(executable)) return
  const directory = join(resources, 'development-bin')
  await assertDevelopmentToolLaunchers(developmentLauncherOptions(directory, executable, join(resources, 'npm')))
  const env = managedProcessEnvironment()
  env.PATH = `${directory}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`
  const outcome = await runManagedProcess({
    command: process.platform === 'win32' ? env.ComSpec! : '/bin/sh',
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', 'node -p process.execPath && npm --version && npx --version']
      : ['-c', 'node -p process.execPath && npm --version && npx --version'],
    env, timeoutMs: 30_000,
  })
  const [actualNode, npm, npx] = outcome.output.trim().split(/\r?\n/u)
  if (outcome.exitCode !== 0 || outcome.outputTruncated || actualNode === undefined
    || await realpath(actualNode) !== await realpath(executable) || npm !== npmVersion || npx !== npmVersion) {
    throw new Error('Packaged Desktop node/npm/npx commands failed runtime ownership verification')
  }
}
