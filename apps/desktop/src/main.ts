/** Production Electron entrypoint for the dual-mode desktop application. */

import { createNativeNotifications } from './native-notifications.ts'
import { randomBytes } from 'node:crypto'
import { observeHarnessNotifications } from './harness-notification-runtime.ts'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  shell,
  Tray,
  WebContentsView,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import { CHAT_PARTITION } from './chat-navigation.ts'
import { clearChatPartition } from './chat-surface.ts'
import {
  DeepSeekMemoryRuntime,
  type DeepSeekMemoryStatus,
} from './deepseek-memory-extension.ts'
import {
  createDesktopApplication,
  type DesktopApplication,
} from './desktop-application.ts'
import { createHarnessUpdateView, type HarnessUpdateView } from './harness-update-view.ts'
import { createHostSupervisor, spawnDshWeb } from './host-supervisor.ts'
import { createHarnessHealthCheck } from './managed-harness-health.ts'
import { createNpmHarnessInstaller } from './managed-harness-installer.ts'
import { managedHarnessLayout } from './managed-harness-paths.ts'
import { createHarnessReleaseSource } from './managed-harness-registry.ts'
import {
  createManagedHarnessRuntime,
  type ManagedHarnessRuntime,
  type ManagedHarnessStatus,
  type ManagedHarnessTransaction,
  type ManagedHarnessUpdateCheck,
} from './managed-harness.ts'
import { configureNativeWindowMenu } from './native-window-menu.ts'
import { resolveShellLocale, shellStrings, type DesktopShellLocale, type DesktopShellStrings } from './shell-locale.ts'
import type { DesktopHarnessUpdateOperation } from './shell-protocol.ts'
import {
  shellMenuModel,
  type DesktopShellPreferences,
  type ShellMenuModel,
  type ShellSettingsAction,
  type ShellSettingsGroup,
} from './shell-menu.ts'

const APP_NAME = 'DeepSeek Desktop'
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..')

let desktopApplication: DesktopApplication | undefined
let memoryRuntime: DeepSeekMemoryRuntime | undefined
let managedHarness: ManagedHarnessRuntime | undefined
let tray: Tray | undefined
let quitReleased = false
let quitOperation: Promise<void> | undefined

/**
 * Directory the packaged app owns for managed Harness artifacts: program
 * versions, staging, the package cache, and diagnostics. Harness user data is
 * deliberately not here — the CLI keeps it in its own home, so switching a
 * program version never touches it.
 * @returns the managed root inside the application's user-data directory.
 */
function managedHarnessRoot(): string {
  return join(app.getPath('userData'), 'managed-harness')
}

/** Executable, entry, and flags for one Harness launch. */
interface HarnessLaunch {
  readonly nodeExecutable: string
  readonly cliEntry: string
  readonly cwd: string
  readonly electronRunAsNode: boolean
  readonly suppressBrowserHandoff: boolean
}

/**
 * Create the managed Harness runtime that installs and versions the official
 * Harness the packaged app no longer bundles.
 * @returns the runtime, or undefined outside a packaged app, where the Harness
 * comes from the checkout instead.
 */
function createManagedHarness(): ManagedHarnessRuntime | undefined {
  if (!app.isPackaged) return undefined
  const root = managedHarnessRoot()
  const layout = managedHarnessLayout(root)
  const nodeExecutable = process.execPath
  const cwd = app.getPath('home')
  return createManagedHarnessRuntime({
    root,
    nodeExecutable,
    cwd,
    electronRunAsNode: true,
    releaseSource: createHarnessReleaseSource(),
    installer: createNpmHarnessInstaller({
      layout,
      nodeExecutable,
      npmCliEntry: join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js'),
    }),
    healthCheck: createHarnessHealthCheck({ layout, nodeExecutable, cwd, electronRunAsNode: true }),
    onTransactionStage: (progress) => { harnessUpdate.report(progress) },
  })
}

/**
 * Resolve what the Harness tab launches.
 *
 * A promoted managed version wins. Outside a packaged app the checkout's own CLI
 * is the Harness. A packaged app still shipping the fixed bundled closure uses it
 * only while no managed version is promoted, so dropping that closure from
 * packaging is what makes the managed runtime the only source.
 * @returns the launch, or undefined when the user must install the Harness first.
 */
