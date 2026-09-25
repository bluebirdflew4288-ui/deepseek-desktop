/** Injectable Electron composition for the independent Chat and Harness desktop modes. */

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Event,
  IpcMain,
  IpcMainEvent,
  Input,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import { CHAT_URL } from './chat-navigation.ts'
import { clearChatPartition, createChatSurface } from './chat-surface.ts'
import { observeChatCompletions } from './chat-completion.ts'
import {
  desktopChromeBounds,
  HARNESS_UPDATE_RADIUS,
  insetDesktopContentBounds,
} from './desktop-chrome-layout.ts'
import {
  createDesktopModeController,
  type DesktopModeController,
} from './desktop-mode-controller.ts'
import type {
  DesktopContentBounds,
  DesktopMode,
  DesktopModeSnapshot,
  DesktopSurface,
  DesktopThemedSurface,
} from './desktop-mode.ts'
import { loadDesktopState, saveDesktopState, type DesktopState } from './desktop-state.ts'
import {
  schemeForThemeColor,
  type DesktopColorScheme,
  type DesktopSystemTheme,
  type DesktopThemePreference,
} from './desktop-theme.ts'
import { shellStrings, type DesktopShellLocale } from './shell-locale.ts'
import type { DesktopShellPreferences } from './shell-menu.ts'
import {
  createDesktopThemeCoordinator,
  type DesktopThemeCoordinator,
  type DesktopThemeSnapshot,
  type DesktopThemeState,
} from './desktop-theme-sync.ts'
import { createHarnessSurface } from './harness-surface.ts'
import type { HostSupervisor } from './host-supervisor.ts'
import {
  DESKTOP_TITLEBAR_HEIGHT,
  DESKTOP_SHELL_CHANNELS,
  isDesktopChromeSurface,
  isDesktopHarnessUpdateAction,
  isDesktopShellCommand,
  type DesktopChromeSurface,
  type DesktopHarnessUpdateAction,
  type DesktopHarnessUpdateView,
  type DesktopShellLocalePayload,
  type DesktopShellCommand,
} from './shell-protocol.ts'
import { createDesktopLifecycle } from './window-lifecycle.ts'

import {
  isNotificationAccent, createDesktopNotifications, DEFAULT_NOTIFICATION_PREFERENCES, isSourceViewed,
  type DesktopTaskEvent, type DesktopTaskVisibility, type DesktopNotificationAdapter, type NotificationPreferences,
} from './desktop-notifications.ts'

const APP_NAME = 'DeepSeek Desktop'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920

/** Native factories, paths, and side effects supplied by the production entrypoint. */
export interface DesktopApplicationOptions {
  readonly notificationAdapter?: DesktopNotificationAdapter
  readonly stateFile: string
  readonly shellPath: string
  readonly preloadPath: string
  readonly chromePath: string
  readonly chromePreloadPath: string
  readonly harnessThemePreloadPath: string
  readonly chatThemePreloadPath: string
  readonly platform: NodeJS.Platform
  readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow
  readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView
  readonly createAuthWindow: DesktopApplicationOptions['createWindow']
  readonly createHost: () => HostSupervisor
  /**
   * Report that the Harness cannot start because a prerequisite only the user
   * can supply is missing. The Harness tab shows its setup state instead of a
   * failure, and the shell's install action supplies the prerequisite.
   * @returns Whether the Harness surface is currently withheld.
   */
  readonly harnessSetupRequired?: () => boolean
  /**
   * Supply the missing Harness prerequisite, then let the surface be retried.
   * Omitted where the Harness needs no user-triggered setup.
   * @returns A promise settling when the prerequisite is in place or the attempt
   * failed; either way the Harness surface is retried afterwards.
   */
  readonly installHarness?: () => Promise<void>
  /**
   * Act on one request the Harness update card made. The card is the chrome
   * renderer's own surface, so its requests reach the managed Harness transaction
   * through the composition root rather than through the mode controller.
   * @param action - Request the user made of the card.
   */
  readonly harnessUpdateAction?: (action: DesktopHarnessUpdateAction) => void
  /**
   * Attach the per-launch Host credential to a Harness surface's origin.
   * Omitted where no credential is in use, leaving the surface unauthenticated.
   */
  /** Start an optional read-only observer after Harness authentication. */
  readonly observeHarnessNotifications?: import('./harness-surface.ts').HarnessSurfaceOptions['observeNotifications']
  readonly attachHostApiAuth?: (origin: string) => () => void
  readonly chatSession: Session
  readonly ipcMain: IpcMain
  readonly openExternal: (url: string) => Promise<void>
  readonly quit: () => void
  readonly reportError: (error: unknown) => void
  readonly systemTheme: DesktopSystemTheme
  /**
   * Shell language to render in until the user chooses one. Supplied by the
   * Electron entrypoint, which is the only place that can read the operating
   * system's UI language.
   */
  readonly defaultLocale?: DesktopShellLocale
  /**
   * Observe a desktop-owned preference change so the shell menus can re-render.
   * Both the application menu and the tray are views of this one authority.
   * @param preferences - the appearance and language now in effect.
   */
  readonly onPreferencesChange?: (preferences: DesktopShellPreferences) => void
  readonly onShellLoaded?: () => void
  readonly harnessSurfaceFactory?: (options: DesktopHarnessSurfaceFactoryOptions) => Promise<DesktopSurface>
  readonly chatSurfaceFactory?: (options: DesktopChatSurfaceFactoryOptions) => Promise<DesktopSurface>
  /**
   * Test seam for the Chat completion observer: decide whether one finished
   * request is an official Chat completion. Production uses the audited endpoints.
   */
  readonly chatCompletionMatch?: (url: string) => boolean
  /**
   * Test seam for the Chat completion observer: decide whether one finished
   * request is the client's stop request. Production uses the audited endpoint.
   */
  readonly chatCompletionStopMatch?: (url: string) => boolean
  readonly clearChatStorage?: () => Promise<void>
}

