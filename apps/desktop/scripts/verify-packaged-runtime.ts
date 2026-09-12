/**
 * Reject a packaged desktop shell that omitted shell assets or a working npm
 * runtime.
 */

import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AfterPackContext } from 'electron-builder'
import { assertNpmRuntime, placeNpmRuntime } from './packaged-npm-runtime.ts'

const REQUIRED_SHELL_FILES = [
  ['desktop-resources', 'shell.html'],
  ['desktop-resources', 'shell.css'],
  ['desktop-resources', 'mode-chrome.html'],
  ['desktop-resources', 'deepseek-memory', 'manifest.json'],
  ['desktop-resources', 'deepseek-memory', 'host.html'],
  ['desktop-resources', 'deepseek-memory', 'host.js'],
  ['desktop-resources', 'deepseek-memory', 'main-world.js'],
  ['desktop-resources', 'deepseek-memory', 'content.js'],
  ['desktop-resources', 'deepseek-memory', 'memory-store.js'],
  ['desktop-resources', 'deepseek-memory', 'memory-selector.js'],
  ['desktop-resources', 'deepseek-memory', 'memory-call-parser.js'],
  ['desktop-resources', 'deepseek-memory', 'manager.html'],
  ['desktop-resources', 'deepseek-memory', 'manager.js'],
  ['desktop-resources', 'deepseek-memory', 'manager.css'],
  ['desktop-resources', 'deepseek-memory', 'LICENSE'],
  ['desktop-resources', 'deepseek-memory', 'NOTICE.md'],
  ['desktop-resources', 'mode-chrome.css'],
  ['app.asar.unpacked', 'lib', 'shell-preload.cjs'],
  ['app.asar.unpacked', 'lib', 'mode-chrome-preload.cjs'],
  ['app.asar.unpacked', 'lib', 'harness-theme-preload.cjs'],
  ['app.asar.unpacked', 'lib', 'chat-theme-preload.cjs'],
] as const

/**
 * Resolve the packaged Electron binary, which is what runs both the npm runtime
 * and the managed Harness.
 * @param context - Electron Builder's completed application directory.
 * @returns The executable on macOS, and undefined where this hook does not yet
 * know the bundle layout.
 */
function electronExecutable(context: AfterPackContext): string | undefined {
  if (context.electronPlatformName !== 'darwin') return undefined
  const product = context.packager.appInfo.productFilename
  return join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product)
}

/**
 * Verify every file the packaged application needs before it can start, placing
 * the npm runtime first because Electron Builder's own copy omits the nested
 * `node_modules` npm depends on.
 * @param context - Electron Builder's completed application directory.
 * @param stagedNpmRoot - parent of the staged npm runtime tree.
 * @returns A promise that rejects when a staged entrypoint is absent, or the npm
 * runtime is not the pinned version or does not execute.
 */
export async function verifyPackagedRuntime(context: AfterPackContext, stagedNpmRoot: string): Promise<void> {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  for (const segments of REQUIRED_SHELL_FILES) {
    await access(join(resources, ...segments))
  }
  const pin = await placeNpmRuntime(resources, stagedNpmRoot)
  await assertNpmRuntime(resources, pin, electronExecutable(context))
}

/**
 * Electron Builder's `afterPack` hook.
 * @param context - Electron Builder's completed application directory.
 * @returns A promise that rejects when the package is missing a runtime it needs.
 */
export async function afterPack(context: AfterPackContext): Promise<void> {
  await verifyPackagedRuntime(context, join(resolve(import.meta.dirname, '..'), 'runtime-npm'))
}

export default afterPack
