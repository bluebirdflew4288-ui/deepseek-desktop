/** Environment ownership for daily Harness Hosts, independent of maintenance and Chat. */

import { win32, posix } from 'node:path'
import type { HostSupervisor } from './host-supervisor.ts'

/** Exported SDK paths accepted from development discovery. */
export const DEVELOPMENT_PATH_VARIABLES = [
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
] as const

const NETWORK_NODE_VARIABLES = new Set([
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY',
])

/**
 * Whether an inherited variable changes Node startup or belongs to Desktop.
 * Certificate/proxy settings survive; disabling TLS verification and loader hooks do not.
 * @param name - Environment variable name, matched case-insensitively.
 * @returns Whether the variable must be removed before launching a Host.
 */
export function isHarnessStartupVariable(name: string): boolean {
  const key = name.toUpperCase()
  return (key.startsWith('NODE_') && !NETWORK_NODE_VARIABLES.has(key))
    || key.startsWith('DSH_') || key.startsWith('ELECTRON_')
    || key.startsWith('DYLD_') || key.startsWith('LD_')
    || key.startsWith('BASH_FUNC_')
    || ['OPENSSL_CONF', 'OPENSSL_MODULES', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'].includes(key)
}

/**
 * Read the inherited PATH with Windows' case-insensitive key semantics.
 * @param environment - Source environment.
 * @param platform - Target operating system.
 * @returns PATH, or an empty string when absent.
 */
export function developmentSearchPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return environment.PATH ?? ''
  return Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

/**
 * Build a new Host environment without mutating either input or the Electron process.
 * @param base - Desktop/OS environment; startup hooks and internal namespaces are stripped.
 * @param development - Discovered PATH and SDK paths; all other entries are ignored.
 * @param launcherDirectory - Last-resort packaged node/npm/npx directory; empty for source development.
 * @param owned - Explicit product values, applied last (before the parent watchdog).
 * @param platform - Target operating system, defaulting to this host.
 * @returns Complete daily Host environment; never used for maintenance.
 */
export function harnessHostEnvironment(
  base: NodeJS.ProcessEnv, development: NodeJS.ProcessEnv, launcherDirectory: string,
  owned: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !isHarnessStartupVariable(key)))
  const windows = platform === 'win32'
  const separator = windows ? ';' : ':'
  const pathApi = windows ? win32 : posix
  const root = base.SystemRoot ?? base.SYSTEMROOT ?? 'C:\\Windows'
  const system = windows
    ? [win32.join(root, 'System32'), root, win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0')]
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
  // npm's default global command directory supplements user paths; custom prefixes stay explicit.
  const globalBin = !launcherDirectory ? '' : windows
    ? (base.APPDATA ? win32.join(base.APPDATA, 'npm') : base.USERPROFILE ? win32.join(base.USERPROFILE, '.local') : '')
    : (base.HOME ? posix.join(base.HOME, '.local', 'bin') : '')
  const candidates = [...developmentSearchPath(development, platform).split(separator),
    ...developmentSearchPath(base, platform).split(separator), ...system, globalBin, launcherDirectory]
  const seen = new Set<string>()
  const paths = candidates.filter((entry) => {
    // Relative/empty entries make command selection depend on the task directory.
    if (!pathApi.isAbsolute(entry)) return false
    const normalized = pathApi.normalize(entry).replace(windows ? /[\\/]+$/u : /\/+$/u, '') || pathApi.parse(entry).root
    const key = windows ? normalized.toLowerCase() : normalized
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const name of DEVELOPMENT_PATH_VARIABLES) {
    if (development[name] !== undefined) env[name] = development[name]
  }
  // Collapse Windows aliases so Node cannot select an earlier Path over PATH.
  const ownedKeys = new Set(Object.keys(owned).map(key => key.toUpperCase()))
  const ordinary = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !windows || (!['PATH', 'PATHEXT'].includes(key.toUpperCase()) && !ownedKeys.has(key.toUpperCase()))))
  const extensions = Object.entries(base).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '.COM;.EXE;.BAT;.CMD'
  return {
    ...ordinary, PATH: paths.join(separator),
    ...(windows ? { PATHEXT: [...new Set([...extensions.toUpperCase().split(';'), '.CMD'])].join(';'), NoDefaultCurrentDirectoryInExePath: '1' } : {}),
    ...owned,
  }
}

/**
 * Gate only Host startup on discovery; shutting down while discovery runs prevents a late spawn.
 * @param supervisor - Supervisor whose environment provider reads the prepared environment.
 * @param ready - Shared, bounded preparation promise.
 * @returns Supervisor retaining the original shutdown and unexpected-exit ownership.
 */
export function prepareHarnessHost(supervisor: HostSupervisor, ready: Promise<void>): HostSupervisor {
  let stopped = false
  return {
    async start() {
      await ready
      if (stopped) throw new Error('Harness startup cancelled during environment discovery')
      return supervisor.start()
    },
    onUnexpectedExit: listener => supervisor.onUnexpectedExit(listener),
    async shutdown() { stopped = true; await supervisor.shutdown() },
  }
}
