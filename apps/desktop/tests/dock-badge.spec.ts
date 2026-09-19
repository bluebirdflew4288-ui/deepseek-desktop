/**
 * macOS Dock numeric badge as unseen source-level attention.
 *
 * The Dock number is `chatPendingCount + harnessPendingCount`: one occurrence of
 * an unseen source-level reminder per count, cleared only by entering that source.
 * It is deliberately independent of ordinary unread receipts and of native
 * delivery, so these cases pin the exact 1 -> 2 -> 3 -> 1 -> 0 sequence.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopNotifications,
  dockBadgeCount,
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationState,
  type DesktopNotificationState,
  type DesktopTaskEvent,
  type DesktopTaskVisibility,
} from '../src/desktop-notifications.ts'

/** One finished Chat reply exactly as the audited observer emits it. */
const chatCompletion = (id: string): DesktopTaskEvent => ({
  id, source: 'chat', kind: 'completed', occurredAt: 1, topLevel: true, presentation: 'background-only',
})
/** One top-level Harness outcome exactly as the audited poller emits it. */
const harnessOutcome = (id: string, kind: 'completed' | 'failed' = 'completed'): DesktopTaskEvent =>
  ({ id, source: 'harness', kind, targetId: 'root', occurredAt: 1, topLevel: true, presentation: 'background-only' })

