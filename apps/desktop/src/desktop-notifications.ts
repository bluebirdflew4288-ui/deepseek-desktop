/** Desktop-owned task metadata and target-specific unread policy; no message content is retained. */
import type { DesktopMode } from './desktop-mode.ts'

/** User-level outcomes; execution state remains owned by the task provider. */
export type TaskNotificationKind = 'completed' | 'failed' | 'action-required'
/** A provider must supply a stable occurrence id and assert top-level ownership. */
export interface DesktopTaskEvent {
  readonly id: string
  readonly source: DesktopMode
  readonly kind: TaskNotificationKind
  readonly targetId?: string
  readonly occurredAt: number
  readonly topLevel: boolean
  /** Notification-only events retain dedupe receipts without creating unread state. */
  readonly presentation?: 'background-only'
}
/** Delivery records do not imply that the user read an event. */
export interface DesktopUnreadEvent extends DesktopTaskEvent {
  readonly read: boolean
  readonly delivery: 'pending' | 'attempted' | 'disabled' | 'unavailable'
}
/** Optional identity is positive evidence only; absent identity never matches a task. */
export interface DesktopTaskVisibility {
  readonly focused: boolean
  readonly visible: boolean
  readonly minimized: boolean
  readonly source: DesktopMode
  readonly targetId?: string
}
/** Independent switches affect presentation, never unread accounting. */
export interface NotificationPreferences {
  readonly chat: boolean
  readonly completed: boolean
  readonly failed: boolean
  readonly actionRequired: boolean
  readonly dock: boolean
  readonly indicators: boolean
  readonly accent: string
}
/** Default presentation for an installation without notification preferences. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  chat: true, completed: true, failed: true, actionRequired: true,
  dock: true, indicators: true, accent: 'theme',
}
/** Minimal durable ledger, including read tombstones for occurrence deduplication. */
export interface DesktopNotificationState {
  readonly preferences: NotificationPreferences
  readonly events: readonly DesktopUnreadEvent[]
  /**
   * Source-level Harness attention: a top-level Harness result the user has not
   * entered the Harness surface to see. It is a plain boolean, deliberately
   * independent of per-event `read`, so it never contributes to ordinary unread
   * counts. Absent means false.
   */
  readonly harnessAttention?: boolean
  /** Unseen Chat result; independent of receipts, unread totals, and native delivery. */
  readonly chatAttention?: boolean
  /**
   * Unseen Harness occurrences awaiting an explicit Harness entry. This is the
   * Dock number's Harness component and is independent of per-event `read`.
   * Absent means zero.
   */
  readonly harnessPendingCount?: number
  /** Unseen Chat occurrences awaiting an explicit Chat entry; the Dock number's Chat component. Absent means zero. */
  readonly chatPendingCount?: number
}
/** Platform side effects supplied by Electron composition. */
export interface DesktopNotificationAdapter {
  supported(): boolean
  show(event: DesktopTaskEvent, onClick: () => void): void
  /**
   * Present the numeric Dock badge; zero clears it. A platform failure must not
   * corrupt the durable ledger, so callers treat this as best-effort presentation.
   */
  setDockBadge(count: number): void
  dispose(): void
}
/**
 * Count the unseen source-level occurrences the Dock number reports.
 *
 * It deliberately ignores per-event `read`: notification-only receipts stay read
 * and never reach this total, and ordinary unread never drives it.
 * @param state - Current durable notification state.
 * @returns The number of unseen Chat plus Harness occurrences.
 */
export function dockBadgeCount(state: Pick<DesktopNotificationState, 'chatPendingCount' | 'harnessPendingCount'>): number {
  return (state.chatPendingCount ?? 0) + (state.harnessPendingCount ?? 0)
}
/**
 * Test a persisted pending count.
 * @param value - Parsed desktop state field.
 * @returns Whether it is a non-negative safe integer.
 */
function isPendingCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
/**
 * Accept only named accents or an opaque six-digit CSS color.
 * @param value - Preference crossing disk or renderer boundaries.
 * @returns Whether it is safe to use as a color value.
 */
