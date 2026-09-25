/** Notification observation uses historical read APIs and never subscribes or activates sessions. */
import { describe, expect, it, vi } from 'vitest'
import { createHarnessNotificationPoll } from '../src/harness-notification-poll.ts'

const record = (type: string, seq: number, data: unknown = {}) => ({ type: 'event', event: { type, seq, time: 1000 + seq, data } })
const prompt = (seq: number, rpcId = 'prompt-1') => record('user/message', seq, { source: { kind: 'user', rpcId } })
const reply = (seq: number, body = 'Done') => record('assistant/message', seq, { message: { role: 'assistant', content: [{ type: 'text', text: body }] } })
function fixture(allowCompleted = false) {
  let cursor = 0
  let extra = {}
  let records: unknown[] = []
  const receive = vi.fn(async () => {})
  // The audited `session/list` Remote method returns its summaries inside an envelope, and
  // the Gateway forwards that business result without output decoding, so the fixture sends
  // `{ items }` exactly as it arrives. A bare-array fixture hid the shape the poller reads.
  const rpc = vi.fn(async (method: string) => method === 'session/list'
    ? { items: [{ sessionId: 'root', cwd: '/workspace', running: false, projections: { asOfSeq: cursor }, ...extra }] }
    : { records, hasMore: false })
  const poller = createHarnessNotificationPoll({ rpc, receive, allowCompleted })
  return { receive, rpc, poller,
    set(next: number, values: unknown[], metadata = {}) { cursor = next; records = values; extra = metadata },
  }
}
const turn = (reason: string) => [record('turn/start', 1, { turn: 1 }),
  record('user/message', 2, { source: { kind: 'user', rpcId: 'prompt-1' } }),
  record('assistant/message', 3, { message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }),
  record('turn/end', 4, { turn: 1, reason: { kind: reason, error: { code: 'MISSING_CREDENTIAL' } } })]

