/**
 * End-to-end Chat completion notifications through the real Electron composition.
 *
 * The fixture's chat surface serves a same-origin stand-in for the audited
 * completion stream, so the real observer, the real notification owner, and the
 * real mode controller are exercised without reaching the real website.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { assertFixtureImportsResolve } from './electron-fixture-artifacts.ts'

interface ChatNotificationFixture {
  notificationCount(): number
  lastNotification(): { readonly source?: string; readonly kind?: string; readonly presentation?: string } | undefined
  badge(): number
  clickNotification(): void
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolve(desktopRoot, 'tests/fixtures/dual-mode-app')

async function launch(userDataDirectory: string): Promise<ElectronApplication> {
  assertFixtureImportsResolve(resolve(fixtureRoot, 'main.mjs'))
  return await _electron.launch({
    args: [fixtureRoot],
    cwd: desktopRoot,
    env: { ...process.env, DSH_DESKTOP_FIXTURE_USER_DATA: userDataDirectory },
  })
}

function isPath(page: Page, path: string): boolean {
  // Local surfaces are `file://` URLs, whose pathname is the whole filesystem
  // path, so suffix matching is the only form that covers both kinds of page.
  return page.url().endsWith(path)
}

async function waitForPage(application: ElectronApplication, path: string): Promise<Page> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = application.windows().find(page => isPath(page, path))
    if (found !== undefined) {
      await found.waitForLoadState('domcontentloaded')
      return found
    }
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50) })
  }
  throw new Error(`${path} page did not settle: ${application.windows().map(page => page.url()).join(', ')}`)
}

/** Open Chat so its surface, partition, and real observer wiring exist. */
async function openChat(application: ElectronApplication): Promise<{ chrome: Page; chat: Page }> {
  const chrome = await waitForPage(application, '/mode-chrome.html')
  await chrome.locator('#mode-switch').waitFor({ timeout: 8_000 })
  await chrome.locator('#mode-switch [data-mode="chat"]').click()
  await expect.poll(() => chrome.locator('#mode-switch [data-mode="chat"]').getAttribute('aria-checked')).toBe('true')
  return { chrome, chat: await waitForPage(application, '/chat') }
}

/** Drive one finished assistant turn through the Chat renderer itself. */
async function finishChatReply(chat: Page, path = '/api/v0/chat/completion'): Promise<number> {
  return await chat.evaluate(async (target) => {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', parent_message_id: null }),
    })
    const body = await response.text()
    return body.includes('[DONE]') ? response.status : -response.status
  }, path)
}

async function notificationState(application: ElectronApplication) {
  return await application.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & { __dshDualModeFixture: ChatNotificationFixture }).__dshDualModeFixture
    return {
      count: fixture.notificationCount(),
      badge: fixture.badge(),
      last: fixture.lastNotification(),
    }
  })
}

/** Read the durable ledger, which is where both policies are recorded. */
async function persistedNotifications(directory: string) {
  const raw = await readFile(join(directory, 'desktop-state.json'), 'utf8')
  const document = JSON.parse(raw) as {
    notifications?: {
      chatAttention?: boolean
      harnessAttention?: boolean
      chatPendingCount?: number
      harnessPendingCount?: number
      events?: readonly { readonly source: string; readonly read: boolean }[]
    }
  }
  const events = document.notifications?.events ?? []
  return {
    chatAttention: document.notifications?.chatAttention,
    harnessAttention: document.notifications?.harnessAttention,
    chatPendingCount: document.notifications?.chatPendingCount,
    harnessPendingCount: document.notifications?.harnessPendingCount,
    events,
    unread: events.filter(event => !event.read).length,
  }
}

