/** Chat completion endpoint matching and fail-closed observation. */
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_COMPLETION_ORIGIN,
  CHAT_COMPLETION_PATH,
  CHAT_COMPLETION_PATHS,
  CHAT_STOP_PATH,
  isChatCompletionRequest,
  isChatStopRequest,
  observeChatCompletions,
  type ChatCompletionObservation,
  type ChatCompletionSession,
} from '../src/chat-completion.ts'

interface CompletedRequest {
  readonly id: number
  readonly url: string
  readonly method: string
  readonly statusCode: number
  readonly webContentsId?: number
}

interface StartedRequest {
  readonly id: number
  readonly url: string
  readonly method: string
  readonly webContentsId?: number
}

/**
 * Stand-in for the two `webRequest` events the observer uses.
 *
 * `start` models the real lifecycle: Electron reports a request when it begins
 * (and only proceeds once the listener calls back) and again when it finishes,
 * keyed by the same request id.
 */
function fakeSession() {
  let onStart: ((details: StartedRequest, callback: (response: unknown) => void) => void) | null = null
  let onFinish: ((details: CompletedRequest) => void) | null = null
  const mount = (first: unknown, second?: unknown): ((details: never, callback?: never) => void) | null =>
    (typeof first === 'function' ? first : (first === null ? null : second)) as ((details: never, callback?: never) => void) | null
  const webRequest = {
    onBeforeRequest: (first: unknown, second?: unknown): void => {
      onStart = mount(first, second) as ((details: StartedRequest, callback: (response: unknown) => void) => void) | null
    },
    onCompleted: (first: unknown, second?: unknown): void => {
      onFinish = mount(first, second) as ((details: CompletedRequest) => void) | null
    },
  }
  /** What the start listener handed Chromium: how often, and whether it continued. */
  const starts: Array<{ details: StartedRequest; callbacks: Array<Record<string, unknown>> }> = []
  const start = (details: Partial<StartedRequest>): void => {
    const full: StartedRequest = {
      id: 1,
      url: `${CHAT_COMPLETION_ORIGIN}${CHAT_COMPLETION_PATH}`,
      method: 'POST',
      ...details,
    }
    const callbacks: Array<Record<string, unknown>> = []
    onStart?.(full, (response: unknown) => { callbacks.push(response as Record<string, unknown>) })
    starts.push({ details: full, callbacks })
  }
  const finish = (details: Partial<CompletedRequest>): void => {
    onFinish?.({
      id: 1,
      url: `${CHAT_COMPLETION_ORIGIN}${CHAT_COMPLETION_PATH}`,
      method: 'POST',
      statusCode: 200,
      ...details,
    })
  }
  return {
    session: { webRequest } as unknown as ChatCompletionSession,
    /** A whole request that started and finished, the common case. */
    emit: (details: Partial<CompletedRequest>): void => { start(details); finish(details) },
    start,
    finish,
    starts,
    attached: (): boolean => onStart !== null && onFinish !== null,
    listenerState: (): { start: boolean; finish: boolean } => ({ start: onStart !== null, finish: onFinish !== null }),
  }
}

function observer(overrides: Partial<Parameters<typeof observeChatCompletions>[0]> = {}) {
  const fake = fakeSession()
  const seen: ChatCompletionObservation[] = []
  const reportError = vi.fn()
  const dispose = observeChatCompletions({
    session: fake.session,
    onCompletion: (observation) => { seen.push(observation) },
    reportError,
    createNonce: () => 'nonce',
    now: () => 1234,
    ...overrides,
  })
  return { fake, seen, reportError, dispose }
}