describe('Harness read-only background poll', () => {
  it('baselines history and emits one new owned failure through the unified receiver', async () => {
    const f = fixture(); await f.poller.poll(); f.set(4, turn('error')); await f.poller.poll(); await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:4', kind: 'failed', targetId: 'root', presentation: 'background-only', topLevel: true }))
    expect(f.rpc.mock.calls.every(([method]) => ['session/list', 'session/page'].includes(method))).toBe(true)
  })
  it('retains a user turn across polling cuts when the bounded page still contains it', async () => {
    const f = fixture(); await f.poller.poll(); f.set(2, turn('error').slice(0, 2)); await f.poller.poll()
    f.set(4, turn('error')); await f.poller.poll(); expect(f.receive).toHaveBeenCalledOnce()
  })
  it.each(['completed', 'aborted', 'blocked', 'interrupted', 'unknown'])('does not ship %s alerts by default', async (reason) => {
    const f = fixture(); await f.poller.poll(); f.set(4, turn(reason)); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('allows completed only in explicitly enabled verification, with user input and assistant output', async () => {
    const f = fixture(true); await f.poller.poll(); f.set(4, turn('completed')); await f.poller.poll(); expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }))
    const empty = fixture(true); await empty.poller.poll(); empty.set(2, [record('turn/start', 1, { turn: 1 }), record('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })]); await empty.poller.poll(); expect(empty.receive).not.toHaveBeenCalled()
  })
  it.each([{ origin: 'subagent' }, { parentSessionId: 'parent' }, { origin: 'unrecognized' }])('excludes child, fork and unknown ownership %j', async (metadata) => {
    const f = fixture(); await f.poller.poll(); f.set(4, turn('error'), metadata); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalledWith('session/page', expect.anything())
  })
  it('does not replay initial, restarted or regressed history', async () => {
    const f = fixture(); f.set(4, turn('error')); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
    f.set(0, []); await f.poller.poll(); f.set(4, turn('error')); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
    const restarted = fixture(); restarted.set(4, turn('error')); await restarted.poller.poll(); expect(restarted.receive).not.toHaveBeenCalled()
  })
  it('rebaselines after RPC failure instead of replaying unseen outcomes', async () => {
    const f = fixture(); await f.poller.poll(); f.rpc.mockRejectedValueOnce(new Error('offline'))
    await expect(f.poller.poll()).rejects.toThrow('offline'); f.set(4, turn('error')); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('drops an interval outside the bounded page and rejects an internal gap', async () => {
    const f = fixture(); await f.poller.poll(); f.set(4, turn('error').slice(2)); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
    const gap = fixture(); await gap.poller.poll(); gap.set(4, [turn('error')[0], turn('error')[3]])
    await expect(gap.poller.poll()).rejects.toThrow('gap'); expect(gap.receive).not.toHaveBeenCalled()
  })
  it('does not mistake plugin context or mismatched turn identity for user failure', async () => {
    const f = fixture(); await f.poller.poll(); f.set(3, [record('turn/start', 1, { turn: 1 }), record('user/message', 2, { source: { kind: 'plugin' } }), record('turn/end', 3, { turn: 2, reason: { kind: 'error' } })]); await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
})

describe('turn spanning the observation watermark', () => {
  // A session that is created and used between two polls starts its turn before the first
  // observation ever sees the session. Turn evidence is therefore rebuilt from the bounded
  // page even when `turn/start.seq` is not newer than the watermark, and only a
  // `turn/end.seq > previous cursor` result may be emitted.
  it('emits one completion for a turn that started before the first observation', async () => {
    const f = fixture(true)
    f.set(2, [record('turn/start', 1, { turn: 1 }), prompt(2)])
    await f.poller.poll()
    expect(f.receive).not.toHaveBeenCalled()
    f.set(4, [record('turn/start', 1, { turn: 1 }), prompt(2), reply(3), record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })])
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:4', kind: 'completed', targetId: 'root', occurredAt: 1004 }))
  })
  it('never replays a turn that completed before the first observation', async () => {
    const f = fixture(true)
    f.set(4, turn('completed'))
    await f.poller.poll()
    expect(f.receive).not.toHaveBeenCalled()
    f.set(5, [...turn('completed'), record('todo/write', 5, {})])
    await f.poller.poll()
    expect(f.receive).not.toHaveBeenCalled()
  })
  it('emits one failure for a spanning turn that ends with an error', async () => {
    const f = fixture()
    f.set(2, [record('turn/start', 1, { turn: 1 }), prompt(2)])
    await f.poller.poll()
    f.set(4, turn('error'))
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:4', kind: 'failed' }))
  })
  it('fails closed when the bounded page cannot prove the spanning turn', async () => {
    const noStart = fixture(true)
    noStart.set(2, [record('turn/start', 1, { turn: 1 }), prompt(2)])
    await noStart.poller.poll()
    noStart.set(4, [prompt(2), reply(3), record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })])
    await noStart.poller.poll()
    expect(noStart.receive).not.toHaveBeenCalled()

    const noUser = fixture(true)
    noUser.set(2, [record('turn/start', 1, { turn: 1 }), prompt(2)])
    await noUser.poller.poll()
    noUser.set(4, [record('turn/start', 1, { turn: 1 }), record('user/message', 2, { source: { kind: 'plugin' } }), reply(3), record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })])
    await noUser.poller.poll()
    expect(noUser.receive).not.toHaveBeenCalled()
  })
})

