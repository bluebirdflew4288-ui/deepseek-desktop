import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/desktop-notifications.ts'
import { assertFixtureImportsResolve } from './electron-fixture-artifacts.ts'

interface FixtureState {
  readonly snapshot?: {
    readonly selected: 'chat' | 'harness'
    readonly chat: { readonly phase: string }
    readonly harness: { readonly phase: string }
  }
  readonly visible: { readonly chat: boolean; readonly harness: boolean }
  readonly generations: { readonly chat: number; readonly harness: number }
  readonly bounds: {
    readonly chat?: FixtureBounds
    readonly chrome?: FixtureBounds
    readonly harness?: FixtureBounds
  }
  readonly preferences: { readonly chat: FixtureThemePreference; readonly harness: FixtureThemePreference }
  readonly schemes: { readonly chat: FixtureThemeScheme; readonly harness: FixtureThemeScheme }
  readonly reloads: { readonly chat: number; readonly harness: number }
  readonly sidebarClicks: number
}

interface FixtureBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type FixtureThemeTarget = 'chat' | 'harness' | 'system'
type FixtureThemePreference = 'light' | 'dark' | 'system'
type FixtureThemeScheme = 'light' | 'dark'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolve(desktopRoot, 'tests/fixtures/dual-mode-app')

function isModeChrome(page: Page): boolean {
  try {
    return new URL(page.url()).pathname.endsWith('/mode-chrome.html')
  } catch {
    return false
  }
}

async function modeChrome(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const existing = application.windows().find(isModeChrome)
    if (existing !== undefined) {
      await existing.waitForLoadState('domcontentloaded', { timeout: 8_000 })
      await existing.locator('#mode-switch').waitFor({ timeout: 8_000 })
      return existing
    }
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50) })
  }
  throw new Error(`mode chrome page did not settle: ${application.windows().map(page => page.url()).join(', ')}`)
}

async function selectMode(chrome: Page, mode: 'chat' | 'harness'): Promise<void> {
  const segment = chrome.locator(`#mode-switch [data-mode="${mode}"]`)
  await segment.click()
  await expect.poll(() => segment.getAttribute('aria-checked')).toBe('true')
}

async function waitForChromeWidth(chrome: Page, width: number): Promise<void> {
  await chrome.waitForFunction(expected => window.innerWidth === expected, width, { timeout: 8_000 })
}

async function fixtureState(application: ElectronApplication): Promise<FixtureState> {
  return application.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __dshDualModeFixture?: { state: () => FixtureState }
    }).__dshDualModeFixture
    if (fixture === undefined) throw new Error('dual-mode fixture API is unavailable')
    return fixture.state()
  })
}

async function failFixture(application: ElectronApplication, mode: 'chat' | 'harness'): Promise<void> {
  await application.evaluate((_electron, selectedMode) => {
    const fixture = (globalThis as typeof globalThis & {
      __dshDualModeFixture?: { fail: (mode: 'chat' | 'harness') => void }
    }).__dshDualModeFixture
    if (fixture === undefined) throw new Error('dual-mode fixture API is unavailable')
    fixture.fail(selectedMode)
  }, mode)
}

async function setFixtureTheme(
  application: ElectronApplication,
  target: FixtureThemeTarget,
  preference: FixtureThemePreference,
): Promise<void> {
  await application.evaluate(async (_electron, input) => {
    const fixture = (globalThis as typeof globalThis & {
      __dshDualModeFixture?: {
        setTheme: (target: FixtureThemeTarget, preference: FixtureThemePreference) => Promise<void>
      }
    }).__dshDualModeFixture
    if (fixture === undefined) throw new Error('dual-mode fixture API is unavailable')
    await fixture.setTheme(input.target, input.preference)
  }, { target, preference })
}

async function captureWindow(
  application: ElectronApplication,
  chrome: Page,
  mode: 'chat' | 'harness',
  name: string,
): Promise<void> {
  const directory = process.env.DSH_DESKTOP_SCREENSHOT_DIR
  if (directory === undefined) return
  await chrome.waitForTimeout(180)
  const content = application.windows().find((page) => {
    try {
      return new URL(page.url()).pathname === `/${mode}`
    } catch {
      return false
    }
  })
  if (content === undefined) throw new Error(`dual-mode ${mode} fixture page is unavailable`)
  const [contentImage, chromeImage, state, windowBounds, scale] = await Promise.all([
    content.screenshot(),
    chrome.screenshot({ omitBackground: true }),
    fixtureState(application),
    application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds()),
    chrome.evaluate(() => devicePixelRatio),
  ])
  const [contentMetadata, theme] = await Promise.all([
    sharp(contentImage).metadata(),
    chrome.evaluate(() => document.documentElement.dataset.theme),
  ])
  const contentBounds = state.bounds[mode]
  const chromeBounds = state.bounds.chrome
  if (contentMetadata.width === undefined || contentMetadata.height === undefined
    || contentBounds === undefined || chromeBounds === undefined) {
    throw new Error('dual-mode fixture screenshot dimensions are unavailable')
  }
  await mkdir(directory, { recursive: true })
  await sharp({
    create: {
      width: Math.round(windowBounds.width * scale),
      height: Math.round(windowBounds.height * scale),
      channels: 4,
      background: theme === 'dark' ? '#121416' : '#f5f7f8',
    },
  })
    .composite([
      { input: contentImage, left: Math.round(contentBounds.x * scale), top: Math.round(contentBounds.y * scale) },
      { input: chromeImage, left: Math.round(chromeBounds.x * scale), top: Math.round(chromeBounds.y * scale) },
    ])
    .png()
    .toFile(join(directory, `${name}.png`))
}

