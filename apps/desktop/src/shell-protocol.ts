/** Closed IPC protocol between the trusted desktop shell and Electron main process. */

import { isDesktopShellLocale, type DesktopShellLocale, type DesktopShellStrings } from './shell-locale.ts'

/** Fixed height of the native titlebar overlay in CSS pixels. */
export const DESKTOP_TITLEBAR_HEIGHT = 44

/** Channel names accepted by the desktop shell's narrow IPC protocol. */
export const DESKTOP_SHELL_CHANNELS = {
  select: 'dsh-desktop:select-mode',
  command: 'dsh-desktop:shell-command',
  snapshot: 'dsh-desktop:mode-snapshot',
  chromeSurface: 'dsh-desktop:chrome-surface',
  chromeLayout: 'dsh-desktop:chrome-layout',
  chromeTheme: 'dsh-desktop:chrome-theme',
  titlebarBackground: 'dsh-desktop:titlebar-background',
  shellStrings: 'dsh-desktop:shell-strings',
} as const

/** Native bounds state requested by the local chrome renderer. */
export type DesktopChromeSurface = 'closed' | 'chat-menu' | 'dialog'

/** Layout data sent to the local chrome renderer by Electron main. */
export interface DesktopChromeLayout {
  readonly surface: DesktopChromeSurface
  readonly dismissMenus: boolean
}

/** Commands the trusted shell can send to the Electron main process. */
export type DesktopShellCommand =
  | 'retry-chat'
  | 'retry-harness'
  | 'install-harness'
  | 'reload-chat'
  | 'clear-chat-data'
  | 'open-chat-browser'
  | 'open-pending-external'
  | 'close-window'

const COMMANDS = new Set<DesktopShellCommand>([
  'retry-chat',
  'retry-harness',
  'install-harness',
  'reload-chat',
  'clear-chat-data',
  'open-chat-browser',
  'open-pending-external',
  'close-window',
])

/**
 * Test whether a renderer value is a command accepted by the shell protocol.
 * @param value - Untrusted renderer value to classify.
 * @returns Whether the value belongs to the closed command union.
 */
export function isDesktopShellCommand(value: unknown): value is DesktopShellCommand {
  return typeof value === 'string' && COMMANDS.has(value as DesktopShellCommand)
}

/**
 * Test whether a renderer value is a supported chrome surface state.
 * @param value - untrusted renderer value to classify.
 * @returns Whether the value belongs to the closed chrome surface union.
 */
export function isDesktopChromeSurface(value: unknown): value is DesktopChromeSurface {
  return value === 'closed' || value === 'chat-menu' || value === 'dialog'
}

/** The locale and string table main pushes to its own two renderers. */
export interface DesktopShellLocalePayload {
  readonly locale: DesktopShellLocale
  readonly strings: DesktopShellStrings
}

/**
 * Read the locale out of a locale payload whose shape crossed a process border.
 * @param payload - value received on the shell-strings channel.
 * @returns the closed locale union member, or undefined when malformed.
 */
export function localePayloadLocale(payload: unknown): DesktopShellLocale | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const locale = (payload as { locale?: unknown }).locale
  return isDesktopShellLocale(locale) ? locale : undefined
}

/**
 * Read one labelled string out of a locale payload of unverified shape. The
 * renderers keep their shipped fallback text for any key that fails the check,
 * so a malformed push degrades to the previous labels instead of blank ones.
 * @param payload - value received on the shell-strings channel.
 * @param key - string-table key to read.
 * @returns the non-empty string, or undefined when absent or malformed.
 */
export function localePayloadString(
  payload: unknown,
  key: keyof DesktopShellStrings,
): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const strings = (payload as { strings?: unknown }).strings
  if (typeof strings !== 'object' || strings === null) return undefined
  const value = (strings as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
