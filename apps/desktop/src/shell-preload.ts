/** Trusted DOM behavior for the local desktop shell. */

import { ipcRenderer } from 'electron'
import { desktopTitlebarDragStart } from './desktop-chrome-layout.ts'
import type { DesktopMode, DesktopModeSnapshot } from './desktop-mode.ts'
import { isDesktopColorScheme, isDesktopThemeBackgroundColor } from './desktop-theme.ts'
import {
  DESKTOP_SHELL_CHANNELS,
  localePayloadLocale,
  localePayloadString,
  type DesktopShellCommand,
} from './shell-protocol.ts'

/** Retrieve one required shell element by id. */
function element(id: string): HTMLElement {
  const value = document.getElementById(id)
  if (value === null) throw new Error(`desktop shell element is missing: ${id}`)
  return value
}

/** Send one closed shell command to Electron main. */
function sendCommand(command: DesktopShellCommand): void {
  ipcRenderer.send(DESKTOP_SHELL_CHANNELS.command, command)
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform
  document.documentElement.style.setProperty(
    '--shell-drag-start',
    `${String(desktopTitlebarDragStart(process.platform))}px`,
  )
  const status = element('mode-status')
  const title = element('status-title')
  const message = element('status-message')
  const installHarness = element('install-harness') as HTMLButtonElement
  const retry = element('retry') as HTMLButtonElement
  const openBrowser = element('open-browser') as HTMLButtonElement
  const openExternal = element('open-external') as HTMLButtonElement

  installHarness.addEventListener('click', () => { sendCommand('install-harness') })
  openBrowser.addEventListener('click', () => { sendCommand('open-chat-browser') })
  openExternal.addEventListener('click', () => { sendCommand('open-pending-external') })
  document.addEventListener('keydown', (event) => {
    if (process.platform !== 'darwin' || !event.metaKey || event.key.toLowerCase() !== 'w') return
    event.preventDefault()
    sendCommand('close-window')
  })

  let selected: DesktopMode = 'harness'
  let localePayload: unknown
  let lastSnapshot: DesktopModeSnapshot | undefined
  retry.addEventListener('click', () => { sendCommand(selected === 'chat' ? 'retry-chat' : 'retry-harness') })
  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.chromeTheme, (_event, value: unknown) => {
    if (isDesktopColorScheme(value)) document.documentElement.dataset.theme = value
  })
  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.titlebarBackground, (_event, value: unknown) => {
    if (value === null) {
      document.documentElement.style.removeProperty('--shell-chat-background')
    } else if (isDesktopThemeBackgroundColor(value)) {
      document.documentElement.style.setProperty('--shell-chat-background', value)
    }
  })
  /** Re-render the status copy from the last snapshot in the active locale. */
  const renderStatus = (): void => {
    const snapshot = lastSnapshot
    if (snapshot === undefined) return
    const current = snapshot[selected]
    const chat = selected === 'chat'
    // Only the Harness has a prerequisite the user must trigger, so only it is
    // ever withheld in the setup phase.
    const setup = !chat && current.phase === 'setup'
    status.hidden = current.phase === 'ready'
    if (setup) {
      title.textContent = localePayloadString(localePayload, 'harnessSetupTitle')
        ?? 'DeepSeek Harness is not installed'
      message.textContent = localePayloadString(localePayload, 'harnessSetupMessage') ?? ''
    } else {
      title.textContent = current.phase === 'loading'
        ? localePayloadString(localePayload, chat ? 'loadingChat' : 'loadingHarness')
          ?? `Loading ${chat ? 'Chat' : 'Harness'}`
        : localePayloadString(localePayload, chat ? 'unavailableChat' : 'unavailableHarness')
          ?? `${chat ? 'Chat' : 'Harness'} unavailable`
      message.textContent = current.message ?? ''
    }
    retry.hidden = current.phase !== 'failed'
    installHarness.hidden = !setup
    openBrowser.hidden = selected !== 'chat' || current.phase !== 'failed'
    openExternal.hidden = !snapshot.pendingExternalUrl
  }

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.snapshot, (_event, snapshot: DesktopModeSnapshot) => {
    selected = snapshot.selected
    document.documentElement.dataset.mode = selected
    lastSnapshot = snapshot
    renderStatus()
  })
  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.shellStrings, (_event, payload: unknown) => {
    localePayload = payload
    const locale = localePayloadLocale(payload)
    if (locale !== undefined) document.documentElement.lang = locale
    const retryLabel = localePayloadString(payload, 'retry')
    if (retryLabel !== undefined) retry.textContent = retryLabel
    const installHarnessLabel = localePayloadString(payload, 'installHarness')
    if (installHarnessLabel !== undefined) installHarness.textContent = installHarnessLabel
    const openBrowserLabel = localePayloadString(payload, 'openBrowser')
    if (openBrowserLabel !== undefined) openBrowser.textContent = openBrowserLabel
    const openExternalLabel = localePayloadString(payload, 'openExternal')
    if (openExternalLabel !== undefined) openExternal.textContent = openExternalLabel
    renderStatus()
  })
})
