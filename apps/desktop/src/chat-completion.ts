/**
 * Read-only observation of finished official Chat turns.
 *
 * The embedded Chat surface is the official DeepSeek website, so this desktop
 * owns no chat protocol of its own. The one content-free signal that already
 * exists is the completion request itself: the shipped Memory bridge treats
 * `POST https://chat.deepseek.com/api/v0/chat/completion` as the audited
 * completion endpoint, and Electron's session observer sees that same request
 * finish. Only the request lifecycle is observed — the response body is never
 * read, so no message content is retained or interpreted.
 *
 * This is deliberately not a DOM heuristic: nothing here watches rendered text,
 * selectors, timers, or framework internals.
 */

import { randomUUID } from 'node:crypto'
import type { CallbackResponse, OnBeforeRequestListenerDetails, OnCompletedListenerDetails, Session } from 'electron'

/** Audited origin of the official Chat completion endpoints. */
export const CHAT_COMPLETION_ORIGIN = 'https://chat.deepseek.com'
/**
 * Audited paths of the official Chat completion family.
 *
 * Each is a `POST` on the Chat origin that carries a generated answer, and each
 * was observed finishing successfully on a real session:
 * - `/api/v0/chat/completion` — a first answer for the turn.
 * - `/api/v0/chat/regenerate` — a replacement answer for the same turn.
 * - `/api/v0/chat/continue` — a continuation appended to the same answer.
 *
 * A path outside this family is never treated as a completion, so an unknown
 * endpoint stays silent rather than fabricating a result.
 */
export const CHAT_COMPLETION_PATHS: readonly string[] = [
  '/api/v0/chat/completion',
  '/api/v0/chat/regenerate',
  '/api/v0/chat/continue',
]
/** The first-answer endpoint, kept for the fixture and the existing tests. */
export const CHAT_COMPLETION_PATH = CHAT_COMPLETION_PATHS[0] as string

/**
 * Audited path of the client's explicit stop request.
 *
 * Stopping a generation does not fail its transport: on a real session a stopped
 * completion still ended with HTTP 200. This request is the only content-free
 * evidence that the user cut the answer short, so it is what keeps a truncated
 * reply from being announced as a finished one.
 */
export const CHAT_STOP_PATH = '/api/v0/chat/stop_stream'

/**
 * URL filter for the blocking-capable start listener.
 *
 * Every audited endpoint lives under this path prefix, and the host is matched
 * loosely so an injected matcher (the fixture's loopback origin) still works.
 * Everything else is filtered out by Chromium before the listener is invoked.
 */
const CHAT_API_URL_FILTER = '*://*/api/v0/chat/*'

/** Bounded number of finished request ids retained for in-launch duplicate protection. */
const SEEN_LIMIT = 4096
/**
 * Bound on tracked in-flight generations.
 *
 * A generation whose transport dies without ever reporting completion would
 * otherwise be retained forever, so the oldest records are dropped once the map
 * grows past this size.
 */
const GENERATION_LIMIT = 256

/** One finished Chat turn, identified without any conversation identity. */
export interface ChatCompletionObservation {
  /**
   * Occurrence identity. It carries a per-observer launch nonce, so an id can
   * never collide with one persisted by an earlier launch.
   */
  readonly id: string
  /** When the completion request finished, in wall-clock milliseconds. */
  readonly occurredAt: number
}

/** Lifecycle state of one generation request that has started but not finished. */
interface GenerationRecord {
  /** Whether a stop was observed while this generation was running. */
  stopped: boolean
  /** Rendering surface that owns the request, used to scope stop correlation. */
  readonly contents: number
}

/**
 * Reduce a URL to its audited origin and pathname.
 * @param url - Absolute URL reported by the session observer.
 * @returns The parsed parts, or undefined for an unparsable URL.
 */
function endpoint(url: string): { origin: string; pathname: string } | undefined {
  try {
    const parsed = new URL(url)
    return { origin: parsed.origin, pathname: parsed.pathname }
  } catch {
    return undefined
  }
}