export function isNotificationAccent(value: unknown): value is string {
  return typeof value === 'string' && (['theme', 'deepseek', 'blue', 'purple', 'green'].includes(value) || /^#[\da-f]{6}$/iu.test(value))
}
/**
 * Validate a persisted notification ledger without retaining unknown fields.
 * @param value - Parsed desktop state field.
 * @returns Detached metadata, or undefined for a malformed ledger.
 */
export function parseNotificationState(value: unknown): DesktopNotificationState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Record<string, unknown>
  if (typeof state.preferences !== 'object' || state.preferences === null || !Array.isArray(state.events)) return undefined
  const p = state.preferences as Record<string, unknown>
  if (!['chat', 'completed', 'failed', 'actionRequired', 'dock', 'indicators'].every(key => typeof p[key] === 'boolean') || !isNotificationAccent(p.accent)) return undefined
  const preferences: NotificationPreferences = {
    chat: p.chat as boolean, completed: p.completed as boolean, failed: p.failed as boolean,
    actionRequired: p.actionRequired as boolean, dock: p.dock as boolean,
    indicators: p.indicators as boolean, accent: p.accent,
  }
  const events: DesktopUnreadEvent[] = []
  const ids = new Set<string>()
  for (const raw of state.events) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id || e.id.length > 256 || ids.has(e.id)
      || (e.source !== 'chat' && e.source !== 'harness')
      || !['completed', 'failed', 'action-required'].includes(String(e.kind))
      || (e.presentation !== undefined && e.presentation !== 'background-only')
      || e.topLevel !== true || typeof e.read !== 'boolean'
      || typeof e.occurredAt !== 'number' || !Number.isFinite(e.occurredAt)
      || (e.targetId !== undefined && (typeof e.targetId !== 'string' || !e.targetId || e.targetId.length > 256))
      || !['pending', 'attempted', 'disabled', 'unavailable'].includes(String(e.delivery))) return undefined
    ids.add(e.id)
    events.push({ id: e.id, source: e.source, kind: e.kind as TaskNotificationKind,
      occurredAt: e.occurredAt, topLevel: true, read: e.read,
      delivery: e.delivery as DesktopUnreadEvent['delivery'],
      ...e.presentation === undefined ? {} : { presentation: 'background-only' as const },
      ...e.targetId === undefined ? {} : { targetId: e.targetId },
    })
  }
  if (state.harnessAttention !== undefined && typeof state.harnessAttention !== 'boolean') return undefined
  if (state.chatAttention !== undefined && typeof state.chatAttention !== 'boolean') return undefined
  if (state.harnessPendingCount !== undefined && !isPendingCount(state.harnessPendingCount)) return undefined
  if (state.chatPendingCount !== undefined && !isPendingCount(state.chatPendingCount)) return undefined
  // A document written before pending counts existed carries only the boolean. A set
  // dot proves at least one unseen occurrence but not how many, so the count migrates
  // to 1 as the minimum representable pending count and the reminder survives the
  // upgrade instead of being silently dropped. An absent or cleared boolean migrates
  // to zero.
  const harnessPendingCount = isPendingCount(state.harnessPendingCount)
    ? state.harnessPendingCount
    : state.harnessAttention === true ? 1 : 0
  const chatPendingCount = isPendingCount(state.chatPendingCount)
    ? state.chatPendingCount
    : state.chatAttention === true ? 1 : 0
  return { preferences, events,
    ...harnessPendingCount > 0 ? { harnessAttention: true, harnessPendingCount } : {},
    ...chatPendingCount > 0 ? { chatAttention: true, chatPendingCount } : {},
  }
}
/**
 * Require a visible focused window and exact provider identity before reading.
 * @param event - Event whose target must be visible.
 * @param view - Current positive visibility evidence.
 * @returns Whether this specific target is being viewed.
 */
export function isTaskViewed(event: DesktopTaskEvent, view: DesktopTaskVisibility): boolean {
  return view.focused && view.visible && !view.minimized && view.source === event.source
    && event.targetId !== undefined && event.targetId === view.targetId
}
/**
 * Test whether the user is looking at a whole source, without requiring a task identity.
 *
 * The source-level Harness dot must not depend on which session is open, so this
 * deliberately ignores `targetId`: entering the Harness surface is enough.
 * @param source - Source surface whose visibility matters.
 * @param view - Current positive visibility evidence.
 * @returns Whether that source is focused, visible, and not minimized.
 */
