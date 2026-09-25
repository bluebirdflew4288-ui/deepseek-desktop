import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  Session,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopApplication } from '../src/desktop-application.ts'
import { HARNESS_UPDATE_RADIUS } from '../src/desktop-chrome-layout.ts'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type DesktopNotificationAdapter,
  type DesktopTaskEvent,
} from '../src/desktop-notifications.ts'
import type { DesktopColorScheme, DesktopSystemTheme } from '../src/desktop-theme.ts'
import { DESKTOP_THEME_CHANNELS } from '../src/desktop-theme-sync.ts'
import type { HostReadiness, HostSupervisor } from '../src/host-supervisor.ts'
import {
  DESKTOP_SHELL_CHANNELS,
  type DesktopHarnessUpdateAction,
  type DesktopHarnessUpdateView,
} from '../src/shell-protocol.ts'

type Listener = (...args: unknown[]) => void

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

class FakeEmitter {
  readonly listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => { this.off(event, wrapper); listener(...args) }
    return this.on(event, wrapper)
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeViewContents extends FakeEmitter {
  readonly loadURL = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())
  readonly loadFile = vi.fn<(filename: string) => Promise<void>>(() => Promise.resolve())
  readonly send = vi.fn()
  readonly reload = vi.fn()
  readonly close = vi.fn()
  readonly isDestroyed = vi.fn(() => false)
  readonly setWindowOpenHandler = vi.fn()
}

function fakeView() {
  const contents = new FakeViewContents()
  const value = {
    webContents: contents,
    setBounds: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBorderRadius: vi.fn(),
    setVisible: vi.fn(),
  }
  return { contents, value, view: value as unknown as WebContentsView }
}

function fakeThemedSurface() {
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    reload: vi.fn(),
    setThemePreference: vi.fn(),
    dispose: vi.fn(() => Promise.resolve()),
  }
}

class FakeWindow extends FakeEmitter {
  visible = false
  destroyed = false
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  readonly webContents = new FakeViewContents()
  readonly contentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  }
  readonly loadFile = vi.fn(async () => { queueMicrotask(() => { this.emit('ready-to-show') }) })
  // Real restores emit the platform events, not just the state change, so the
  // foreground listeners see the same sequence here as under Electron.
  readonly show = vi.fn(() => { this.visible = true; this.emit('show') })
  readonly focus = vi.fn(() => { this.emit('focus') })
  readonly hide = vi.fn(() => { this.visible = false; this.emit('hide') })
  readonly getContentBounds = vi.fn(() => ({ x: 20, y: 30, width: 1200, height: 800 }))

  constructor() {
    super()
    this.webContents.send.mockImplementation((channel: string, payload: unknown) => {
      this.sent.push({ channel, payload })
    })
  }

  isFocused(): boolean { return this.visible }
  isMinimized(): boolean { return false }
  isVisible(): boolean { return this.visible }
  isDestroyed(): boolean { return this.destroyed }
}

class FakeIpc extends FakeEmitter {
  dispatch(channel: string, payload: unknown, sender?: FakeViewContents): void {
    this.emit(channel, { sender }, payload)
  }
}