describe('isChatCompletionRequest', () => {
  it('accepts every audited completion path, with or without a query string', () => {
    for (const path of CHAT_COMPLETION_PATHS) {
      expect([path, isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}${path}`)]).toEqual([path, true])
      expect([path, isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}${path}?x=1&y=2`)]).toEqual([path, true])
    }
  })

  it('covers a first answer, a regenerated answer, and a continuation', () => {
    // Real-session evidence: Regenerate issues POST /api/v0/chat/regenerate and
    // Continue issues POST /api/v0/chat/continue, each finishing 2xx.
    expect(isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}/api/v0/chat/completion`)).toBe(true)
    expect(isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate`)).toBe(true)
    expect(isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}/api/v0/chat/continue`)).toBe(true)
  })

  it('recognises the stop endpoint but never treats it as a completion', () => {
    expect(isChatStopRequest(`${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}`)).toBe(true)
    expect(isChatStopRequest(`${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}?x=1`)).toBe(true)
    expect(isChatStopRequest('https://example.com/api/v0/chat/stop_stream')).toBe(false)
    expect(isChatCompletionRequest(`${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}`)).toBe(false)
  })

  it('rejects a different origin, scheme, path, or a longer prefix', () => {
    for (const url of [
      `http://chat.deepseek.com${CHAT_COMPLETION_PATH}`,
      'https://chat.deepseek.com/api/v0/chat/completion/extra',
      'https://chat.deepseek.com/api/v0/chat',
      'https://chat.deepseek.com/api/v0/chat/regenerate/extra',
      'https://chat.deepseek.com/api/v0/chat/stop',
      'https://example.com/api/v0/chat/completion',
      'https://example.com/api/v0/chat/regenerate',
      'https://chat.deepseek.com.evil.test/api/v0/chat/completion',
      'https://chat.deepseek.com.evil.test/api/v0/chat/regenerate',
      'not a url',
      '',
    ]) {
      expect([url, isChatCompletionRequest(url)]).toEqual([url, false])
    }
  })
})

