/** Opt-in-by-runtime-fingerprint reader for the audited installed Harness RPC; never opens event streams. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DesktopTaskEvent } from './desktop-notifications.ts'
import { createHarnessNotificationPoll } from './harness-notification-poll.ts'

// Session format alone does not version RPC or cold-read behavior. Unknown bundles stay disconnected.
const AUDITED_FILES: Readonly<Record<string, string>> = {
  'dsh-api-session-controller/lib/index.js': '16ecb48f33996efe72868f1603223214430634c5ac4c3e8fe9060bf240e990ff',
  'dsh-session-query/lib/index.js': 'c2a3954a0060942b179a92111cce556f27b8d659a4d815bb0e9defadbdb874da',
  'dsh-session/lib/index.js': '05e94f57d96e7979670a5b51024c8591572eb0051ce793613dbdec35cf2c47bf',
  'dsh-subagent/lib/index.js': 'b8ea0e37bd6f1d9c4bd870c4ca03839f6d0e42f648a83578e31a448f6dffe4ef',
  'dsh-agent-loop/lib/index.js': '257eb83c00a05ee068e9f4ba80ca71ab94e3a1275d24b7a0cf5038ff23dd0fd8',
  'dsh-api-gateway/lib/index.js': 'ee3b7ee01e87638813d0f304a8f7527d79e8e42990247116fa67086eb268e699',
  'dsh-client-connection/lib/index.js': 'bbe7c9aa6d82a7a4ec657aa8bc51064e12bb091be0465526d0b9f5e031f540f7',
}
/**
 * Check the executed module files of the installed, audited rc.2 protocol combination.
 * @param cliEntry - Managed launch's absolute CLI entry, never a guessed user directory.
 * @returns Whether the read-only behavior matches the audited artifacts.
 */
export async function supportsHarnessNotificationReads(cliEntry: string): Promise<boolean> {
  const root = dirname(dirname(dirname(cliEntry)))
  try {
    const matches = await Promise.all(Object.entries(AUDITED_FILES).map(async ([relative, expected]) =>
      createHash('sha256').update(await readFile(join(root, relative))).digest('hex') === expected))
    return matches.every(Boolean)
  } catch {
    // Missing/unreadable managed modules cannot qualify for notification observation.
    return false
  }
}
/**
 * Start a single-flight, bounded poll using the Harness view's authenticated Electron session.
 * @param options - Audited launch, authenticated fetch, durable receiver and content-free diagnostics.
 * @returns An async disposer that aborts and joins outstanding reads before Host shutdown.
 */
export async function observeHarnessNotifications(options: {
  cliEntry: string
  origin: string
  fetch: typeof fetch
  receive: (event: DesktopTaskEvent) => Promise<void>
  reportError: (error: unknown) => void
}): Promise<() => Promise<void>> {
  if (!await supportsHarnessNotificationReads(options.cliEntry)) {
    options.reportError(new Error('Harness background notifications disabled: unaudited runtime'))
    return async () => {}
  }
  const url = new URL(options.origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.origin !== options.origin) {
    throw new Error('Harness notification observer requires the owned loopback origin')
  }
  const lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  let reported = false
  const poller = createHarnessNotificationPoll({
    // Completion still requires a matching root user turn plus non-empty assistant output; that mapping is now real.
    allowCompleted: true,
    receive: async (event) => { if (!lifetime.signal.aborted) await options.receive(event) },
    rpc: async (method, args) => {
      const rpcId = randomUUID()
      const response = await options.fetch(`${options.origin}/api/${method}`, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Origin: options.origin },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3_000)]),
      })
      if (!response.ok || response.body === null) throw new Error('Harness notification read failed')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 524_288) throw new Error('Harness notification read exceeded its size limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel() }
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof envelope !== 'object' || envelope === null || !('type' in envelope) || envelope.type !== 'server-response'
        || !('rpcId' in envelope) || envelope.rpcId !== rpcId || !('result' in envelope)) throw new Error('Harness notification response is invalid')
      const result = envelope.result
      if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true || !('value' in result)) throw new Error('Harness notification RPC failed')
      return result.value
    },
  })
  const tick = (): void => {
    pending = poller.poll().catch(() => {
      if (!lifetime.signal.aborted && !reported) {
        reported = true
        options.reportError(new Error('Harness notification observation paused; next read establishes a fresh baseline'))
      }
    }).finally(() => {
      if (!lifetime.signal.aborted) timer = setTimeout(tick, 10_000)
    })
  }
  tick()
  return async () => { lifetime.abort(); clearTimeout(timer); await pending }
}
