/** Closed IPC protocol between the trusted desktop shell and Electron main process. */

import { isDesktopShellLocale, type DesktopShellLocale, type DesktopShellStrings } from './shell-locale.ts'

/** Fixed height of the native titlebar overlay in CSS pixels. */
export const DESKTOP_TITLEBAR_HEIGHT = 44

/** Channel names accepted by the desktop shell's narrow IPC protocol. */
export const DESKTOP_SHELL_CHANNELS = {
  editNotificationAccent: 'dsh-desktop:edit-notification-accent',
  notificationAccent: 'dsh-desktop:notification-accent',
  notifications: 'dsh-desktop:notifications',
  select: 'dsh-desktop:select-mode',
  command: 'dsh-desktop:shell-command',
  snapshot: 'dsh-desktop:mode-snapshot',
  chromeSurface: 'dsh-desktop:chrome-surface',
  chromeLayout: 'dsh-desktop:chrome-layout',
  chromeTheme: 'dsh-desktop:chrome-theme',
  titlebarBackground: 'dsh-desktop:titlebar-background',
  shellStrings: 'dsh-desktop:shell-strings',
  harnessUpdate: 'dsh-desktop:harness-update',
  harnessUpdateAction: 'dsh-desktop:harness-update-action',
} as const

/** Native bounds state requested by the local chrome renderer. */
export type DesktopChromeSurface = 'closed' | 'chat-menu' | 'dialog' | 'harness-update'

/** Layout data sent to the local chrome renderer by Electron main. */
export interface DesktopChromeLayout {
  readonly surface: DesktopChromeSurface
  readonly dismissMenus: boolean
}

/** Transaction the update card reports on. Only staging transactions are shown. */
export type DesktopHarnessUpdateOperation = 'install' | 'update' | 'reinstall'

/**
 * Stage a staging transaction has reached, as the card renders it.
 *
 * The managed runtime produces the same closed set of names, and the update view
 * that carries one into the other is where TypeScript refuses a drift between
 * them. The chrome renderer is given this name instead of the runtime's so the
 * title-bar page never has to resolve a main-process module.
 */
export type DesktopHarnessUpdateStage = 'preparing' | 'installing' | 'verifying' | 'health'

/**
 * What the update card shows, one member per phase the transaction can be in.
 *
 * `stage` and `cancellable` are reported by the managed runtime as it reaches
 * each step, so the card never names work the transaction has not started nor
 * claims a safety the transaction does not provide. `cancelling` records that the
 * runtime accepted a cancel request the transaction has not stopped for yet,
 * `confirming` that the card is asking whether to cancel, and `collapsed` that
 * the user hid the card while the transaction keeps running.
 */
export type DesktopHarnessUpdateView =
  | {
    readonly phase: 'running'
    readonly operation: DesktopHarnessUpdateOperation
    readonly stage: DesktopHarnessUpdateStage
    readonly cancellable: boolean
    readonly cancelling: boolean
    readonly confirming: boolean
    readonly collapsed: boolean
  }
  | {
    readonly phase: 'completed'
    readonly operation: DesktopHarnessUpdateOperation
    /**
     * Version this promotion replaced, absent when it replaced none: a first
     * install had no version, and a reinstall promoted the version already in use.
     */
    readonly from?: string
    /** Version now promoted and launchable. */
    readonly to: string
  }
  | { readonly phase: 'failed'; readonly operation: DesktopHarnessUpdateOperation; readonly reason: string }
  | { readonly phase: 'cancelled'; readonly operation: DesktopHarnessUpdateOperation }

/** What the update card asks Electron main to do. */
export type DesktopHarnessUpdateAction =
  | 'cancel'
  | 'keep'
  | 'confirm-cancel'
  | 'collapse'
  | 'dismiss'
  | 'retry'
  | 'details'
  | 'restart'

const HARNESS_UPDATE_ACTIONS = new Set<DesktopHarnessUpdateAction>([
  'cancel',
  'keep',
  'confirm-cancel',
  'collapse',
  'dismiss',
  'retry',
  'details',
  'restart',
])

/**
 * Test whether a renderer value is an action the update card may ask for.
 * @param value - Untrusted renderer value to classify.
 * @returns Whether it belongs to the closed action union.
 */
export function isDesktopHarnessUpdateAction(value: unknown): value is DesktopHarnessUpdateAction {
  return typeof value === 'string' && HARNESS_UPDATE_ACTIONS.has(value as DesktopHarnessUpdateAction)
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
  return value === 'closed' || value === 'chat-menu' || value === 'dialog' || value === 'harness-update'
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