/**
 * Test whether a URL is one of the audited official Chat completion endpoints.
 *
 * Origin and path must match exactly. A query string is allowed because the
 * official client appends one; any other path — including a longer one that
 * merely starts with the same text — is rejected.
 * @param url - Absolute URL reported by the session observer.
 * @returns Whether the request targets an audited completion endpoint.
 */
export function isChatCompletionRequest(url: string): boolean {
  const parts = endpoint(url)
  return parts !== undefined
    && parts.origin === CHAT_COMPLETION_ORIGIN
    && CHAT_COMPLETION_PATHS.includes(parts.pathname)
}

/**
 * Test whether a URL is the audited official Chat stop endpoint.
 * @param url - Absolute URL reported by the session observer.
 * @returns Whether the request asks the server to stop the running stream.
 */
export function isChatStopRequest(url: string): boolean {
  const parts = endpoint(url)
  return parts !== undefined && parts.origin === CHAT_COMPLETION_ORIGIN && parts.pathname === CHAT_STOP_PATH
}

/** The session capabilities this observer needs. */
export type ChatCompletionSession = {
  readonly webRequest?: Pick<Session['webRequest'], 'onBeforeRequest' | 'onCompleted'> | undefined
}

/**
 * Fail-closed guard: a session that cannot expose both lifecycle listeners simply
 * yields no observations. Start tracking needs `onBeforeRequest` and completion
 * needs `onCompleted`; without either, a generation could not be proven
 * uninterrupted, so nothing is reported. This keeps a partial or stubbed session
 * from taking the desktop down, and it can never fabricate a completion.
 * @param session - Session the observer would attach to.
 * @returns Whether the session can report both request start and finish.
 */
function canObserve(session: ChatCompletionSession): session is {
  readonly webRequest: Pick<Session['webRequest'], 'onBeforeRequest' | 'onCompleted'>
} {
  return typeof session.webRequest?.onBeforeRequest === 'function'
    && typeof session.webRequest.onCompleted === 'function'
}

/** One observer per session, so a second registration cannot silently replace the first. */
const installed = new WeakMap<ChatCompletionSession, () => void>()

/**
 * Observe finished official Chat completions on one session.
 *
 * Registration is per session and idempotent: registering twice returns the
 * existing disposer instead of replacing the listener, because Electron keeps a
 * single listener per `webRequest` event per session and a blind re-registration
 * would drop the earlier one.
 *
 * Correlation is by observed request lifecycle, not by request-id magnitude:
 * a generation is tracked from its start, and a stop only marks the generations
 * that are still running on the same rendering surface when that stop begins.
 *
 * Every rejection path is fail-closed: a request that did not finish with a 2xx
 * response, was not a POST, does not match an audited endpoint, was already
 * reported, whose start was never observed, or that was stopped while running
 * produces no observation.
 *
 * @param options - Session, endpoint matchers, occurrence identity, and reporting.
 * @returns A disposer that detaches both listeners; it is safe to call repeatedly.
 */
