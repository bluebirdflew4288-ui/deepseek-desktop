/**
 * Durable desktop state: the selected mode plus the desktop-owned appearance and
 * language preferences. One document, one writer — a per-field save would drop
 * the fields it does not carry, so callers hold the whole state and persist it.
 */

import { parseNotificationState, type DesktopNotificationState } from './desktop-notifications.ts'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopMode } from './desktop-mode.ts'
import { isDesktopThemePreference, type DesktopThemePreference } from './desktop-theme.ts'
import { isDesktopShellLocale, type DesktopShellLocale } from './shell-locale.ts'

/** Document version written by this build. */
const STATE_VERSION = 2

/** Version 1 carried only the mode; the preferences joined in version 2. */
interface DesktopStateDocumentV1 {
  readonly version: 1
  readonly mode: DesktopMode
}

/** Version 2 adds the optional desktop-owned preferences. */
interface DesktopStateDocumentV2 {
  readonly version: 2
  readonly mode: DesktopMode
  readonly theme?: DesktopThemePreference
  readonly locale?: DesktopShellLocale
  readonly notifications?: DesktopNotificationState
}

/** Durable desktop state read from or written to the state file. */
export interface DesktopState {
  /** Surface the shell restores on launch. */
  readonly mode: DesktopMode
  /**
   * Appearance preference. Absent until the user chooses one, so the operating
   * system decides — a version 1 document legitimately has no theme.
   */
  readonly theme?: DesktopThemePreference
  /**
   * Shell language. Absent until the user chooses one, so the operating
   * system's UI language decides.
   */
  readonly locale?: DesktopShellLocale
  readonly notifications?: DesktopNotificationState
}

/**
 * Read the durable state, migrating a version 1 document in place.
 *
 * A version 1 file carries only `mode`; it is returned with both preferences
 * absent rather than rejected, so adding them never invalidates existing state.
 * An unrecognized preference value is dropped instead of failing the load: a
 * stale theme must not cost the user their selected mode.
 * @param filename - JSON file containing the persisted desktop state.
 * @returns the validated state, or the Harness default when the file is absent.
 */
export async function loadDesktopState(filename: string): Promise<DesktopState> {
  let content: string
  try {
    content = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { mode: 'harness' }
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('desktop state is invalid')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop state is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.mode !== 'chat' && candidate.mode !== 'harness') {
    throw new Error('desktop state is invalid')
  }
  const mode: DesktopMode = candidate.mode
  if (candidate.version === 1) return { mode }
  if (candidate.version !== STATE_VERSION) throw new Error('desktop state is invalid')
  const document = candidate as unknown as DesktopStateDocumentV2
  return {
    mode,
    ...isDesktopThemePreference(document.theme) ? { theme: document.theme } : {},
    ...isDesktopShellLocale(document.locale) ? { locale: document.locale } : {},
    ...document.notifications === undefined ? {} : { notifications: requireNotifications(document.notifications) },
  }
}

/**
 * Persist the complete state using an owner-only atomic file replacement.
 * @param filename - JSON file receiving the persisted desktop state.
 * @param state - the whole state; every field is written, so nothing is dropped.
 */
export async function saveDesktopState(filename: string, state: DesktopState): Promise<void> {
  const document: DesktopStateDocumentV1 | DesktopStateDocumentV2 = {
    version: STATE_VERSION,
    mode: state.mode,
    ...state.theme === undefined ? {} : { theme: state.theme },
    ...state.locale === undefined ? {} : { locale: state.locale },
    ...state.notifications === undefined ? {} : { notifications: state.notifications },
  }
  await writeFileAtomic(filename, `${JSON.stringify(document)}\n`, { mode: 0o600, dirMode: 0o700 })
}

function requireNotifications(value: unknown): DesktopNotificationState {
  const state = parseNotificationState(value)
  if (state === undefined) throw new Error('desktop notification state is invalid')
  return state
}
