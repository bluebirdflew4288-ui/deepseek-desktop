/**
 * Chat reply completion as a notification-only source.
 *
 * These cover the manager contract the Chat producer relies on: one completion
 * occurrence must drive the source-level Chat reminder, its Dock number, and the
 * native alert together, with app-level foreground suppression, exactly one
 * receipt, and no unread state.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopNotifications,
  DEFAULT_NOTIFICATION_PREFERENCES,
  parseNotificationState,
  raisesChatAttention,
  type DesktopNotificationState,
  type DesktopTaskEvent,
  type DesktopTaskVisibility,
} from '../src/desktop-notifications.ts'

/** One finished Chat turn, exactly as the completion observer produces it. */
const chatCompletion = (id: string): DesktopTaskEvent => ({
  id,
  source: 'chat',
  kind: 'completed',
  occurredAt: 1,
  topLevel: true,
  presentation: 'background-only',
})

function fixture(initial?: DesktopNotificationState) {
  let view: DesktopTaskVisibility = { focused: false, visible: false, minimized: false, source: 'chat' }
  let click: (() => void) | undefined
  const adapter = {
    supported: vi.fn(() => true),
    show: vi.fn((_event: DesktopTaskEvent, callback: () => void) => { click = callback }),
    setDockBadge: vi.fn(),
    dispose: vi.fn(),
  }
  const save = vi.fn(async (_state: DesktopNotificationState) => {})
  const open = vi.fn(async (_event: DesktopTaskEvent) => {})
  const manager = createDesktopNotifications({
    initial: initial ?? { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
    visibility: () => view,
    adapter, save, open, publish: vi.fn(), reportError: vi.fn(),
  })
  return {
    manager, adapter, save, open,
    click: () => click?.(),
    view: (patch: Partial<DesktopTaskVisibility>) => { view = { ...view, ...patch } },
  }
}

describe('Chat completion notifications', () => {
  it('alerts when the desktop is in the background', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.show).toHaveBeenCalledOnce()
    expect(f.adapter.show.mock.calls[0]?.[0].source).toBe('chat')
    expect(f.manager.snapshot().events[0]?.delivery).toBe('attempted')
  })

  it.each([
    ['hidden', { visible: false }],
    ['minimized', { minimized: true }],
    ['another application focused', { focused: false }],
  ])('alerts while the window is %s', async (_label, patch) => {
    const f = fixture()
    f.view({ focused: true, visible: true, ...patch })
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.show).toHaveBeenCalledOnce()
  })

  it.each(['chat', 'harness'] as const)('suppresses while the desktop is foreground on %s', async (source) => {
    const f = fixture()
    f.view({ focused: true, visible: true, minimized: false, source })
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().events[0]?.delivery).toBe('disabled')
  })

  it('never creates unread state and counts each unseen reply in the Dock number', async () => {
    const f = fixture()
    for (const id of ['c1', 'c2', 'c3']) await f.manager.receive(chatCompletion(id))
    expect(f.manager.snapshot().events.every(event => event.read)).toBe(true)
    expect(f.manager.snapshot().events.filter(event => !event.read)).toHaveLength(0)
    expect(f.manager.snapshot().events).toHaveLength(3)
    expect(f.manager.snapshot().chatPendingCount).toBe(3)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(3)
  })

  it('notifies once for a repeated occurrence', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.show).toHaveBeenCalledOnce()
    expect(f.manager.snapshot().events).toHaveLength(1)
  })

  it('round-trips a notification-only Chat receipt through durable state', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    const persisted = parseNotificationState(f.manager.snapshot())
    expect(persisted).toBeDefined()
    expect(persisted?.events[0]?.source).toBe('chat')
    expect(persisted?.events[0]?.presentation).toBe('background-only')
    expect(persisted?.events[0]?.read).toBe(true)
  })

  it('does not replay a persisted completion after a restart', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    const restarted = fixture(parseNotificationState(f.manager.snapshot()))
    restarted.manager.publish()
    // The ledger is what suppresses a replay; nothing re-dispatches on load.
    expect(restarted.adapter.show).not.toHaveBeenCalled()
    await restarted.manager.receive(chatCompletion('c1'))
    expect(restarted.adapter.show).not.toHaveBeenCalled()
    // A genuinely new reply after the restart still alerts.
    await restarted.manager.receive(chatCompletion('c2'))
    expect(restarted.adapter.show).toHaveBeenCalledOnce()
  })

  it('opens the Chat source when the notification is clicked', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    f.click()
    expect(f.open).toHaveBeenCalledWith(chatCompletion('c1'))
  })

  it('respects the Chat presentation switch without affecting delivery state', async () => {
    const f = fixture()
    await f.manager.setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, chat: false })
    await f.manager.receive(chatCompletion('c1'))
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().events[0]?.delivery).toBe('disabled')
    expect(f.manager.snapshot().events[0]?.read).toBe(true)
  })

  it('reports unavailable delivery without creating unread when the platform cannot alert', async () => {
    const f = fixture()
    f.adapter.supported.mockReturnValue(false)
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().events[0]?.delivery).toBe('unavailable')
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })
})