export function isSourceViewed(source: DesktopMode, view: DesktopTaskVisibility): boolean {
  return view.focused && view.visible && !view.minimized && view.source === source
}
/**
 * Decide whether one occurrence should raise the source-level Harness dot.
 *
 * Only a top-level Harness completion or failure counts. Cancellations, children,
 * forks, and waiting states never reach this point because the provider already
 * excludes them; requiring the two kinds here keeps that contract explicit.
 * @param event - Provider-confirmed top-level occurrence.
 * @param view - Current positive visibility evidence.
 * @returns Whether the Harness entry should show its unseen-result dot.
 */
export function raisesHarnessAttention(event: DesktopTaskEvent, view: DesktopTaskVisibility): boolean {
  return event.source === 'harness'
    && (event.kind === 'completed' || event.kind === 'failed')
    && !isSourceViewed('harness', view)
}
/**
 * Decide whether one occurrence should raise the source-level Chat dot.
 *
 * The audited Chat producer reports only notification-only completions, and the
 * gate states that contract exactly. An ordinary Chat event that already carries
 * unread accounting keeps its count instead of being replaced by the dot.
 *
 * A user sitting in a focused, restored Chat surface is already looking at the
 * conversation, so nothing is raised; every other situation — background, hidden,
 * minimized, or foreground on Harness — leaves the reminder for the Chat entry.
 * @param event - Provider-confirmed top-level occurrence.
 * @param view - Current positive visibility evidence.
 * @returns Whether the Chat entry should show its unseen-result dot.
 */
export function raisesChatAttention(event: DesktopTaskEvent, view: DesktopTaskVisibility): boolean {
  return event.source === 'chat'
    && event.presentation === 'background-only'
    && (event.kind === 'completed' || event.kind === 'failed')
    && !isSourceViewed('chat', view)
}
/**
 * Resolve ordinary unread color without changing failure or action semantics.
 * @param accent - Validated preference.
 * @returns CSS value usable by desktop-owned chrome.
 */
export function notificationAccentColor(accent: string): string {
  const colors: Record<string, string> = { theme: 'var(--chrome-accent)', deepseek: '#4d6bfe', blue: '#2563eb', purple: '#9333ea', green: '#16803c' }
  return colors[accent] ?? accent
}
/**
 * Create one serialized durable notification owner. Restored events never redispatch.
 * @param options - Persistence, native effects, and target visibility dependencies.
 * @returns Operations whose promises settle after durable state and presentation update.
 */