describe('observeChatCompletions', () => {
  it('reports one finished POST with a launch-scoped identity', () => {
    const o = observer()
    o.fake.emit({ id: 7 })
    expect(o.seen).toEqual([{ id: 'chat-completion:nonce:7', occurredAt: 1234 }])
  })

  it('reports a regenerated answer as its own occurrence', () => {
    const o = observer()
    // The exact real-session shape: Regenerate is a POST to /api/v0/chat/regenerate.
    o.fake.emit({ id: 143, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    o.fake.emit({ id: 173, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    expect(o.seen).toEqual([
      { id: 'chat-completion:nonce:143', occurredAt: 1234 },
      { id: 'chat-completion:nonce:173', occurredAt: 1234 },
    ])
  })

  it('keeps a first answer and a later regeneration distinct', () => {
    const o = observer()
    o.fake.emit({ id: 109 })
    o.fake.emit({ id: 143, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    o.fake.emit({ id: 202 })
    expect(o.seen.map(entry => entry.id)).toEqual([
      'chat-completion:nonce:109',
      'chat-completion:nonce:143',
      'chat-completion:nonce:202',
    ])
  })

  it('stays silent for a regenerate that did not finish successfully', () => {
    const o = observer()
    o.fake.emit({ id: 1, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate`, statusCode: 500 })
    o.fake.emit({ id: 2, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate`, method: 'GET' })
    expect(o.seen).toEqual([])
  })

  it('reports a continuation as its own occurrence', () => {
    const o = observer()
    o.fake.emit({ id: 76 })
    o.fake.emit({ id: 97, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    o.fake.emit({ id: 173, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/continue` })
    expect(o.seen.map(entry => entry.id)).toEqual([
      'chat-completion:nonce:76',
      'chat-completion:nonce:97',
      'chat-completion:nonce:173',
    ])
  })

  it('stays silent for a generation the user stopped, which still reports 2xx', () => {
    const o = observer()
    // Real lifecycle: the generation starts, the stop starts while it is running,
    // and the generation's transport still ends with 200.
    o.fake.start({ id: 126, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/completion` })
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 126, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/completion`, statusCode: 200 })
    expect(o.seen).toEqual([])
  })

  it('suppresses a stopped continuation too', () => {
    const o = observer()
    o.fake.start({ id: 135, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/continue` })
    o.fake.emit({ id: 143, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 135, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/continue` })
    expect(o.seen).toEqual([])
  })

  it('suppresses a stopped regenerate too', () => {
    const o = observer()
    o.fake.start({ id: 97, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 97, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    expect(o.seen).toEqual([])
  })

  it('still reports a completion that had already finished when the stop started', () => {
    const o = observer()
    o.fake.emit({ id: 76 })
    // The stop belongs to whatever comes next, not to the answer above.
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    expect(o.seen.map(entry => entry.id)).toEqual(['chat-completion:nonce:76'])
  })

  it('does not let an earlier stop suppress a generation that starts afterwards', () => {
    const o = observer()
    o.fake.emit({ id: 50, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.emit({ id: 76 })
    expect(o.seen.map(entry => entry.id)).toEqual(['chat-completion:nonce:76'])
  })

  it('recovers after a stop: the next generation still reports', () => {
    const o = observer()
    o.fake.start({ id: 126 })
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 126 })
    // Stop is consumed by the generation it interrupted; the next one is clean.
    o.fake.emit({ id: 140 })
    o.fake.emit({ id: 150, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/regenerate` })
    o.fake.emit({ id: 160, url: `${CHAT_COMPLETION_ORIGIN}/api/v0/chat/continue` })
    expect(o.seen.map(entry => entry.id)).toEqual([
      'chat-completion:nonce:140',
      'chat-completion:nonce:150',
      'chat-completion:nonce:160',
    ])
  })

  it('keeps repeated stop/generation cycles from contaminating each other', () => {
    const o = observer()
    const cycle = (generation: number, stop: number, expected: boolean): void => {
      o.fake.start({ id: generation })
      o.fake.emit({ id: stop, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
      o.fake.finish({ id: generation })
      if (expected) expect(o.seen.at(-1)?.id).toBe(`chat-completion:nonce:${String(generation)}`)
    }
    cycle(10, 11, false)   // stopped
    o.fake.emit({ id: 20 })  // clean
    cycle(30, 31, false)   // stopped
    cycle(40, 41, false)   // stopped again
    o.fake.emit({ id: 50 })  // clean again
    expect(o.seen.map(entry => entry.id)).toEqual([
      'chat-completion:nonce:20',
      'chat-completion:nonce:50',
    ])
  })

  it('scopes a stop to the surface that issued it', () => {
    const o = observer()
    o.fake.start({ id: 100, webContentsId: 7 })
    o.fake.start({ id: 101, webContentsId: 9 })
    // The stop comes from surface 9 only.
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}`, webContentsId: 9 })
    o.fake.finish({ id: 100, webContentsId: 7 })
    o.fake.finish({ id: 101, webContentsId: 9 })
    // Surface 7's answer is untouched; surface 9's was stopped.
    expect(o.seen.map(entry => entry.id)).toEqual(['chat-completion:nonce:100'])
  })

  it('stays silent for a completion whose start was never observed', () => {
    const o = observer()
    // No start record: the observer cannot prove this answer was uninterrupted.
    o.fake.finish({ id: 126 })
    expect(o.seen).toEqual([])
  })

  it('ignores a stop that was not a POST and one from another origin', () => {
    const o = observer()
    o.fake.start({ id: 126 })
    o.fake.emit({ id: 132, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}`, method: 'GET' })
    o.fake.emit({ id: 133, url: `https://example.com${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 126 })
    // Neither stop counts, so the generation is still reported.
    expect(o.seen.map(entry => entry.id)).toEqual(['chat-completion:nonce:126'])
  })

  it('does not order requests by id magnitude', () => {
    const o = observer()
    // A generation with a HIGHER id that starts first must still be stoppable by a
    // LOW id stop, and vice versa: only observed lifecycle order decides.
    o.fake.start({ id: 900 })
    o.fake.emit({ id: 5, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    o.fake.finish({ id: 900 })
    expect(o.seen).toEqual([])

    const second = observer()
    second.fake.start({ id: 5 })
    second.fake.emit({ id: 900, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })
    second.fake.finish({ id: 5 })
    expect(second.seen).toEqual([])
  })

  it('ignores a non-POST, a non-2xx, and a non-completion URL', () => {
    const o = observer()
    o.fake.emit({ method: 'GET' })
    o.fake.emit({ statusCode: 500 })
    o.fake.emit({ statusCode: 0 })
    o.fake.emit({ url: 'https://chat.deepseek.com/api/v0/other' })
    expect(o.seen).toEqual([])
  })

  it('treats 2xx boundaries as completed and everything else as not', () => {
    const o = observer()
    for (const statusCode of [200, 201, 204, 299]) o.fake.emit({ id: statusCode, statusCode })
    for (const statusCode of [199, 300, 404]) o.fake.emit({ id: statusCode, statusCode })
    expect(o.seen.map(entry => entry.id)).toEqual([
      'chat-completion:nonce:200',
      'chat-completion:nonce:201',
      'chat-completion:nonce:204',
      'chat-completion:nonce:299',
    ])
  })

  it('never reports the same finished request twice', () => {
    const o = observer()
    o.fake.emit({ id: 5 })
    o.fake.emit({ id: 5 })
    expect(o.seen).toHaveLength(1)
  })

  it('keeps ids distinct across launches so a restart cannot dedupe a new reply', () => {
    const first = observer({ createNonce: () => 'launch-a' })
    const second = observer({ createNonce: () => 'launch-b' })
    first.fake.emit({ id: 3 })
    second.fake.emit({ id: 3 })
    expect(first.seen[0]?.id).toBe('chat-completion:launch-a:3')
    expect(second.seen[0]?.id).toBe('chat-completion:launch-b:3')
  })

  it('registers once per session instead of replacing the live listener', () => {
    const o = observer()
    const again = observeChatCompletions({
      session: o.fake.session,
      onCompletion: () => { throw new Error('a second registration must not take over') },
      reportError: vi.fn(),
    })
    expect(again).toBe(o.dispose)
    o.fake.emit({ id: 1 })
    expect(o.seen).toHaveLength(1)
  })

  it('detaches both lifecycle listeners on dispose and lets a later registration take over', () => {
    const o = observer()
    o.dispose()
    // Both events must be released, or a stale observer would keep tracking.
    expect(o.fake.listenerState()).toEqual({ start: false, finish: false })
    o.fake.emit({ id: 1 })
    expect(o.seen).toEqual([])
    const revived: ChatCompletionObservation[] = []
    observeChatCompletions({
      session: o.fake.session,
      onCompletion: (observation) => { revived.push(observation) },
      reportError: vi.fn(),
    })
    o.fake.emit({ id: 2 })
    expect(revived).toHaveLength(1)
  })

  it('reports nothing when the session cannot observe request starts', () => {
    const seen: ChatCompletionObservation[] = []
    // Only onCompleted exists: a generation could never be proven uninterrupted,
    // so the observer must stay silent rather than guess.
    const partial = {
      webRequest: {
        onCompleted: (): void => { throw new Error('must not be used') },
      },
    } as unknown as ChatCompletionSession
    const dispose = observeChatCompletions({
      session: partial,
      onCompletion: (observation) => { seen.push(observation) },
      reportError: vi.fn(),
    })
    expect(seen).toEqual([])
    expect(() => { dispose() }).not.toThrow()
  })

  it('continues every request it observes, unmodified, exactly once', () => {
    const o = observer()
    o.fake.start({ id: 1 })                                                            // matched generation
    o.fake.start({ id: 2, url: `${CHAT_COMPLETION_ORIGIN}${CHAT_STOP_PATH}` })          // matched stop
    o.fake.start({ id: 3, method: 'GET' })                                             // unrelated method
    o.fake.start({ id: 4, url: 'https://example.com/sidebar-click' })                  // unrelated origin
    expect(o.fake.starts).toHaveLength(4)
    for (const started of o.fake.starts) {
      // Does not cancel, does not redirect, and does not call back twice.
      expect(started.callbacks).toEqual([{}])
    }
  })

  it('continues the request even when tracking throws', () => {
    const reportError = vi.fn()
    const o = observer({
      reportError,
      // A matcher that explodes inside the tracking path.
      matches: () => { throw new Error('matcher failed') },
      matchesStop: () => false,
    })
    expect(() => { o.fake.start({ id: 1 }) }).not.toThrow()
    // The failure is reported, and the request is still continued exactly once.
    expect(reportError).toHaveBeenCalledOnce()
    expect(o.fake.starts[0]?.callbacks).toEqual([{}])
  })

  it('reports a throwing consumer instead of escaping the event listener', () => {
    const reportError = vi.fn()
    const o = observer({
      reportError,
      onCompletion: () => { throw new Error('consumer failed') },
    })
    expect(() => { o.fake.emit({ id: 1 }) }).not.toThrow()
    expect(reportError).toHaveBeenCalledOnce()
  })

  it('bounds tracked generations so an abandoned request cannot leak', () => {
    const o = observer()
    // Far more started-but-never-finished generations than the retained bound.
    for (let id = 0; id < 400; id += 1) o.fake.start({ id })
    // The observer still works for a request it can see start and finish.
    o.fake.emit({ id: 1000 })
    expect(o.seen.map(entry => entry.id)).toEqual(['chat-completion:nonce:1000'])
  })
})