async function chromeForeground(chrome: Page): Promise<number[]> {
  return await chrome.evaluate(() => {
    const channels = (value: string): number[] => [...value.matchAll(/\d+/g)].map(match => Number(match[0]))
    const segment = document.querySelector('#mode-switch [data-mode="harness"]')
    if (segment === null) throw new Error('mode chrome Harness segment is unavailable')
    return channels(getComputedStyle(segment).color)
  })
}

async function modeLabelsFit(chrome: Page): Promise<boolean> {
  return chrome.locator('#mode-switch [data-mode]').evaluateAll(elements =>
    elements.every(element => element.scrollWidth <= element.clientWidth),
  )
}

async function evaluateChat<T>(application: ElectronApplication, expression: string): Promise<T> {
  return application.evaluate(async ({ webContents }, source) => {
    const contents = webContents.getAllWebContents().find((candidate) => {
      try {
        return new URL(candidate.getURL()).pathname === '/chat'
      } catch {
        return false
      }
    })
    if (contents === undefined) throw new Error('Chat fixture WebContents is unavailable')
    return await contents.executeJavaScript(source, true) as T
  }, expression)
}

async function waitForState(
  application: ElectronApplication,
  predicate: (state: FixtureState) => boolean,
): Promise<FixtureState> {
  const deadline = Date.now() + 8_000
  let lastState: FixtureState | undefined
  while (Date.now() < deadline) {
    lastState = await fixtureState(application)
    if (predicate(lastState)) return lastState
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50) })
  }
  throw new Error(`fixture state did not settle: ${JSON.stringify(lastState)}`)
}

async function launchFixture(userDataDirectory: string): Promise<ElectronApplication> {
  assertFixtureImportsResolve(resolve(fixtureRoot, 'main.mjs'))
  return await _electron.launch({
    args: [fixtureRoot],
    cwd: desktopRoot,
    env: {
      ...process.env,
      DSH_DESKTOP_FIXTURE_USER_DATA: userDataDirectory,
    },
  })
}

async function mainWindowState(application: ElectronApplication): Promise<{
  readonly destroyed: boolean
  readonly visible: boolean
}> {
  return await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      destroyed: window?.isDestroyed() ?? true,
      visible: window?.isVisible() ?? false,
    }
  })
}

/** What the update card holds for one staging transaction. */
interface HarnessUpdateCard {
  readonly phase: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly operation: 'install' | 'update' | 'reinstall'
  readonly stage?: 'preparing' | 'installing' | 'verifying' | 'health'
  readonly cancellable?: boolean
  readonly cancelling?: boolean
  readonly confirming?: boolean
  readonly collapsed?: boolean
  readonly from?: string
  readonly to?: string
  readonly reason?: string
}

/** What the traffic-light cluster previews for a pointer inside it. */
async function trafficGlyphs(chrome: Page): Promise<{
  readonly close: { readonly content: string; readonly opacity: number }
  readonly collapse: { readonly content: string; readonly opacity: number }
}> {
  return chrome.locator('.update-traffic').evaluate(() => {
    const light = (id: string) => {
      const style = getComputedStyle(document.getElementById(id)!, '::before')
      return { content: style.content, opacity: Number(style.opacity) }
    }
    return { close: light('update-traffic-close'), collapse: light('update-traffic-collapse') }
  })
}

/** The layers under the card that must not paint a rectangle of their own. */
async function updateBackings(chrome: Page): Promise<string[]> {
  return chrome.evaluate(() => ['#mode-chrome-root', 'body', 'html']
    .map(selector => getComputedStyle(document.querySelector(selector)!).backgroundColor))
}

async function showHarnessUpdate(
  application: ElectronApplication,
  view: HarnessUpdateCard | undefined,
): Promise<void> {
  await application.evaluate(async (_electron, card) => {
    const fixture = (globalThis as typeof globalThis & {
      __dshDualModeFixture?: { showHarnessUpdate: (state: HarnessUpdateCard | undefined) => void }
    }).__dshDualModeFixture
    if (fixture === undefined) throw new Error('dual-mode fixture API is unavailable')
    fixture.showHarnessUpdate(card)
  }, view)
}

async function harnessUpdateActions(application: ElectronApplication): Promise<string[]> {
  return await application.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __dshDualModeFixture?: { harnessUpdateActions: () => string[] }
    }).__dshDualModeFixture
    if (fixture === undefined) throw new Error('dual-mode fixture API is unavailable')
    return fixture.harnessUpdateActions()
  })
}