describe('Chat completion notifications', () => {
  it('alerts for a finished reply while the desktop is hidden, with one Dock reminder and no unread', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)
      const state = await notificationState(application)
      expect(state.last?.source).toBe('chat')
      expect(state.last?.kind).toBe('completed')
      expect(state.last?.presentation).toBe('background-only')
      // Notification-only: the receipt stays read, so ordinary unread stays empty,
      // while the unseen source-level reminder raises the Dock number to one.
      expect(state.badge).toBe(1)
      // The same occurrence also raises the Chat source reminder, as one receipt.
      const ledger = await persistedNotifications(directory)
      expect(ledger.chatAttention).toBe(true)
      expect(ledger.chatPendingCount).toBe(1)
      expect(ledger.events).toHaveLength(1)
      expect(ledger.unread).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('suppresses the alert while the desktop is foreground, on either mode', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-fg-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chrome, chat } = await openChat(application)
      // Suppression depends on real window focus, which another spec in the same
      // run can take away. Force it and wait for it before measuring.
      await application.evaluate(({ BrowserWindow, app }) => {
        BrowserWindow.getAllWindows()[0]?.show()
        BrowserWindow.getAllWindows()[0]?.focus()
        app.focus({ steal: true })
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() === true)).toBe(true)
      expect(await finishChatReply(chat)).toBe(200)
      // Give the observer and the owner a full turn to settle before asserting absence.
      await new Promise((resolveWait) => { setTimeout(resolveWait, 800) })
      expect(await notificationState(application)).toMatchObject({ count: 0, badge: 0 })
      // Looking at a focused, restored Chat means nothing is left to remind about.
      expect((await persistedNotifications(directory)).chatAttention).not.toBe(true)

      // Foreground on Harness is still foreground for the desktop as a whole.
      await chrome.locator('#mode-switch [data-mode="harness"]').click()
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="harness"]').getAttribute('aria-checked')).toBe('true')
      await application.evaluate(({ BrowserWindow, app }) => {
        BrowserWindow.getAllWindows()[0]?.focus()
        app.focus({ steal: true })
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() === true)).toBe(true)
      expect(await finishChatReply(chat)).toBe(200)
      await new Promise((resolveWait) => { setTimeout(resolveWait, 800) })
      // Suppressed banner, raised reminder: the Dock number follows the unseen
      // source, not the count of system notifications.
      expect(await notificationState(application)).toMatchObject({ count: 0, badge: 1 })
      // The headline integration case: the user is inside DeepSeek Desktop but not
      // looking at Chat, so the reminder is raised while the alert stays suppressed.
      const ledger = await persistedNotifications(directory)
      expect(ledger.chatAttention).toBe(true)
      expect(ledger.chatPendingCount).toBe(1)
      expect(ledger.unread).toBe(0)
      expect(ledger.events.filter(event => event.source === 'chat')).toHaveLength(2)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('alerts exactly once per finished reply and never for an unrelated request', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-once-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })

      // A POST that is not the completion endpoint must stay silent.
      await chat.evaluate(async () => { await fetch('/sidebar-click', { method: 'POST' }) })
      await new Promise((resolveWait) => { setTimeout(resolveWait, 600) })
      expect((await notificationState(application)).count).toBe(0)

      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)
      await new Promise((resolveWait) => { setTimeout(resolveWait, 600) })
      expect((await notificationState(application)).count).toBe(1)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats a regenerated answer as a new occurrence, repeatedly', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-regenerate-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chrome, chat } = await openChat(application)

      // Foreground on Harness: a regeneration must raise the dot and stay silent.
      await chrome.locator('#mode-switch [data-mode="harness"]').click()
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="harness"]').getAttribute('aria-checked')).toBe('true')
      await application.evaluate(({ BrowserWindow, app }) => {
        BrowserWindow.getAllWindows()[0]?.show()
        BrowserWindow.getAllWindows()[0]?.focus()
        app.focus({ steal: true })
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() === true)).toBe(true)

      expect(await finishChatReply(chat, '/api/v0/chat/regenerate')).toBe(200)
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).toBe(true)
      await new Promise((resolveWait) => { setTimeout(resolveWait, 600) })
      expect((await notificationState(application)).count).toBe(0)
      // Foreground on Harness: suppressed banner, but the unseen Chat reply is
      // counted once in the Dock number.
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(1)

      // Clearing must not poison the next regeneration: a repeat is a new occurrence.
      await chrome.locator('#mode-switch [data-mode="chat"]').click()
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).not.toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(0)
      await chrome.locator('#mode-switch [data-mode="harness"]').click()
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="harness"]').getAttribute('aria-checked')).toBe('true')

      expect(await finishChatReply(chat, '/api/v0/chat/regenerate')).toBe(200)
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(1)

      // Background regeneration alerts, and the ledger still holds one receipt each.
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      await chrome.locator('#mode-switch [data-mode="harness"]').click()
      expect(await finishChatReply(chat, '/api/v0/chat/regenerate')).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)
      // A second unseen regeneration raises the Dock number to two.
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(2)
      const ledger = await persistedNotifications(directory)
      expect(ledger.chatPendingCount).toBe(2)
      expect(ledger.events.filter(event => event.source === 'chat')).toHaveLength(3)
      expect(ledger.unread).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('notifies for a continuation and stays silent when the user stops the stream', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-continue-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })

      // A continuation that runs to completion is a finished answer.
      expect(await finishChatReply(chat, '/api/v0/chat/continue')).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)

      // A generation the user stops must not be announced, even though its
      // transport still ends with 200 exactly like a finished answer.
      await chat.evaluate(async (target) => {
        const running = fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"prompt":"stop me","parent_message_id":null}',
        })
        // Let the stream start, then stop it: the stop request finishes first.
        await new Promise((resolveWait) => { setTimeout(resolveWait, 40) })
        await fetch('/api/v0/chat/stop_stream', { method: 'POST' })
        await running.catch(() => undefined)
      }, '/api/v0/chat/completion')

      await new Promise((resolveWait) => { setTimeout(resolveWait, 1200) })
      // Still exactly one alert: the stopped generation added nothing.
      expect((await notificationState(application)).count).toBe(1)
      const ledger = await persistedNotifications(directory)
      expect(ledger.events.filter(event => event.source === 'chat')).toHaveLength(1)
      expect(ledger.unread).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores the desktop and selects Chat when the notification is clicked', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-click-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chrome, chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)

      await application.evaluate(() => {
        (globalThis as typeof globalThis & { __dshDualModeFixture: ChatNotificationFixture }).__dshDualModeFixture.clickNotification()
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return window?.isVisible() === true && !window.isMinimized()
      })).toBe(true)
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="chat"]').getAttribute('aria-checked')).toBe('true')
      // Following the notification into Chat is an explicit entry, so the reminder clears.
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).not.toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('acknowledges the Chat reminder when the app returns to the foreground on Chat', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-attention-foreground-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chrome, chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(1)

      // No notification was clicked: the user brought the app back to the surface
      // that already shows Chat, which is the acknowledgement this case pins.
      await application.evaluate(({ BrowserWindow, app }) => {
        BrowserWindow.getAllWindows()[0]?.show()
        BrowserWindow.getAllWindows()[0]?.focus()
        app.focus({ steal: true })
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() === true)).toBe(true)
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).not.toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(0)
      // The rendered Chat dot follows the acknowledged state, and acknowledging it
      // never touches the receipts or unread accounting.
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="chat"]')
        .getAttribute('data-attention')).not.toBe('true')
      const ledger = await persistedNotifications(directory)
      expect(ledger.unread).toBe(0)
      expect(ledger.events.filter(event => event.source === 'chat')).toHaveLength(1)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the Chat reminder while the foreground returns to Harness, then clears it on entry', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-attention-entry-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chrome, chat } = await openChat(application)
      // Leave Chat before the reply lands, so Harness is what stays on screen.
      await chrome.locator('#mode-switch [data-mode="harness"]').click()
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="harness"]').getAttribute('aria-checked')).toBe('true')
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).toBe(true)

      await application.evaluate(({ BrowserWindow, app }) => {
        BrowserWindow.getAllWindows()[0]?.show()
        BrowserWindow.getAllWindows()[0]?.focus()
        app.focus({ steal: true })
      })
      await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() === true)).toBe(true)
      // Acknowledgement is scoped to the source in view: a return to Harness must not
      // spend a reminder that belongs to Chat.
      await new Promise((resolveWait) => { setTimeout(resolveWait, 800) })
      const foreground = await persistedNotifications(directory)
      expect(foreground.chatAttention).toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(1)

      await chrome.locator('#mode-switch [data-mode="chat"]').click()
      await expect.poll(() => chrome.locator('#mode-switch [data-mode="chat"]').getAttribute('aria-checked')).toBe('true')
      await expect.poll(async () => (await persistedNotifications(directory)).chatAttention).not.toBe(true)
      await expect.poll(async () => (await notificationState(application!)).badge).toBe(0)
      // Clearing the dot never touches the receipts or unread accounting.
      const ledger = await persistedNotifications(directory)
      expect(ledger.unread).toBe(0)
      expect(ledger.harnessAttention).not.toBe(true)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stays silent when the reply is cancelled mid-stream', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-abort-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })

      // Start a completion and abort it after the first streamed chunk, the way a
      // user stopping generation does. A cancelled reply must not alert.
      const outcome = await chat.evaluate(async (target) => {
        const controller = new AbortController()
        let read = 0
        try {
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"prompt":"cancel me","parent_message_id":null}',
            signal: controller.signal,
          })
          const reader = response.body?.getReader()
          for (;;) {
            const chunk = await reader?.read()
            if (chunk === undefined || chunk.done) break
            read += 1
            if (read >= 1) { controller.abort(); break }
          }
          return 'aborted'
        } catch {
          return 'aborted'
        }
      }, '/api/v0/chat/completion')
      expect(outcome).toBe('aborted')
      await new Promise((resolveWait) => { setTimeout(resolveWait, 1200) })
      expect((await notificationState(application)).count).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('never replays a persisted reply after a restart', { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-chat-completion-restart-'))
    let application: ElectronApplication | undefined
    try {
      application = await launch(directory)
      const { chat } = await openChat(application)
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.hide() })
      expect(await finishChatReply(chat)).toBe(200)
      await expect.poll(async () => (await notificationState(application!)).count).toBe(1)
      await application.close()

      application = await launch(directory)
      await openChat(application)
      await new Promise((resolveWait) => { setTimeout(resolveWait, 1200) })
      // Nothing is re-dispatched from the restored ledger, and the observer only
      // ever sees requests made after this launch.
      expect((await notificationState(application)).count).toBe(0)
    } finally {
      await application?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