export function createDesktopNotifications(options: {
  initial: DesktopNotificationState
  visibility: () => DesktopTaskVisibility
  save: (state: DesktopNotificationState) => Promise<void>
  publish: (state: DesktopNotificationState) => void
  adapter: DesktopNotificationAdapter
  open: (event: DesktopTaskEvent) => Promise<void>
  reportError: (error: unknown) => void
}) {
  let state = structuredClone(options.initial)
  let pending = Promise.resolve()
  let disposed = false
  let accepting = true
  const publish = (): void => {
    // State is the truth and the Dock number is presentation derived from it. A
    // failing platform call is reported and swallowed so it can never block the
    // chrome publication or roll back a durable transition.
    try {
      options.adapter.setDockBadge(state.preferences.dock ? dockBadgeCount(state) : 0)
    } catch (error) {
      options.reportError(error)
    }
    options.publish(structuredClone(state))
  }
  const queue = (operation: () => Promise<void>): Promise<void> => {
    if (!accepting) return Promise.resolve()
    const result = pending.then(async () => { if (!disposed) await operation() })
    pending = result.catch(options.reportError)
    return result
  }
  const commit = async (next: DesktopNotificationState): Promise<void> => {
    await options.save(next)
    state = next
    publish()
  }
  return {
    snapshot: (): DesktopNotificationState => structuredClone(state),
    publish,
    receive: (event: DesktopTaskEvent): Promise<void> => queue(async () => {
      if (!event.topLevel || state.events.some(e => e.id === event.id)) return
      const view = options.visibility()
      // Notification-only occurrences (Harness background results and Chat reply
      // completions) never create ordinary unread state: `read` stays true so they
      // cannot reach the unread total. They do raise the independent source-level
      // reminder, and that reminder is what the Dock number counts.
      const backgroundOnly = event.presentation === 'background-only'
      const read = backgroundOnly || isTaskViewed(event, view)
      const suppressed = backgroundOnly ? view.focused && view.visible && !view.minimized : read
      const p = state.preferences
      const enabled = event.source === 'chat' ? p.chat : event.kind === 'action-required' ? p.actionRequired : p[event.kind]
      const delivery = suppressed || !enabled ? 'disabled' : options.adapter.supported() ? 'attempted' : 'unavailable'
      const record: DesktopUnreadEvent = { ...event, read, delivery }
      // One occurrence decides both policies in a single serialized step, against
      // the same visibility snapshot, and lands as exactly one receipt: the
      // source-level reminder (attention and its pending count) and the native
      // alert (delivery) can therefore never disagree about, or double-count, the
      // same completion. Duplicates return above, before any accounting runs, so a
      // suppressed repeat can never add a second count.
      const raisedHarness = raisesHarnessAttention(event, view)
      const raisedChat = raisesChatAttention(event, view)
      const harnessAttention = state.harnessAttention === true || raisedHarness
      const chatAttention = state.chatAttention === true || raisedChat
      const harnessPendingCount = (state.harnessPendingCount ?? 0) + (raisedHarness ? 1 : 0)
      const chatPendingCount = (state.chatPendingCount ?? 0) + (raisedChat ? 1 : 0)
      // Persist the attempt before OS dispatch: a crash cannot produce duplicate alerts on restart.
      await commit({
        ...state,
        events: [...state.events, record],
        ...harnessAttention ? { harnessAttention: true } : {},
        ...chatAttention ? { chatAttention: true } : {},
        ...harnessPendingCount > 0 ? { harnessPendingCount } : {},
        ...chatPendingCount > 0 ? { chatPendingCount } : {},
      })
      const latest = options.visibility()
      const becameForeground = backgroundOnly && latest.focused && latest.visible && !latest.minimized
      if (accepting && !becameForeground && delivery === 'attempted') options.adapter.show(event, () => {
        if (accepting) void options.open(event).catch(options.reportError)
      })
    }),
    viewed: (): Promise<void> => queue(async () => {
      const view = options.visibility()
      const events = state.events.map(e => !e.read && isTaskViewed(e, view) ? { ...e, read: true } : e)
      if (events.some((e, i) => e !== state.events[i])) await commit({ ...state, events })
    }),
    /**
     * Clear the source-level dot and its pending count because the user entered
     * that surface.
     *
     * Called only for an explicit entry — choosing the mode or following a
     * notification — so a plain restart that happens to restore Harness never
     * silently discards a result the user has not been shown. Only the entered
     * source is cleared; the other source keeps its count, so the Dock number
     * falls by exactly the entries being acknowledged. It never touches per-event
     * `read`, keeping ordinary unread accounting untouched.
     * @param source - Surface the user just entered.
     * @returns Completion of persistence and chrome publication.
     */
    enterSource: (source: DesktopMode): Promise<void> => queue(async () => {
      const attentionKey = source === 'chat' ? 'chatAttention' : 'harnessAttention'
      const countKey = source === 'chat' ? 'chatPendingCount' : 'harnessPendingCount'
      if (state[attentionKey] !== true && (state[countKey] ?? 0) === 0) return
      await commit(source === 'chat'
        ? { ...state, chatAttention: false, chatPendingCount: 0 }
        : { ...state, harnessAttention: false, harnessPendingCount: 0 })
    }),
    setPreferences: (preferences: NotificationPreferences): Promise<void> => queue(async () => {
      await commit({ ...state, preferences: { ...preferences } })
    }),
    dispose: async (): Promise<void> => { accepting = false; await pending; disposed = true; options.adapter.dispose() },
  }
}
