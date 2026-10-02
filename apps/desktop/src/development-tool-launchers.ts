/** Packaged fallback commands reuse Electron and bundled npm without a second runtime. */

import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { electronNodeBootstrapArgument } from './electron-node-bootstrap.ts'

/** Runtime inputs used to generate relocatable packaged fallback commands. */
export interface DevelopmentLauncherOptions {
  readonly directory: string
  readonly executable: string
  readonly npmCliEntry: string
  readonly npxCliEntry: string
  readonly platform: NodeJS.Platform
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Render node/npm/npx launchers relative to their directory, preserving arguments and exit status.
 * Windows commands target cmd/PowerShell (not shell-free CreateProcess); POSIX commands exec Electron.
 * @param options - Runtime and bundled CLI locations.
 * @returns Filenames and their complete script contents, without developer-machine absolute paths.
 */
export function developmentLauncherScripts(options: DevelopmentLauncherOptions): Readonly<Record<string, string>> {
  const paths = {
    node: undefined,
    npm: relative(options.directory, options.npmCliEntry),
    npx: relative(options.directory, options.npxCliEntry),
  }
  const executable = relative(options.directory, options.executable)
  return Object.fromEntries(Object.entries(paths).map(([name, cli]) => {
    if (options.platform === 'win32') {
      // Product paths are build inputs; reject characters cmd would expand as code.
      if ([executable, cli ?? ''].some(path => /[%"\r\n]/u.test(path))) throw new Error('Unsupported Windows launcher path')
      return [`${name}.cmd`, [
        '@echo off', 'setlocal DisableDelayedExpansion', 'set "ELECTRON_RUN_AS_NODE=1"',
        'set "NODE_OPTIONS="', 'set "NODE_PATH="',
        ...(cli === undefined ? [] : [
          'if not defined PREFIX if defined APPDATA set "PREFIX=%APPDATA%\\npm"',
          'if not defined PREFIX set "PREFIX=%USERPROFILE%\\.local"',
        ]),
        `"%~dp0${executable.replaceAll('/', '\\')}" "${electronNodeBootstrapArgument()}"${cli === undefined ? '' : ` "%~dp0${cli.replaceAll('/', '\\')}"`} %*`,
        'exit /b %errorlevel%', '',
      ].join('\r\n')]
    }
    return [name, [
      '#!/bin/sh', 'launcher_dir=$(CDPATH= cd -- "${0%/*}" && pwd) || exit 1',
      'unset NODE_OPTIONS NODE_PATH', 'export ELECTRON_RUN_AS_NODE=1',
      // PREFIX changes npm's default only; explicit CLI/env/npmrc configuration still wins.
      ...(cli === undefined ? [] : [': "${PREFIX:=$HOME/.local}"', 'export PREFIX']),
      `exec "$launcher_dir/"${shellQuote(executable)} ${shellQuote(electronNodeBootstrapArgument())}${cli === undefined ? '' : ` "$launcher_dir/"${shellQuote(cli)}`} "$@"`, '',
    ].join('\n')]
  }))
}

async function canonicalOptions(options: DevelopmentLauncherOptions): Promise<DevelopmentLauncherOptions> {
  // macOS /var aliases /private/var; relative targets must use one physical path namespace.
  const executable = await realpath(options.executable).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return options.executable // Asset-only packaging fixtures have no executable.
  })
  return {
    ...options, executable, directory: await realpath(options.directory),
    npmCliEntry: await realpath(options.npmCliEntry), npxCliEntry: await realpath(options.npxCliEntry),
  }
}

/**
 * Place all three launchers after confirming the runtime and both bundled CLIs exist.
 * @param options - Owned output directory and runtime locations.
 * @returns Completion after executable scripts are written.
 */
export async function placeDevelopmentToolLaunchers(options: DevelopmentLauncherOptions): Promise<void> {
  for (const file of [options.npmCliEntry, options.npxCliEntry]) await access(file)
  await mkdir(options.directory, { recursive: true })
  for (const [name, contents] of Object.entries(developmentLauncherScripts(await canonicalOptions(options)))) {
    const file = resolve(options.directory, name)
    await writeFile(file, contents, { mode: 0o755 })
    await chmod(file, 0o755)
  }
}

/**
 * Reject absent or stale launcher targets after packaging or before a packaged Host launch.
 * @param options - Expected runtime paths inside the completed package.
 * @returns Completion when every script matches the package's relative targets.
 */
export async function assertDevelopmentToolLaunchers(options: DevelopmentLauncherOptions): Promise<void> {
  for (const file of [options.executable, options.npmCliEntry, options.npxCliEntry]) await access(file)
  for (const [name, contents] of Object.entries(developmentLauncherScripts(await canonicalOptions(options)))) {
    const actual = await readFile(resolve(options.directory, name), 'utf8')
    if (actual !== contents) throw new Error(`Desktop development launcher ${name} is missing or stale`)
  }
}

/**
 * Resolve bundled CLI paths adjacent to the command directory.
 * @param directory - Packaged resources/development-bin.
 * @param executable - Desktop's Electron executable.
 * @param npmDirectory - Complete bundled npm directory.
 * @returns Explicit launcher inputs for the current platform.
 */
export function developmentLauncherOptions(directory: string, executable: string, npmDirectory: string): DevelopmentLauncherOptions {
  return {
    directory, executable, platform: process.platform,
    npmCliEntry: resolve(npmDirectory, 'bin/npm-cli.js'),
    npxCliEntry: resolve(npmDirectory, 'bin/npx-cli.js'),
  }
}