function harnessLaunch(): HarnessLaunch | undefined {
  const managed = managedHarness?.launch()
  if (managed !== undefined) {
    return {
      nodeExecutable: process.execPath,
      cliEntry: managed.cliEntry,
      cwd: app.getPath('home'),
      electronRunAsNode: true,
      suppressBrowserHandoff: managed.suppressBrowserHandoff,
    }
  }
  if (!app.isPackaged) {
    const cliEntry = join(REPOSITORY_ROOT, 'apps/cli/lib/bin.js')
    if (!existsSync(cliEntry)) {
      throw new Error(`desktop Host entry is missing: ${cliEntry}; run pnpm run build first`)
    }
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry,
      cwd: process.cwd(),
      electronRunAsNode: false,
      suppressBrowserHandoff: false,
    }
  }
  const bundled = join(process.resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bundled)) return undefined
  return {
    nodeExecutable: process.execPath,
    cliEntry: bundled,
    cwd: app.getPath('home'),
    electronRunAsNode: true,
    suppressBrowserHandoff: false,
  }
}

/**
 * High-entropy credential minted once per launch. It lives only in this process
 * and the Host's: the shell attaches it below the page, so it never reaches
 * renderer JavaScript, a URL, web storage, or disk.
 *
 * A capability barrier, not a hard boundary — a process already running
 * arbitrary code as this OS user can read it out of either process.
 */
const hostApiToken = randomBytes(32).toString('base64url')

/**
 * Loopback `host:port` authorities the credential is currently attached to.
 * Compared as a host rather than an origin because a WebSocket handshake
 * carries a `ws:` origin, which never equals the Host's `http:` origin.
 */
const authedHostAuthorities = new Set<string>()
let hostApiAuthInstalled = false

/**
 * Attach the per-launch credential to every request the Harness view sends to
 * its own Host. Injection happens in the default session's request layer, below
 * the page; the Chat renderer lives in its own partition and is never touched.
 *
 * The filter lists both loopback spellings the Host readiness line accepts, in
 * both schemes: a match pattern's `<all_urls>` does not cover `ws://`, and the
 * Host's event downlinks upgrade to WebSocket. The port is left open in the
 * filter and the listener injects only for a `host:port` this launch actually
 * started a Host on, so the credential never travels to an unrelated loopback
 * service — nor to the same host on a port some other process later binds.
 * @param origin - the Host's loopback origin, as reported at readiness.
 * @returns a disposer detaching the credential from that origin.
 */