describe('desktop dual-mode Electron application', () => {
  it('defaults a fresh profile to Harness and restores the last selected mode', { timeout: 30_000 }, async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'dsh-dual-mode-persistence-'))
    let application: ElectronApplication | undefined
    try {
      application = await launchFixture(userDataDirectory)
      let chrome = await modeChrome(application)
      await waitForState(application, state =>
        state.snapshot?.selected === 'harness'
        && state.snapshot.harness.phase === 'ready'
        && state.visible.harness,
      )

      await selectMode(chrome, 'chat')
      await waitForState(application, state =>
        state.snapshot?.selected === 'chat'
        && state.snapshot.chat.phase === 'ready'
        && state.visible.chat,
      )
      await application.close()

      application = await launchFixture(userDataDirectory)
      chrome = await modeChrome(application)
      await waitForState(application, state =>
        state.snapshot?.selected === 'chat'
        && state.snapshot.chat.phase === 'ready'
        && state.visible.chat
        && !state.visible.harness,
      )
      expect(await chrome.locator('#mode-switch [data-mode="chat"]').getAttribute('aria-checked')).toBe('true')
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userDataDirectory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'darwin')(
    'hides and restores the main window for Command+W and the native close action without changing explicit quit',
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await mkdtemp(join(tmpdir(), 'dsh-dual-mode-window-lifecycle-'))
      let application: ElectronApplication | undefined
      try {
        application = await launchFixture(userDataDirectory)
        await modeChrome(application)
        const initial = await waitForState(application, state =>
          state.snapshot?.selected === 'harness'
          && state.snapshot.harness.phase === 'ready'
          && state.visible.harness,
        )
        const shell = application.windows().find(page => page.url().endsWith('/shell.html'))
        if (shell === undefined) throw new Error('dual-mode shell window is unavailable')

        expect(await application.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()?.items
            .flatMap(entry => entry.submenu?.items ?? [])
            .find(entry => entry.role === 'close')
          return item === undefined
            ? undefined
            : { accelerator: item.accelerator, enabled: item.enabled, visible: item.visible }
        })).toEqual({ accelerator: 'Command+W', enabled: true, visible: true })

        await shell.bringToFront()
        await shell.keyboard.press('Meta+W')
        await expect.poll(() => mainWindowState(application!)).toEqual({ destroyed: false, visible: false })
        const commandHidden = await fixtureState(application)
        expect(commandHidden.snapshot).toEqual(initial.snapshot)
        expect(commandHidden.generations).toEqual(initial.generations)

        await application.evaluate(({ app }) => { app.emit('activate') })
        await expect.poll(() => mainWindowState(application!)).toEqual({ destroyed: false, visible: true })

        await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close() })
        await expect.poll(() => mainWindowState(application!)).toEqual({ destroyed: false, visible: false })
        const nativeHidden = await fixtureState(application)
        expect(nativeHidden.snapshot).toEqual(initial.snapshot)
        expect(nativeHidden.generations).toEqual(initial.generations)

        await application.evaluate(({ app }) => { app.emit('activate') })
        await expect.poll(() => mainWindowState(application!)).toEqual({ destroyed: false, visible: true })

        expect(await application.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()?.items
            .flatMap(entry => entry.submenu?.items ?? [])
            .find(entry => entry.role === 'quit')
          return item === undefined ? undefined : { accelerator: item.accelerator, enabled: item.enabled }
        })).toEqual({ accelerator: 'CommandOrControl+Q', enabled: true })

        const closed = application.waitForEvent('close')
        await application.evaluate(({ app }) => { app.quit() })
        await closed
        application = undefined
      } finally {
        await application?.close().catch(() => undefined)
        await rm(userDataDirectory, { recursive: true, force: true })
      }
    },
  )

  it('retains Chat state, isolates failures, and clears the Chat partition', { timeout: 30_000 }, async () => {
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'dsh-dual-mode-electron-'))
    let application: ElectronApplication | undefined
    try {
      application = await launchFixture(userDataDirectory)
      const chrome = await modeChrome(application)
      await waitForChromeWidth(chrome, 164)
      expect(await chrome.locator('#mode-menu').count()).toBe(0)
      expect(await chrome.locator('.chevron').count()).toBe(0)
      await waitForState(application, state =>
        state.snapshot?.harness.phase === 'ready'
        && state.visible.harness
        && !state.visible.chat,
      )
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.mode)).toBe('harness')
      expect(await chrome.locator('#mode-switch [data-mode="chat"]').getAttribute('aria-checked')).toBe('false')
      expect(await chrome.locator('#mode-switch [data-mode="harness"]').getAttribute('aria-checked')).toBe('true')
      await chrome.locator('#mode-switch [data-mode="harness"]').focus()
      await chrome.keyboard.press('Home')
      await waitForState(application, state => state.snapshot?.selected === 'chat')
      await waitForChromeWidth(chrome, 200)
      await chrome.keyboard.press('End')
      await waitForState(application, state => state.snapshot?.selected === 'harness')
      await waitForChromeWidth(chrome, 164)
      await chrome.keyboard.press('ArrowLeft')
      await waitForState(application, state => state.snapshot?.selected === 'chat')
      await chrome.keyboard.press('ArrowRight')
      await waitForState(application, state => state.snapshot?.selected === 'harness')
      await chrome.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
      const shell = application.windows().find(page => page.url().endsWith('/shell.html'))
      const harnessContent = application.windows().find((page) => {
        try {
          return new URL(page.url()).pathname === '/harness'
        } catch {
          return false
        }
      })
      if (shell === undefined || harnessContent === undefined) {
        throw new Error('dual-mode shell hierarchy did not settle')
      }
      const [shellHeight, chromeHeight, contentHeight, switchBox, dragBox] = await Promise.all([
        shell.evaluate(() => innerHeight),
        chrome.evaluate(() => innerHeight),
        harnessContent.evaluate(() => innerHeight),
        chrome.locator('#mode-switch').boundingBox(),
        shell.locator('#window-drag-region').boundingBox(),
      ])
      expect(contentHeight).toBe(shellHeight - 44)
      expect(chromeHeight).toBe(32)
      expect(switchBox).not.toBeNull()
      expect(switchBox).toMatchObject({ x: 0, y: 0, width: 164, height: 32 })
      expect(dragBox).not.toBeNull()
      expect(dragBox?.x).toBe(300)
      expect(await chrome.locator('.mode-mark').count()).toBe(0)
      expect(await chrome.locator('#mode-switch').evaluate((element) => {
        const style = getComputedStyle(element)
        return { border: style.borderTopWidth, columns: style.gridTemplateColumns }
      })).toEqual({ border: '0px', columns: '82px 82px' })
      expect(await chrome.locator('#mode-switch [data-mode="chat"]').textContent()).toBe('Chat')
      expect(await chrome.locator('#mode-switch [data-mode="harness"]').textContent()).toBe('Harness')
      expect(await modeLabelsFit(chrome)).toBe(true)

      await setFixtureTheme(application, 'harness', 'light')
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
      await expect.poll(async () => Math.max(...(await chromeForeground(chrome)))).toBeLessThan(128)
      await captureWindow(application, chrome, 'harness', 'harness-light-selected')
      await setFixtureTheme(application, 'harness', 'dark')
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
      await expect.poll(async () => Math.min(...(await chromeForeground(chrome)))).toBeGreaterThan(200)
      await captureWindow(application, chrome, 'harness', 'harness-dark-selected')

      await selectMode(chrome, 'chat')
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.mode)).toBe('chat')
      const initialChat = await waitForState(application, state =>
        state.snapshot?.selected === 'chat'
        && state.snapshot.chat.phase === 'ready'
        && state.visible.chat
        && !state.visible.harness,
      )
      expect(initialChat.preferences).toEqual({ chat: 'dark', harness: 'dark' })
      expect(initialChat.schemes).toEqual({ chat: 'dark', harness: 'dark' })
      expect(initialChat.reloads.chat).toBeGreaterThan(0)
      expect(await modeLabelsFit(chrome)).toBe(true)
      const chatContent = application.windows().find((page) => {
        try {
          return new URL(page.url()).pathname === '/chat'
        } catch {
          return false
        }
      })
      if (chatContent === undefined || initialChat.bounds.chat === undefined || initialChat.bounds.chrome === undefined) {
        throw new Error('Chat fixture geometry is unavailable')
      }
      expect(initialChat.bounds.chrome.x + initialChat.bounds.chrome.width).toBeLessThanOrEqual(dragBox!.x)
      const sidebarToggleBox = await chatContent.locator('#chat-sidebar-toggle').boundingBox()
      if (sidebarToggleBox === null) throw new Error('Chat fixture sidebar toggle is unavailable')
      expect(initialChat.bounds.chat.y + sidebarToggleBox.y)
        .toBeGreaterThanOrEqual(initialChat.bounds.chrome.y + initialChat.bounds.chrome.height)
      await chatContent.locator('#chat-sidebar-toggle').click()
      const runningApplication = application
      await expect.poll(async () => (await fixtureState(runningApplication)).sidebarClicks).toBe(1)

      const reloadsBeforeChatChoice = initialChat.reloads.chat
      await setFixtureTheme(application, 'chat', 'light')
      const chatLight = await waitForState(application, state =>
        state.preferences.chat === 'light'
        && state.preferences.harness === 'light'
        && state.schemes.chat === 'light'
        && state.schemes.harness === 'light',
      )
      expect(chatLight.reloads.chat).toBe(reloadsBeforeChatChoice)
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
      await expect.poll(() => shell.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
      const chatLightBackground = await evaluateChat<string>(application, 'getComputedStyle(document.body).backgroundColor')
      expect(await shell.locator('#titlebar-backdrop').evaluate(element => getComputedStyle(element).backgroundColor))
        .toBe(chatLightBackground)

      await selectMode(chrome, 'harness')
      const harnessLight = await waitForState(application, state => state.visible.harness && !state.visible.chat)
      await setFixtureTheme(application, 'chat', 'dark')
      const correctedChat = await waitForState(application, state =>
        state.preferences.chat === 'light'
        && state.preferences.harness === 'light'
        && state.reloads.chat > harnessLight.reloads.chat,
      )
      expect(correctedChat.schemes).toEqual({ chat: 'light', harness: 'light' })
      await setFixtureTheme(application, 'harness', 'system')
      await setFixtureTheme(application, 'system', 'dark')
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
      await expect.poll(async () => Math.min(...(await chromeForeground(chrome)))).toBeGreaterThan(200)
      await waitForState(application, state =>
        state.preferences.chat === 'system'
        && state.preferences.harness === 'system'
        && state.schemes.chat === 'dark'
        && state.schemes.harness === 'dark',
      )
      await selectMode(chrome, 'chat')
      await waitForState(application, state => state.visible.chat && !state.visible.harness)
      await expect.poll(() => shell.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
      const chatDarkBackground = await evaluateChat<string>(application, 'getComputedStyle(document.body).backgroundColor')
      expect(await shell.locator('#titlebar-backdrop').evaluate(element => getComputedStyle(element).backgroundColor))
        .toBe(chatDarkBackground)
      await captureWindow(application, chrome, 'chat', 'chat-dark-selected')
      await setFixtureTheme(application, 'system', 'light')
      await expect.poll(() => chrome.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
      await evaluateChat(application, `(() => {
        document.querySelector('#chat-draft').value = 'retained draft'
        localStorage.setItem('login-marker', 'fixture-user')
      })()`)

      await selectMode(chrome, 'harness')
      await waitForState(application, state => state.visible.harness && !state.visible.chat)
      await selectMode(chrome, 'chat')
      await waitForState(application, state => state.visible.chat && !state.visible.harness)
      await expect(evaluateChat<string>(application,
        'document.querySelector(\'#chat-draft\').value',
      )).resolves.toBe('retained draft')
      expect((await fixtureState(application)).generations.chat).toBe(initialChat.generations.chat)

      await failFixture(application, 'harness')
      await waitForState(application, state =>
        state.snapshot?.harness.phase === 'failed'
        && state.snapshot.chat.phase === 'ready'
        && state.visible.chat,
      )

      await selectMode(chrome, 'harness')
      await waitForState(application, state =>
        state.snapshot?.harness.phase === 'ready'
        && state.visible.harness
        && !state.visible.chat,
      )
      await failFixture(application, 'chat')
      await waitForState(application, state =>
        state.snapshot?.chat.phase === 'failed'
        && state.snapshot.harness.phase === 'ready'
        && state.visible.harness,
      )

      await selectMode(chrome, 'chat')
      const recreatedChat = await waitForState(application, state =>
        state.snapshot?.chat.phase === 'ready'
        && state.visible.chat,
      )
      expect(recreatedChat.generations.chat).toBeGreaterThan(initialChat.generations.chat)
      await expect(evaluateChat<string | null>(application,
        'localStorage.getItem(\'login-marker\')',
      )).resolves.toBe('fixture-user')

      await chrome.locator('#chat-actions').click()
      await chrome.locator('#clear-chat-data').click()
      await chrome.locator('#clear-chat-confirm[open]').waitFor()
      await chrome.locator('#confirm-clear').click()
      const clearedChat = await waitForState(application, state =>
        state.snapshot?.chat.phase === 'ready'
        && state.visible.chat
        && state.generations.chat > recreatedChat.generations.chat,
      )
      expect(clearedChat.snapshot?.harness.phase).toBe('ready')
      expect(clearedChat.preferences).toEqual({ chat: 'system', harness: 'system' })
      expect(clearedChat.schemes).toEqual({ chat: 'light', harness: 'light' })
      await expect(evaluateChat<string | null>(application,
        'localStorage.getItem(\'login-marker\')',
      )).resolves.toBeNull()

      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(980, 720) })
      await waitForChromeWidth(chrome, 200)
      expect(await chrome.locator('#mode-switch [data-mode="chat"]').textContent()).toBe('Chat')
      expect(await chrome.locator('#mode-switch [data-mode="harness"]').textContent()).toBe('Harness')
      expect(await modeLabelsFit(chrome)).toBe(true)
      expect(await chrome.locator('.mode-mark').count()).toBe(0)
      expect(await chrome.locator('#mode-menu').count()).toBe(0)
      expect(await chrome.locator('.chevron').count()).toBe(0)
      await captureWindow(application, chrome, 'chat', 'chat-light-selected')
    } finally {
      await application?.close().catch(() => undefined)
      await rm(userDataDirectory, { recursive: true, force: true })
    }
  })
})


