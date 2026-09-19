/** Target visibility, delivery, and durability behavior independent of native permissions. */
import { describe, expect, it, vi } from 'vitest'
import { createDesktopNotifications, DEFAULT_NOTIFICATION_PREFERENCES, isSourceViewed, notificationAccentColor, parseNotificationState, raisesHarnessAttention, type DesktopNotificationState, type DesktopTaskEvent, type DesktopTaskVisibility } from '../src/desktop-notifications.ts'

const event = (id = 'a', patch: Partial<DesktopTaskEvent> = {}): DesktopTaskEvent => ({
  id, source: 'chat', kind: 'completed', targetId: id, occurredAt: 1, topLevel: true, ...patch,
})
function fixture(initial?: DesktopNotificationState) {
  let view: DesktopTaskVisibility = { focused: true, visible: true, minimized: false, source: 'chat', targetId: 'a' }
  let click: (() => void) | undefined
  const adapter = {
    supported: vi.fn(() => true), show: vi.fn((_event: DesktopTaskEvent, callback: () => void) => { click = callback }),
    setDockBadge: vi.fn(), dispose: vi.fn(),
  }
  const save = vi.fn(async (_state: DesktopNotificationState) => {})
  const open = vi.fn(async (_event: DesktopTaskEvent) => {})
  const manager = createDesktopNotifications({
    initial: initial ?? { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
    visibility: () => view,
    adapter, save, open, publish: vi.fn(), reportError: vi.fn() })
  return { manager, adapter, save, open, click: () => click?.(),
    view: (patch: Partial<DesktopTaskVisibility>) => { view = { ...view, ...patch } } }
}

/** One background-only Harness occurrence, the shape the audited poller emits. */
const harnessEvent = (id: string, kind: 'completed' | 'failed' | 'action-required' = 'completed'): DesktopTaskEvent =>
  ({ id, source: 'harness', kind, targetId: 'root', occurredAt: 1, topLevel: true, presentation: 'background-only' })
describe('restored source attention', () => {
  it('migrates both legacy booleans to one pending occurrence each and clears only the entered source', async () => {
    const initial = parseNotificationState({
      preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], chatAttention: true, harnessAttention: true,
    })
    // A pre-count document keeps its reminder: each set boolean becomes pending 1.
    expect(initial?.chatPendingCount).toBe(1)
    expect(initial?.harnessPendingCount).toBe(1)
    const f = fixture(initial)
    f.manager.publish()
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(2)
    await f.manager.enterSource('chat')
    expect(f.manager.snapshot().chatAttention).toBe(false)
    expect(f.manager.snapshot().chatPendingCount).toBe(0)
    expect(f.manager.snapshot().harnessAttention).toBe(true)
    expect(f.manager.snapshot().harnessPendingCount).toBe(1)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
    const restarted = fixture(parseNotificationState(f.manager.snapshot()))
    restarted.manager.publish()
    expect(restarted.manager.snapshot().chatAttention).not.toBe(true)
    expect(restarted.manager.snapshot().events).toEqual([])
    expect(restarted.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })

  it('rejects a count or string in Chat attention', () => {
    for (const chatAttention of [1, 'true']) {
      expect(parseNotificationState({ preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [], chatAttention })).toBeUndefined()
    }
  })

  it('rejects a malformed pending count instead of trusting it', () => {
    const base = { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] }
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
      expect(parseNotificationState({ ...base, chatPendingCount: bad }), String(bad)).toBeUndefined()
      expect(parseNotificationState({ ...base, harnessPendingCount: bad }), String(bad)).toBeUndefined()
    }
    // Zero normalizes away exactly like a cleared boolean, and a positive count
    // implies the dot without needing the boolean in the document.
    expect(parseNotificationState({ ...base, chatPendingCount: 0 })?.chatPendingCount).toBeUndefined()
    expect(parseNotificationState({ ...base, chatPendingCount: 3 })).toMatchObject({ chatAttention: true, chatPendingCount: 3 })
  })
})

