/** Trusted DOM behavior for the title-bar mode chrome. */

import { parseNotificationState, notificationAccentColor } from './desktop-notifications.ts'
import { ipcRenderer } from 'electron'
import type { DesktopMode, DesktopModeSnapshot } from './desktop-mode.ts'
import { isDesktopColorScheme } from './desktop-theme.ts'
import type { DesktopShellStrings } from './shell-locale.ts'
import {
  DESKTOP_SHELL_CHANNELS,
  localePayloadLocale,
  localePayloadString,
  type DesktopChromeLayout,
  type DesktopChromeSurface,
  type DesktopHarnessUpdateAction,
  type DesktopHarnessUpdateOperation,
  type DesktopHarnessUpdateStage,
  type DesktopHarnessUpdateView,
  type DesktopShellCommand,
} from './shell-protocol.ts'

function element(id: string): HTMLElement {
  const value = document.getElementById(id)
  if (value === null) throw new Error(`desktop mode chrome element is missing: ${id}`)
  return value
}

function isDesktopMode(value: string | null | undefined): value is DesktopMode {
  return value === 'chat' || value === 'harness'
}

function sendCommand(command: DesktopShellCommand): void {
  ipcRenderer.send(DESKTOP_SHELL_CHANNELS.command, command)
}

/**
 * Ask Electron main to act on the Harness update card.
 * @param action - Request the user made of the card.
 */
function sendUpdateAction(action: DesktopHarnessUpdateAction): void {
  ipcRenderer.send(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, action)
}

/** Line the update card shows for each stage the managed runtime reports. */
const STAGE_KEYS = {
  preparing: 'harnessUpdatePreparing',
  installing: 'harnessUpdateInstalling',
  verifying: 'harnessUpdateVerifying',
  health: 'harnessUpdateHealth',
} as const satisfies Record<DesktopHarnessUpdateStage, keyof DesktopShellStrings>

/** Title the update card shows once a transaction promoted a version. */
const COMPLETED_KEYS = {
  install: 'harnessInstallCompleted',
  update: 'harnessUpdateCompleted',
  reinstall: 'harnessReinstallCompleted',
} as const satisfies Record<DesktopHarnessUpdateOperation, keyof DesktopShellStrings>

/**
 * Replace the update card's state line with one short rise.
 *
 * Both lines hold the same grid cell, so the card and the mark above it stay
 * exactly where they are while the text changes.
 * @param line - Element holding the line.
 * @param text - Text the line shows now.
 */