interface NotificationFixture {
  notificationCount(): number
  notify(event: { id: string; source: 'chat' | 'harness'; kind: 'completed' | 'failed' | 'action-required'; occurredAt: number; topLevel: boolean; targetId: string; presentation?: 'background-only' }): Promise<void>
  badge(): number
  clickNotification(): void
  editAccent(): Promise<void>
}

/** Background-only occurrence exactly as the audited Harness poller emits it. */
function harnessOutcome(id: string, kind: 'completed' | 'failed'): Parameters<NotificationFixture['notify']>[0] {
  return { id, source: 'harness', kind, targetId: 'root', occurredAt: 1, topLevel: true, presentation: 'background-only' }
}

async function notify(application: ElectronApplication, event: Parameters<NotificationFixture['notify']>[0]): Promise<void> {
  // Electron's evaluate passes the Electron module first, then the argument.
  await application.evaluate(async (_electron, payload) => {
    await (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture.notify(payload)
  }, event)
}

async function harnessDot(chrome: Page): Promise<string> {
  return await chrome.locator('button[data-mode="harness"]').getAttribute('data-attention') ?? 'missing'
}

/** Read the numeric Dock badge the fixture adapter last received. */
async function dockBadge(application: ElectronApplication): Promise<number> {
  return await application.evaluate(() =>
    (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture.badge())
}

/**
 * Wait until the chrome renderer has consumed its first notification publication.
 *
 * The dot is rendered from the last published state, so a test that notifies
 * before that first publication would race the preload's IPC subscription
 * instead of exercising the dot.
 */
async function waitForChromeNotifications(chrome: Page): Promise<void> {
  await expect.poll(() => chrome.locator('button[data-mode="chat"]').getAttribute('aria-label')).toBe('Chat')
}

it('renders persisted unread semantics and restores a minimized window from a notification', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-notifications-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    const chrome = await modeChrome(application)
    await application.evaluate(async () => {
      const f = (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture
      for (const [id, source, kind] of [['a', 'chat', 'completed'], ['b', 'harness', 'failed'], ['c', 'harness', 'action-required']] as const) {
        await f.notify({ id, source, kind, targetId: id, occurredAt: 1, topLevel: true })
      }
    })
    const chat = chrome.locator('button[data-mode="chat"]')
    const harness = chrome.locator('button[data-mode="harness"]')
    await expect.poll(() => chat.getAttribute('data-unread')).toBe('1')
    expect(await harness.getAttribute('data-unread')).toBe('2')
    expect(await harness.getAttribute('data-notification-kind')).toBe('failed')
    expect(await chrome.locator('#mode-switch button').evaluateAll(buttons => buttons.map(button => ({
      label: button.getAttribute('aria-label'), kind: (button as HTMLElement).dataset.notificationKind,
    })))).toMatchInlineSnapshot(`
      [
        {
          "kind": "completed",
          "label": "Chat (1)",
        },
        {
          "kind": "failed",
          "label": "Harness (2)",
        },
      ]
    `)
    await application.evaluate(async () => {
      await (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture.editAccent()
    })
    await chrome.locator('#notification-accent-dialog').waitFor({ state: 'visible' })
    await chrome.locator('#notification-accent-color').fill('#00ff00')
    await chrome.locator('#notification-accent-save').click()
    await expect.poll(() => chat.evaluate(el => getComputedStyle(el, '::after').backgroundColor)).toBe('rgb(0, 255, 0)')
    expect(await harness.evaluate(el => getComputedStyle(el, '::after').backgroundColor)).not.toBe('rgb(0, 255, 0)')
    // The Dock number counts unseen source reminders, never ordinary unread. Whether
    // this focused Harness window suppressed the reminder decides the number, and the
    // badge must agree with the rendered dot rather than with the unread totals.
    const expectedDock = await harness.getAttribute('data-attention') === 'true' ? 1 : 0
    await application.evaluate(async (_electron, expected: number) => {
      const f = (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture
      if (f.badge() !== expected) throw new Error('ordinary unread must not drive the Dock number')
      await f.notify({ id: 'warning', source: 'chat', kind: 'action-required', targetId: 'warning', occurredAt: 2, topLevel: true })
    }, expectedDock)
    await expect.poll(() => chat.getAttribute('data-notification-kind')).toBe('action-required')
    expect(await chat.evaluate(el => getComputedStyle(el, '::after').backgroundColor)).not.toBe('rgb(0, 255, 0)')
    expect(await chat.evaluate(el => getComputedStyle(el, '::after').backgroundColor))
      .not.toBe(await harness.evaluate(el => getComputedStyle(el, '::after').backgroundColor))
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.minimize() })
    await application.evaluate(() => {
      (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture.clickNotification()
    })
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return w?.isVisible() && !w.isMinimized()
    })).toBe(true)
    expect(await dockBadge(application)).toBe(expectedDock)
    await application.close()
    application = await launchFixture(directory)
    const restored = await modeChrome(application)
    await expect.poll(() => restored.locator('button[data-mode="chat"]').getAttribute('data-unread')).toBe('2')
    expect(await restored.locator('button[data-mode="harness"]').getAttribute('data-unread')).toBe('2')
    // The Dock number is restored from the durable pending count, not from unread.
    await expect.poll(() => dockBadge(application!)).toBe(expectedDock)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})