describe('desktop task notifications', () => {
  it('A: observing the exact Chat target creates no unread or alert', async () => {
    const f = fixture(); await f.manager.receive(event())
    expect(f.manager.snapshot().events[0]?.read).toBe(true)
    expect(f.adapter.show).not.toHaveBeenCalled(); expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
  })
  it('B: another source completes while Chat is focused', async () => {
    const f = fixture(); await f.manager.receive(event('b', { source: 'harness' }))
    // The unseen Harness reminder feeds the Dock number even though ordinary unread
    // accounting is a separate concern.
    expect(f.adapter.show).toHaveBeenCalledOnce(); expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })
  it.each([{ focused: false }, { visible: false }, { minimized: true }])('C/D: background, hidden, and minimized windows retain unread: %j', async (patch) => {
    const f = fixture(); f.view(patch); await f.manager.receive(event())
    expect(f.adapter.show).toHaveBeenCalledOnce(); expect(f.manager.snapshot().events[0]?.read).toBe(false)
  })
  it.each(['failed', 'action-required'] as const)('E/F: preserves %s semantics', async (kind) => {
    const f = fixture(); await f.manager.receive(event('b', { source: 'harness', kind }))
    expect(f.adapter.show.mock.calls[0]?.[0].kind).toBe(kind)
    expect(f.manager.snapshot().events[0]?.kind).toBe(kind)
  })
  it('G: internal events are excluded', async () => {
    const f = fixture(); await f.manager.receive(event('child', { topLevel: false }))
    expect(f.save).not.toHaveBeenCalled(); expect(f.adapter.show).not.toHaveBeenCalled()
  })
  it('H: click opens the source without declaring an unknown target read', async () => {
    const f = fixture(); await f.manager.receive(event('b')); f.click()
    expect(f.open).toHaveBeenCalledWith(event('b'))
    f.view({ targetId: 'unknown' }); await f.manager.viewed()
    expect(f.manager.snapshot().events[0]?.read).toBe(false)
  })
  it('I: three unread events become two only after one exact target is viewed, without a Dock number', async () => {
    const f = fixture(); f.view({ focused: false })
    await Promise.all(['a', 'b', 'c'].map(id => f.manager.receive(event(id))))
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(3)
    // Ordinary unread never drives the Dock number; these are not source-level
    // attention occurrences, so the presentation stays cleared.
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
    f.view({ focused: true }); await f.manager.viewed()
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(2)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
  })
  it('J: changing the accent retains failure and action kinds', async () => {
    const f = fixture(); await f.manager.receive(event('b', { kind: 'failed' }))
    await f.manager.setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, accent: '#00ff00' })
    expect(notificationAccentColor(f.manager.snapshot().preferences.accent)).toBe('#00ff00')
    expect(f.manager.snapshot().events[0]?.kind).toBe('failed')
  })
  it('deduplicates read and unread occurrences across restart without redelivery', async () => {
    const f = fixture(); await f.manager.receive(event('b')); await f.manager.receive(event('b'))
    expect(f.adapter.show).toHaveBeenCalledOnce()
    const restarted = fixture(f.manager.snapshot()); restarted.manager.publish(); await restarted.manager.receive(event('b'))
    expect(restarted.adapter.show).not.toHaveBeenCalled()
  })
  it('keeps unread when notification permissions or presentation switches prevent alerts', async () => {
    const f = fixture(); f.adapter.supported.mockReturnValue(false); await f.manager.receive(event('b'))
    expect(f.manager.snapshot().events[0]?.delivery).toBe('unavailable')
    await f.manager.setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, dock: false, chat: false })
    await f.manager.receive(event('c'))
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(2)
    expect(f.adapter.show).not.toHaveBeenCalled(); expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
  })
  it('does not dispatch before persistence succeeds', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.manager.receive(event('b'))).rejects.toThrow('disk full')
    expect(f.adapter.show).not.toHaveBeenCalled(); expect(f.manager.snapshot().events).toHaveLength(0)
  })
  it('validates durable metadata and strips unrecognized message content', () => {
    const state = { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [{ ...event(), read: false, delivery: 'attempted', body: 'private' }] }
    expect(parseNotificationState(state)?.events[0]).not.toHaveProperty('body')
    expect(parseNotificationState({ ...state, events: [state.events[0], state.events[0]] })).toBeUndefined()
    expect(parseNotificationState({ ...state, preferences: { ...state.preferences, accent: 'url(evil)' } })).toBeUndefined()
  })
})