export function observeChatCompletions(options: {
  readonly session: ChatCompletionSession
  readonly onCompletion: (observation: ChatCompletionObservation) => void
  readonly reportError: (error: unknown) => void
  /** Endpoint matcher. Defaults to the audited official endpoints. */
  readonly matches?: (url: string) => boolean
  /** Stop matcher. Defaults to the audited official stop endpoint. */
  readonly matchesStop?: (url: string) => boolean
  /** Occurrence nonce factory; injectable so a test can pin identities. */
  readonly createNonce?: () => string
  /** Clock used for the reported completion time; injectable for tests. */
  readonly now?: () => number
}): () => void {
  const existing = installed.get(options.session)
  if (existing !== undefined) return existing
  // Nothing to observe on a session without both capabilities; report nothing.
  if (!canObserve(options.session)) return () => {}

  const session = options.session
  const matches = options.matches ?? isChatCompletionRequest
  const matchesStop = options.matchesStop ?? isChatStopRequest
  const createNonce = options.createNonce ?? ((): string => randomUUID())
  const now = options.now ?? ((): number => Date.now())
  const nonce = createNonce()
  const seen = new Set<number>()
  // Generations that have started and not yet finished, keyed by request id.
  const generations = new Map<number, GenerationRecord>()
  // Which of those are still running on each rendering surface.
  const runningByContents = new Map<number, Set<number>>()

  const forgetGeneration = (id: number): void => {
    const record = generations.get(id)
    if (record === undefined) return
    generations.delete(id)
    const running = runningByContents.get(record.contents)
    if (running === undefined) return
    running.delete(id)
    if (running.size === 0) runningByContents.delete(record.contents)
  }

  const onBeforeRequest = (
    details: OnBeforeRequestListenerDetails,
    callback: (response: CallbackResponse) => void,
  ): void => {
    try {
      if (details.method.toUpperCase() === 'POST') {
        const contents = details.webContentsId ?? 0
        if (matchesStop(details.url)) {
          // The user asked to stop. A stop can only target a generation that is
          // still running on the surface that issued it, so exactly those are
          // marked; a generation that starts later is untouched and stays eligible.
          for (const id of runningByContents.get(contents) ?? []) {
            const record = generations.get(id)
            if (record !== undefined) record.stopped = true
          }
        } else if (matches(details.url)) {
          generations.set(details.id, { stopped: false, contents })
          const running = runningByContents.get(contents) ?? new Set<number>()
          running.add(details.id)
          runningByContents.set(contents, running)
          if (generations.size > GENERATION_LIMIT) {
            const oldest = generations.keys().next().value
            if (oldest !== undefined) forgetGeneration(oldest)
          }
        }
      }
    } catch (error) {
      options.reportError(error)
    } finally {
      // This listener only observes. It must never cancel, redirect, or delay a
      // request, so every path — including a tracking failure — continues the
      // request unmodified with exactly one callback call.
      callback({})
    }
  }

  const onCompleted = (details: OnCompletedListenerDetails): void => {
    try {
      if (details.method.toUpperCase() !== 'POST') return
      if (matchesStop(details.url)) return
      if (!matches(details.url)) return
      // Recycle first, so one outcome can never leave a record behind.
      const record = generations.get(details.id)
      forgetGeneration(details.id)
      if (details.statusCode < 200 || details.statusCode >= 300) return
      // One finished request must never produce two notifications.
      if (seen.has(details.id)) return
      // Fail closed. A stopped generation still reports 2xx, so its transport is
      // indistinguishable from a finished answer; and a generation whose start was
      // never observed cannot be proven uninterrupted. A missed alert is
      // recoverable, a wrong one is not.
      if (record === undefined || record.stopped) return
      if (seen.size >= SEEN_LIMIT) seen.clear()
      seen.add(details.id)
      options.onCompletion({
        id: `chat-completion:${nonce}:${String(details.id)}`,
        occurredAt: now(),
      })
    } catch (error) {
      options.reportError(error)
    }
  }

  // The start listener can block a request, so it is narrowed to the audited Chat
  // API path family: unrelated requests never enter it at all. Host is left open
  // because the matcher is injectable (the fixture serves the same paths on
  // loopback). The finish listener cannot block anything, so it stays unfiltered.
  session.webRequest.onBeforeRequest({ urls: [CHAT_API_URL_FILTER] }, onBeforeRequest)
  session.webRequest.onCompleted({ urls: ['*://*/*'] }, onCompleted)

  let released = false
  const dispose = (): void => {
    if (released) return
    released = true
    installed.delete(session)
    session.webRequest.onBeforeRequest(null)
    session.webRequest.onCompleted(null)
    generations.clear()
    runningByContents.clear()
    seen.clear()
  }
  installed.set(session, dispose)
  return dispose
}