it('delivers notification-only Harness failures while hidden without unread or replay', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-background-notifications-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    await modeChrome(application)
    await application.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.hide()
      const f = (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture
      const event = { id: 'background-failure', source: 'harness', kind: 'failed', targetId: 'root', occurredAt: 1, topLevel: true, presentation: 'background-only' } as const
      await f.notify(event); await f.notify(event)
    })
    const observed = await application.evaluate(() => {
      const f = (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture
      return { count: f.notificationCount(), badge: f.badge() }
    })
    expect(observed).toEqual({ count: 1, badge: 1 })
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show() })
    await application.close()
    application = await launchFixture(directory)
    await modeChrome(application)
    // The receipt is deduplicated across restart while its unseen reminder, and so
    // the Dock number, is restored.
    expect(await application.evaluate(() => {
      const f = (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture
      return { count: f.notificationCount(), badge: f.badge() }
    })).toEqual({ count: 0, badge: 1 })
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it('raises a source-level Harness dot for unseen results and clears it on entry', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-harness-attention-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    let chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)

    // A fresh profile shows no dot.
    expect(await harnessDot(chrome)).not.toBe('true')

    // A background outcome raises the dot while the window is hidden.
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
    await notify(application, harnessOutcome('unseen', 'failed'))
    await expect.poll(() => harnessDot(chrome)).toBe('true')
    // The dot is a boolean in the source UI, while the Dock carries the number.
    await expect.poll(() => dockBadge(application!)).toBe(1)
    expect(await chrome.locator('button[data-mode="chat"]').getAttribute('data-unread')).toBe('')
    expect(await chrome.locator('button[data-mode="harness"]').getAttribute('data-unread')).toBe('')
    // It reuses the existing mode-entry dot styling.
    const harnessButton = chrome.locator('button[data-mode="harness"]')
    expect(await harnessButton.evaluate(el => getComputedStyle(el, '::after').content)).not.toBe('none')
    expect(await harnessButton.evaluate(el => getComputedStyle(el, '::after').width)).toBe('7px')

    // Entering Harness clears it and keeps it cleared across a restart.
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show() })
    await selectMode(chrome, 'harness')
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(0)

    await application.close()
    application = await launchFixture(directory)
    chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(0)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it('clears the Harness dot when the user follows the system notification into Harness', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-harness-attention-click-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    const chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
    await notify(application, harnessOutcome('followed', 'failed'))
    await expect.poll(() => harnessDot(chrome)).toBe('true')
    // The background failure still dispatched a real alert.
    expect(await application.evaluate(() =>
      (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture })
        .__dshDualModeFixture.notificationCount())).toBe(1)

    await application.evaluate(() => {
      (globalThis as typeof globalThis & { __dshDualModeFixture: NotificationFixture }).__dshDualModeFixture.clickNotification()
    })
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => chrome.locator('button[data-mode="harness"]').getAttribute('aria-checked')).toBe('true')
    // Following the notification into Harness clears the Harness Dock reminder.
    await expect.poll(() => dockBadge(application!)).toBe(0)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['light', 'dark'] as const)('renders both restored attention dots in notification red in %s mode', { timeout: 30_000 }, async (theme) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-red-attention-'))
  let application: ElectronApplication | undefined
  try {
    await writeFile(join(directory, 'desktop-state.json'), JSON.stringify({
      version: 2, mode: 'chat', theme,
      notifications: { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, accent: '#00ff00' }, events: [], chatAttention: true, harnessAttention: true },
    }))
    application = await launchFixture(directory)
    const chrome = await modeChrome(application)
    // A pre-count document migrates each set dot to one pending occurrence, so the
    // restored Dock number starts at two.
    await expect.poll(() => dockBadge(application!)).toBe(2)
    for (const source of ['chat', 'harness'] as const) {
      const button = chrome.locator(`button[data-mode="${source}"]`)
      await expect.poll(() => button.getAttribute('data-attention')).toBe('true')
      expect(await button.evaluate(el => getComputedStyle(el, '::after').backgroundColor)).toBe('rgb(255, 59, 48)')
      expect(await button.getAttribute('data-unread')).toBe('')
    }
    await selectMode(chrome, 'chat')
    await expect.poll(() => chrome.locator('button[data-mode="chat"]').getAttribute('data-attention')).not.toBe('true')
    expect(await harnessDot(chrome)).toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(1)
    await selectMode(chrome, 'harness')
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(0)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it('restores an unseen Harness dot after a restart and keeps a cleared dot cleared', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-harness-attention-restart-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    let chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
    await notify(application, harnessOutcome('persisted', 'completed'))
    await expect.poll(() => harnessDot(chrome)).toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(1)

    // Close while the dot is set: a restart must still show it and its Dock number.
    await application.close()
    application = await launchFixture(directory)
    chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)
    await expect.poll(() => harnessDot(chrome)).toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(1)

    // Entering Harness clears it, and that cleared value also survives a restart.
    await selectMode(chrome, 'harness')
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(0)
    await application.close()
    application = await launchFixture(directory)
    chrome = await modeChrome(application)
    await waitForChromeNotifications(chrome)
    await expect.poll(() => harnessDot(chrome)).not.toBe('true')
    await expect.poll(() => dockBadge(application!)).toBe(0)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it('reports a running Harness update in a card the rest of the window outlives', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-harness-update-card-'))
  let application: ElectronApplication | undefined
  try {
    application = await launchFixture(directory)
    const chrome = await modeChrome(application)
    await waitForState(application, state => state.snapshot?.harness.phase === 'ready')
    const content = await application.evaluate(({ BrowserWindow }) => {
      const { width, height } = BrowserWindow.getAllWindows()[0]!.getContentBounds()
      return { width, height }
    })

    await showHarnessUpdate(application, {
      phase: 'running',
      operation: 'update',
      stage: 'installing',
      cancellable: true,
      cancelling: false,
      confirming: false,
      collapsed: false,
    })

    const observed = await chrome.locator('#harness-update').evaluate((card) => {
      const box = card.getBoundingClientRect()
      return {
        phase: card.dataset.phase,
        stage: card.dataset.stage,
        headline: document.querySelector('#update-stage .update-stage-in')?.textContent,
        footnote: document.getElementById('update-note')?.textContent,
        uncancellable: document.getElementById('update-traffic-close')?.dataset.uncancellable,
        collapseDisabled: (document.getElementById('update-traffic-collapse') as HTMLButtonElement | null)?.disabled,
        actionsHidden: document.getElementById('update-actions')?.hidden,
        controlsVisible: getComputedStyle(document.getElementById('chrome-controls')!).visibility,
        markWidth: document.querySelector('.update-mark')?.getBoundingClientRect().width,
        tileWidth: document.querySelector('.update-tile')?.getBoundingClientRect().width,
        tileRadius: getComputedStyle(document.querySelector('.update-tile')!).borderRadius,
        cardRadius: getComputedStyle(card).borderRadius,
        markMotion: getComputedStyle(document.querySelector('.update-mark')!).animationName,
        holds: { scrollHeight: card.scrollHeight, clientHeight: card.clientHeight },
        fills: { x: box.x, y: box.y, width: box.width, height: box.height },
        dots: [...document.querySelectorAll('#update-dots i')]
          .map(dot => getComputedStyle(dot).backgroundColor),
      }
    })

    expect(observed.phase).toBe('running')
    expect(observed.stage).toBe('installing')
    // The line names the step the runtime reported, in the shell's own language.
    expect(observed.headline).toBe('Downloading and installing Harness…')
    expect(observed.footnote).toBe('Keep the app open while the update runs.')
    expect(observed.uncancellable).toBe('false')
    expect(observed.collapseDisabled).toBe(false)
    expect(observed.actionsHidden).toBe(true)
    // The mark reads as a shipped app icon: the tile carries it, and the tile is
    // the object the eye measures, not a bare logo.
    expect(observed.tileWidth).toBeGreaterThanOrEqual(52)
    expect(observed.tileWidth).toBeLessThanOrEqual(56)
    expect(observed.markWidth).toBeLessThan(observed.tileWidth ?? 0)
    expect(observed.tileRadius).toBe('14px')
    // The card owns its corner, and nothing behind it owns a rectangle.
    expect(observed.cardRadius).toBe('12px')
    expect(observed.holds.scrollHeight).toBe(observed.holds.clientHeight)
    expect(observed.markMotion).toBe('update-mark-life')
    expect(await updateBackings(chrome)).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
    // A user who asked for less motion gets a still mark: the card says the same
    // thing either way, and nothing about the transaction changes.
    await chrome.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => chrome.locator('.update-mark').evaluate(
      mark => getComputedStyle(mark).animationName,
    )).toBe('none')
    await chrome.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => chrome.locator('.update-mark').evaluate(
      mark => getComputedStyle(mark).animationName,
    )).toBe('update-mark-life')

    // Entering the cluster previews both live actions at once, and leaving the
    // whole cluster takes both away; a precise hover is not required.
    expect(await trafficGlyphs(chrome)).toEqual({
      close: { content: '"\u00d7"', opacity: 0 },
      collapse: { content: '"\u2212"', opacity: 0 },
    })
    await chrome.hover('.update-traffic')
    await expect.poll(() => trafficGlyphs(chrome)).toEqual({
      close: { content: '"\u00d7"', opacity: 1 },
      collapse: { content: '"\u2212"', opacity: 1 },
    })
    await chrome.locator('#update-stage').hover()
    await expect.poll(() => trafficGlyphs(chrome)).toMatchObject({
      close: { opacity: 0 },
      collapse: { opacity: 0 },
    })
    // Two of the four dots are lit: the transaction has reached its second step.
    expect(observed.dots).toHaveLength(4)
    expect(observed.dots[0]).toBe(observed.dots[1])
    expect(observed.dots[2]).toBe(observed.dots[3])
    expect(observed.dots[0]).not.toBe(observed.dots[2])
    // The mode switch cannot share the card's rectangle, so it stands aside.
    expect(observed.controlsVisible).toBe('hidden')

    const held = (await fixtureState(application)).bounds.chrome
    expect(held).toBeDefined()
    if (held === undefined) throw new Error('dual-mode fixture chrome bounds are unavailable')
    expect(observed.fills).toEqual({ x: 0, y: 0, width: held.width, height: held.height })
    // The card owns a small rectangle, so the surface under it still answers.
    expect(held.width).toBeLessThan(content.width / 2)
    expect(held.height).toBeLessThan(content.height / 2)
    expect(held.x + held.width / 2).toBeCloseTo(content.width / 2, 0)
    expect(held.y + held.height / 2).toBeLessThan(content.height / 2)

    // The red control asks the transaction owner to cancel; the owner answers
    // with the question the card then shows.
    await chrome.locator('#update-traffic-close').click()
    await expect.poll(() => harnessUpdateActions(application!)).toEqual(['cancel'])
    await showHarnessUpdate(application, {
      phase: 'running',
      operation: 'update',
      stage: 'installing',
      cancellable: true,
      cancelling: false,
      confirming: true,
      collapsed: false,
    })
    await expect.poll(() => chrome.locator('#update-stage').textContent())
      .toBe('Cancel the Harness update?')
    expect(await chrome.locator('#update-actions').isVisible()).toBe(true)
    await chrome.locator('#update-confirm-cancel').click()
    await expect.poll(() => harnessUpdateActions(application!))
      .toEqual(['cancel', 'confirm-cancel'])

    // A step the runtime says it cannot interrupt takes the red control away and
    // answers the click with an explanation instead of a cancel.
    await showHarnessUpdate(application, {
      phase: 'running',
      operation: 'update',
      stage: 'verifying',
      cancellable: false,
      cancelling: false,
      confirming: false,
      collapsed: false,
    })
    await expect.poll(() => chrome.locator('#update-stage').textContent())
      .toBe('Verifying the installation…')
    expect(await chrome.locator('#update-traffic-close').evaluate(
      light => light.dataset.uncancellable,
    )).toBe('true')
    // A step that cannot be interrupted must not preview a cancel it cannot do.
    await chrome.hover('.update-traffic')
    await expect.poll(() => trafficGlyphs(chrome)).toMatchObject({
      close: { opacity: 0 },
      collapse: { opacity: 1 },
    })
    await chrome.locator('#update-stage').hover()
    await chrome.locator('#update-traffic-close').click()
    expect(await chrome.locator('#update-note').textContent())
      .toBe('This step cannot be interrupted, so the update cannot be cancelled yet.')
    expect(await harnessUpdateActions(application)).toEqual(['cancel', 'confirm-cancel'])

    // A collapsed card gives the title bar and the whole window back.
    await showHarnessUpdate(application, {
      phase: 'running',
      operation: 'update',
      stage: 'installing',
      cancellable: true,
      cancelling: false,
      confirming: false,
      collapsed: true,
    })
    await expect.poll(async () => (await fixtureState(application!)).bounds.chrome?.width).toBe(164)
    expect(await chrome.locator('#harness-update').isVisible()).toBe(false)

    await showHarnessUpdate(application, {
      phase: 'completed',
      operation: 'update',
      from: '0.1.0',
      to: '0.2.0',
    })
    await expect.poll(() => chrome.locator('#update-stage').textContent()).toBe('Harness update installed')
    expect(await chrome.locator('#update-note').textContent()).toBe('0.1.0 → 0.2.0')
    // What the card says is what is true: installed, and not yet what runs.
    expect(await chrome.locator('#update-effect').isVisible()).toBe(true)
    expect(await chrome.locator('#update-effect').textContent())
      .toBe('Takes effect after restarting Harness.')
    expect(await chrome.locator('#update-dots').isVisible()).toBe(false)
    // The version line, the effect line and the button all fit the same card.
    expect(await chrome.locator('#harness-update').evaluate(card => ({
      scrollHeight: card.scrollHeight,
      clientHeight: card.clientHeight,
    }))).toEqual({ scrollHeight: 214, clientHeight: 214 })
    await chrome.locator('#update-restart').click()
    expect(await harnessUpdateActions(application)).toContain('restart')

    // A reinstall promotes the version already in use, so it has no version to
    // come from and must not read as an upgrade over the rollback target.
    await showHarnessUpdate(application, {
      phase: 'completed',
      operation: 'reinstall',
      to: '0.2.0',
    })
    await expect.poll(() => chrome.locator('#update-stage').textContent()).toBe('Harness reinstalled')
    expect(await chrome.locator('#update-note').textContent()).toBe('0.2.0')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
