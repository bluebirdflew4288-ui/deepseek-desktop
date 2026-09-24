/** Separate replaceable program assets and preferences from browser profile data. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadDesktopState, saveDesktopState } from './desktop-state.ts'

/** Inputs resolved by Electron after applying any explicit profile selection. */
export interface DesktopStorageOptions {
  /** Host operating system. */
  readonly platform: NodeJS.Platform
  /** Electron's resolved browser profile directory. */
  readonly userData: string
  /** Current user's home directory. */
  readonly home: string
  /** Whether the launch explicitly selected a user-data directory. */
  readonly explicitUserData: boolean
}

/**
 * Resolve the directory used for atomic program and preference writes.
 * Windows profile encryption can reject same-directory rename in AppData.
 * Browser storage stays in Electron userData; explicit profiles stay isolated.
 * @param options - Platform and already-resolved profile paths.
 * @returns Program root and its preference and managed-runtime locations.
 */
export function desktopStoragePaths(options: DesktopStorageOptions): {
  programRoot: string
  stateFile: string
  managedRoot: string
} {
  const programRoot = options.platform === 'win32' && !options.explicitUserData
    ? join(options.home, '.deepseek-desktop')
    : options.userData
  return {
    programRoot,
    stateFile: join(programRoot, 'desktop-state.json'),
    managedRoot: join(programRoot, 'managed-harness'),
  }
}

/**
 * Preserve recognized preferences when the Windows program directory changes.
 * Neither browser storage nor old program trees are moved or removed.
 * @param previous - Previous profile's preference file.
 * @param selected - Preference file in the selected program root.
 */
export async function preserveDesktopPreferences(previous: string, selected: string): Promise<void> {
  if (previous === selected || existsSync(selected) || !existsSync(previous)) return
  await saveDesktopState(selected, await loadDesktopState(previous))
}