function fakeSession(clearStorageData = vi.fn(() => Promise.resolve())): Session {
  return {
    getUserAgent: vi.fn(() => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DeepSeekDesktop/1.0.4 Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36'),
    setUserAgent: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    clearStorageData,
    clearCache: vi.fn(() => Promise.resolve()),
  } as unknown as Session
}

function fakeHost(start: () => Promise<HostReadiness>) {
  let exitListener: ((detail: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined
  const value = {
    start: vi.fn(start),
    shutdown: vi.fn(() => Promise.resolve()),
    onUnexpectedExit: vi.fn((listener: typeof exitListener) => {
      exitListener = listener
      return () => { exitListener = undefined }
    }),
  }
  return value as HostSupervisor
}

function fakeSystemTheme(initial: DesktopColorScheme = 'dark') {
  let scheme = initial
  const listeners = new Set<() => void>()
  const value: DesktopSystemTheme = {
    getColorScheme: vi.fn(() => scheme),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    value,
    set(next: DesktopColorScheme): void {
      scheme = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function stateFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-composition-'))
  roots.push(root)
  return join(root, 'desktop-state.json')
}

function applicationOptions(input: {
  readonly stateFile: string
  readonly window: FakeWindow
  readonly views: WebContentsView[]
  readonly host: HostSupervisor
  readonly platform?: NodeJS.Platform
  readonly chatSession?: Session
  readonly ipc?: FakeIpc
  readonly order?: string[]
  readonly quit?: () => void
  readonly reportError?: (error: unknown) => void
  readonly systemTheme?: DesktopSystemTheme
  readonly notificationAdapter?: DesktopNotificationAdapter
}) {
  const ipc = input.ipc ?? new FakeIpc()
  const order = input.order ?? []
  return {
    ipc,
    options: {
      stateFile: input.stateFile,
      shellPath: '/desktop-resources/shell.html',
      preloadPath: '/app/lib/shell-preload.cjs',
      chromePath: '/desktop-resources/mode-chrome.html',
      chromePreloadPath: '/app/lib/mode-chrome-preload.cjs',
      harnessThemePreloadPath: '/app/lib/harness-theme-preload.cjs',
      chatThemePreloadPath: '/app/lib/chat-theme-preload.cjs',
      platform: input.platform ?? 'darwin',
      ...input.notificationAdapter === undefined ? {} : { notificationAdapter: input.notificationAdapter },
      createWindow: vi.fn((_options: BrowserWindowConstructorOptions) => input.window as unknown as BrowserWindow),
      createView: vi.fn((_options: WebContentsViewConstructorOptions) => {
        const view = input.views.shift()
        if (view === undefined) throw new Error('no fake view available')
        return view
      }),
      createAuthWindow: vi.fn((_options: BrowserWindowConstructorOptions): BrowserWindow => {
        throw new Error('unexpected authentication window')
      }),
      createHost: vi.fn(() => input.host),
      chatSession: input.chatSession ?? fakeSession(),
      ipcMain: ipc as unknown as IpcMain,
      openExternal: vi.fn((_url: string) => Promise.resolve()),
      quit: input.quit ?? vi.fn<() => void>(),
      reportError: input.reportError ?? vi.fn<(error: unknown) => void>(),
      systemTheme: input.systemTheme ?? fakeSystemTheme().value,
      onShellLoaded: () => { order.push('shell') },
    },
  }
}

describe('desktop application composition', () => {
  it.each([
    { platform: 'darwin' as const, chromeBounds: { x: 88, y: 6, width: 164, height: 32 } },
    { platform: 'win32' as const, chromeBounds: { x: 72, y: 6, width: 164, height: 32 } },
  ])('places $platform Harness directly below the title bar chrome', async ({ platform, chromeBounds }) => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const hostReady = deferred<HostReadiness>()
    const order: string[] = []
    const host = fakeHost(async () => { order.push('host'); return hostReady.promise })
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view],
      host,
      order,
      platform,
    })
    const application = createDesktopApplication(options)

    await application.start()

    expect(order).toEqual(['shell', 'host'])
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(harness.value.setBounds).not.toHaveBeenCalled()

    hostReady.resolve({ origin: 'http://127.0.0.1:4173' })
    await vi.waitFor(() => {
      expect(harness.value.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 44,
        width: 1200,
        height: 756,
      })
    })
    expect(chrome.value.setBounds).toHaveBeenCalledWith(chromeBounds)
    expect(chrome.value.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    // Closed chrome is a strip, not a card, so its view keeps square corners.
    expect(chrome.value.setBorderRadius).toHaveBeenLastCalledWith(0)
    expect(window.contentView.addChildView).toHaveBeenCalledWith(harness.view)
    expect(application.snapshot()?.harness.phase).toBe('ready')
  })

  it('relayouts the mode chrome when a minimized Windows window is restored', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const ipc = new FakeIpc()
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view],
      host,
      ipc,
      platform: 'win32',
    })
    const application = createDesktopApplication(options)
    await application.start()
    await vi.waitFor(() => {
      expect(harness.value.setBounds).toHaveBeenCalledWith({ x: 0, y: 44, width: 1200, height: 756 })
    })
    const chromeBounds = (): unknown => chrome.value.setBounds.mock.lastCall?.[0]
    expect(chromeBounds()).toEqual({ x: 72, y: 6, width: 164, height: 32 })
    // A minimized placement hands every layout pass a zero-size content rectangle,
    // exactly what a Windows iconic window reports from getContentBounds().
    window.getContentBounds.mockReturnValue({ x: -25593, y: -25600, width: 0, height: 0 })
    vi.spyOn(window, 'isMinimized').mockReturnValue(true)
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.chromeSurface, 'closed', chrome.contents)
    expect(chromeBounds()).toEqual({ x: 72, y: 6, width: 0, height: 0 })
    // Windows restores with restore/show/focus and emits no resize at all, so the
    // restore listener is the only thing that can give the chrome a usable rectangle.
    window.getContentBounds.mockReturnValue({ x: 20, y: 30, width: 1200, height: 800 })
    vi.spyOn(window, 'isMinimized').mockReturnValue(false)
    window.emit('restore')
    window.emit('show')
    window.emit('focus')
    expect(chromeBounds()).toEqual({ x: 72, y: 6, width: 164, height: 32 })
    expect(harness.value.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 44, width: 1200, height: 756 })
  })

  it('applies expanded chrome bounds before acknowledging the requested surface', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const ipc = new FakeIpc()
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view],
      host,
      ipc,
    })
    const application = createDesktopApplication(options)

    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })
    chrome.value.setBounds.mockClear()
    chrome.contents.send.mockClear()

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.chromeSurface, 'chat-menu', chrome.contents)

    expect(chrome.value.setBounds).toHaveBeenLastCalledWith({
      x: 88,
      y: 6,
      width: 184,
      height: 132,
    })
    expect(chrome.contents.send).toHaveBeenLastCalledWith(
      DESKTOP_SHELL_CHANNELS.chromeLayout,
      { surface: 'chat-menu', dismissMenus: false },
    )
    expect(chrome.value.setBounds.mock.invocationCallOrder.at(-1))
      .toBeLessThan(chrome.contents.send.mock.invocationCallOrder.at(-1)!)
  })

  it('synchronizes theme changes from the selected mode and contains hidden disagreement', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const chat = fakeView()
    const ipc = new FakeIpc()
    const systemTheme = fakeSystemTheme('dark')
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view, chat.view],
      host,
      ipc,
      systemTheme: systemTheme.value,
    })
    const application = createDesktopApplication(options)

    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })
    expect(chrome.contents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.titlebarBackground, null)

    ipc.dispatch(
      DESKTOP_THEME_CHANNELS.report,
      { preference: 'dark', scheme: 'dark' },
      harness.contents,
    )
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'chat')
    await vi.waitFor(() => { expect(application.snapshot()?.chat.phase).toBe('ready') })
    expect(chat.value.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 44,
      width: 1200,
      height: 756,
    })
    expect(chat.contents.send).toHaveBeenCalledWith(DESKTOP_THEME_CHANNELS.apply, 'dark')

    ipc.dispatch(
      DESKTOP_THEME_CHANNELS.report,
      { preference: 'light', scheme: 'light', backgroundColor: '#f5f7f8' },
      chat.contents,
    )
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_SHELL_CHANNELS.titlebarBackground,
      '#f5f7f8',
    )
    expect(harness.contents.send).toHaveBeenLastCalledWith(DESKTOP_THEME_CHANNELS.apply, 'light')

    ipc.dispatch(
      DESKTOP_THEME_CHANNELS.report,
      { preference: 'dark', scheme: 'dark' },
      harness.contents,
    )
    expect(harness.contents.send).toHaveBeenLastCalledWith(DESKTOP_THEME_CHANNELS.apply, 'light')
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')

    ipc.dispatch(
      DESKTOP_THEME_CHANNELS.report,
      { preference: 'system', scheme: 'light', backgroundColor: '#f5f7f8' },
      chat.contents,
    )
    systemTheme.set('dark')
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_SHELL_CHANNELS.titlebarBackground,
      '#f5f7f8',
    )
    expect(harness.contents.send).toHaveBeenLastCalledWith(DESKTOP_THEME_CHANNELS.apply, 'system')

    ipc.dispatch(DESKTOP_THEME_CHANNELS.adapterError, 'unsupported theme format', chat.contents)
    expect(application.snapshot()?.chat.phase).toBe('ready')
    expect(options.reportError).toHaveBeenCalledWith(new Error('unsupported theme format'))
  })

  it('applies an established theme before accepting a newly selected surface report', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeThemedSurface()
    const chat = fakeThemedSurface()
    const ipc = new FakeIpc()
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view],
      host,
      ipc,
    })
    const application = createDesktopApplication({
      ...options,
      harnessSurfaceFactory: async (surfaceOptions) => {
        surfaceOptions.onThemeState({ preference: 'dark', scheme: 'dark' })
        return harness
      },
      chatSurfaceFactory: async (surfaceOptions) => {
        surfaceOptions.onThemeState({ preference: 'system', scheme: 'light' })
        return chat
      },
    })

    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'chat')
    await vi.waitFor(() => { expect(application.snapshot()?.chat.phase).toBe('ready') })

    expect(chat.setThemePreference).toHaveBeenCalledWith('dark')
    expect(harness.setThemePreference).not.toHaveBeenCalledWith('system')
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'dark')
  })

  it('contains invalid durable state and malformed IPC until a valid user selection is persisted', async () => {
    const filename = await stateFile()
    // A version this build does not write: the containment contract is that an
    // unrecognized document is reported, left byte-identical on disk, and never
    // acted on until a valid user selection replaces it.
    await writeFile(filename, '{"version":3,"mode":"chat"}\n')
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const chat = fakeView()
    const reportError = vi.fn<(error: unknown) => void>()
    const ipc = new FakeIpc()
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view, chat.view],
      host,
      ipc,
      reportError,
    })
    const application = createDesktopApplication(options)
    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })

    expect(application.snapshot()?.selected).toBe('harness')
    expect(reportError).toHaveBeenCalledOnce()
    expect(await readFile(filename, 'utf8')).toBe('{"version":3,"mode":"chat"}\n')
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'invalid')
    await Promise.resolve()
    expect(application.snapshot()?.selected).toBe('harness')
    expect(await readFile(filename, 'utf8')).toBe('{"version":3,"mode":"chat"}\n')

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'chat')
    await vi.waitFor(() => { expect(application.snapshot()?.chat.phase).toBe('ready') })
    expect(await readFile(filename, 'utf8')).toBe('{"version":2,"mode":"chat"}\n')
  })

  it('turns command rejection into a selected-mode failure without quitting the application', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const chat = fakeView()
    const ipc = new FakeIpc()
    const quit = vi.fn<() => void>()
    const clearFailure = new Error('partition unavailable')
    const chatSession = fakeSession(vi.fn(() => Promise.reject(clearFailure)))
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view, chat.view],
      host,
      chatSession,
      ipc,
      quit,
    })
    const application = createDesktopApplication(options)
    await application.start()
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'chat')
    await vi.waitFor(() => { expect(application.snapshot()?.chat.phase).toBe('ready') })

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.command, 'clear-chat-data')

    await vi.waitFor(() => { expect(application.snapshot()?.chat).toEqual({ phase: 'failed', message: clearFailure.message }) })
    expect(application.snapshot()?.harness.phase).toBe('ready')
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('foreground attention acknowledgement', () => {
  /** Durable attention exactly as the Dock and the two dots read it. */
  async function persistedAttention(filename: string) {
    const raw = await readFile(filename, 'utf8').catch(() => undefined)
    const ledger = raw === undefined
      ? undefined
      : (JSON.parse(raw) as { notifications?: { chatAttention?: boolean; harnessAttention?: boolean } }).notifications
    return { chat: ledger?.chatAttention === true, harness: ledger?.harnessAttention === true }
  }

  function notifications() {
    const clicks = new Map<string, () => void>()
    const badges: number[] = []
    const adapter: DesktopNotificationAdapter = {
      supported: () => true,
      show: (event, click) => { clicks.set(event.source, click) },
      setDockBadge: (count) => { badges.push(count) },
      dispose: () => {},
    }
    return {
      adapter, clicks, badges,
      shown: () => clicks.size,
      badge: () => badges.at(-1),
    }
  }

  /**
   * Compose a desktop whose Dock number and notification clicks the test can read.
   * @param input.mode - Surface left on screen, which defaults to Harness.
   * @param input.reminder - Durable attention a previous run left behind, for the
   *   startup case. An empty document is written when it is absent.
   * @returns The application, its fake window, and the notification observation.
   */
  async function foregrounded(input: { mode?: 'chat' | 'harness'; reminder?: Record<string, unknown> } = {}) {
    const filename = await stateFile()
    const mode = input.mode ?? 'harness'
    await writeFile(filename, JSON.stringify({
      version: 2, mode,
      notifications: { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], ...input.reminder },
    }))
    const window = new FakeWindow()
    const chrome = fakeView()
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const note = notifications()
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, fakeView().view, fakeView().view, fakeView().view],
      host,
      notificationAdapter: note.adapter,
    })
    const application = createDesktopApplication(options)
    await application.start()
    // The surface on screen is what a return acknowledges, so a test must not raise
    // an occurrence before the restored mode is the one the desktop reports.
    await vi.waitFor(() => { expect(application.snapshot()?.selected).toBe(mode) })
    return { application, window, note, filename }
  }

  /** One unseen Chat reply, as the audited completion observer reports it. */
  const unseenChat = (id: string): DesktopTaskEvent =>
    ({ id, source: 'chat', kind: 'completed', occurredAt: 1, topLevel: true, presentation: 'background-only' })
  /** One unseen top-level Harness outcome, as the audited poller reports it. */
  const unseenHarness = (id: string): DesktopTaskEvent =>
    ({ id, source: 'harness', kind: 'completed', targetId: 'root', occurredAt: 1, topLevel: true, presentation: 'background-only' })

  it('keeps a reminder restored by startup, because no return happened yet', async () => {
    const { window, note, filename } = await foregrounded({
      reminder: { harnessAttention: true, harnessPendingCount: 2 },
    })
    // Startup reveals and focuses the window: the Dock number is restored, and the
    // reminder a previous run left behind survives that first foreground.
    expect(window.show).toHaveBeenCalledOnce()
    expect(note.badge()).toBe(2)
    expect(await persistedAttention(filename)).toEqual({ chat: false, harness: true })
  })

  it('clears only Chat when the app returns to the foreground on Chat', async () => {
    const { application, window, note, filename } = await foregrounded({ mode: 'chat' })
    window.hide()
    await application.receiveTaskEvent(unseenChat('c1'))
    await vi.waitFor(() => { expect(note.badge()).toBe(1) })
    expect(await persistedAttention(filename)).toEqual({ chat: true, harness: false })

    window.show()
    await vi.waitFor(async () => { expect(await persistedAttention(filename)).toEqual({ chat: false, harness: false }) })
    expect(note.badge()).toBe(0)
  })

  it('clears only Harness when the app returns to the foreground on Harness', async () => {
    const { application, window, note, filename } = await foregrounded()
    window.hide()
    await application.receiveTaskEvent(unseenHarness('h1'))
    await vi.waitFor(() => { expect(note.badge()).toBe(1) })
    expect(await persistedAttention(filename)).toEqual({ chat: false, harness: true })

    window.show()
    await vi.waitFor(async () => { expect(await persistedAttention(filename)).toEqual({ chat: false, harness: false }) })
    expect(note.badge()).toBe(0)
  })

  it('acknowledges the visible source and keeps the other one at one', async () => {
    const chatOnScreen = await foregrounded({ mode: 'chat' })
    chatOnScreen.window.hide()
    await chatOnScreen.application.receiveTaskEvent(unseenChat('c1'))
    await chatOnScreen.application.receiveTaskEvent(unseenHarness('h1'))
    await vi.waitFor(() => { expect(chatOnScreen.note.badge()).toBe(2) })

    // Returning to Chat is not returning to Harness: the Dock number is recomputed
    // from what remains, so it falls to one instead of reaching zero.
    chatOnScreen.window.show()
    await vi.waitFor(async () => {
      expect(await persistedAttention(chatOnScreen.filename)).toEqual({ chat: false, harness: true })
    })
    expect(chatOnScreen.note.badge()).toBe(1)

    const harnessOnScreen = await foregrounded()
    harnessOnScreen.window.hide()
    await harnessOnScreen.application.receiveTaskEvent(unseenChat('c1'))
    await harnessOnScreen.application.receiveTaskEvent(unseenHarness('h1'))
    await vi.waitFor(() => { expect(harnessOnScreen.note.badge()).toBe(2) })

    harnessOnScreen.window.show()
    await vi.waitFor(async () => {
      expect(await persistedAttention(harnessOnScreen.filename)).toEqual({ chat: true, harness: false })
    })
    expect(harnessOnScreen.note.badge()).toBe(1)
  })

  it('leaves another source untouched while the visible one has nothing to clear', async () => {
    const { application, window, note, filename } = await foregrounded({ mode: 'chat' })
    window.hide()
    await application.receiveTaskEvent(unseenHarness('h1'))
    await vi.waitFor(() => { expect(note.badge()).toBe(1) })

    // Chat is what the user comes back to, and it holds no reminder, so viewing it
    // must not reach across into Harness.
    window.show()
    await new Promise((resolveWait) => { setTimeout(resolveWait, 120) })
    expect(await persistedAttention(filename)).toEqual({ chat: false, harness: true })
    expect(note.badge()).toBe(1)
  })

  it.each(['chat', 'harness'] as const)('clears only the source a %s notification click enters', async (source) => {
    const other = source === 'chat' ? 'harness' : 'chat'
    const { application, window, note, filename } = await foregrounded()
    window.hide()
    await application.receiveTaskEvent(unseenChat('c1'))
    await application.receiveTaskEvent(unseenHarness('h1'))
    await vi.waitFor(() => { expect(note.badge()).toBe(2) })

    // The window is restored before Harness stops being the surface on screen, so the
    // foreground edge inside the click must not acknowledge the source being left.
    note.clicks.get(source)?.()
    await vi.waitFor(async () => {
      const seen = await persistedAttention(filename)
      expect(seen[source]).toBe(false)
      expect(seen[other]).toBe(true)
    })
    expect(note.badge()).toBe(1)
    await vi.waitFor(() => { expect(application.snapshot()?.selected).toBe(source) })
  })

  it('neither alerts nor reminds when the visible source is already in view', async () => {
    const { application, note, filename } = await foregrounded({ mode: 'chat' })
    // The window is up and Chat is on screen: a Chat reply is seen as it lands.
    await application.receiveTaskEvent(unseenChat('c1'))
    await new Promise((resolveWait) => { setTimeout(resolveWait, 120) })
    expect(note.shown()).toBe(0)
    expect(note.badge()).toBe(0)
    expect(await persistedAttention(filename)).toEqual({ chat: false, harness: false })
    expect(note.badges.filter(count => count > 0)).toEqual([])
  })
})