describe('consumed-event contract', () => {
  // `session/page` is already the audited runtime's validated boundary: Session persistence
  // rejects unknown non-ignorable events and admits unknown ignorable ones. Re-declaring that
  // vocabulary here let one unrelated legal record abort the cycle and drop the completion
  // that followed it, so the poller now interprets only the four events it consumes.
  it('keeps one completion when unrelated legal records share the unseen interval', async () => {
    const f = fixture(true); await f.poller.poll()
    f.set(9, [record('turn/start', 1, { turn: 1 }),
      record('todo/write', 2, {}), record('deliverables/presented', 3, {}),
      record('llm/retry', 4, {}), record('llm/retry-started', 5, {}), record('session/end-seed', 6, {}),
      prompt(7), reply(8),
      record('turn/end', 9, { turn: 1, reason: { kind: 'completed' } })])
    await f.poller.poll(); await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:9', kind: 'completed' }))
  })
  it('still notifies after a turn that called tools, whose records are audited', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(6, [record('turn/start', 1, { turn: 1 }), prompt(2),
      record('tool/call', 3, {}), record('tool/result', 4, {}), reply(5),
      record('turn/end', 6, { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } })])
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:6', kind: 'failed' }))
  })
  it('skips an unrecognized record instead of failing the poll', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(5, [record('turn/start', 1, { turn: 1 }), record('not-a-real/event', 2, {}), prompt(3), reply(4),
      record('turn/end', 5, { turn: 1, reason: { kind: 'error' } })])
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:5', kind: 'failed' }))
  })
  it('never lets an unrecognized record fabricate turn state', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('not-a-real/turn-start', 1, { turn: 1 }), prompt(2), record('turn/end', 3, { turn: 1, reason: { kind: 'error' } })])
    await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('fails closed on a turn/start without a turn number', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('turn/start', 1, { turn: 'one' }), prompt(2), record('turn/end', 3, { turn: 1, reason: { kind: 'error' } })])
    await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('fails closed on a non-user message source', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('turn/start', 1, { turn: 1 }), record('user/message', 2, { source: { kind: 'plugin' } }), record('turn/end', 3, { turn: 1, reason: { kind: 'error' } })])
    await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('fails closed on an empty rpcId', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('turn/start', 1, { turn: 1 }), prompt(2, ''), record('turn/end', 3, { turn: 1, reason: { kind: 'error' } })])
    await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('fails closed on a turn/end without a reason', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('turn/start', 1, { turn: 1 }), prompt(2), record('turn/end', 3, { turn: 1 })])
    await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
  })
  it('fails closed on assistant content that cannot prove completed output', async () => {
    for (const content of ['Done', [], [{ type: 'text', text: '   ' }], [{ type: 'tool-call', id: 'call-1' }]]) {
      const f = fixture(true); await f.poller.poll()
      f.set(4, [record('turn/start', 1, { turn: 1 }), prompt(2), record('assistant/message', 3, { message: { role: 'assistant', content } }), record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })])
      await f.poller.poll(); expect(f.receive).not.toHaveBeenCalled()
    }
  })
  it('fails closed when the list envelope is missing', async () => {
    const receive = vi.fn(async () => {})
    const rpc = vi.fn(async () => [{ sessionId: 'root', cwd: '/workspace', running: false, projections: { asOfSeq: 4 } }])
    const poller = createHarnessNotificationPoll({ rpc, receive, allowCompleted: false })
    await expect(poller.poll()).rejects.toThrow('list is invalid'); expect(receive).not.toHaveBeenCalled()
  })
})