/** Attached-view operations available to an injected Harness fixture adapter. */
export interface DesktopHarnessSurfaceFactoryOptions {
  readonly createView: DesktopApplicationOptions['createView']
  readonly removeView: (view: WebContentsView) => void
  readonly onFailure: (error: Error) => void
  readonly onThemeColor: (color: string | null) => void
  readonly onThemeState: (state: DesktopThemeState) => void
  readonly platform: NodeJS.Platform
}

/** Attached-view operations available to an injected Chat fixture adapter. */
export interface DesktopChatSurfaceFactoryOptions {
  readonly createView: DesktopApplicationOptions['createView']
  readonly removeView: (view: WebContentsView) => void
  readonly onExternalNavigation: (url: string) => void
  readonly onFailure: (error: Error) => void
  readonly onThemeState: (state: DesktopThemeState) => void
  readonly onThemeAdapterError: (error: Error) => void
}

/** Public lifecycle of one composed desktop application. */
export interface DesktopApplication {
  /** Restore the window and open the desktop-owned color picker. */
  editNotificationAccent(): Promise<void>
  /**
   * Accept a provider-confirmed occurrence after startup; no renderer IPC exposes this method.
   * @param event - Globally stable occurrence identity and minimal top-level task metadata.
   * @returns Completion of durable unread recording and any native dispatch attempt.
   */
  receiveTaskEvent(event: DesktopTaskEvent): Promise<void>
  /**
   * Persist notification presentation choices without changing read state.
   * @param preferences - Complete validated desktop presentation preferences.
   * @returns Completion of persistence and chrome/menu publication.
   */
  setNotificationPreferences(preferences: NotificationPreferences): Promise<void>
  /** Create and reveal the local shell without waiting for Harness readiness. */
  start(): Promise<void>
  /** Restore and focus the current desktop window. */
  showWindow(): Promise<void>
  /** Join every surface disposer and release Electron quit. */
  requestQuit(): Promise<void>
  /** Return the current detached mode snapshot when a shell is active. */
  snapshot(): DesktopModeSnapshot | undefined
  /**
   * Show, update, or take away the Harness update card.
   *
   * The latest view is remembered, so a chrome renderer that loads while a
   * transaction is still running is given the state it missed rather than a card
   * that says nothing about work in progress.
   * @param view - State to render, or undefined to take the card away.
   */
  publishHarnessUpdate(view: DesktopHarnessUpdateView | undefined): void
  /**
   * Stop and start the Harness surface, restarting the process this desktop owns.
   * Progress arrives through the mode snapshots, not a returned promise.
   */
  restartHarness(): void
  /** Return the desktop-owned appearance and language preferences. */
  preferences(): DesktopShellPreferences
  /** Choose the appearance for every surface and persist it. */
  setThemePreference(preference: DesktopThemePreference): void
  /** Choose the shell language and persist it. */
  setLocale(locale: DesktopShellLocale): void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isDesktopMode(value: unknown): value is DesktopMode {
  return value === 'chat' || value === 'harness'
}

function contentBounds(window: BrowserWindow): DesktopContentBounds {
  const { width, height } = window.getContentBounds()
  return {
    x: 0,
    y: 0,
    width: Math.max(0, width),
    height: Math.max(0, height),
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported desktop shell command: ${String(value)}`)
}

/**
 * Compose the shell window, IPC, mode controller, and independent surfaces.
 * @param options - Electron factories, persistent paths, and application side effects.
 * @returns An application whose explicit quit waits for both mode surfaces.
 */
export function createDesktopApplication(options: DesktopApplicationOptions): DesktopApplication {
  let notifications: ReturnType<typeof createDesktopNotifications> | undefined
  let chatCompletionDisposer: (() => void) | undefined
  let window: BrowserWindow | undefined
  let controller: DesktopModeController | undefined
  let startPromise: Promise<void> | undefined
  let disposalPromise: Promise<void> | undefined
  let controllerShutdown: Promise<void> = Promise.resolve()
  let disposed = false
  const attachedViews = new Set<WebContentsView>()
  const commandWContents = new Set<WebContents>()
  const windowListenerDisposers: Array<() => void> = []
  let chromeView: WebContentsView | undefined
  let chromeLoaded = false
  let chromeSurface: DesktopChromeSurface = 'closed'
  let harnessUpdateView: DesktopHarnessUpdateView | undefined
  let selectedMode: DesktopMode = 'harness'
  // Application-scoped rather than per native window: a recreated window keeps the
  // one notification owner that closes over these three.
  // Whether the window has been out of the foreground since it was last genuinely
  // visible. The first foreground after launch is not a return, so a mode startup
  // restored keeps the reminder the previous run left behind.
  let returnedFromBackground = false
  // Raised while a notification click restores the window, whose source is selected
  // only after that restore.
  let acknowledgingFromNotification = false
  // The one positive-visibility evidence, read both to decide what the user is
  // looking at and to detect a return to the foreground.
  const visibility = (): DesktopTaskVisibility => ({
    focused: window?.isFocused() === true,
    visible: window?.isVisible() === true,
    minimized: window?.isMinimized() !== false,
    source: selectedMode,
  })
  let systemScheme = options.systemTheme.getColorScheme()
  let harnessScheme: DesktopColorScheme | undefined
  let themeCoordinator: DesktopThemeCoordinator | undefined
  let themeSnapshot: DesktopThemeSnapshot | undefined
  // The one desktop preference authority: loaded from durable state, written by
  // the settings menus, and adopted from a surface that changes its own theme so
  // two competing preferences cannot coexist.
  let desktopState: DesktopState = { mode: 'harness' }
  let pendingSave: Promise<void> = Promise.resolve()

  /**
   * Queue one whole-document write behind the previous one.
   *
   * Two preferences chosen in quick succession must land in the order they were
   * made: concurrent unawaited atomic writes can complete out of order, and the
   * slower one would then resurrect the older document.
   * @param state - the complete document to write.
   * @returns the queued write, for callers that must await durability.
   */
  const enqueueSave = (state: DesktopState): Promise<void> => {
    pendingSave = pendingSave
      .catch(() => {}) // an earlier failure must not block a later choice
      .then(() => saveDesktopState(options.stateFile, state))
    return pendingSave
  }

  const preferencesValue = (): DesktopShellPreferences => ({
    notifications: desktopState.notifications?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
    theme: desktopState.theme ?? 'system',
    locale: desktopState.locale ?? options.defaultLocale ?? 'en-US',
  })

  const publishPreferences = (): void => {
    const listener = options.onPreferencesChange
    if (listener === undefined) return
    try {
      listener(preferencesValue())
    } catch (error) {
      reportError(error)
    }
  }

  /**
   * Adopt a preference change into the one authority and notify the menus.
   * @param patch - the theme and/or locale that changed.
   * @param persist - whether this came from an explicit desktop settings choice.
   *   A preference a surface reported is adopted in memory only: it keeps one
   *   authority and keeps the menus honest, but the durable record holds what
   *   the user chose in the desktop settings, and writing from a synchronous
   *   theme report would race application teardown. An explicit choice always
   *   writes, even when the coordinator already adopted the same value on the
   *   way through — otherwise the change detection would swallow it.
   */
  const adoptPreferences = (
    patch: { theme?: DesktopThemePreference; locale?: DesktopShellLocale },
    persist: boolean,
  ): void => {
    const next: DesktopState = {
      ...desktopState,
      ...patch.theme === undefined ? {} : { theme: patch.theme },
      ...patch.locale === undefined ? {} : { locale: patch.locale },
    }
    const changed = next.theme !== desktopState.theme || next.locale !== desktopState.locale
    const localeChanged = next.locale !== desktopState.locale
    desktopState = next
    if (changed) publishPreferences()
    // The local renderers keep the previous locale's labels until told, so a
    // language choice re-pushes the string table beside the menu re-render.
    if (localeChanged) sendShellStrings()
    if (!persist) return
    // One writer owns the document, so a preference save carries the mode too.
    void enqueueSave(desktopState).catch((error: unknown) => { reportError(error) })
  }

  const reportError = (error: unknown): void => {
    try {
      options.reportError(error)
    } catch (callbackError) {
      console.error('desktop error listener failed:', callbackError)
    }
  }

  const selectedScheme = (): DesktopColorScheme => {
    if (themeSnapshot?.authoritative === true) return themeSnapshot.scheme
    return selectedMode === 'harness' ? harnessScheme ?? systemScheme : systemScheme
  }

  const sendChromeTheme = (): void => {
    const scheme = selectedScheme()
    const titlebarBackground = selectedMode === 'chat'
      ? themeSnapshot?.backgroundColor ?? null
      : null
    const currentWindow = window
    const localContents = [
      currentWindow === undefined || currentWindow.isDestroyed()
        ? undefined
        : currentWindow.webContents,
      chromeLoaded ? chromeView?.webContents : undefined,
    ]
    for (const contents of localContents) {
      if (contents === undefined || contents.isDestroyed()) continue
      try {
        contents.send(DESKTOP_SHELL_CHANNELS.chromeTheme, scheme)
        if (contents === currentWindow?.webContents) {
          contents.send(DESKTOP_SHELL_CHANNELS.titlebarBackground, titlebarBackground)
        }
      } catch (error) {
        reportError(error)
      }
    }
  }

  /**
   * Push the active locale and string table to both local renderers, which hold
   * whatever labels they were last told, or their shipped fallback before any
   * push. Sent once each shell loads and again on every language change.
   */
  const sendShellStrings = (): void => {
    const locale = preferencesValue().locale
    const payload: DesktopShellLocalePayload = { locale, strings: shellStrings(locale) }
    const currentWindow = window
    const localContents = [
      currentWindow === undefined || currentWindow.isDestroyed()
        ? undefined
        : currentWindow.webContents,
      chromeLoaded ? chromeView?.webContents : undefined,
    ]
    for (const contents of localContents) {
      if (contents === undefined || contents.isDestroyed()) continue
      try {
        contents.send(DESKTOP_SHELL_CHANNELS.shellStrings, payload)
      } catch (error) {
        reportError(error)
      }
    }
  }

  /**
   * Push the Harness update card's state to the chrome renderer that draws it.
   * The card belongs to the chrome alone, so unlike the theme and the string
   * table this reaches one renderer, and the last state is kept so a chrome that
   * loads mid-transaction catches up.
   */
  const sendHarnessUpdate = (): void => {
    const contents = chromeLoaded ? chromeView?.webContents : undefined
    if (contents === undefined || contents.isDestroyed()) return
    try {
      contents.send(DESKTOP_SHELL_CHANNELS.harnessUpdate, harnessUpdateView)
    } catch (error) {
      reportError(error)
    }
  }

  const sendSnapshot = (snapshot: DesktopModeSnapshot): void => {
    selectedMode = snapshot.selected
    themeCoordinator?.select(selectedMode)
    setChromeBounds()
    const currentWindow = window
    if (currentWindow === undefined || currentWindow.isDestroyed()) return
    for (const contents of [currentWindow.webContents, chromeView?.webContents]) {
      if (contents === undefined || contents.isDestroyed()) continue
      try {
        contents.send(DESKTOP_SHELL_CHANNELS.snapshot, snapshot)
      } catch (error) {
        reportError(error)
      }
    }
    sendChromeTheme()
    void notifications?.viewed().catch(reportError)
  }

  const onHarnessThemeColor = (color: string | null): void => {
    harnessScheme = schemeForThemeColor(color)
    if (selectedMode === 'harness' && themeSnapshot?.authoritative !== true) sendChromeTheme()
  }

  const connectTheme = (
    mode: DesktopMode,
    surface: DesktopThemedSurface,
    contentTopInset = 0,
  ): DesktopThemedSurface => {
    const themes = themeCoordinator
    if (themes === undefined) throw new Error('desktop theme coordinator is unavailable')
    const disconnect = themes.connect(mode, (preference) => { surface.setThemePreference(preference) })
    let disposed = false
    return {
      setBounds(bounds) {
        surface.setBounds(contentTopInset === 0
          ? bounds
          : insetDesktopContentBounds(bounds, contentTopInset))
      },
      setVisible(visible) { surface.setVisible(visible) },
      reload() { surface.reload() },
      setThemePreference(preference) { surface.setThemePreference(preference) },
      async dispose() {
        if (disposed) return
        disposed = true
        disconnect()
        await surface.dispose()
      },
    }
  }

  const createThemeConnection = (mode: DesktopMode, contentTopInset = 0) => {
    const themes = themeCoordinator
    if (themes === undefined) throw new Error('desktop theme coordinator is unavailable')
    let connected = false
    let pendingState: DesktopThemeState | undefined
    return {
      report(state: DesktopThemeState): void {
        if (!connected) {
          pendingState = state
          return
        }
        themes.report(mode, state)
      },
      connect(surface: DesktopThemedSurface): DesktopThemedSurface {
        const acceptPendingState = !themes.snapshot().authoritative
        connected = true
        const connectedSurface = connectTheme(mode, surface, contentTopInset)
        if (acceptPendingState && pendingState !== undefined) themes.report(mode, pendingState)
        pendingState = undefined
        return connectedSurface
      },
    }
  }

  const onBeforeInput = (event: Event, input: Input): void => {
    if (options.platform !== 'darwin' || input.type !== 'keyDown' || !input.meta || input.key.toLowerCase() !== 'w') return
    event.preventDefault()
    const currentWindow = window
    if (currentWindow !== undefined && !currentWindow.isDestroyed()) currentWindow.close()
  }

  const bindCommandW = (contents: WebContents): void => {
    contents.on('before-input-event', onBeforeInput)
    commandWContents.add(contents)
  }

  const unbindCommandW = (contents: WebContents): void => {
    contents.off('before-input-event', onBeforeInput)
    commandWContents.delete(contents)
  }

  const setChromeBounds = (dismissMenus = false): void => {
    const currentWindow = window
    const currentChrome = chromeView
    if (currentWindow === undefined || currentChrome === undefined || currentWindow.isDestroyed()) return
    const content = contentBounds(currentWindow)
    currentChrome.setBounds(desktopChromeBounds({
      platform: options.platform,
      mode: selectedMode,
      surface: chromeSurface,
      content,
    }))
    // The update card owns its rectangle, so the view's own square corners are
    // what a user sees around it. Clipping the view to the card's radius is the
    // only thing that lets the content page show through the four outer corners.
    currentChrome.setBorderRadius(chromeSurface === 'harness-update' ? HARNESS_UPDATE_RADIUS : 0)
    if (chromeLoaded && !currentChrome.webContents.isDestroyed()) {
      currentChrome.webContents.send(DESKTOP_SHELL_CHANNELS.chromeLayout, {
        surface: chromeSurface,
        dismissMenus,
      })
    }
  }

  const removeAttachedView = (view: WebContentsView): void => {
    if (!attachedViews.delete(view)) return
    unbindCommandW(view.webContents)
    const currentWindow = window
    if (currentWindow === undefined || currentWindow.isDestroyed()) return
    currentWindow.contentView.removeChildView(view)
  }

  const keepChromeAbove = (currentWindow: BrowserWindow): void => {
    const currentChrome = chromeView
    if (currentChrome === undefined) return
    currentWindow.contentView.removeChildView(currentChrome)
    currentWindow.contentView.addChildView(currentChrome)
  }

  const createAttachedView = (viewOptions: WebContentsViewConstructorOptions): WebContentsView => {
    const currentWindow = window
    if (currentWindow === undefined || currentWindow.isDestroyed()) {
      throw new Error('desktop window is unavailable for a content view')
    }
    const view = options.createView(viewOptions)
    bindCommandW(view.webContents)
    currentWindow.contentView.addChildView(view)
    keepChromeAbove(currentWindow)
    attachedViews.add(view)
    return view
  }

  const disposeChrome = (): void => {
    const currentWindow = window
    const currentChrome = chromeView
    chromeView = undefined
    chromeLoaded = false
    if (currentChrome === undefined) return
    if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
      currentWindow.contentView.removeChildView(currentChrome)
    }
    if (!currentChrome.webContents.isDestroyed()) currentChrome.webContents.close()
  }

  const runControllerOperation = (operation: (current: DesktopModeController) => Promise<void> | void): void => {
    const current = controller
    if (current === undefined) return
    void Promise.resolve().then(() => operation(current)).catch(async (error: unknown) => {
      if (controller !== current) return
      try {
        await current.fail(current.snapshot().selected, asError(error))
      } catch (failureError) {
        reportError(failureError)
      }
    })
  }

  const onSelectMode = (_event: IpcMainEvent, value: unknown): void => {
    if (!isDesktopMode(value)) return
    // Restoring a mode on startup preserves attention; explicit entry clears it.
    void notifications?.enterSource(value).catch(reportError)
    runControllerOperation(current => current.select(value))
  }

  const onChromeSurface = (_event: IpcMainEvent, value: unknown): void => {
    if (!isDesktopChromeSurface(value)) return
    chromeSurface = value
    setChromeBounds()
  }

  const performCommand = (current: DesktopModeController, command: DesktopShellCommand): Promise<void> | void => {
    switch (command) {
      case 'retry-chat': return current.retry('chat')
      case 'retry-harness': return current.retry('harness')
      case 'install-harness':
        return options.installHarness === undefined
          ? current.retry('harness')
          : options.installHarness().then(() => current.retry('harness'))
      case 'reload-chat':
        current.reloadChat()
        return
      case 'clear-chat-data': return current.clearChatData()
      case 'open-chat-browser': return options.openExternal(CHAT_URL)
      case 'open-pending-external': return current.openPendingExternal()
      case 'close-window':
        window?.close()
        return
      default: return assertNever(command)
    }
  }

  const onShellCommand = (_event: IpcMainEvent, value: unknown): void => {
    if (!isDesktopShellCommand(value)) return
    runControllerOperation(current => performCommand(current, value))
  }

  const onNotificationAccent = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== chromeView?.webContents || event.senderFrame !== event.sender.mainFrame || !isNotificationAccent(value)) return
    if (notifications === undefined) return
    void notifications.setPreferences({ ...notifications.snapshot().preferences, accent: value }).catch(reportError)
  }
  /**
   * Forward one update-card request to the composition root.
   *
   * The card is the only surface allowed to end a Harness transaction, so its
   * requests are accepted from the local chrome renderer's main frame alone: the
   * Harness and Chat surfaces are remote documents and must not be able to cancel
   * or dismiss a transaction they did not start.
   */
  const onHarnessUpdateAction = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== chromeView?.webContents || event.senderFrame !== event.sender.mainFrame) return
    if (!isDesktopHarnessUpdateAction(value)) return
    options.harnessUpdateAction?.(value)
  }
  options.ipcMain.on(DESKTOP_SHELL_CHANNELS.notificationAccent, onNotificationAccent)
  options.ipcMain.on(DESKTOP_SHELL_CHANNELS.select, onSelectMode)
  options.ipcMain.on(DESKTOP_SHELL_CHANNELS.command, onShellCommand)
  options.ipcMain.on(DESKTOP_SHELL_CHANNELS.chromeSurface, onChromeSurface)
  options.ipcMain.on(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, onHarnessUpdateAction)
  const removeIpcListeners = (): void => {
    options.ipcMain.off(DESKTOP_SHELL_CHANNELS.notificationAccent, onNotificationAccent)
    options.ipcMain.off(DESKTOP_SHELL_CHANNELS.select, onSelectMode)
    options.ipcMain.off(DESKTOP_SHELL_CHANNELS.command, onShellCommand)
    options.ipcMain.off(DESKTOP_SHELL_CHANNELS.chromeSurface, onChromeSurface)
    options.ipcMain.off(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, onHarnessUpdateAction)
  }

  const removeWindowListeners = (): void => {
    for (const dispose of windowListenerDisposers.splice(0)) dispose()
  }

  const stopController = (target: DesktopModeController | undefined): Promise<void> => {
    if (target === undefined) return Promise.resolve()
    return target.shutdown().catch((error: unknown) => { reportError(error) })
  }

  const disposeApplication = (): Promise<void> => {
    disposalPromise ??= (async () => {
      disposed = true
      chatCompletionDisposer?.()
      chatCompletionDisposer = undefined
      await notifications?.dispose()
      removeIpcListeners()
      removeWindowListeners()
      const current = controller
      controller = undefined
      await stopController(current)
      await controllerShutdown
      disposeChrome()
      attachedViews.clear()
    })()
    return disposalPromise
  }

  const createWindow = async (): Promise<BrowserWindow> => {
    await controllerShutdown
    try {
      desktopState = await loadDesktopState(options.stateFile)
    } catch (error) {
      reportError(error)
    }
    notifications ??= createDesktopNotifications({
      initial: desktopState.notifications ?? { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
      visibility,
      save: async (state) => {
        const next = { ...desktopState, notifications: state }
        desktopState = next
        await enqueueSave(next)
      },
      publish: (state) => {
        if (chromeLoaded && chromeView !== undefined && !chromeView.webContents.isDestroyed()) {
          chromeView.webContents.send(DESKTOP_SHELL_CHANNELS.notifications, state)
        }
        publishPreferences()
      },
      adapter: options.notificationAdapter ?? { supported: () => false, show: () => {}, setDockBadge: () => {}, dispose: () => {} },
      open: async (event) => {
        // The window is restored before its source is selected, so a foreground edge
        // taken inside this sequence would acknowledge whichever surface is still on
        // screen. The explicit entry below acknowledges the notification's source.
        acknowledgingFromNotification = true
        try {
          if (window?.isMinimized()) window.restore()
          await lifecycle.showWindow()
          await controller?.select(event.source)
          await notifications?.viewed()
          // Following a notification into a source is the second explicit entry.
          await notifications?.enterSource(event.source)
        } finally {
          acknowledgingFromNotification = false
        }
      },
      reportError,
    })
    // Chat replies are produced by the official website, so the only content-free
    // completion signal is its completion request finishing. This is the single
    // Chat completion detector: it is observed once per session and handed to the
    // notification owner, which decides the source-level reminder and the native
    // alert together, for one receipt per occurrence.
    chatCompletionDisposer ??= observeChatCompletions({
      session: options.chatSession,
      ...options.chatCompletionMatch === undefined ? {} : { matches: options.chatCompletionMatch },
      ...options.chatCompletionStopMatch === undefined ? {} : { matchesStop: options.chatCompletionStopMatch },
      onCompletion: (observation) => {
        void notifications?.receive({
          id: observation.id,
          source: 'chat',
          kind: 'completed',
          occurredAt: observation.occurredAt,
          topLevel: true,
          // Notification-only: never ordinary unread; unseen source attention contributes to the independent numeric Dock badge.
          presentation: 'background-only',
        }).catch(reportError)
      },
      reportError,
    })
    const initialMode = desktopState.mode
    themeCoordinator = createDesktopThemeCoordinator({
      initialMode,
      initialSystemScheme: systemScheme,
      // A persisted choice makes the desktop authoritative immediately, so each
      // surface is told the preference instead of being waited on.
      ...desktopState.theme === undefined ? {} : { initialPreference: desktopState.theme },
      onChange: (snapshot) => {
        themeSnapshot = snapshot
        sendChromeTheme()
        // A theme chosen inside a surface is adopted by the desktop authority, so
        // the two menus and the other surface follow one value instead of
        // competing with it. Compared against the effective preference, so a
        // surface agreeing with the default causes no state change at all.
        if (preferencesValue().theme !== snapshot.preference) {
          adoptPreferences({ theme: snapshot.preference }, false)
        }
      },
    })
    themeSnapshot = themeCoordinator.snapshot()

    const nativeWindow = options.createWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: 960,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      frame: options.platform === 'win32',
      titleBarStyle: options.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(options.platform === 'darwin' ? {} : {
        titleBarOverlay: { color: '#00000000', symbolColor: '#7f858f', height: DESKTOP_TITLEBAR_HEIGHT },
      }),
      ...(options.platform === 'darwin' ? {
        trafficLightPosition: { x: 16, y: 18 },
        vibrancy: 'sidebar' as const,
        visualEffectState: 'followWindow' as const,
      } : {}),
      ...(options.platform === 'win32' ? {
        backgroundMaterial: 'acrylic' as const,
        hasShadow: true,
        roundedCorners: true,
        thickFrame: true,
      } : {
        transparent: true,
        backgroundColor: '#00000000',
      }),
      title: APP_NAME,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    window = nativeWindow
    bindCommandW(nativeWindow.webContents)
    const onVisibility = (): void => {
      // Coming back to the foreground with one source already on screen is that
      // source's acknowledgement, because its reminder was raised while the surface
      // was out of sight. Only the source on screen is entered, so a reminder
      // belonging to the other source survives and the Dock number is recomputed.
      const foreground = isSourceViewed(selectedMode, visibility())
      const acknowledgeReturn = foreground && returnedFromBackground && !acknowledgingFromNotification
      returnedFromBackground = !foreground
      if (acknowledgeReturn) void notifications?.enterSource(selectedMode).catch(reportError)
      void notifications?.viewed().catch(reportError)
    }
    nativeWindow.on('focus', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('focus', onVisibility) })
    nativeWindow.on('blur', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('blur', onVisibility) })
    nativeWindow.on('show', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('show', onVisibility) })
    nativeWindow.on('hide', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('hide', onVisibility) })
    nativeWindow.on('minimize', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('minimize', onVisibility) })
    nativeWindow.on('restore', onVisibility)
    windowListenerDisposers.push(() => { nativeWindow.off('restore', onVisibility) })

    const onClose = (event: Event): void => { lifecycle.onWindowClose(event) }
    const onResize = (): void => {
      const bounds = contentBounds(nativeWindow)
      setChromeBounds()
      controller?.resize(bounds)
    }
    const onClosed = (): void => {
      removeWindowListeners()
      for (const contents of commandWContents) unbindCommandW(contents)
      if (window !== nativeWindow) return
      window = undefined
      const closedController = controller
      controller = undefined
      controllerShutdown = stopController(closedController)
      disposeChrome()
      attachedViews.clear()
    }
    nativeWindow.on('close', onClose)
    nativeWindow.on('resize', onResize)
    nativeWindow.on('closed', onClosed)
    windowListenerDisposers.push(
      () => { nativeWindow.off('close', onClose) },
      () => { nativeWindow.off('resize', onResize) },
      () => { nativeWindow.off('closed', onClosed) },
    )
    const stopSystemTheme = options.systemTheme.subscribe(() => {
      systemScheme = options.systemTheme.getColorScheme()
      if (themeCoordinator === undefined) {
        sendChromeTheme()
        return
      }
      // Always told, so following the system updates live and switching back to
      // `system` later resolves against the current operating-system scheme.
      themeCoordinator.systemChanged(systemScheme)
      if (themeSnapshot?.authoritative !== true) sendChromeTheme()
    })
    windowListenerDisposers.push(stopSystemTheme)

    const readyToShow = new Promise<void>((resolve) => { nativeWindow.once('ready-to-show', resolve) })
    await Promise.all([nativeWindow.loadFile(options.shellPath), readyToShow])
    options.onShellLoaded?.()
    if (disposed) throw new Error('desktop application was disposed during shell load')
    sendShellStrings()

    try {
      chromeView = options.createView({
        webPreferences: {
          preload: options.chromePreloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      })
      chromeView.setBackgroundColor('#00000000')
      nativeWindow.contentView.addChildView(chromeView)
      const onChromeBlur = (): void => { setChromeBounds(true) }
      chromeView.webContents.on('blur', onChromeBlur)
      windowListenerDisposers.push(() => { chromeView?.webContents.off('blur', onChromeBlur) })
      setChromeBounds()
      await chromeView.webContents.loadFile(options.chromePath)
      chromeLoaded = true
      notifications.publish()
      setChromeBounds()
      sendChromeTheme()
      sendShellStrings()
      // A transaction that started before this chrome existed must still be shown.
      sendHarnessUpdate()
    } catch (error) {
      disposeChrome()
      throw error
    }

    const nextController = createDesktopModeController({
      initialMode,
      ...options.harnessSetupRequired === undefined ? {} : { harnessSetupRequired: options.harnessSetupRequired },
      createHarness: async (onFailure) => {
        // The native title-bar chrome owns the first 44 content pixels on every
        // platform. Harness content starts immediately below that rectangle.
        const themeConnection = createThemeConnection('harness', DESKTOP_TITLEBAR_HEIGHT)
        const factoryOptions: DesktopHarnessSurfaceFactoryOptions = {
          createView: createAttachedView,
          removeView: removeAttachedView,
          onFailure,
          onThemeColor: onHarnessThemeColor,
          onThemeState: (state) => { themeConnection.report(state) },
          platform: options.platform,
        }
        const surface = options.harnessSurfaceFactory === undefined
          ? await createHarnessSurface({
            ...factoryOptions,
            host: options.createHost(),
            ...options.observeHarnessNotifications === undefined ? {} : { observeNotifications: options.observeHarnessNotifications },
            ipcMain: options.ipcMain,
            themePreloadPath: options.harnessThemePreloadPath,
            openExternal: options.openExternal,
            ...options.attachHostApiAuth === undefined ? {} : { attachApiAuth: options.attachHostApiAuth },
          })
          : await options.harnessSurfaceFactory(factoryOptions) as DesktopThemedSurface
        return themeConnection.connect(surface)
      },
      createChat: async (onFailure) => {
        const themeConnection = createThemeConnection('chat', DESKTOP_TITLEBAR_HEIGHT)
        const factoryOptions: DesktopChatSurfaceFactoryOptions = {
          createView: createAttachedView,
          removeView: removeAttachedView,
          onExternalNavigation: (url) => { nextController.offerExternalUrl(url) },
          onFailure,
          onThemeState: (state) => { themeConnection.report(state) },
          onThemeAdapterError: reportError,
        }
        const surface = options.chatSurfaceFactory === undefined
          ? await createChatSurface({
            ...factoryOptions,
            chatSession: options.chatSession,
            ipcMain: options.ipcMain,
            themePreloadPath: options.chatThemePreloadPath,
            openExternal: options.openExternal,
            createAuthWindow: options.createAuthWindow,
          })
          : await options.chatSurfaceFactory(factoryOptions) as DesktopThemedSurface
        return themeConnection.connect(surface)
      },
      clearChatStorage: options.clearChatStorage
        ?? (async () => { await clearChatPartition(options.chatSession) }),
      openExternal: options.openExternal,
      saveMode: async (mode) => {
        desktopState = { ...desktopState, mode }
        await enqueueSave(desktopState)
      },
      onChange: sendSnapshot,
    })
    controller = nextController
    nextController.resize(contentBounds(nativeWindow))
    setChromeBounds()
    sendSnapshot(nextController.snapshot())
    void nextController.start().catch((error: unknown) => { reportError(error) })
    return nativeWindow
  }

  const lifecycle = createDesktopLifecycle({
    getWindow: () => window,
    createWindow,
    disposeApplication,
    quit: options.quit,
    reportError,
  })

  return {
    async editNotificationAccent() {
      if (window?.isMinimized()) window.restore()
      await lifecycle.showWindow()
      chromeView?.webContents.send(DESKTOP_SHELL_CHANNELS.editNotificationAccent, notifications?.snapshot().preferences.accent)
    },
    async receiveTaskEvent(event) {
      if (notifications === undefined) throw new Error('desktop notifications require application startup')
      await notifications.receive(event)
    },
    async setNotificationPreferences(preferences) { await notifications?.setPreferences(preferences) },
    start() {
      startPromise ??= lifecycle.showWindow()
      return startPromise
    },
    showWindow() { return lifecycle.showWindow() },
    async requestQuit() {
      // A preference chosen moments before quitting must reach the disk first.
      await pendingSave
      return lifecycle.requestQuit()
    },
    snapshot() { return controller?.snapshot() },
    publishHarnessUpdate(view) {
      harnessUpdateView = view
      sendHarnessUpdate()
    },
    restartHarness() { runControllerOperation(current => current.restart('harness')) },
    preferences() { return preferencesValue() },
    setThemePreference(preference) {
      themeCoordinator?.setPreference(preference)
      adoptPreferences({ theme: preference }, true)
    },
    setLocale(locale) { adoptPreferences({ locale }, true) },
  }
}