function fixture(initial?: DesktopNotificationState) {
  let view: DesktopTaskVisibility = { focused: false, visible: false, minimized: false, source: 'harness' }
  let click: (() => void) | undefined
  const adapter = {
    supported: vi.fn(() => true),
    show: vi.fn((_event: DesktopTaskEvent, callback: () => void) => { click = callback }),
    setDockBadge: vi.fn((_count: number) => {}),
    dispose: vi.fn(),
  }
  const saved: DesktopNotificationState[] = []
  const published: DesktopNotificationState[] = []
  const save = vi.fn(async (state: DesktopNotificationState) => { saved.push(state) })
  // The native click handler is fire-and-forget in the manager, so the fixture
  // records the entry operation for the test to join before asserting.
  let opened: Promise<void> = Promise.resolve()
  const manager = createDesktopNotifications({
    initial: initial ?? { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
    visibility: () => view,
    adapter,
    save,
    open: (event: DesktopTaskEvent) => { opened = manager.enterSource(event.source); return opened },
    publish: (state) => { published.push(state) },
    reportError: vi.fn(),
  })
  return {
    manager, adapter, saved, published,
    click: async () => { click?.(); await opened },
    counts: () => ({
      chat: manager.snapshot().chatPendingCount ?? 0,
      harness: manager.snapshot().harnessPendingCount ?? 0,
      dock: dockBadgeCount(manager.snapshot()),
      badge: adapter.setDockBadge.mock.calls.at(-1)?.[0],
    }),
    view: (patch: Partial<DesktopTaskVisibility>) => { view = { ...view, ...patch } },
  }
}

describe('Dock numeric badge sequence', () => {
  it('starts empty and reaches 1 -> 2 -> 3 -> 1 -> 0 across the two sources', async () => {
    const f = fixture()
    f.manager.publish()
    expect(f.counts()).toEqual({ chat: 0, harness: 0, dock: 0, badge: 0 })

    // A: one unseen Chat completion.
    await f.manager.receive(chatCompletion('chat-1'))
    expect(f.counts()).toEqual({ chat: 1, harness: 0, dock: 1, badge: 1 })

    // B: a second unseen Chat completion, without entering Chat.
    await f.manager.receive(chatCompletion('chat-2'))
    expect(f.counts()).toEqual({ chat: 2, harness: 0, dock: 2, badge: 2 })

    // C: one unseen Harness outcome while still not in Chat.
    await f.manager.receive(harnessOutcome('harness-1'))
    expect(f.counts()).toEqual({ chat: 2, harness: 1, dock: 3, badge: 3 })

    // D: entering Chat clears only the Chat component.
    await f.manager.enterSource('chat')
    expect(f.counts()).toEqual({ chat: 0, harness: 1, dock: 1, badge: 1 })

    // E: entering Harness clears the rest and hides the badge.
    await f.manager.enterSource('harness')
    expect(f.counts()).toEqual({ chat: 0, harness: 0, dock: 0, badge: 0 })
  })

  it('counts an unseen Harness failure and ignores a viewed source', async () => {
    const unseen = fixture()
    await unseen.manager.receive(harnessOutcome('h-failed', 'failed'))
    expect(unseen.counts()).toEqual({ chat: 0, harness: 1, dock: 1, badge: 1 })

    const viewed = fixture()
    viewed.view({ focused: true, visible: true, minimized: false, source: 'harness' })
    await viewed.manager.receive(harnessOutcome('h-seen'))
    expect(viewed.counts()).toEqual({ chat: 0, harness: 0, dock: 0, badge: 0 })

    const viewedChat = fixture()
    viewedChat.view({ focused: true, visible: true, minimized: false, source: 'chat' })
    await viewedChat.manager.receive(chatCompletion('c-seen'))
    expect(viewedChat.counts()).toEqual({ chat: 0, harness: 0, dock: 0, badge: 0 })
  })

  it('raises the number for a Chat completion while the desktop is foreground on Harness', async () => {
    const f = fixture()
    f.view({ focused: true, visible: true, minimized: false, source: 'harness' })
    await f.manager.receive(chatCompletion('c-fg'))
    // Native alert suppressed, reminder still counted: the Dock number tracks the
    // unseen source, not the number of banners.
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().events[0]?.delivery).toBe('disabled')
    expect(f.counts()).toEqual({ chat: 1, harness: 0, dock: 1, badge: 1 })
  })

  it('adds exactly one per occurrence and nothing for a suppressed duplicate', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('dup'))
    await f.manager.receive(chatCompletion('dup'))
    expect(f.counts()).toEqual({ chat: 1, harness: 0, dock: 1, badge: 1 })
    expect(f.manager.snapshot().events).toHaveLength(1)
    expect(f.saved).toHaveLength(1)
  })

  it('clears only the source a notification click opens', async () => {
    const chatClick = fixture()
    await chatClick.manager.receive(chatCompletion('c1'))
    await chatClick.manager.receive(harnessOutcome('h1'))
    await chatClick.click()
    // The last shown alert was the Harness one; the click follows it.
    expect(chatClick.counts()).toEqual({ chat: 1, harness: 0, dock: 1, badge: 1 })

    const harnessClick = fixture()
    await harnessClick.manager.receive(harnessOutcome('h1'))
    await harnessClick.manager.receive(chatCompletion('c1'))
    await harnessClick.click()
    expect(harnessClick.counts()).toEqual({ chat: 0, harness: 1, dock: 1, badge: 1 })
  })

  it('restores the Dock number from durable state after a restart', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    await f.manager.receive(chatCompletion('c2'))
    await f.manager.receive(harnessOutcome('h1'))
    const restarted = fixture(parseNotificationState(f.manager.snapshot()))
    restarted.manager.publish()
    expect(restarted.counts()).toEqual({ chat: 2, harness: 1, dock: 3, badge: 3 })
  })

  it('migrates a legacy attention boolean to one pending occurrence', () => {
    const legacyChat = parseNotificationState({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], chatAttention: true,
    })
    expect(legacyChat).toMatchObject({ chatAttention: true, chatPendingCount: 1 })
    expect(dockBadgeCount(legacyChat!)).toBe(1)
    const legacyHarness = parseNotificationState({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], harnessAttention: true,
    })
    expect(legacyHarness).toMatchObject({ harnessAttention: true, harnessPendingCount: 1 })
    const cleared = parseNotificationState({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], chatAttention: false,
    })
    expect(cleared?.chatPendingCount).toBeUndefined()
    expect(dockBadgeCount(cleared!)).toBe(0)
  })

  it('keeps ordinary unread and background-only receipts exactly as before', async () => {
    const f = fixture()
    // An ordinary (notification-shaped) Chat event keeps its unread accounting and
    // must never drive the Dock number.
    await f.manager.receive({ id: 'ordinary', source: 'chat', kind: 'completed', targetId: 'x', occurredAt: 1, topLevel: true })
    expect(f.manager.snapshot().events[0]?.read).toBe(false)
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(1)
    expect(f.counts()).toEqual({ chat: 0, harness: 0, dock: 0, badge: 0 })

    // A notification-only receipt stays read while its reminder is counted.
    await f.manager.receive(chatCompletion('background'))
    const receipt = f.manager.snapshot().events.find(e => e.id === 'background')
    expect(receipt?.read).toBe(true)
    expect(receipt?.presentation).toBe('background-only')
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(1)
    expect(f.counts()).toEqual({ chat: 1, harness: 0, dock: 1, badge: 1 })
  })

  it('hides the badge when the user turns the Dock presentation switch off', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
    await f.manager.setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, dock: false })
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
    // The reminder itself is retained; only its presentation is switched off.
    expect(f.counts()).toMatchObject({ chat: 1, dock: 1 })
  })

  it('keeps durable state intact when the platform Dock call throws', async () => {
    const f = fixture()
    f.adapter.setDockBadge.mockImplementationOnce(() => { throw new Error('dock unavailable') })
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().chatPendingCount).toBe(1)
    expect(f.manager.snapshot().events).toHaveLength(1)
    expect(f.published).toHaveLength(1)
    expect(f.published[0]?.chatPendingCount).toBe(1)
  })
})