function attachHostApiAuth(origin: string): () => void {
  const authority = new URL(origin).host
  authedHostAuthorities.add(authority)
  if (!hostApiAuthInstalled) {
    hostApiAuthInstalled = true
    session.defaultSession.webRequest.onBeforeSendHeaders({
      urls: ['http://127.0.0.1/*', 'http://localhost/*', 'ws://127.0.0.1/*', 'ws://localhost/*'],
    }, (details, callback) => {
      let authority = ''
      try {
        authority = new URL(details.url).host
      } catch {
        authority = ''
      }
      if (!authedHostAuthorities.has(authority) || authority === '') {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${hostApiToken}` } })
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    authedHostAuthorities.delete(authority)
    if (authedHostAuthorities.size > 0) return
    hostApiAuthInstalled = false
    session.defaultSession.webRequest.onBeforeSendHeaders(null)
  }
}

function shellPaths(): {
  shellPath: string
  preloadPath: string
  chromePath: string
  chromePreloadPath: string
  harnessThemePreloadPath: string
  chatThemePreloadPath: string
} {
  if (app.isPackaged) {
    return {
      shellPath: join(process.resourcesPath, 'desktop-resources/shell.html'),
      preloadPath: join(process.resourcesPath, 'app.asar.unpacked/lib/shell-preload.cjs'),
      chromePath: join(process.resourcesPath, 'desktop-resources/mode-chrome.html'),
      chromePreloadPath: join(process.resourcesPath, 'app.asar.unpacked/lib/mode-chrome-preload.cjs'),
      harnessThemePreloadPath: join(process.resourcesPath, 'app.asar.unpacked/lib/harness-theme-preload.cjs'),
      chatThemePreloadPath: join(process.resourcesPath, 'app.asar.unpacked/lib/chat-theme-preload.cjs'),
    }
  }
  return {
    shellPath: join(DESKTOP_DIR, 'resources/shell.html'),
    preloadPath: join(DESKTOP_DIR, 'lib/shell-preload.cjs'),
    chromePath: join(DESKTOP_DIR, 'resources/mode-chrome.html'),
    chromePreloadPath: join(DESKTOP_DIR, 'lib/mode-chrome-preload.cjs'),
    harnessThemePreloadPath: join(DESKTOP_DIR, 'lib/harness-theme-preload.cjs'),
    chatThemePreloadPath: join(DESKTOP_DIR, 'lib/chat-theme-preload.cjs'),
  }
}

/** Load the app-local tray template, with an empty fallback for incomplete staging. */
function trayImage(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'desktop-resources/trayTemplate.png')]
    : [join(DESKTOP_DIR, 'resources/trayTemplate.png')]
  const path = candidates.find(candidate => existsSync(candidate))
  const image = path === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(path)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function releaseAppQuit(): void {
  if (quitReleased) return
  quitReleased = true
  tray?.destroy()
  tray = undefined
  app.quit()
}

function requestAppQuit(): Promise<void> {
  quitOperation ??= (async () => {
    await memoryRuntime?.stop().catch((error: unknown) => {
      console.error('DeepSeek Memory teardown failed:', error)
    })
    if (desktopApplication !== undefined) await desktopApplication.requestQuit()
    else releaseAppQuit()
    await managedHarness?.dispose().catch((error: unknown) => {
      console.error('managed Harness teardown failed:', error)
    })
  })()
  return quitOperation
}

/**
 * The operating system's UI language tags, most preferred first.
 *
 * `app.getLocale()` is resolved against the application bundle's own
 * localizations, so it reports what the bundle ships rather than what the user
 * speaks whenever the two disagree. The preferred-system-language list comes
 * from the operating system and is bundle-independent, so it leads.
 * @returns the tags to resolve a shell locale from, empty when unreadable.
 */
function systemLanguageTags(): string[] {
  try {
    const preferred = app.getPreferredSystemLanguages()
    if (preferred.length > 0) return [...preferred]
  } catch {
    // an unavailable preference list falls through to the bundle locale
  }
  try {
    return [app.getLocale()]
  } catch {
    return [] // an unreadable UI language falls back rather than failing the shell
  }
}

/**
 * The shell locale before the desktop preference authority exists, resolved from
 * the operating system's UI language. A fallback only: once the application is
 * composed, {@link currentPreferences} reads the one persisted authority, so the
 * shell never keeps a second locale of its own.
 * @returns the locale the shell renders in before startup.
 */
function fallbackShellLocale(): DesktopShellLocale {
  // The first tag is the user's top-ranked language; a lower-ranked one is a
  // fallback they placed below it, so preference order decides.
  return resolveShellLocale(systemLanguageTags()[0] ?? '')
}

/**
 * Read the one desktop preference authority.
 * @returns the persisted preferences, or their pre-startup resolution.
 */
function currentPreferences(): DesktopShellPreferences {
  return desktopApplication?.preferences() ?? { theme: 'system', locale: fallbackShellLocale() }
}

function currentMemoryStatus(): DeepSeekMemoryStatus {
  return memoryRuntime?.status() ?? { phase: 'idle' }
}

function runMemoryAction(action: 'manage' | 'export' | 'import'): void {
  const runtime = memoryRuntime
  if (runtime === undefined) return
  const operation = action === 'manage'
    ? runtime.openManager()
    : action === 'export'
      ? runtime.exportWithNativeDialog()
      : runtime.importWithNativeDialog()
  void operation.catch((error: unknown) => {
    console.error('DeepSeek Memory action failed:', error)
  })
}

/**
 * Transaction the update card can retry, from the operation it named.
 * @param runtime - managed Harness runtime the card's transaction belongs to.
 * @param operation - Transaction the card is reporting on.
 * @returns the started transaction, which the card settles against.
 */
function startHarnessTransaction(
  runtime: ManagedHarnessRuntime,
  operation: DesktopHarnessUpdateOperation,
): Promise<ManagedHarnessTransaction> {
  if (operation === 'install') return runtime.install()
  if (operation === 'reinstall') return runtime.reinstall()
  return runtime.update()
}

/**
 * The card the shell shows while a staging Harness transaction runs.
 *
 * It is the only place the desktop reports what an update is doing, so it opens
 * before the first step and settles with the transaction, whatever the outcome.
 */
const harnessUpdate: HarnessUpdateView = createHarnessUpdateView({
  publish: (view) => { desktopApplication?.publishHarnessUpdate(view) },
  cancel: () => managedHarness?.cancelTransaction() ?? 'idle',
  retry: (operation) => {
    const runtime = managedHarness
    if (runtime === undefined) return
    runHarnessTransaction(current => startHarnessTransaction(current, operation), operation)
  },
  openDiagnostics: () => {
    void shell.openPath(managedHarnessLayout(managedHarnessRoot()).logFile)
  },
  restart: () => { desktopApplication?.restartHarness() },
})

/**
 * Run one managed Harness transaction, then re-render the menus around its result.
 *
 * A promoted version only takes effect once the running Harness is stopped and
 * started again, because the live process still serves the outgoing version. The
 * card that reported the promotion asks the user before that restart; a
 * transaction the card does not cover, which is a rollback, restarts on its own.
 * @param start - the transaction the menu action or a card retry selected.
 * @param card - transaction the update card reports on, absent for a rollback.
 */
function runHarnessTransaction(
  start: (runtime: ManagedHarnessRuntime) => Promise<ManagedHarnessTransaction>,
  card?: DesktopHarnessUpdateOperation,
): void {
  void (async () => {
    const strings = shellStrings(currentPreferences().locale)
    const runtime = managedHarness
    if (runtime === undefined) return
    if (card !== undefined && !harnessUpdate.begin(card, runtime.retained().current)) return
    applyShellMenus()
    let transaction: ManagedHarnessTransaction | undefined
    let failure: string | undefined
    try {
      transaction = await start(runtime)
    } catch (error) {
      console.error('managed Harness transaction failed:', error)
      failure = error instanceof Error ? error.message : String(error)
    }
    if (card !== undefined) harnessUpdate.settle(transaction, failure, runtime.retained())
    applyShellMenus()
    if (transaction === undefined) return
    if (transaction.outcome === 'promoted' || transaction.outcome === 'rolled-back') {
      if (card === undefined) desktopApplication?.restartHarness()
      return
    }
    // The card already carries a failure or a cancellation with what the user can
    // still do about it; only an unchanged Harness is reported by dialog.
    if (card !== undefined && transaction.outcome !== 'up-to-date') return
    await dialog.showMessageBox({
      type: transaction.outcome === 'failed' ? 'error' : 'info',
      title: `${APP_NAME}: ${strings.harnessResultTitle}`,
      message: transaction.outcome === 'failed' ? transaction.reason : strings.harnessUpToDate,
    })
  })()
}

/**
 * Describe one update check for the user.
 * @param check - what comparing the official `latest` tag with the promoted
 * version found.
 * @param strings - shell string table in the active locale.
 * @returns the dialog body.
 */
function describeUpdateCheck(check: ManagedHarnessUpdateCheck, strings: DesktopShellStrings): string {
  if (check.state === 'available' || check.state === 'not-installed') {
    return `${strings.harnessUpdateAvailablePrefix}${check.latest}`
  }
  if (check.state === 'up-to-date') return strings.harnessUpToDate
  return check.reason
}

/**
 * Read the official registry and report whether a newer Harness exists.
 *
 * This is the only path that asks the registry what it publishes; nothing here
 * installs, and no schedule calls it.
 */
function checkHarnessUpdate(): void {
  void (async () => {
    const runtime = managedHarness
    if (runtime === undefined) return
    const strings = shellStrings(currentPreferences().locale)
    const check = await runtime.checkForUpdate().catch((error: unknown): ManagedHarnessUpdateCheck => {
      console.error('managed Harness update check failed:', error)
      return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
    })
    await dialog.showMessageBox({
      type: check.state === 'failed' ? 'error' : 'info',
      title: `${APP_NAME}: ${strings.harnessResultTitle}`,
      message: describeUpdateCheck(check, strings),
    })
  })()
}

/**
 * Render one managed Harness status as a disabled menu line.
 * @param status - the runtime's current status, absent outside a packaged app.
 * @param strings - shell string table in the active locale.
 * @returns the status line.
 */
function harnessStatusLine(status: ManagedHarnessStatus | undefined, strings: DesktopShellStrings): string {
  if (status === undefined) return strings.harnessStatusNotInstalled
  if (status.phase === 'ready') return strings.harnessStatusReady
  if (status.phase === 'busy') return strings.harnessStatusBusy
  if (status.phase === 'failed') return strings.harnessStatusFailed
  if (status.phase === 'invalid') return strings.harnessStatusInvalid
  return strings.harnessStatusNotInstalled
}

/**
 * Build the Harness menu: what is installed, the actions that change it, and an
 * advanced group holding rollback and diagnostics. Rollback stays disabled until
 * a second version is retained, so the menu never offers an empty transaction.
 * @param strings - the shell string table in the active locale.
 * @returns the Harness submenu template.
 */
function harnessMenuTemplate(strings: DesktopShellStrings): MenuItemConstructorOptions[] {
  const runtime = managedHarness
  const retained = runtime?.retained()
  const status = runtime?.status()
  const idle = runtime !== undefined && status?.phase !== 'busy' && !harnessUpdate.running()
  return [
    { label: `${strings.harnessVersionPrefix}${retained?.current ?? '—'}`, enabled: false },
    { label: harnessStatusLine(status, strings), enabled: false },
    { type: 'separator' },
    {
      label: strings.harnessInstall,
      enabled: idle,
      click: () => { runHarnessTransaction(current => current.install(), 'install') },
    },
    {
      label: strings.harnessCheckForUpdate,
      enabled: runtime !== undefined,
      click: () => { checkHarnessUpdate() },
    },
    {
      label: strings.harnessUpdate,
      enabled: idle,
      click: () => { runHarnessTransaction(current => current.update(), 'update') },
    },
    { label: strings.harnessRestart, click: () => { desktopApplication?.restartHarness() } },
    { type: 'separator' },
    {
      label: strings.harnessAdvanced,
      submenu: [
        {
          label: strings.harnessRollback,
          enabled: idle && retained?.previous !== undefined,
          click: () => { runHarnessTransaction(current => current.rollback()) },
        },
        {
          label: strings.harnessReinstall,
          enabled: idle,
          click: () => { runHarnessTransaction(current => current.reinstall(), 'reinstall') },
        },
        {
          label: strings.harnessOpenLog,
          click: () => {
            void shell.openPath(managedHarnessLayout(managedHarnessRoot()).logFile)
          },
        },
      ],
    },
  ]
}

/**
 * Apply one settings choice to the desktop preference authority, which persists
 * it, pushes the theme to every surface, and calls back to re-render both menus.
 * @param action - the theme or locale choice picked in either shell menu.
 */
function runShellAction(action: ShellSettingsAction): void {
  if (action.kind === 'theme') desktopApplication?.setThemePreference(action.preference)
  else if (action.kind === 'locale') desktopApplication?.setLocale(action.locale)
  else if (action.kind === 'custom-notification-accent') void desktopApplication?.editNotificationAccent()
  else void desktopApplication?.setNotificationPreferences(action.preferences).catch((error: unknown) => { console.error('desktop notification preference failed:', error) })
}

/**
 * Render one settings group as a radio submenu.
 * @param group - the appearance or language group from the shared model.
 * @returns the submenu template both shell menus use unchanged.
 */
function settingsSubmenu(group: ShellSettingsGroup): MenuItemConstructorOptions {
  return {
    label: group.label,
    submenu: group.choices.map((choice): MenuItemConstructorOptions => ({
      label: choice.label,
      type: group.type ?? 'radio',
      checked: choice.checked,
      click: () => { runShellAction(choice.action) },
    })),
  }
}

/**
 * Build the tray menu from the shared model. The settings groups sit at the top
 * level here because the tray is the only reachable surface while the window is
 * hidden; they are the same groups the application menu renders.
 * @param model - the shell menu model for the current preferences.
 * @returns the tray template.
 */
function trayTemplate(model: ShellMenuModel): MenuItemConstructorOptions[] {
  return [
    { label: model.openMainWindow, click: () => { void desktopApplication?.showWindow() } },
    { type: 'separator' },
    {
      label: model.strings.memory,
      submenu: [
        { label: model.strings.manageMemory, click: () => { runMemoryAction('manage') } },
        { label: model.strings.exportMemory, click: () => { runMemoryAction('export') } },
        { label: model.strings.importMemory, click: () => { runMemoryAction('import') } },
      ],
    },
    { type: 'separator' },
    ...model.groups.map(settingsSubmenu),
    { type: 'separator' },
    { label: model.quit, click: () => { void requestAppQuit() } },
  ]
}

/**
 * Build the application menu: the desktop settings inside the product menu,
 * beside the standard edit, view and window roles Electron ships. Keeping those
 * roles is what preserves copy/paste, reload and window management for the
 * Harness and Chat renderers, which have no menu of their own. Every role still
 * carries an explicit label, so the menu speaks the shell locale instead of
 * Electron's English defaults and the bundle's internal package name; the items
 * the operating system inserts into these menus follow the bundle localization.
 * The Window menu is relabelled after the build, see localizeWindowMenu.
 * @param model - the shell menu model for the current preferences.
 * @returns the application menu template.
 */
function applicationMenuTemplate(model: ShellMenuModel): MenuItemConstructorOptions[] {
  const strings = model.strings
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: strings.aboutApp },
        { type: 'separator' },
        {
          label: strings.memory,
          submenu: [
            { label: strings.manageMemory, click: () => { runMemoryAction('manage') } },
            { label: strings.exportMemory, click: () => { runMemoryAction('export') } },
            { label: strings.importMemory, click: () => { runMemoryAction('import') } },
            { type: 'separator' },
            {
              label: currentMemoryStatus().phase === 'ready'
                ? strings.memoryReady
                : strings.memoryUnavailable,
              enabled: false,
            },
          ],
        },
        { type: 'separator' },
        { label: strings.harness, submenu: harnessMenuTemplate(strings) },
        { type: 'separator' },
        { label: model.settings, submenu: model.groups.map(settingsSubmenu) },
        { type: 'separator' },
        { role: 'hide', label: strings.hideApp },
        { role: 'hideOthers', label: strings.hideOthers },
        { role: 'unhide', label: strings.unhideApp },
        { type: 'separator' },
        { role: 'quit', label: strings.quitApp },
      ],
    },
    {
      label: strings.menuEdit,
      submenu: [
        { role: 'undo', label: strings.undo },
        { role: 'redo', label: strings.redo },
        { type: 'separator' },
        { role: 'cut', label: strings.cut },
        { role: 'copy', label: strings.copy },
        { role: 'paste', label: strings.paste },
        { role: 'pasteAndMatchStyle', label: strings.pasteAndMatchStyle },
        { role: 'delete', label: strings.delete },
        { role: 'selectAll', label: strings.selectAll },
        { type: 'separator' },
        {
          label: strings.substitutions,
          submenu: [
            { role: 'showSubstitutions', label: strings.showSubstitutions },
            { type: 'separator' },
            { role: 'toggleSmartQuotes', label: strings.smartQuotes },
            { role: 'toggleSmartDashes', label: strings.smartDashes },
            { role: 'toggleTextReplacement', label: strings.textReplacement },
          ],
        },
        {
          label: strings.speech,
          submenu: [
            { role: 'startSpeaking', label: strings.startSpeaking },
            { role: 'stopSpeaking', label: strings.stopSpeaking },
          ],
        },
      ],
    },
    {
      label: strings.menuView,
      submenu: [
        { role: 'reload', label: strings.reload },
        { role: 'forceReload', label: strings.forceReload },
        { role: 'toggleDevTools', label: strings.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: strings.actualSize },
        { role: 'zoomIn', label: strings.zoomIn },
        { role: 'zoomOut', label: strings.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: strings.toggleFullScreen },
      ],
    },
    // The Window menu keeps its role: it is what registers the menu with the
    // operating system, which then inserts its tiling and window-list items
    // beside ours. localizeWindowMenu rewrites the labels the role owns.
    { role: 'windowMenu' },
  ]
}

/** Re-render both shell menus from the single preference authority. */
function applyShellMenus(): void {
  const model = shellMenuModel(currentPreferences())
  const menu = Menu.buildFromTemplate(applicationMenuTemplate(model))
  configureNativeWindowMenu(menu, model.strings, process.platform)
  Menu.setApplicationMenu(menu)
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate(model)))
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip(APP_NAME)
  tray.on('click', () => { void desktopApplication?.showWindow() })
  applyShellMenus()
}

async function boot(): Promise<void> {
  const paths = shellPaths()
  const chatSession = session.fromPartition(CHAT_PARTITION)
  memoryRuntime = new DeepSeekMemoryRuntime({
    extensionPath: app.isPackaged
      ? join(process.resourcesPath, 'desktop-resources/deepseek-memory')
      : join(DESKTOP_DIR, 'resources/deepseek-memory'),
    chatSession,
    createWindow: options => new BrowserWindow(options),
    reportError: (error) => {
      console.error('DeepSeek Memory failed without disabling Chat or Harness:', error)
      applyShellMenus()
    },
  })
  await memoryRuntime.start()
  managedHarness = createManagedHarness()
  // Recovery runs before any surface exists: an interrupted transaction must be
  // settled, and a Harness a crashed launch still owns must be stopped, before
  // this launch decides what to start.
  await managedHarness?.recover().catch((error: unknown) => {
    console.error('managed Harness recovery failed:', error)
  })
  desktopApplication = createDesktopApplication({
    stateFile: join(app.getPath('userData'), 'desktop-state.json'),
    shellPath: paths.shellPath,
    preloadPath: paths.preloadPath,
    chromePath: paths.chromePath,
    chromePreloadPath: paths.chromePreloadPath,
    harnessThemePreloadPath: paths.harnessThemePreloadPath,
    chatThemePreloadPath: paths.chatThemePreloadPath,
    platform: process.platform,
    createWindow: options => new BrowserWindow(options),
    createView: options => new WebContentsView(options),
    createAuthWindow: options => new BrowserWindow(options),
    createHost: () => {
      const managed = managedHarness
      if (managed?.launch() !== undefined) return managed.createHostSupervisorForLaunch(hostApiToken)
      const launch = harnessLaunch()
      if (launch === undefined) throw new Error('desktop Harness is not installed')
      return createHostSupervisor({
        spawnHost: () => spawnDshWeb({
          ...launch,
          env: { ...process.env, DSH_DESKTOP: '1', DSH_DESKTOP_API_TOKEN: hostApiToken },
        }),
        log: chunk => process.stderr.write(chunk),
      })
    },
    harnessSetupRequired: () => harnessLaunch() === undefined,
    observeHarnessNotifications: async (origin, contents) => {
      const launch = managedHarness?.launch()
      if (process.platform !== 'darwin' || launch === undefined) return async () => {}
      return observeHarnessNotifications({
        cliEntry: launch.cliEntry, origin,
        fetch: (input, init) => contents.session.fetch(input instanceof URL ? input.href : input, init),
        receive: async (event) => {
          if (desktopApplication === undefined) throw new Error('Desktop notification receiver is unavailable')
          await desktopApplication.receiveTaskEvent(event)
        },
        reportError: () => { console.error('desktop Harness background notification observation unavailable') },
      })
    },
    installHarness: async () => {
      const strings = shellStrings(currentPreferences().locale)
      const transaction = await managedHarness?.install().catch((error: unknown) => {
        console.error('managed Harness install failed:', error)
        return undefined
      })
      applyShellMenus()
      if (transaction?.outcome === 'failed') {
        await dialog.showMessageBox({
          type: 'error',
          title: `${APP_NAME}: ${strings.harnessResultTitle}`,
          message: transaction.reason,
        })
      }
    },
    notificationAdapter: createNativeNotifications(() => currentPreferences().locale, (error) => { console.error('desktop notification failed:', error) }),
    harnessUpdateAction: (action) => { harnessUpdate.act(action) },
    attachHostApiAuth,
    defaultLocale: fallbackShellLocale(),
    onPreferencesChange: () => { applyShellMenus() },
    chatSession,
    ipcMain,
    openExternal: async (url) => { await shell.openExternal(url) },
    clearChatStorage: async () => {
      await memoryRuntime?.stop().catch((error: unknown) => {
        console.error('DeepSeek Memory stop before Chat clear failed:', error)
      })
      try {
        await clearChatPartition(chatSession)
      } finally {
        await memoryRuntime?.start()
        applyShellMenus()
      }
    },
    quit: releaseAppQuit,
    reportError: (error) => { console.error('desktop application error:', error) },
    systemTheme: {
      getColorScheme: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      subscribe: (listener) => {
        nativeTheme.on('updated', listener)
        return () => { nativeTheme.off('updated', listener) }
      },
    },
  })
  createTray()
  await desktopApplication.start()
  // Startup loaded the durable preferences; re-render so both menus mark the
  // choices the user made in an earlier launch rather than the fallbacks.
  applyShellMenus()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { void desktopApplication?.showWindow() })
  app.on('activate', () => { void desktopApplication?.showWindow() })
  app.on('window-all-closed', () => {
    // Tray and desktop surfaces own application lifetime on every platform.
  })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    console.error('desktop startup failed:', error)
    if (!quitReleased) {
      const strings = shellStrings(currentPreferences().locale)
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME}: ${strings.failedToStartTitle}`,
        message: `${strings.failedToStartMessage}\n${error instanceof Error ? error.message : String(error)}`,
      })
    }
    await requestAppQuit()
  })
}