describe('Chat source attention driven by the same occurrence', () => {
  it('is a plain source test that ignores which Chat conversation is open', () => {
    const base: DesktopTaskVisibility = { focused: true, visible: true, minimized: false, source: 'chat' }
    expect(raisesChatAttention(chatCompletion('c1'), base)).toBe(false)
    expect(raisesChatAttention(chatCompletion('c1'), { ...base, source: 'harness' })).toBe(true)
    for (const patch of [{ focused: false }, { visible: false }, { minimized: true }]) {
      expect(raisesChatAttention(chatCompletion('c1'), { ...base, ...patch }), JSON.stringify(patch)).toBe(true)
    }
    expect(raisesChatAttention({ ...chatCompletion('c1'), source: 'harness' }, base)).toBe(false)
    expect(raisesChatAttention({ ...chatCompletion('c1'), kind: 'action-required' }, base)).toBe(false)
    // An ordinary Chat event carries its own unread accounting, so it must not
    // be replaced by the dot: only the notification-only producer shape raises.
    expect(raisesChatAttention({ id: 'plain', source: 'chat', kind: 'completed', occurredAt: 1, topLevel: true }, base)).toBe(false)
  })

  it('does not take over an ordinary Chat event that keeps unread accounting', async () => {
    const f = fixture()
    f.view({ focused: true, visible: true, minimized: false, source: 'harness' })
    await f.manager.receive({ id: 'plain', source: 'chat', kind: 'completed', targetId: 'x', occurredAt: 1, topLevel: true })
    expect(f.manager.snapshot().chatAttention).not.toBe(true)
    expect(f.manager.snapshot().events[0]?.read).toBe(false)
  })

  it('raises attention while alerting in the background', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().chatAttention).toBe(true)
    expect(f.adapter.show).toHaveBeenCalledOnce()
  })

  it('raises attention while hidden and while minimized, and still alerts', async () => {
    for (const patch of [{ visible: false }, { minimized: true }]) {
      const f = fixture()
      f.view({ focused: true, visible: true, ...patch })
      await f.manager.receive(chatCompletion('c1'))
      expect(f.manager.snapshot().chatAttention, JSON.stringify(patch)).toBe(true)
      expect(f.adapter.show).toHaveBeenCalledOnce()
    }
  })

  it('raises attention on foreground Harness while suppressing the alert', async () => {
    const f = fixture()
    f.view({ focused: true, visible: true, minimized: false, source: 'harness' })
    await f.manager.receive(chatCompletion('c1'))
    // Two different policies from one occurrence: remind, do not alert.
    expect(f.manager.snapshot().chatAttention).toBe(true)
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().events[0]?.delivery).toBe('disabled')
  })

  it('does not raise while the user is looking at a focused, restored Chat', async () => {
    const f = fixture()
    f.view({ focused: true, visible: true, minimized: false, source: 'chat' })
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().chatAttention).toBeUndefined()
  })

  it('writes exactly one receipt per occurrence and counts the same occurrence once', async () => {
    const f = fixture()
    for (const id of ['c1', 'c2', 'c3']) await f.manager.receive(chatCompletion(id))
    expect(f.manager.snapshot().events).toHaveLength(3)
    expect(f.manager.snapshot().chatAttention).toBe(true)
    expect(f.manager.snapshot().chatPendingCount).toBe(3)
    expect(typeof f.manager.snapshot().chatAttention).toBe('boolean')
    // One occurrence, one receipt, one count: a repeat must not append or add.
    await f.manager.receive(chatCompletion('c3'))
    expect(f.manager.snapshot().events).toHaveLength(3)
    expect(f.manager.snapshot().chatPendingCount).toBe(3)
    expect(f.adapter.show).toHaveBeenCalledTimes(3)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(3)
  })

  it('clears attention and only the Chat count when the user enters Chat', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().chatAttention).toBe(true)
    await f.manager.enterSource('chat')
    expect(f.manager.snapshot().chatAttention).toBe(false)
    expect(f.manager.snapshot().chatPendingCount).toBe(0)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
  })

  it('does not clear Chat attention by entering Harness', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    await f.manager.enterSource('harness')
    expect(f.manager.snapshot().chatAttention).toBe(true)
  })

  it('persists attention and does not replay the reply after a restart', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    const persisted = parseNotificationState(f.manager.snapshot())
    expect(persisted?.chatAttention).toBe(true)
    expect(persisted?.events[0]?.read).toBe(true)

    const restarted = fixture(persisted)
    restarted.manager.publish()
    expect(restarted.adapter.show).not.toHaveBeenCalled()
    expect(restarted.manager.snapshot().chatAttention).toBe(true)

    await restarted.manager.enterSource('chat')
    const cleared = parseNotificationState(restarted.manager.snapshot())
    expect(cleared?.chatAttention).not.toBe(true)
  })

  it('shows the unseen Chat reminder as a Dock number while keeping ordinary unread empty', async () => {
    const f = fixture()
    await f.manager.receive(chatCompletion('c1'))
    expect(f.manager.snapshot().chatAttention).toBe(true)
    expect(f.manager.snapshot().chatPendingCount).toBe(1)
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(0)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })
})
