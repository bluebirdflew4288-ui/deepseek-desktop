/** Bounded, read-only Harness history polling; missing continuity loses alerts rather than replaying history. */
import type { DesktopTaskEvent } from './desktop-notifications.ts'

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}
function seq(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function identity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 }
interface Summary { id: string; cursor: number }
interface RecordEvent { type: string; seq: number; time: number; data: JsonObject }
function summaries(value: unknown): Summary[] {
  // The audited Remote method returns its summaries inside an envelope, and the Gateway
  // forwards that business result without output decoding, so the value is `{ items }`.
  // `object()` is deliberately undefined for arrays, which keeps the list contract closed
  // to the one shape the runtime sends instead of guessing at a second one.
  const items = object(value)?.items
  if (!Array.isArray(items)) throw new Error('Harness notification list is invalid')
  const result: Summary[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const item = object(raw)
    if (item === undefined || !identity(item.sessionId) || seen.has(item.sessionId)) throw new Error('Harness notification identity is invalid')
    seen.add(item.sessionId)
    // Ordinary forks are excluded as well: list hints cannot prove seed-prefix ownership.
    if (item.origin !== undefined || item.parentSessionId !== undefined) continue
    const cursor = object(item.projections)?.asOfSeq
    if (typeof item.running !== 'boolean' || typeof item.cwd !== 'string' || !seq(cursor)) continue
    result.push({ id: item.sessionId, cursor })
    if (result.length === 128) break
  }
  return result
}
function events(value: unknown, cursor: number): RecordEvent[] {
  const page = object(value)
  if (page === undefined || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('Harness notification page is invalid')
  const result: RecordEvent[] = []
  for (const raw of page.records) {
    const wrapper = object(raw)
    const e = object(wrapper?.event)
    if (wrapper?.type !== 'event' || e === undefined || typeof e.type !== 'string' || !seq(e.seq)
      || typeof e.time !== 'number' || !Number.isFinite(e.time) || e.seq > cursor) throw new Error('Harness notification record is invalid')
    const previous = result.at(-1)
    if (previous !== undefined && e.seq !== previous.seq + 1) throw new Error('Harness notification page has a sequence gap')
    result.push({ type: e.type, seq: e.seq, time: e.time, data: object(e.data) ?? {} })
  }
  return result
}
/**
 * Create one launch-scoped polling state; initial and discontinuous observations only establish cursors.
 * @param options - Read-only RPC and the existing durable notification receiver. Completion is opt-in for verification only.
 * @returns A single-flight poll operation; callers own scheduling and cancellation.
 */
export function createHarnessNotificationPoll(options: {
  rpc: (method: 'session/list' | 'session/page', args: JsonObject) => Promise<unknown>
  receive: (event: DesktopTaskEvent) => Promise<void>
  allowCompleted: boolean
}) {
  let cursors = new Map<string, number>()
  const quarantined = new Set<string>()
  let active: Promise<void> | undefined
  async function run(): Promise<void> {
    try {
      const current = summaries(await options.rpc('session/list', { _request: {} }))
      const next = new Map<string, number>()
      let pages = 0
      for (const s of current) {
        if (quarantined.has(s.id)) continue
        const previous = cursors.get(s.id)
        if (previous !== undefined && s.cursor < previous) {
          quarantined.add(s.id)
          continue
        }
        next.set(s.id, s.cursor)
        if (previous === undefined || s.cursor <= previous || pages >= 8) continue
        pages += 1
        const records = events(await options.rpc('session/page', {
          request: { address: { kind: 'session', sessionId: s.id }, throughSeq: s.cursor, maxMessages: 32 },
        }), s.cursor)
        // The bounded page must cover the entire unseen interval. No backfill or cold activation.
        if ((records[0]?.seq ?? Infinity) > previous + 1 || records.at(-1)?.seq !== s.cursor) continue
        // Consumed-event contract: `session/page` is already the runtime's validated data
        // boundary, because Session persistence rejects unknown non-ignorable events and
        // admits unknown ignorable ones. This poller therefore interprets only the events
        // the completion and waiting-for-user alerts depend on and skips every other legal
        // record without touching turn state. Re-declaring the full event vocabulary here
        // would let one unrelated record abort the cycle and lose a real completion.
        // A turn may start before the observation watermark and end after it, so turn state is
        // rebuilt from whatever evidence the bounded page still carries. Freshness is decided
        // only by `turn/end.seq > previous`, which is what keeps ended-before-watermark turns
        // from ever being replayed.
        let turn: { number: number; user: boolean; assistant: boolean } | undefined
        // The runtime's own audit pair for a user decision: `approval/asked` is appended
        // before the answerer runs and `approval/decided` after it settles, so an ask
        // without its matching decision is the durable, content-free evidence that this
        // session is waiting on the user. Both events are named in the audited runtime's
        // known-event vocabulary.
        const asked = new Map<string, RecordEvent>()
        const decided = new Set<string>()
        for (const e of records) {
          if (e.type === 'turn/start') {
            turn = seq(e.data.turn) ? { number: e.data.turn, user: false, assistant: false } : undefined
          } else if (e.type === 'user/message' && turn !== undefined) {
            const source = object(e.data.source)
            if (source?.kind === 'user' && identity(source.rpcId)) turn.user = true
          } else if (e.type === 'assistant/message' && turn !== undefined) {
            // The transcript nests assistant parts under `message`, not directly on the record.
            const content = object(e.data.message)?.content
            turn.assistant = Array.isArray(content) && content.some((part) => {
              const p = object(part)
              return p?.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0
            })
          } else if (e.type === 'approval/asked') {
            // An ask whose identity cannot be read cannot be matched against a decision,
            // so it is dropped rather than reported as pending.
            if (identity(e.data.id)) asked.set(e.data.id, e)
          } else if (e.type === 'approval/decided') {
            if (identity(e.data.id)) decided.add(e.data.id)
          } else if (e.type === 'turn/end') {
            const reason = object(e.data.reason)?.kind
            const kind = reason === 'error' ? 'failed' : reason === 'completed' && options.allowCompleted && turn?.assistant === true ? 'completed' : undefined
            if (e.seq > previous && kind !== undefined && turn?.user === true && e.data.turn === turn.number) {
              await options.receive({ id: `harness:${s.id}:${e.seq}`, source: 'harness', targetId: s.id,
                kind, occurredAt: e.time, topLevel: true, presentation: 'background-only' })
            }
            turn = undefined
          }
        }
        // Only an ask newer than the watermark is reported: one observed before this
        // reader's baseline is history, exactly like a turn that ended before it.
        for (const [id, ask] of asked) {
          if (decided.has(id) || ask.seq <= previous) continue
          await options.receive({ id: `harness:${s.id}:${ask.seq}`, source: 'harness', targetId: s.id,
            kind: 'action-required', occurredAt: ask.time, topLevel: true, presentation: 'background-only' })
        }
      }
      cursors = next
    } catch (error) {
      cursors.clear()
      throw error
    }
  }
  return {
    poll(): Promise<void> {
      active ??= run().finally(() => { active = undefined })
      return active
    },
  }
}