describe('waiting-for-user approval mapping', () => {
  // `approval/asked` without its matching `approval/decided` is the runtime's own durable
  // evidence that the session is waiting on the user; the ask's seq is the occurrence id.
  it('reports one action-required occurrence for an unanswered ask', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(5, [record('turn/start', 1, { turn: 1 }), prompt(2),
      record('approval/asked', 3, { id: 'approval-1', toolName: 'bash' }),
      record('tool/call', 4, {}), record('tool/result', 5, {})])
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({
      id: 'harness:root:3', kind: 'action-required', targetId: 'root',
      occurredAt: 1003, topLevel: true, presentation: 'background-only',
    }))
  })
  it('stays silent for a decided ask and never reports the decision as a new occurrence', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(3, [record('approval/asked', 2, { id: 'approval-1' }), record('approval/decided', 3, { id: 'approval-1', outcome: 'allowed-once' })])
    await f.poller.poll()
    f.set(4, [record('todo/write', 4, {})])
    await f.poller.poll()
    expect(f.receive).not.toHaveBeenCalled()
  })
  it('does not replay an ask observed before the watermark and ignores an unreadable identity', async () => {
    const pending = fixture()
    pending.set(2, [record('approval/asked', 2, { id: 'approval-1' })])
    await pending.poller.poll()
    expect(pending.receive).not.toHaveBeenCalled()
    pending.set(3, [record('approval/asked', 2, { id: 'approval-1' }), record('todo/write', 3, {})])
    await pending.poller.poll()
    expect(pending.receive).not.toHaveBeenCalled()

    const unreadable = fixture(); await unreadable.poller.poll()
    unreadable.set(3, [record('approval/asked', 2, {}), record('approval/asked', 3, { id: '' })])
    await unreadable.poller.poll()
    expect(unreadable.receive).not.toHaveBeenCalled()
  })
  it('reports only the still-pending ask when one decision settles another', async () => {
    const f = fixture(); await f.poller.poll()
    f.set(4, [record('approval/asked', 1, { id: 'a-1' }), record('approval/asked', 2, { id: 'a-2' }),
      record('approval/decided', 3, { id: 'a-1', outcome: 'rejected' }), record('todo/write', 4, {})])
    await f.poller.poll()
    expect(f.receive).toHaveBeenCalledOnce()
    expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'harness:root:2', kind: 'action-required' }))
  })
  it('raises no source dot for a pending ask and still hands it to the native adapter', async () => {
    const { createDesktopNotifications, DEFAULT_NOTIFICATION_PREFERENCES } = await import('../src/desktop-notifications.ts')
    const adapter = { supported: () => true, show: vi.fn(), setDockBadge: vi.fn(), dispose: vi.fn() }
    const notifications = createDesktopNotifications({
      initial: { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
      visibility: () => ({ focused: false, visible: false, minimized: false, source: 'chat' }),
      adapter, save: async () => {}, open: async () => {}, publish: () => {}, reportError: () => {},
    })
    const f = fixture()
    const poller = createHarnessNotificationPoll({ rpc: f.rpc, receive: event => notifications.receive(event), allowCompleted: true })
    await poller.poll()
    f.set(1, [record('approval/asked', 1, { id: 'approval-1' })])
    await poller.poll()
    const state = notifications.snapshot()
    expect(state.events).toHaveLength(1)
    expect(state.events[0]?.delivery).toBe('attempted')
    expect(state.harnessAttention ?? false).toBe(false)
    expect(state.harnessPendingCount ?? 0).toBe(0)
    expect(adapter.show).toHaveBeenCalledOnce()
  })
})

describe('receiver hand-off', () => {
  // One Harness completion must land as exactly one receipt, one source reminder, and one
  // pending count, read through the same envelope the runtime sends.
  it('turns one real completion into exactly one receipt, reminder, and pending count', async () => {
    const { createDesktopNotifications, DEFAULT_NOTIFICATION_PREFERENCES } = await import('../src/desktop-notifications.ts')
    const adapter = { supported: () => true, show: vi.fn(), setDockBadge: vi.fn(), dispose: vi.fn() }
    const notifications = createDesktopNotifications({
      initial: { preferences: DEFAULT_NOTIFICATION_PREFERENCES, events: [] },
      visibility: () => ({ focused: true, visible: true, minimized: false, source: 'chat', targetId: 'chat-1' }),
      adapter, save: async () => {}, open: async () => {}, publish: () => {}, reportError: () => {},
    })
    const f = fixture(true)
    const poller = createHarnessNotificationPoll({
      rpc: f.rpc,
      receive: event => notifications.receive(event),
      allowCompleted: true,
    })
    await poller.poll()
    f.set(4, [record('turn/start', 1, { turn: 1 }), prompt(2), reply(3), record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })])
    await poller.poll()
    await poller.poll()
    const state = notifications.snapshot()
    expect(state.events).toHaveLength(1)
    expect(state.harnessAttention).toBe(true)
    expect(state.harnessPendingCount).toBe(1)
    expect(state.chatPendingCount ?? 0).toBe(0)
    expect(adapter.setDockBadge).toHaveBeenLastCalledWith(1)
  })
})