describe('the desktop preference authority', () => {
  async function composed(input: {
    stateFile: string
    systemTheme?: ReturnType<typeof fakeSystemTheme>
    defaultLocale?: 'zh-CN' | 'en-US'
    onPreferencesChange?: (preferences: { theme: string; locale: string }) => void
    harnessUpdateAction?: (action: DesktopHarnessUpdateAction) => void
  }) {
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const chat = fakeView()
    const ipc = new FakeIpc()
    const theme = input.systemTheme ?? fakeSystemTheme('dark')
    const host = fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' }))
    const { options } = applicationOptions({
      stateFile: input.stateFile,
      window,
      views: [chrome.view, harness.view, chat.view],
      host,
      ipc,
      systemTheme: theme.value,
    })
    const application = createDesktopApplication({
      ...options,
      ...input.defaultLocale === undefined ? {} : { defaultLocale: input.defaultLocale },
      ...input.onPreferencesChange === undefined ? {} : { onPreferencesChange: input.onPreferencesChange },
      ...input.harnessUpdateAction === undefined ? {} : { harnessUpdateAction: input.harnessUpdateAction },
    })
    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })
    return { application, window, chrome, harness, chat, ipc, theme }
  }

  async function persisted(filename: string): Promise<Record<string, unknown>> {
    await vi.waitFor(() => { expect(JSON.parse(readFileSync(filename, 'utf8'))).toBeTruthy() })
    return JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>
  }

  it('persists an appearance choice and pushes it to every surface', async () => {
    const filename = await stateFile()
    const seen: Array<{ theme: string; locale: string }> = []
    const { application, harness, chat, ipc } = await composed({
      stateFile: filename,
      onPreferencesChange: preferences => seen.push(preferences),
    })

    application.setThemePreference('dark')

    expect(application.preferences().theme).toBe('dark')
    expect(await persisted(filename)).toMatchObject({ version: 2, theme: 'dark' })
    expect(harness.contents.send).toHaveBeenCalledWith(DESKTOP_THEME_CHANNELS.apply, 'dark')
    expect(seen.at(-1)).toMatchObject({ theme: 'dark', locale: 'en-US' })

    // The Chat surface is created lazily, so it was not connected yet: it must
    // be told the desktop preference when it does connect, rather than asked.
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.select, 'chat')
    await vi.waitFor(() => { expect(application.snapshot()?.chat.phase).toBe('ready') })
    expect(chat.contents.send).toHaveBeenCalledWith(DESKTOP_THEME_CHANNELS.apply, 'dark')
  })

  it('persists a language choice without disturbing the appearance', async () => {
    const filename = await stateFile()
    const { application } = await composed({ stateFile: filename, defaultLocale: 'en-US' })

    application.setThemePreference('light')
    application.setLocale('zh-CN')

    expect(application.preferences()).toMatchObject({ theme: 'light', locale: 'zh-CN' })
    expect(await persisted(filename)).toMatchObject({ version: 2, theme: 'light', locale: 'zh-CN' })
  })

  it('restores both preferences on the next launch', async () => {
    const filename = await stateFile()
    const first = await composed({ stateFile: filename })
    first.application.setThemePreference('dark')
    first.application.setLocale('zh-CN')
    await persisted(filename)

    const second = await composed({ stateFile: filename, defaultLocale: 'en-US' })
    expect(second.application.preferences()).toMatchObject({ theme: 'dark', locale: 'zh-CN' })
  })

  it('follows a live operating-system change while the preference is system', async () => {
    const filename = await stateFile()
    const systemTheme = fakeSystemTheme('dark')
    const { application, chrome, theme } = await composed({ stateFile: filename, systemTheme })

    application.setThemePreference('system')
    expect(application.preferences().theme).toBe('system')
    expect(await persisted(filename)).toMatchObject({ version: 2, theme: 'system' })

    theme.set('light')
    await vi.waitFor(() => {
      expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')
    })
  })

  it('holds an explicit palette against a contrary operating-system change', async () => {
    const filename = await stateFile()
    const { application, chrome, theme } = await composed({ stateFile: filename })

    application.setThemePreference('light')
    expect(await persisted(filename)).toMatchObject({ version: 2, theme: 'light' })
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')

    // The system goes the other way; the desktop choice still decides.
    theme.set('dark')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.chromeTheme, 'light')
  })

  it('pushes the shell string table to both local renderers and on language change', async () => {
    const filename = await stateFile()
    const { application, window, chrome } = await composed({
      stateFile: filename,
      defaultLocale: 'zh-CN',
    })

    expect(window.webContents.send).toHaveBeenCalledWith(
      DESKTOP_SHELL_CHANNELS.shellStrings,
      expect.objectContaining({ locale: 'zh-CN' }),
    )
    expect(chrome.contents.send).toHaveBeenCalledWith(
      DESKTOP_SHELL_CHANNELS.shellStrings,
      expect.objectContaining({ locale: 'zh-CN' }),
    )

    application.setLocale('en-US')

    expect(chrome.contents.send).toHaveBeenLastCalledWith(
      DESKTOP_SHELL_CHANNELS.shellStrings,
      expect.objectContaining({ locale: 'en-US' }),
    )
  })

  it('defaults the language from the operating system until the user chooses', async () => {
    const filename = await stateFile()
    const { application } = await composed({ stateFile: filename, defaultLocale: 'zh-CN' })
    expect(application.preferences().locale).toBe('zh-CN')
    // No choice made, so nothing is written: the operating system keeps deciding
    // and a later first choice is not shadowed by an early default on disk.
    expect(existsSync(filename)).toBe(false)
  })

  const UPDATE_CARD: DesktopHarnessUpdateView = {
    phase: 'running',
    operation: 'update',
    stage: 'installing',
    cancellable: true,
    cancelling: false,
    confirming: false,
    collapsed: false,
  }

  it('shows the Harness update card on the chrome renderer that draws it', async () => {
    const filename = await stateFile()
    const { application, window, chrome } = await composed({ stateFile: filename })

    application.publishHarnessUpdate(UPDATE_CARD)

    expect(chrome.contents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.harnessUpdate, UPDATE_CARD)
    // The shell page renders no card, so it is not sent one to hold.
    expect(window.webContents.send).not.toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.harnessUpdate, UPDATE_CARD)
    application.publishHarnessUpdate(undefined)
    expect(chrome.contents.send).toHaveBeenLastCalledWith(DESKTOP_SHELL_CHANNELS.harnessUpdate, undefined)
  })

  it('clips the chrome view only while the update card holds it', async () => {
    const filename = await stateFile()
    const { chrome, ipc } = await composed({ stateFile: filename })

    // The card fills its own rectangle, so only the native clip can take the
    // view's square corners away and let the content page show through them.
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.chromeSurface, 'harness-update', chrome.contents)
    expect(chrome.value.setBorderRadius).toHaveBeenLastCalledWith(HARNESS_UPDATE_RADIUS)

    // The other surfaces are strips and menus, which must keep square corners.
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.chromeSurface, 'closed', chrome.contents)
    expect(chrome.value.setBorderRadius).toHaveBeenLastCalledWith(0)
  })

  it('replays the card to a chrome that loads while its transaction is still running', async () => {
    const filename = await stateFile()
    const window = new FakeWindow()
    const chrome = fakeView()
    const harness = fakeView()
    const chat = fakeView()
    const { options } = applicationOptions({
      stateFile: filename,
      window,
      views: [chrome.view, harness.view, chat.view],
      host: fakeHost(() => Promise.resolve({ origin: 'http://127.0.0.1:4173' })),
      ipc: new FakeIpc(),
    })
    const application = createDesktopApplication(options)

    // The transaction starts before any window exists, as it can after a close.
    application.publishHarnessUpdate(UPDATE_CARD)
    await application.start()
    await vi.waitFor(() => { expect(application.snapshot()?.harness.phase).toBe('ready') })

    expect(chrome.contents.send).toHaveBeenCalledWith(DESKTOP_SHELL_CHANNELS.harnessUpdate, UPDATE_CARD)
  })

  it('takes an update-card request only from the chrome renderer itself', async () => {
    const filename = await stateFile()
    const actions: string[] = []
    const { application, chrome, harness, ipc } = await composed({
      stateFile: filename,
      harnessUpdateAction: (action) => { actions.push(action) },
    })

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, 'confirm-cancel', harness.contents)
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, 'dismiss')
    ipc.dispatch(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, 'clear-chat-data', chrome.contents)
    expect(actions).toEqual([])

    ipc.dispatch(DESKTOP_SHELL_CHANNELS.harnessUpdateAction, 'collapse', chrome.contents)
    expect(actions).toEqual(['collapse'])
    expect(application.snapshot()?.harness.phase).toBe('ready')
  })
})