describe('notification-only Harness presentation', () => {
  it('suppresses foreground without needing a visible session and creates no unread', async () => {
    const f = fixture()
    await f.manager.receive(event('background', { source: 'harness', presentation: 'background-only' }))
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().events[0]?.read).toBe(true)
  })
  it('delivers in background, counts one unseen reminder, and retains durable deduplication', async () => {
    const f = fixture(); f.view({ focused: false })
    const e = event('background', { source: 'harness', presentation: 'background-only' })
    await f.manager.receive(e); await f.manager.receive(e)
    expect(f.adapter.show).toHaveBeenCalledOnce(); expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
    const state = parseNotificationState(f.manager.snapshot())
    expect(state?.events[0]?.presentation).toBe('background-only')
    const restarted = fixture(state); await restarted.manager.receive(e); expect(restarted.adapter.show).not.toHaveBeenCalled()
  })
})

describe('source-level Harness attention', () => {
  it('is a plain source test that ignores which session is open', () => {
    const base: DesktopTaskVisibility = { focused: true, visible: true, minimized: false, source: 'harness', targetId: 'other' }
    expect(isSourceViewed('harness', base)).toBe(true)
    expect(isSourceViewed('chat', base)).toBe(false)
    for (const patch of [{ focused: false }, { visible: false }, { minimized: true }]) {
      expect(isSourceViewed('harness', { ...base, ...patch })).toBe(false)
    }
  })

  it.each(['completed', 'failed'] as const)('raises on a background Harness %s', async (kind) => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1', kind))
    expect(f.manager.snapshot().harnessAttention).toBe(true)
  })

  it('raises while the window is hidden and while it is minimized', async () => {
    for (const patch of [{ visible: false }, { minimized: true }]) {
      const f = fixture(); f.view(patch)
      await f.manager.receive(harnessEvent('h1'))
      expect(f.manager.snapshot().harnessAttention, JSON.stringify(patch)).toBe(true)
    }
  })

  it('raises in a focused foreground window sitting on Chat, where the alert is suppressed', async () => {
    const f = fixture() // focused, visible, Chat selected
    await f.manager.receive(harnessEvent('h1'))
    expect(f.adapter.show).not.toHaveBeenCalled()
    expect(f.manager.snapshot().harnessAttention).toBe(true)
  })

  it('does not raise while the user is looking at Harness', async () => {
    const f = fixture(); f.view({ source: 'harness', targetId: 'other' })
    await f.manager.receive(harnessEvent('h1'))
    expect(f.manager.snapshot().harnessAttention).toBeUndefined()
  })

  it('does not raise for a cancel-shaped, action-required, or non-Harness occurrence', async () => {
    const cancelled = fixture(); cancelled.view({ focused: false })
    await cancelled.manager.receive(harnessEvent('h1', 'action-required'))
    expect(cancelled.manager.snapshot().harnessAttention).toBeUndefined()

    const chat = fixture(); chat.view({ focused: false })
    await chat.manager.receive(event('c1', { source: 'chat', kind: 'failed' }))
    expect(chat.manager.snapshot().harnessAttention).toBeUndefined()

    expect(raisesHarnessAttention(harnessEvent('h2', 'action-required'), { focused: false, visible: false, minimized: false, source: 'chat' })).toBe(false)
  })

  it('does not raise for a child, subagent, or fork occurrence', async () => {
    const f = fixture(); f.view({ focused: false })
    // The provider excludes children, subagents, and forks before delivery, so the
    // only shape that reaches the manager is a non-top-level occurrence.
    await f.manager.receive({ ...harnessEvent('child'), topLevel: false })
    await f.manager.receive({ ...harnessEvent('child'), topLevel: false })
    expect(f.manager.snapshot().harnessAttention).toBeUndefined()
    expect(f.manager.snapshot().events).toHaveLength(0)
    expect(f.adapter.show).not.toHaveBeenCalled()
  })

  it('stays one boolean no matter how many occurrences arrive', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1'))
    await f.manager.receive(harnessEvent('h2', 'failed'))
    await f.manager.receive(harnessEvent('h3'))
    const attention = f.manager.snapshot().harnessAttention
    expect(attention).toBe(true)
    expect(typeof attention).toBe('boolean')
  })

  it('clears when the user enters Harness and persists the cleared value', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1'))
    expect(f.manager.snapshot().harnessAttention).toBe(true)
    await f.manager.enterSource('harness')
    expect(f.manager.snapshot().harnessAttention).toBe(false)
  })

  it('ignores entry into a source other than Harness', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1'))
    await f.manager.enterSource('chat')
    expect(f.manager.snapshot().harnessAttention).toBe(true)
  })

  it('keeps ordinary unread at zero while the dot and its Dock number are set', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1', 'failed'))
    expect(f.manager.snapshot().harnessAttention).toBe(true)
    expect(f.manager.snapshot().harnessPendingCount).toBe(1)
    expect(f.manager.snapshot().events.filter(e => !e.read)).toHaveLength(0)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })

  it('increments once per occurrence and never for a duplicate', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1'))
    await f.manager.receive(harnessEvent('h2', 'failed'))
    await f.manager.receive(harnessEvent('h3'))
    expect(f.manager.snapshot().harnessPendingCount).toBe(3)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(3)
    await f.manager.receive(harnessEvent('h2', 'failed'))
    expect(f.manager.snapshot().harnessPendingCount).toBe(3)
    expect(f.manager.snapshot().events).toHaveLength(3)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(3)
  })

  it('keeps a zero Dock number cleared and survives a failing platform badge call', async () => {
    const f = fixture()
    f.adapter.setDockBadge.mockImplementationOnce(() => { throw new Error('dock unavailable') })
    await f.manager.receive(event('b', { source: 'harness' }))
    // The durable transition and chrome publication complete even when the native
    // Dock API throws; only presentation was lost.
    expect(f.manager.snapshot().events).toHaveLength(1)
    expect(f.manager.snapshot().harnessPendingCount).toBe(1)
    await f.manager.enterSource('harness')
    expect(f.manager.snapshot().harnessPendingCount).toBe(0)
    expect(f.adapter.setDockBadge).toHaveBeenLastCalledWith(0)
  })

  it('round-trips attention through the durable ledger and restart', async () => {
    const f = fixture(); f.view({ focused: false })
    await f.manager.receive(harnessEvent('h1'))
    const persisted = parseNotificationState(f.manager.snapshot())
    expect(persisted?.harnessAttention).toBe(true)
    // A restart restores the ledger: the dot is still there before any entry.
    const restarted = fixture(persisted)
    restarted.manager.publish()
    expect(restarted.manager.snapshot().harnessAttention).toBe(true)
    await restarted.manager.enterSource('harness')
    // A second restart after entering Harness stays cleared. `parseNotificationState`
    // normalizes the cleared value away, and absent means false.
    const cleared = parseNotificationState(restarted.manager.snapshot())
    expect(cleared?.harnessAttention).not.toBe(true)
    expect(fixture(cleared).manager.snapshot().harnessAttention).not.toBe(true)
  })

  it('rejects a malformed attention value instead of trusting it', () => {
    const base = { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] }
    expect(parseNotificationState({ ...base, harnessAttention: 'yes' })).toBeUndefined()
    expect(parseNotificationState({ ...base, harnessAttention: false })?.harnessAttention).toBeUndefined()
    expect(parseNotificationState({ ...base, harnessAttention: true })?.harnessAttention).toBe(true)
  })
})