function showLine(line: HTMLElement, text: string): void {
  if (line.querySelector('.update-stage-in')?.textContent === text) return
  for (const stale of line.querySelectorAll('.update-stage-out')) stale.remove()
  const previous = line.lastElementChild
  if (previous !== null) {
    previous.classList.remove('update-stage-in')
    previous.classList.add('update-stage-out')
    previous.addEventListener('animationend', () => { previous.remove() }, { once: true })
  }
  const next = document.createElement('span')
  next.className = 'update-stage-in'
  next.textContent = text
  line.append(next)
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform
  const modeSwitch = element('mode-switch')
  const modeButtons = [...modeSwitch.querySelectorAll<HTMLButtonElement>('[data-mode]')]
  const actions = element('chat-actions') as HTMLButtonElement
  const chatMenu = element('chat-menu')
  const dialog = element('clear-chat-confirm') as HTMLDialogElement
  const accentDialog = element('notification-accent-dialog') as HTMLDialogElement
  const accentColor = element('notification-accent-color') as HTMLInputElement
  let editingAccent = false
  const confirmClear = element('confirm-clear') as HTMLButtonElement
  let selected: DesktopMode = 'harness'
  let requestedSurface: DesktopChromeSurface = 'closed'
  let appliedSurface: DesktopChromeSurface = 'closed'
  let latestNotifications: ReturnType<typeof parseNotificationState>
  let attentionLabel: string | undefined
  let localePayload: unknown
  let updateView: DesktopHarnessUpdateView | undefined
  let updateCardHoldsSurface = false
  let cancelBlocked = false

  /**
   * Ask Electron main for the native rectangle one chrome surface needs.
   *
   * The Harness update card holds its rectangle while a transaction runs, and no
   * other surface may take it from under it: a menu that covered the card would
   * leave the user no way to see or stop the work the desktop is doing.
   */
  const requestSurface = (next: DesktopChromeSurface, byUpdateCard = false): void => {
    if (updateCardHoldsSurface && !byUpdateCard && next !== 'harness-update') return
    requestedSurface = next
    ipcRenderer.send(DESKTOP_SHELL_CHANNELS.chromeSurface, next)
  }
  const hideChatMenu = (): void => {
    chatMenu.hidden = true
    actions.setAttribute('aria-expanded', 'false')
  }
  const closeChatMenu = (): void => {
    const wasOpen = requestedSurface === 'chat-menu' || appliedSurface === 'chat-menu'
    hideChatMenu()
    if (wasOpen) requestSurface('closed')
  }
  const select = (mode: DesktopMode): void => {
    ipcRenderer.send(DESKTOP_SHELL_CHANNELS.select, mode)
  }

  const updateCard = element('harness-update')
  const updateStage = element('update-stage')
  const updateNote = element('update-note')
  const updateEffect = element('update-effect')
  const updateActions = element('update-actions')
  const updateClose = element('update-traffic-close') as HTMLButtonElement
  const updateCollapse = element('update-traffic-collapse') as HTMLButtonElement
  const updateKeep = element('update-keep') as HTMLButtonElement
  const updateConfirmCancel = element('update-confirm-cancel') as HTMLButtonElement
  const updateRestart = element('update-restart') as HTMLButtonElement
  const updateRetry = element('update-retry') as HTMLButtonElement
  const updateDetails = element('update-details') as HTMLButtonElement

  /** One update-card string, in the language Electron main last pushed. */
  const updateText = (key: keyof DesktopShellStrings, fallback: string): string =>
    localePayloadString(localePayload, key) ?? fallback

  /** The card's state line: the stage the transaction reached, or its outcome. */
  const updateHeadline = (view: DesktopHarnessUpdateView): string => {
    if (view.phase === 'running') {
      if (view.confirming) return updateText('harnessUpdateCancelQuestion', 'Cancel the Harness update?')
      if (view.cancelling) return updateText('harnessUpdateCancelling', 'Cancelling…')
      return updateText(STAGE_KEYS[view.stage], view.stage)
    }
    if (view.phase === 'completed') {
      return updateText(COMPLETED_KEYS[view.operation], 'Harness update installed')
    }
    const installing = view.operation === 'install'
    if (view.phase === 'failed') {
      return updateText(installing ? 'harnessInstallFailed' : 'harnessUpdateFailed', 'Harness update failed')
    }
    return updateText(installing ? 'harnessInstallCancelled' : 'harnessUpdateCancelled', 'Harness update cancelled')
  }

  /** The card's low-contrast line: the wait, the version pair, or the failure. */
  const updateFootnote = (view: DesktopHarnessUpdateView): string => {
    if (view.phase === 'running') {
      return cancelBlocked
        ? updateText('harnessUpdateCannotCancel', 'This step cannot be interrupted.')
        : updateText('harnessUpdateKeepOpen', 'Keep the app open while the update runs.')
    }
    if (view.phase === 'completed') {
      return view.from === undefined ? view.to : `${view.from} → ${view.to}`
    }
    return view.phase === 'failed' ? view.reason : ''
  }

  /** Render the update card, or take it away once nothing is left to report. */
  const renderHarnessUpdate = (): void => {
    const view = updateView
    const collapsed = view !== undefined && view.phase === 'running' && view.collapsed
    if (view === undefined || collapsed) {
      updateCard.hidden = true
      updateCardHoldsSurface = false
      if (requestedSurface === 'harness-update') requestSurface('closed', true)
      return
    }
    updateCard.hidden = false
    updateCardHoldsSurface = true
    if (requestedSurface !== 'harness-update') requestSurface('harness-update', true)
    updateCard.dataset.phase = view.phase
    updateCard.dataset.stage = view.phase === 'running' ? view.stage : ''
    showLine(updateStage, updateHeadline(view))
    updateNote.textContent = updateFootnote(view)
    updateEffect.hidden = view.phase !== 'completed'
    if (view.phase === 'completed') {
      updateEffect.textContent = updateText('harnessUpdateRestartEffect', 'Takes effect after restarting Harness.')
    }
    const asking = view.phase === 'running' && view.confirming
    updateKeep.hidden = !asking
    updateConfirmCancel.hidden = !asking
    updateRestart.hidden = view.phase !== 'completed'
    updateRetry.hidden = view.phase !== 'failed'
    updateDetails.hidden = view.phase !== 'failed'
    updateActions.hidden = !asking && view.phase !== 'completed' && view.phase !== 'failed'
    // An uncancellable step stays clickable: its answer is why it cannot act.
    updateClose.dataset.uncancellable = String(
      view.phase === 'running' && (!view.cancellable || view.cancelling),
    )
    updateCollapse.disabled = view.phase !== 'running'
    updateKeep.textContent = updateText('harnessUpdateKeepGoing', 'Keep updating')
    updateConfirmCancel.textContent = updateText('cancel', 'Cancel')
    updateRestart.textContent = updateText('harnessRestart', 'Restart Harness')
    updateRetry.textContent = updateText('retry', 'Retry')
    updateDetails.textContent = updateText('harnessOpenLog', 'Open Diagnostics')
    updateClose.setAttribute('aria-label', updateText('harnessUpdateClose', 'Close'))
    updateCollapse.setAttribute('aria-label', updateText('harnessUpdateCollapse', 'Minimize'))
  }

  updateClose.addEventListener('click', () => {
    const view = updateView
    if (view === undefined) return
    if (view.phase !== 'running') {
      sendUpdateAction('dismiss')
      return
    }
    if (view.confirming) {
      sendUpdateAction('keep')
      return
    }
    // An uncancellable step is answered here rather than by main: the card already
    // holds the runtime's own verdict, and nothing needs to be refused twice.
    if (!view.cancellable || view.cancelling) {
      cancelBlocked = true
      renderHarnessUpdate()
      return
    }
    sendUpdateAction('cancel')
  })
  updateCollapse.addEventListener('click', () => { sendUpdateAction('collapse') })
  updateKeep.addEventListener('click', () => { sendUpdateAction('keep') })
  updateConfirmCancel.addEventListener('click', () => { sendUpdateAction('confirm-cancel') })
  updateRestart.addEventListener('click', () => { sendUpdateAction('restart') })
  updateRetry.addEventListener('click', () => { sendUpdateAction('retry') })
  updateDetails.addEventListener('click', () => { sendUpdateAction('details') })

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.harnessUpdate, (_event, view: DesktopHarnessUpdateView | undefined) => {
    // A new report from the transaction answers the blocked question again.
    cancelBlocked = false
    updateView = view
    renderHarnessUpdate()
  })

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-mode')
      if (isDesktopMode(mode)) select(mode)
    })
    button.addEventListener('keydown', (event) => {
      const index = modeButtons.indexOf(button)
      let nextIndex: number | undefined
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + modeButtons.length) % modeButtons.length
      else if (event.key === 'ArrowRight') nextIndex = (index + 1) % modeButtons.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = modeButtons.length - 1
      if (nextIndex === undefined) return
      event.preventDefault()
      const nextButton = modeButtons[nextIndex]
      if (nextButton === undefined) return
      const nextMode = nextButton.getAttribute('data-mode')
      if (!isDesktopMode(nextMode)) return
      nextButton.focus()
      select(nextMode)
    })
  })
  actions.addEventListener('click', () => {
    hideChatMenu()
    if (requestedSurface !== 'chat-menu') {
      requestSurface('chat-menu')
    } else {
      closeChatMenu()
    }
  })
  element('reload-chat').addEventListener('click', () => { closeChatMenu(); sendCommand('reload-chat') })
  element('clear-chat-data').addEventListener('click', () => {
    hideChatMenu()
    requestSurface('dialog')
  })
  confirmClear.addEventListener('click', () => { sendCommand('clear-chat-data') })
  accentDialog.addEventListener('close', () => {
    if (accentDialog.returnValue === 'save') ipcRenderer.send(DESKTOP_SHELL_CHANNELS.notificationAccent, accentColor.value)
    editingAccent = false
    requestSurface('closed')
  })
  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.editNotificationAccent, (_event, accent: unknown) => {
    accentColor.value = typeof accent === 'string' && /^#[\da-f]{6}$/iu.test(accent) ? accent : '#4d6bfe'
    accentDialog.returnValue = 'cancel'
    editingAccent = true
    requestSurface('dialog')
  })
  dialog.addEventListener('close', () => { requestSurface('closed') })
  document.addEventListener('keydown', (event) => {
    if (process.platform === 'darwin' && event.metaKey && event.key.toLowerCase() === 'w') {
      event.preventDefault()
      sendCommand('close-window')
      return
    }
    if (event.key !== 'Escape' || chatMenu.hidden) return
    event.preventDefault()
    closeChatMenu()
    actions.focus()
  })
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node)
      || (!actions.contains(event.target)
        && !chatMenu.contains(event.target)
        && !dialog.contains(event.target))) {
      closeChatMenu()
    }
  })

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.chromeLayout, (_event, layout: DesktopChromeLayout) => {
    appliedSurface = layout.surface
    if (layout.dismissMenus) {
      hideChatMenu()
      if (dialog.open) dialog.close()
      if (accentDialog.open) accentDialog.close('cancel')
      // The update card is not a menu: losing focus must not take away the only
      // report of a transaction that is still running.
      if (!updateCardHoldsSurface && requestedSurface !== 'closed') requestSurface('closed')
      return
    }
    if (layout.surface !== requestedSurface) return
    document.documentElement.dataset.surface = layout.surface
    switch (layout.surface) {
      case 'closed':
        hideChatMenu()
        if (dialog.open) dialog.close()
        if (accentDialog.open) accentDialog.close('cancel')
        return
      case 'chat-menu':
        chatMenu.hidden = false
        actions.setAttribute('aria-expanded', 'true')
        return
      case 'harness-update':
        hideChatMenu()
        return
      case 'dialog':
        hideChatMenu()
        if (editingAccent) { if (!accentDialog.open) accentDialog.showModal() }
        else if (!dialog.open) dialog.showModal()
        return
    }
  })

  /**
   * Render mode-entry indicators from the last published notification state.
   *
   * Kept separate from the IPC handler so a late language push can relabel the
   * dot without waiting for the next notification update.
   */
  const renderModeIndicators = (): void => {
    const state = latestNotifications
    if (state === undefined) return
    for (const button of modeButtons) {
      const unread = state.events.filter(e => !e.read && e.source === button.dataset.mode)
      const count = state.preferences.indicators ? unread.length : 0
      button.dataset.unread = count ? String(count) : ''
      button.dataset.notificationKind = unread.some(e => e.kind === 'failed') ? 'failed'
        : unread.some(e => e.kind === 'action-required') ? 'action-required' : 'completed'
      const attention = state.preferences.indicators
        && (button.dataset.mode === 'harness' ? state.harnessAttention : state.chatAttention) === true
      button.dataset.attention = attention ? 'true' : ''
      const label = button.textContent.trim()
      button.setAttribute('aria-label', attention
        ? `${label}${attentionLabel === undefined ? '' : ` (${attentionLabel})`}`
        : `${label}${count ? ` (${String(count)})` : ''}`)
    }
  }

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.notifications, (_event, payload: unknown) => {
    const state = parseNotificationState(payload)
    if (state === undefined) return
    latestNotifications = state
    document.documentElement.style.setProperty('--notification-accent', notificationAccentColor(state.preferences.accent))
    renderModeIndicators()
  })

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.chromeTheme, (_event, value: unknown) => {
    if (!isDesktopColorScheme(value)) return
    document.documentElement.dataset.theme = value
  })

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.shellStrings, (_event, payload: unknown) => {
    localePayload = payload
    const locale = localePayloadLocale(payload)
    if (locale !== undefined) document.documentElement.lang = locale
    const unseen = localePayloadString(payload, 'harnessUnseenResults')
    if (unseen !== undefined) attentionLabel = unseen
    renderModeIndicators()
    element('notification-accent-label').textContent = locale === 'zh-CN' ? '通知强调色' : 'Notification Accent'
    element('notification-accent-cancel').textContent = locale === 'zh-CN' ? '取消' : 'Cancel'
    element('notification-accent-save').textContent = locale === 'zh-CN' ? '保存' : 'Save'
    const label = (id: string, key: keyof DesktopShellStrings): void => {
      const value = localePayloadString(payload, key)
      if (value !== undefined) element(id).textContent = value
    }
    label('reload-chat', 'reloadChat')
    label('clear-chat-data', 'clearChatData')
    label('clear-chat-message', 'clearChatConfirmMessage')
    label('cancel-clear', 'cancel')
    label('confirm-clear', 'confirmClear')
    const actionsLabel = localePayloadString(payload, 'chatActionsLabel')
    if (actionsLabel !== undefined) {
      actions.setAttribute('aria-label', actionsLabel)
      chatMenu.setAttribute('aria-label', actionsLabel)
    }
    const switchLabel = localePayloadString(payload, 'modeSwitchLabel')
    if (switchLabel !== undefined) modeSwitch.setAttribute('aria-label', switchLabel)
    renderHarnessUpdate()
  })

  ipcRenderer.on(DESKTOP_SHELL_CHANNELS.snapshot, (_event, snapshot: DesktopModeSnapshot) => {
    selected = snapshot.selected
    document.documentElement.dataset.mode = selected
    modeButtons.forEach((button) => {
      const isSelected = button.getAttribute('data-mode') === selected
      button.setAttribute('aria-checked', String(isSelected))
      button.tabIndex = isSelected ? 0 : -1
    })
    actions.hidden = selected !== 'chat'
    if (selected !== 'chat') closeChatMenu()
  })
  requestSurface('closed')
})
